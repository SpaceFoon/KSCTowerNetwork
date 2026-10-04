using System;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Sends one-line commands to the Node voice-bridge control port (MIC_ON / MIC_OFF / PING).
    /// All blocking calls have a hard timeout so the Unity main thread cannot stall on a missing
    /// or hung bridge process. Use <see cref="EnqueueSend"/> from gameplay paths (PTT, OnGUI) to
    /// avoid any TCP work on the main thread.
    /// </summary>
    public static class TowerVoiceBridgeControl
    {
        public const int DefaultControlPort = 47373;

        /// <summary>Default upper bound on a single MIC_ON / MIC_OFF / PING round trip.</summary>
        public const int DefaultTimeoutMs = 750;

        private static DateTime _lastReplyAtUtc = DateTime.MinValue;

        /// <summary>
        /// UTC timestamp of the most recent successful TCP round-trip with the bridge.
        /// Updated on any non-empty reply (including ERR), because even an ERR proves the
        /// process is up and the control port is bound — which is exactly what the BRIDGE
        /// LED in the radio panel needs to know.
        /// </summary>
        public static DateTime LastReplyAtUtc { get { return _lastReplyAtUtc; } }

        /// <summary>True when we received any reply within the last <paramref name="seconds"/>.</summary>
        public static bool RecentlyAlive(double seconds)
        {
            if (_lastReplyAtUtc == DateTime.MinValue)
            {
                return false;
            }

            return (DateTime.UtcNow - _lastReplyAtUtc).TotalSeconds < seconds;
        }

        /// <summary>
        /// Connects, writes a single UTF-8 line (newline appended), reads one line of response.
        /// All socket operations are bounded by <paramref name="timeoutMs"/>; the call can never
        /// hang the main thread the way the un-timed default did.
        /// </summary>
        public static bool TrySendLineWithTimeout(string host, int port, string line, int timeoutMs, out string responseLine)
        {
            responseLine = null;
            if (string.IsNullOrEmpty(line))
            {
                return false;
            }

            if (timeoutMs <= 0)
            {
                timeoutMs = DefaultTimeoutMs;
            }

            try
            {
                using (var client = new TcpClient())
                {
                    client.NoDelay = true;
                    client.SendTimeout = timeoutMs;
                    client.ReceiveTimeout = timeoutMs;

                    // BeginConnect + WaitOne is the only way to bound the connect step on
                    // pre-async .NET frameworks; TcpClient.Connect() will sit on the OS
                    // SYN-retry timer (~20s on Windows) when the bridge is down.
                    var ar = client.BeginConnect(host, port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(timeoutMs, false))
                    {
                        try { client.Close(); } catch { /* ignore */ }
                        return false;
                    }
                    try
                    {
                        client.EndConnect(ar);
                    }
                    catch
                    {
                        return false;
                    }

                    var stream = client.GetStream();
                    stream.ReadTimeout = timeoutMs;
                    stream.WriteTimeout = timeoutMs;
                    var payload = Encoding.UTF8.GetBytes(line + "\n");
                    stream.Write(payload, 0, payload.Length);
                    stream.Flush();

                    var ms = new MemoryStream();
                    var buf = new byte[1];
                    while (true)
                    {
                        int n;
                        try
                        {
                            n = stream.Read(buf, 0, 1);
                        }
                        catch (IOException)
                        {
                            // Read timeout or socket reset — return what we have.
                            break;
                        }
                        if (n <= 0)
                        {
                            break;
                        }

                        if (buf[0] == (byte)'\n')
                        {
                            break;
                        }

                        ms.WriteByte(buf[0]);
                        if (ms.Length > 512)
                        {
                            break;
                        }
                    }

                    responseLine = Encoding.UTF8.GetString(ms.ToArray()).Trim();
                    if (!string.IsNullOrEmpty(responseLine))
                    {
                        _lastReplyAtUtc = DateTime.UtcNow;
                    }

                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Backward-compatible wrapper around <see cref="TrySendLineWithTimeout"/> using the
        /// default timeout. Older call sites that haven't switched to <see cref="EnqueueSend"/>
        /// still get bounded blocking instead of the previous unbounded TcpClient.Connect.
        /// </summary>
        public static bool TrySendLine(string host, int port, string line, out string responseLine)
        {
            return TrySendLineWithTimeout(host, port, line, DefaultTimeoutMs, out responseLine);
        }

        /// <summary>
        /// Queues a one-line send to a worker thread so the Unity main thread (OnGUI, PTT,
        /// OnDestroy) never blocks on TCP. <paramref name="onComplete"/> runs on the worker
        /// thread; marshal back to Unity main thread yourself if the callback touches UI.
        /// </summary>
        public static void EnqueueSend(string host, int port, string line, Action<bool, string> onComplete)
        {
            EnqueueSend(host, port, line, DefaultTimeoutMs, onComplete);
        }

        /// <summary>
        /// Queues a one-line send to a worker thread with an explicit timeout.
        /// </summary>
        public static void EnqueueSend(string host, int port, string line, int timeoutMs, Action<bool, string> onComplete)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string resp;
                bool ok;
                try
                {
                    ok = TrySendLineWithTimeout(host, port, line, timeoutMs, out resp);
                }
                catch
                {
                    ok = false;
                    resp = null;
                }

                if (onComplete != null)
                {
                    try
                    {
                        onComplete(ok, resp);
                    }
                    catch
                    {
                        // Callback errors must not propagate up the worker thread.
                    }
                }
            });
        }
    }
}
