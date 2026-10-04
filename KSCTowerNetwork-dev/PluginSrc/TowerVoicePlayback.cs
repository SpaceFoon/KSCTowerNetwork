using System;
using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Plays tower voice from the local Node voice-bridge (TCP PCM s16le mono, default 48 kHz).
    /// Uses a streaming <see cref="AudioClip"/> + PCM callback so audio reaches the mix reliably in KSP
    /// (OnAudioFilterRead + clip is treated as a filter chain in some Unity versions and can stay silent).
    /// Create via <see cref="EnsureExists"/> from the toolbar.
    /// </summary>
    public class TowerVoicePlayback : MonoBehaviour
    {
        public const int DefaultTcpPort = 47372;

        private static TowerVoicePlayback _instance;

        public static TowerVoicePlayback Instance
        {
            get { return _instance; }
        }

        private AudioSource _audio;
        private readonly object _tcpLock = new object();
        private readonly ConcurrentQueue<short> _sampleQueue = new ConcurrentQueue<short>();

        private Thread _thread;
        private volatile bool _wantRun;
        private volatile bool _headerDone;
        private long _listenStartUtcTicks;
        private volatile int _inputSampleRate = 48000;
        private TcpClient _activeTcp;
        private long _bytesReceivedTotal;
        private long _lastChunkUtcTicks;
        private volatile float _lastOutputRms;
        private volatile float _lastOutputPeak;
        private int _queuedSamples;
        private const float PlaybackGain = 2.2f;
        private const int MaxBufferedSamples = 96000;

        /// <summary>How many times the reader thread has failed in a row; used to escalate to a bridge respawn.</summary>
        private volatile int _consecutiveConnectFailures;

        /// <summary>Last remote we were asked to connect to. Used to reconnect after a drop.</summary>
        private string _remoteHost;
        private int _remotePort;

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerVoicePlayback");
            UnityEngine.Object.DontDestroyOnLoad(go);
            go.AddComponent<TowerVoicePlayback>();
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            _audio = gameObject.GetComponent<AudioSource>();
            if (_audio == null)
            {
                _audio = gameObject.AddComponent<AudioSource>();
            }

            _audio.loop = true;
            _audio.playOnAwake = false;
            _audio.spatialBlend = 0f;
            ApplyListenVolumeFromSettings();
            _audio.priority = 0;
            _audio.bypassListenerEffects = true;
            _audio.ignoreListenerPause = true;
        }

        /// <summary>Re-read <see cref="TowerModSettings.VoiceListenVolume"/> and apply to the stream <see cref="AudioSource"/>.</summary>
        public static void RefreshListenVolumeFromSettings()
        {
            if (_instance == null)
            {
                return;
            }

            _instance.ApplyListenVolumeFromSettings();
        }

        private void ApplyListenVolumeFromSettings()
        {
            if (_audio == null)
            {
                return;
            }

            TowerModSettings.EnsureLoaded();
            _audio.volume = Mathf.Clamp01(TowerModSettings.VoiceListenVolume);
        }

        private void Start()
        {
            EnsureStreamingVoiceClip();
            _audio.Play();
        }

        /// <summary>Streaming procedural clip at the device output rate (Unity pulls PCM on the audio thread).</summary>
        private void EnsureStreamingVoiceClip()
        {
            var outRate = AudioSettings.outputSampleRate;
            if (outRate <= 0)
            {
                outRate = 48000;
            }

            if (_audio.isPlaying)
            {
                _audio.Stop();
            }

            var old = _audio.clip;
            _audio.clip = null;
            if (old != null)
            {
                Destroy(old);
            }

            var lengthSamples = Mathf.Clamp(outRate * 3600, 8192, int.MaxValue / 16);
            _audio.clip = AudioClip.Create("KSCTowerVoiceStream", lengthSamples, 1, outRate, true, OnTowerVoicePcmRead);
        }

        private void OnDestroy()
        {
            StopBridgeConnection();
            if (_instance == this)
            {
                _instance = null;
            }
        }

        /// <summary>True while the TCP reader thread is running (may still be negotiating header).</summary>
        public bool IsConnectingOrConnected
        {
            get { return _thread != null && _thread.IsAlive; }
        }

        /// <summary>True after <see cref="StartBridgeConnection"/> until <see cref="StopBridgeConnection"/> completes.</summary>
        public bool WantsHelmetVoiceListen
        {
            get { return _wantRun; }
        }

        /// <summary>
        /// Whether the helmet listen path should read as "ON AIR" in the radio UI: thread is up,
        /// we are within a short post-start grace while the PCM header arrives, or we have a header
        /// and have seen TCP payload recently. Prevents showing ON AIR through claim-pilot failures
        /// (listen stopped) or long dead TCP / reconnect backoff while the worker thread is still alive.
        /// </summary>
        public bool IsListenUiOnAir
        {
            get
            {
                return TowerVoiceListenUiLogic.IsListenUiOnAir(
                    _wantRun,
                    _thread != null && _thread.IsAlive,
                    Interlocked.Read(ref _listenStartUtcTicks),
                    HasStreamHeader,
                    Interlocked.Read(ref _lastChunkUtcTicks),
                    DateTime.UtcNow);
            }
        }

        public bool HasStreamHeader
        {
            get { return _headerDone; }
        }

        public long BytesReceivedTotal
        {
            get { return Interlocked.Read(ref _bytesReceivedTotal); }
        }

        public float LastOutputRms
        {
            get { return _lastOutputRms; }
        }

        public float LastOutputPeak
        {
            get { return _lastOutputPeak; }
        }

        public float SecondsSinceLastChunk
        {
            get
            {
                var ticks = Interlocked.Read(ref _lastChunkUtcTicks);
                if (ticks <= 0)
                {
                    return float.PositiveInfinity;
                }

                var dt = System.DateTime.UtcNow - new System.DateTime(ticks, System.DateTimeKind.Utc);
                return (float)dt.TotalSeconds;
            }
        }

        public void ToggleConnection(string host = "127.0.0.1", int port = DefaultTcpPort)
        {
            if (_thread != null && _thread.IsAlive)
            {
                StopBridgeConnection();
                return;
            }

            StartBridgeConnection(host, port);
            Debug.Log("[KSCTowerNetwork] Helmet audio connecting to " + host + ":" + port);
        }

        public void StartBridgeConnection(string host, int port)
        {
            StopBridgeConnection();
            _wantRun = true;
            _headerDone = false;
            _resampleFrac = 0;
            _lastResampleSample = 0f;
            Interlocked.Exchange(ref _bytesReceivedTotal, 0);
            Interlocked.Exchange(ref _lastChunkUtcTicks, 0);
            Interlocked.Exchange(ref _queuedSamples, 0);
            _lastOutputRms = 0f;
            _lastOutputPeak = 0f;
            _consecutiveConnectFailures = 0;
            _remoteHost = host;
            _remotePort = port;
            DrainQueuedSamples();

            _thread = new Thread(() => RunTcpClientLoop(host, port))
            {
                IsBackground = true,
                Name = "KSCTowerVoiceTcp"
            };
            Interlocked.Exchange(ref _listenStartUtcTicks, DateTime.UtcNow.Ticks);
            _thread.Start();
        }

        public void StopBridgeConnection()
        {
            Interlocked.Exchange(ref _listenStartUtcTicks, 0);
            _wantRun = false;
            TcpClient tcp;
            lock (_tcpLock)
            {
                tcp = _activeTcp;
                _activeTcp = null;
            }

            if (tcp != null)
            {
                try
                {
                    tcp.Close();
                }
                catch
                {
                    /* ignore */
                }
            }

            var t = _thread;
            _thread = null;
            if (t != null && t.IsAlive)
            {
                t.Join(1200);
            }

            DrainQueuedSamples();

            _headerDone = false;
        }

        /// <summary>Outer loop: reconnects with backoff when the reader returns, and pokes the bridge to respawn after repeated failures.</summary>
        private void RunTcpClientLoop(string host, int port)
        {
            var backoffMs = 500;
            const int maxBackoffMs = 5000;
            var respawnRequestedForBurst = false;

            while (_wantRun)
            {
                var streamedAny = RunTcpClientOnce(host, port);
                if (!_wantRun)
                {
                    return;
                }

                if (streamedAny)
                {
                    backoffMs = 500;
                    _consecutiveConnectFailures = 0;
                    respawnRequestedForBurst = false;
                }
                else
                {
                    _consecutiveConnectFailures++;
                    // After ~3 straight failures with no data at all, ask the bridge to respawn on the main thread.
                    // Only do it once per failure burst to avoid start-storms.
                    if (_consecutiveConnectFailures >= 3 && !respawnRequestedForBurst)
                    {
                        respawnRequestedForBurst = true;
                        TowerVoiceBridgeRespawnQueue.RequestRespawn();
                    }
                }

                // Exponential backoff while we keep missing the bridge.
                var wait = backoffMs;
                backoffMs = System.Math.Min(backoffMs * 2, maxBackoffMs);
                var waited = 0;
                while (_wantRun && waited < wait)
                {
                    Thread.Sleep(100);
                    waited += 100;
                }
            }
        }

        /// <summary>One connect attempt. Returns true if it streamed at least one byte (header or PCM).</summary>
        private bool RunTcpClientOnce(string host, int port)
        {
            // Fresh negotiate each attempt so the AUDIO annunciator and IsListenUiOnAir don't
            // stay "live" across a dead socket during reconnect backoff.
            _headerDone = false;
            TcpClient client = null;
            var streamedAny = false;
            try
            {
                client = new TcpClient();
                client.NoDelay = true;
                lock (_tcpLock)
                {
                    _activeTcp = client;
                }

                client.Connect(host, port);
                var stream = client.GetStream();
                if (!ReadHeaderLine(stream))
                {
                    return streamedAny;
                }

                streamedAny = true;
                var buf = new byte[8192];
                var pendingLoByte = -1;
                while (_wantRun && client.Connected)
                {
                    var n = stream.Read(buf, 0, buf.Length);
                    if (n <= 0)
                    {
                        break;
                    }

                    var i = 0;
                    if (pendingLoByte >= 0 && i < n)
                    {
                        var s0 = (short)(pendingLoByte | (buf[i] << 8));
                        EnqueueSample(s0);
                        pendingLoByte = -1;
                        i++;
                    }

                    for (; i + 1 < n; i += 2)
                    {
                        var s = (short)(buf[i] | (buf[i + 1] << 8));
                        EnqueueSample(s);
                    }

                    if (i < n)
                    {
                        pendingLoByte = buf[i];
                    }

                    Interlocked.Add(ref _bytesReceivedTotal, n);
                    Interlocked.Exchange(ref _lastChunkUtcTicks, System.DateTime.UtcNow.Ticks);
                }
            }
            catch (Exception ex)
            {
                // "connection refused" / "target machine actively refused" happens every retry while the bridge is
                // down. Log once at warning for the first failure of a burst, quieter after that.
                if (_consecutiveConnectFailures <= 1)
                {
                    // Debug.Log* must run on the Unity main thread; calling it from this
                    // worker thread sometimes corrupts Unity's log writer or crashes when
                    // the main thread is also writing to the log.
                    var msg = ex.Message;
                    TowerMainThreadDispatcher.Run(() =>
                        Debug.LogWarning("[KSCTowerNetwork] voice TCP: " + msg));
                }
            }
            finally
            {
                lock (_tcpLock)
                {
                    if (_activeTcp == client)
                    {
                        _activeTcp = null;
                    }
                }

                if (client != null)
                {
                    try
                    {
                        client.Close();
                    }
                    catch
                    {
                        /* ignore */
                    }
                }
            }

            return streamedAny;
        }

        private void EnqueueSample(short s)
        {
            while (Interlocked.CompareExchange(ref _queuedSamples, 0, 0) >= MaxBufferedSamples)
            {
                short drop;
                if (_sampleQueue.TryDequeue(out drop))
                {
                    Interlocked.Decrement(ref _queuedSamples);
                }
                else
                {
                    break;
                }
            }

            _sampleQueue.Enqueue(s);
            Interlocked.Increment(ref _queuedSamples);
        }

        private void DrainQueuedSamples()
        {
            short s;
            while (_sampleQueue.TryDequeue(out s))
            {
                /* drain */
            }

            Interlocked.Exchange(ref _queuedSamples, 0);
        }

        private bool ReadHeaderLine(NetworkStream stream)
        {
            var line = new StringBuilder(128);
            while (_wantRun)
            {
                var b = stream.ReadByte();
                if (b < 0)
                {
                    return false;
                }

                if (b == '\n')
                {
                    break;
                }

                if (line.Length < 200)
                {
                    line.Append((char)b);
                }
            }

            var s = line.ToString().Trim();
            if (!s.StartsWith("TOWER_PCM", StringComparison.Ordinal))
            {
                _headerDone = false;
                return false;
            }

            var parts = s.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            for (var i = 0; i < parts.Length - 1; i++)
            {
                if (parts[i] != "s16le")
                {
                    continue;
                }

                int hz;
                if (int.TryParse(parts[i + 1], out hz) && hz > 8000 && hz < 192000)
                {
                    _inputSampleRate = hz;
                    _headerDone = true;
                    return true;
                }
            }

            _headerDone = false;
            return false;
        }

        private void OnTowerVoicePcmRead(float[] data)
        {
            if (!_headerDone || data == null || data.Length == 0)
            {
                Zero(data);
                return;
            }

            var outRate = AudioSettings.outputSampleRate;
            if (outRate <= 0)
            {
                outRate = 48000;
            }

            var inRate = _inputSampleRate;
            var di = 0;
            var sumSq = 0f;
            var peak = 0f;
            while (di < data.Length)
            {
                float m;
                if (outRate == inRate)
                {
                    if (!TryTakeOneSample(out m))
                    {
                        m = 0f;
                    }
                }
                else
                {
                    m = ResampleAndTakeOne(outRate, inRate);
                }

                m *= PlaybackGain;
                if (m > 1f)
                {
                    m = 1f;
                }
                else if (m < -1f)
                {
                    m = -1f;
                }

                var abs = m >= 0f ? m : -m;
                if (abs > peak)
                {
                    peak = abs;
                }

                sumSq += m * m;
                data[di++] = m;
            }

            _lastOutputPeak = peak;
            _lastOutputRms = data.Length > 0 ? Mathf.Sqrt(sumSq / data.Length) : 0f;
        }

        private static void Zero(float[] data)
        {
            for (var i = 0; i < data.Length; i++)
            {
                data[i] = 0f;
            }
        }

        private double _resampleFrac;
        private float _lastResampleSample;

        /// <summary>Consume input samples at inputRate vs output buffer at outRate (sample-and-hold).</summary>
        private float ResampleAndTakeOne(int outRate, int inRate)
        {
            _resampleFrac += (double)inRate / outRate;
            while (_resampleFrac >= 1.0)
            {
                float s;
                if (TryTakeOneSample(out s))
                {
                    _lastResampleSample = s;
                }

                _resampleFrac -= 1.0;
            }

            return _lastResampleSample;
        }

        private bool TryTakeOneSample(out float sample)
        {
            sample = 0f;
            short s16;
            if (!_sampleQueue.TryDequeue(out s16))
            {
                return false;
            }

            Interlocked.Decrement(ref _queuedSamples);
            sample = s16 / 32768f;
            return true;
        }
    }
}
