using System;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Samples the default OS microphone via Unity's <see cref="Microphone"/> for a TX VU meter only.
    /// Does NOT transmit anything: the actual mic-to-LiveKit path is the tower web tab's LocalParticipant
    /// (the bridge just forwards the PTT toggle). Two simultaneous opens of the same input device are fine
    /// in Windows shared mode, so this won't block the web tab from capturing for transmission.
    /// </summary>
    /// <remarks>
    /// Created on demand by the radio panel. Started while PTT is held, stopped on release, so we don't
    /// hold the mic when idle.
    /// </remarks>
    public class TowerMicMeter : MonoBehaviour
    {
        private static TowerMicMeter _instance;

        public static TowerMicMeter Instance
        {
            get { return _instance; }
        }

        private const int SampleWindow = 1024;
        private const int RequestedHz = 16000;
        private AudioClip _clip;
        private string _device;
        private bool _running;
        private float[] _scratch;
        private int _lastSamplePos;

        public float Rms { get; private set; }
        public float Peak { get; private set; }
        public bool DeviceMissing { get; private set; }

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerMicMeter");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerMicMeter>();
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            _scratch = new float[SampleWindow];
        }

        private void OnDestroy()
        {
            StopSampling();
            if (_instance == this)
            {
                _instance = null;
            }
        }

        public void StartSampling()
        {
            if (_running)
            {
                return;
            }

            DeviceMissing = false;
            try
            {
                if (Microphone.devices == null || Microphone.devices.Length == 0)
                {
                    DeviceMissing = true;
                    return;
                }

                _device = Microphone.devices[0];
                _clip = Microphone.Start(_device, true, 1, RequestedHz);
                if (_clip == null)
                {
                    DeviceMissing = true;
                    return;
                }

                _running = true;
                _lastSamplePos = 0;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] Mic VU start failed: " + ex.Message);
                DeviceMissing = true;
            }
        }

        public void StopSampling()
        {
            if (!_running)
            {
                ResetLevels();
                return;
            }

            _running = false;
            try
            {
                Microphone.End(_device);
            }
            catch
            {
                /* ignore */
            }

            if (_clip != null)
            {
                Destroy(_clip);
                _clip = null;
            }

            ResetLevels();
        }

        private void ResetLevels()
        {
            Rms = 0f;
            Peak = 0f;
        }

        private void Update()
        {
            if (!_running || _clip == null)
            {
                // Smooth decay when idle so the bar visibly drops instead of snapping.
                Rms *= 0.85f;
                Peak *= 0.85f;
                return;
            }

            int micPos;
            try
            {
                micPos = Microphone.GetPosition(_device);
            }
            catch
            {
                StopSampling();
                return;
            }

            if (micPos < 0)
            {
                return;
            }

            // Read the most recent SampleWindow samples ending at micPos.
            var clipSamples = _clip.samples;
            if (clipSamples <= 0)
            {
                return;
            }

            var startPos = micPos - SampleWindow;
            if (startPos < 0)
            {
                startPos += clipSamples;
            }

            try
            {
                _clip.GetData(_scratch, startPos);
            }
            catch
            {
                return;
            }

            var sumSq = 0f;
            var peak = 0f;
            for (var i = 0; i < _scratch.Length; i++)
            {
                var v = _scratch[i];
                var a = v >= 0f ? v : -v;
                if (a > peak)
                {
                    peak = a;
                }

                sumSq += v * v;
            }

            var rms = Mathf.Sqrt(sumSq / _scratch.Length);
            // Light smoothing so the bar is readable instead of flickery at speech rates.
            Rms = Mathf.Lerp(Rms, rms, 0.5f);
            Peak = Mathf.Max(Peak * 0.85f, peak);
            _lastSamplePos = micPos;
        }
    }
}
