using System;
using System.Globalization;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Bidirectional sync between the IVA ASET COMM radio's active frequency dial
    /// (<c>ASET_COMM_RADIO_ACTIVE_FREQ</c>) and the KSCTowerNetwork channel
    /// (<see cref="TowerModSettings.SessionId"/>). Optional <see cref="TowerModSettings.FrequencyChannelMap"/>
    /// entries override routing; otherwise tuning matches the floating radio (lobby + session/call).
    /// </summary>
    /// <remarks>
    /// Forward direction (radio → tower): <see cref="OnUpdate"/> reads the persistent dial value
    /// and, when it changes, either (1) calls <see cref="TowerModSettings.SetActiveChannel"/> when
    /// <see cref="TowerModSettings.FrequencyChannelMap"/> lists that MHz, or (2) calls
    /// <see cref="TowerRadioGui.RequestTuneFromIvaCommRadio"/> — same path as the floating radio SET
    /// button (lobby match / <c>/session/call</c>) so the IVA prop works without a manual map.
    /// <para/>
    /// Reverse direction (tower → radio): subscribes to
    /// <see cref="TowerModSettings.OnSessionIdChanged"/> and writes the matching frequency to the
    /// per-pod persistent so the LCD updates when the player changes channel from the UI bar.
    /// <para/>
    /// Both RPM and MAS are supported via <see cref="TowerCommRadioPersistents"/>.
    /// </remarks>
    public class TowerCommRadioFreqSync : InternalModule
    {
        private const string ActiveFreqPersistent = "ASET_COMM_RADIO_ACTIVE_FREQ";

        private double _lastSeenFreqMhz;
        private bool _everSawValue;
        private bool _suppressNextRead;

        // Tracks whether we're currently subscribed to the static event. Used so that a
        // crash inside HandleSessionIdChanged can self-unsubscribe defensively (see below)
        // without double-removing on the eventual OnDestroy.
        private bool _subscribed;

        public override void OnAwake()
        {
            TowerModSettings.OnSessionIdChanged += HandleSessionIdChanged;
            _subscribed = true;
        }

        private void OnDestroy()
        {
            if (_subscribed)
            {
                TowerModSettings.OnSessionIdChanged -= HandleSessionIdChanged;
                _subscribed = false;
            }
        }

        public override void OnUpdate()
        {
            Part part;
            if (!TryGetLivePart(out part))
            {
                return;
            }

            if (_suppressNextRead)
            {
                // We just wrote the persistent ourselves (reverse direction); skip one tick so we
                // don't immediately observe our own write as a "user changed the dial" event.
                _suppressNextRead = false;
                _everSawValue = true;
                _lastSeenFreqMhz = ReadFrequencyMhz(part);
                return;
            }

            var freq = ReadFrequencyMhz(part);
            if (double.IsNaN(freq))
            {
                return;
            }

            if (!_everSawValue)
            {
                _everSawValue = true;
                _lastSeenFreqMhz = freq;
                return;
            }

            if (Math.Abs(freq - _lastSeenFreqMhz) < 0.001)
            {
                return;
            }

            _lastSeenFreqMhz = freq;

            string channel;
            if (TowerModSettings.TryResolveChannelForFrequency(freq, out channel))
            {
                if (string.Equals(channel, TowerModSettings.SessionId, StringComparison.Ordinal))
                {
                    return;
                }

                // SetActiveChannel will fire OnSessionIdChanged synchronously, which calls
                // HandleSessionIdChanged below; that writes the freq back to the persistent (no-op
                // since we're already at it) and sets _suppressNextRead. Safe re-entrancy because the
                // forward path above only fires on a *change* in observed frequency.
                TowerModSettings.SetActiveChannel(channel);
                return;
            }

            // No FREQUENCY_CHANNEL_MAP entry: same behavior as the floating radio panel SET.
            TowerRadioGui.RequestTuneFromIvaCommRadio(freq);
        }

        private void HandleSessionIdChanged(string newSessionId)
        {
            // The static OnSessionIdChanged event can outlive the InternalModule's
            // underlying GameObject when KSP tears down an IVA prop without calling our
            // OnDestroy in time (observed on scene-change races — KSP.log: "OnSessionIdChanged
            // subscriber threw: NullReferenceException ... HandleSessionIdChanged [0x0000e]").
            // The Unity `==` overload would normally translate "destroyed" to null, but the
            // field-access we used to perform throws before that overload runs because the
            // Mono runtime can't get back to the C++ side. Wrap the whole body so a dead
            // module just no-ops, and self-unsubscribe so we don't keep crashing on every
            // future channel switch.
            try
            {
                Part part;
                if (!TryGetLivePart(out part))
                {
                    return;
                }

                double freq;
                if (!TowerModSettings.TryResolveFrequencyForChannel(newSessionId, out freq)
                    && !TryParseSessionIdAsMhz(newSessionId, out freq)
                    && !TowerRadioGui.TryGetLobbyFrequencyMhzForSession(newSessionId, out freq))
                {
                    return;
                }

                if (TowerCommRadioPersistents.Write(part, ActiveFreqPersistent, freq))
                {
                    _suppressNextRead = true;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] HandleSessionIdChanged threw, "
                    + "unsubscribing this dead InternalModule: " + ex.Message);
                if (_subscribed)
                {
                    try { TowerModSettings.OnSessionIdChanged -= HandleSessionIdChanged; }
                    catch { /* already removed — fine */ }
                    _subscribed = false;
                }
            }
        }

        /// <summary>True when <paramref name="sessionId"/> is a literal six-digit MHz string (same as the dial).
        /// </summary>
        private static bool TryParseSessionIdAsMhz(string sessionId, out double mhz)
        {
            mhz = 0.0;
            if (string.IsNullOrEmpty(sessionId))
            {
                return false;
            }

            if (!System.Text.RegularExpressions.Regex.IsMatch(sessionId, "^[0-9]{3}\\.[0-9]{3}$"))
            {
                return false;
            }

            return double.TryParse(sessionId, NumberStyles.Float, CultureInfo.InvariantCulture, out mhz);
        }

        /// <summary>
        /// Resolves <see cref="InternalModule.internalProp"/> → <c>Part</c> defensively. Returns
        /// false (and sets <paramref name="part"/> to null) if either reference is null OR has
        /// been Unity-destroyed; the Unity == overload is enough for the destroyed case but
        /// we additionally guard against the rare race where a field read throws inside Mono
        /// because the underlying C++ object is gone.
        /// </summary>
        private bool TryGetLivePart(out Part part)
        {
            part = null;
            try
            {
                var prop = internalProp;
                // Unity == overload returns true for destroyed objects too. Cast to UnityEngine.Object
                // is unnecessary because InternalProp inherits from MonoBehaviour, which inherits the
                // overload directly.
                if (prop == null)
                {
                    return false;
                }

                var p = prop.part;
                if (p == null)
                {
                    return false;
                }

                part = p;
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static double ReadFrequencyMhz(Part part)
        {
            var raw = TowerCommRadioPersistents.Read(part, ActiveFreqPersistent);
            if (raw == null)
            {
                return double.NaN;
            }

            // C# 5 — no pattern matching; explicit type checks.
            if (raw is double)
            {
                return (double)raw;
            }

            if (raw is float)
            {
                return (float)raw;
            }

            if (raw is int)
            {
                return (int)raw;
            }

            if (raw is long)
            {
                return (long)raw;
            }

            var s = raw as string;
            if (s != null)
            {
                double parsed;
                if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
                {
                    return parsed;
                }
                return double.NaN;
            }

            try
            {
                return Convert.ToDouble(raw, CultureInfo.InvariantCulture);
            }
            catch
            {
                return double.NaN;
            }
        }

    }
}
