using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Mutes Chatterer + the ASET COMM radio's own simulated ATC samples either (A) whenever any
    /// PTT source opens, with a post-release hold, or (B) for the entire Flight scene when
    /// <see cref="TowerModSettings.BlockChattererInFlight"/> is <c>true</c>.
    /// </summary>
    /// <remarks>
    /// We mute the AudioSources directly instead of asking Chatterer to "skip the next exchange":
    /// Chatterer doesn't expose a clean public API for that and the AudioSource list is what the
    /// player actually hears. The post-release window kills any chatter clip queued *during*
    /// transmit (Chatterer's exchange picker fires on a timer that's independent of PTT) so the
    /// next exchange waits for the operator to actually finish talking.
    ///
    /// Restoration uses a snapshot of <c>.mute</c> taken at the moment we duck so a player who had
    /// Chatterer or the ASET radio pre-muted gets back the same state.
    /// </remarks>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TowerChattererDuck : MonoBehaviour
    {
        /// <summary>How long after PTT release we keep ducking active. Chatterer's exchange picker often
        /// fires on a ~4–6 s cadence; keep ducking long enough that a queued clip does not start as soon
        /// as we unmute.</summary>
        public const float PostReleaseHoldSeconds = 4.5f;

        /// <summary>While PTT is held, re-scan for new AudioSources this often (Chatterer spawns fresh sources per exchange).</summary>
        private const float ExtendDuckIntervalSeconds = 0.12f;

        /// <summary>While <see cref="TowerModSettings.BlockChattererInFlight"/> is on, re-scan this often.</summary>
        private const float FlightBlockRescanSeconds = 0.25f;

        // Cache rebuilt on every fresh duck cycle: AudioSource discovery is O(N over all loaded
        // GameObjects) and we mustn't pay it on every PTT click. The cache is invalidated at the
        // end of the post-release window because Chatterer instantiates new AudioSources per
        // exchange.
        private readonly List<DuckedSource> _ducked = new List<DuckedSource>();
        private readonly List<DuckedSource> _flightBlock = new List<DuckedSource>();
        private bool _muteActive;
        private Coroutine _holdRoutine;
        private Coroutine _rapidRescanRoutine;
        private float _nextExtendUnscaledTime;
        private bool _flightBlockMode;
        private float _nextFlightBlockUnscaledTime;

        // Conservative list — Chatterer's audiosets ship with clips named after the era/program
        // (apollo11_*, sts1_*, russian_*, valentina_*); the parent-GameObject path check above
        // ("chatterer") is the strong signal and catches sources whose clips are user-replaced.
        // We deliberately do NOT match "beep" here: ASET props ship a beep-22.ogg button-click
        // sound and we'd silence radio button feedback while the player holds PTT.
        private static readonly string[] ChattererClipPrefixes =
        {
            "apollo", "sts", "russian", "valentina",
        };

        private void OnEnable()
        {
            TowerModSettings.EnsureLoaded();
            _flightBlockMode = TowerModSettings.BlockChattererInFlight;
            if (_flightBlockMode)
            {
                _nextFlightBlockUnscaledTime = 0f;
                RebuildListInto(_flightBlock);
                ApplyMuteToList(_flightBlock, true);
                ExtendFlightBlockNewSources();
                return;
            }

            TowerPttBus.PttStateChanged += HandlePttStateChanged;
        }

        private void OnDisable()
        {
            if (_flightBlockMode)
            {
                ApplyMuteToList(_flightBlock, false);
                _flightBlock.Clear();
                return;
            }

            TowerPttBus.PttStateChanged -= HandlePttStateChanged;
            // Scene unload while ducking is active must restore mute state, otherwise a player who
            // left the flight scene mid-transmit would re-enter with Chatterer permanently silent.
            RestoreImmediate();
        }

        private void OnDestroy()
        {
            if (_flightBlockMode)
            {
                ApplyMuteToList(_flightBlock, false);
                _flightBlock.Clear();
                return;
            }

            RestoreImmediate();
        }

        private void Update()
        {
            if (_flightBlockMode)
            {
                if (Time.unscaledTime < _nextFlightBlockUnscaledTime)
                {
                    return;
                }

                _nextFlightBlockUnscaledTime = Time.unscaledTime + FlightBlockRescanSeconds;
                ExtendFlightBlockNewSources();
                return;
            }

            if (!_muteActive)
            {
                return;
            }

            if (Time.unscaledTime < _nextExtendUnscaledTime)
            {
                return;
            }

            _nextExtendUnscaledTime = Time.unscaledTime + ExtendDuckIntervalSeconds;
            ExtendDuckToNewSources();
        }

        private void HandlePttStateChanged(bool open)
        {
            if (open)
            {
                if (_holdRoutine != null)
                {
                    // Re-press inside the post-release window: cancel the pending restore and stay muted.
                    StopCoroutine(_holdRoutine);
                    _holdRoutine = null;
                }

                _nextExtendUnscaledTime = 0f;
                BeginDuck();
                return;
            }

            // Release: keep the mute for PostReleaseHoldSeconds before restoring.
            if (!_muteActive)
            {
                return;
            }

            if (_holdRoutine != null)
            {
                StopCoroutine(_holdRoutine);
            }

            _holdRoutine = StartCoroutine(PostReleaseHoldThenRestore());
        }

        private void BeginDuck()
        {
            // Always re-scan on each press: Chatterer adds AudioSources lazily as exchanges queue
            // up, and Reviva can swap in a different IVA cockpit between presses.
            if (_rapidRescanRoutine != null)
            {
                StopCoroutine(_rapidRescanRoutine);
                _rapidRescanRoutine = null;
            }

            RebuildListInto(_ducked);
            ApplyMuteToList(_ducked, true);
            _muteActive = true;
            ExtendDuckToNewSources();
            // Chatterer often reacts to the same PTT in its own Update after our InternalModule
            // OnUpdate — mute after end-of-frame and the next couple frames so new sources never
            // get a full audible slice.
            _rapidRescanRoutine = StartCoroutine(RapidRescanAfterPttOpen());
        }

        private IEnumerator RapidRescanAfterPttOpen()
        {
            yield return new WaitForEndOfFrame();
            if (_muteActive)
            {
                ExtendDuckToNewSources();
            }

            for (int i = 0; i < 4; i++)
            {
                yield return null;
                if (!_muteActive)
                {
                    break;
                }

                ExtendDuckToNewSources();
            }

            _rapidRescanRoutine = null;
        }

        private IEnumerator PostReleaseHoldThenRestore()
        {
            if (_rapidRescanRoutine != null)
            {
                StopCoroutine(_rapidRescanRoutine);
                _rapidRescanRoutine = null;
            }

            yield return new WaitForSeconds(PostReleaseHoldSeconds);

            // Best-effort: also stop any currently-playing chatter source so the next exchange
            // doesn't suddenly punch in mid-clip when we unmute. Pure mute alone leaves the audio
            // playhead advancing under the hood.
            for (int i = 0; i < _ducked.Count; i++)
            {
                var d = _ducked[i];
                if (d.Source == null)
                {
                    continue;
                }

                try
                {
                    if (d.Source.isPlaying && d.IsChatterer)
                    {
                        d.Source.Stop();
                    }
                }
                catch
                {
                    // ignore; the source may have been destroyed since we cached it.
                }
            }

            ApplyMuteToList(_ducked, false);
            _ducked.Clear();
            _muteActive = false;
            _holdRoutine = null;
        }

        private void RestoreImmediate()
        {
            if (_holdRoutine != null)
            {
                StopCoroutine(_holdRoutine);
                _holdRoutine = null;
            }

            if (_rapidRescanRoutine != null)
            {
                StopCoroutine(_rapidRescanRoutine);
                _rapidRescanRoutine = null;
            }

            if (_muteActive)
            {
                ApplyMuteToList(_ducked, false);
                _muteActive = false;
            }

            _ducked.Clear();
        }

        /// <summary>
        /// Chatterer often instantiates a <see cref="AudioSource"/> when an exchange starts, *after*
        /// the initial PTT press. Catch those while PTT stays open so IVA / UI / hotkey TX all silence
        /// the same way.
        /// </summary>
        private void ExtendDuckToNewSources()
        {
            var sources = Resources.FindObjectsOfTypeAll<AudioSource>();
            if (sources == null)
            {
                return;
            }

            for (int i = 0; i < sources.Length; i++)
            {
                var s = sources[i];
                if (s == null || !IsInLoadedScene(s))
                {
                    continue;
                }

                if (ListContainsSourceInstance(s))
                {
                    continue;
                }

                bool chatterer = IsChattererSource(s);
                bool atc = !chatterer && IsAsetAtcSource(s);
                if (!chatterer && !atc)
                {
                    continue;
                }

                TryAddDuckedSource(_ducked, s, chatterer, true);
            }
        }

        private void ExtendFlightBlockNewSources()
        {
            var sources = Resources.FindObjectsOfTypeAll<AudioSource>();
            if (sources == null)
            {
                return;
            }

            for (int i = 0; i < sources.Length; i++)
            {
                var s = sources[i];
                if (s == null || !IsInLoadedScene(s))
                {
                    continue;
                }

                if (ListContainsSource(_flightBlock, s))
                {
                    continue;
                }

                bool chatterer = IsChattererSource(s);
                bool atc = !chatterer && IsAsetAtcSource(s);
                if (!chatterer && !atc)
                {
                    continue;
                }

                TryAddDuckedSource(_flightBlock, s, chatterer, true);
            }
        }

        private static bool ListContainsSource(List<DuckedSource> list, AudioSource s)
        {
            for (int i = 0; i < list.Count; i++)
            {
                if (list[i].Source == s)
                {
                    return true;
                }
            }

            return false;
        }

        private static void TryAddDuckedSource(List<DuckedSource> list, AudioSource s, bool isChatterer, bool muteNow)
        {
            list.Add(new DuckedSource
            {
                Source = s,
                PriorMute = s.mute,
                IsChatterer = isChatterer,
            });

            if (!muteNow)
            {
                return;
            }

            try
            {
                s.mute = true;
            }
            catch
            {
                // ignore; source may be torn down mid-flight
            }
        }

        private bool ListContainsSourceInstance(AudioSource s)
        {
            return ListContainsSource(_ducked, s);
        }

        private static void ApplyMuteToList(List<DuckedSource> list, bool mute)
        {
            for (int i = 0; i < list.Count; i++)
            {
                var d = list[i];
                if (d.Source == null)
                {
                    continue;
                }

                try
                {
                    d.Source.mute = mute ? true : d.PriorMute;
                }
                catch
                {
                    // ignore; AudioSource may have been destroyed (Chatterer recycles)
                }
            }
        }

        private static void RebuildListInto(List<DuckedSource> list)
        {
            list.Clear();

            // FindObjectsOfTypeAll catches inactive GameObjects too — Chatterer keeps its
            // AudioSources on disabled child objects between exchanges.
            var sources = Resources.FindObjectsOfTypeAll<AudioSource>();
            if (sources == null)
            {
                return;
            }

            for (int i = 0; i < sources.Length; i++)
            {
                var s = sources[i];
                if (s == null || !IsInLoadedScene(s))
                {
                    continue;
                }

                bool chatterer = IsChattererSource(s);
                bool atc = !chatterer && IsAsetAtcSource(s);
                if (!chatterer && !atc)
                {
                    continue;
                }

                TryAddDuckedSource(list, s, chatterer, false);
            }
        }

        private static bool IsInLoadedScene(AudioSource s)
        {
            if (s == null)
            {
                return false;
            }

            var go = s.gameObject;
            if (go == null)
            {
                return false;
            }

            var sc = go.scene;
            return sc.IsValid() && sc.isLoaded;
        }

        /// <summary>
        /// Catches Chatterer sources that use <see cref="AudioSource.PlayOneShot"/> (no stable
        /// <c>clip</c>) or live under renamed prefabs — any script from the Chatterer mod on the
        /// transform chain marks the branch.
        /// </summary>
        private static bool TransformChainHasChattererManagedScript(Transform leaf)
        {
            for (var t = leaf; t != null; t = t.parent)
            {
                var behaviours = t.GetComponents<MonoBehaviour>();
                if (behaviours == null)
                {
                    continue;
                }

                for (int i = 0; i < behaviours.Length; i++)
                {
                    var c = behaviours[i];
                    if (c == null)
                    {
                        continue;
                    }

                    var ty = c.GetType();
                    var asmName = ty.Assembly.GetName().Name;
                    if (!string.IsNullOrEmpty(asmName)
                        && asmName.IndexOf("chatterer", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return true;
                    }

                    var ns = ty.Namespace;
                    if (!string.IsNullOrEmpty(ns)
                        && ns.IndexOf("chatterer", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static bool IsChattererSource(AudioSource s)
        {
            // Chatterer attaches to a root GameObject literally named "chatterer". Use the
            // GameObject hierarchy name as the strongest signal; fall back to clip-name prefix
            // matching for sources whose parent has been renamed.
            var go = s.gameObject;
            if (go != null)
            {
                var n = go.name;
                if (!string.IsNullOrEmpty(n) && n.IndexOf("chatter", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }

                var parent = go.transform != null ? go.transform.parent : null;
                while (parent != null)
                {
                    var pn = parent.name;
                    if (!string.IsNullOrEmpty(pn) && pn.IndexOf("chatter", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return true;
                    }

                    parent = parent.parent;
                }

                // PlayOneShot leaves clip unset on the source; hierarchy names can differ from stock.
                // Any MonoBehaviour from Chatterer's assembly/namespace on this branch is definitive.
                if (TransformChainHasChattererManagedScript(go.transform))
                {
                    return true;
                }
            }

            var clip = s.clip;
            if (clip == null || string.IsNullOrEmpty(clip.name))
            {
                return false;
            }

            var cn = clip.name;
            if (cn.IndexOf("chatter", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return true;
            }

            if (cn.StartsWith("Chatterer", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            for (int i = 0; i < ChattererClipPrefixes.Length; i++)
            {
                if (cn.IndexOf(ChattererClipPrefixes[i], StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }

            return false;
        }

        private static bool IsAsetAtcSource(AudioSource s)
        {
            // ASET COMM radio plays internal ATC samples named ATC_001..ATC_020 (see
            // ASET_COMM_Radio.cfg lines ~458-639). Chatterer never names anything ATC_ so a clip
            // prefix match is unambiguous.
            var clip = s.clip;
            if (clip == null || string.IsNullOrEmpty(clip.name))
            {
                return false;
            }

            return clip.name.StartsWith("ATC_", StringComparison.OrdinalIgnoreCase);
        }

        private struct DuckedSource
        {
            public AudioSource Source;
            public bool PriorMute;
            public bool IsChatterer;
        }
    }
}
