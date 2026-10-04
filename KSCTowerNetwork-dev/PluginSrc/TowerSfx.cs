using System.Collections.Generic;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Centralised UI sound-effect service for the radio panel. Loads short avionics-style
    /// click/beep clips from <c>ASET/ASET_Props/Sounds/</c> via the stock <c>GameDatabase</c>
    /// and plays them through a single non-spatial <see cref="AudioSource"/>.
    /// </summary>
    /// <remarks>
    /// We deliberately reuse the ASET Avionics (IAV) sound library that the player almost
    /// certainly already has installed alongside RPM-based mods — this way the radio panel's
    /// click/beep palette matches every other cockpit in the save instead of introducing a
    /// new "GUI is plastic" set of sounds. If ASET isn't installed the loaders silently
    /// no-op (single warning to the log) so the panel still functions, just without audio.
    ///
    /// All public entry points are static + idempotent so callers can sprinkle
    /// <c>TowerSfx.PlayClick()</c> next to a button without any wiring.
    /// </remarks>
    public class TowerSfx : MonoBehaviour
    {
        // KSP audio paths are GameData-relative URLs without an extension. The matching files
        // live at GameData\ASET\ASET_Props\Sounds\<name>.{wav,ogg}. If the player doesn't
        // have ASET installed these all resolve to null and the corresponding Play call is a
        // silent no-op (see Load + the warned-once log line).
        private const string ClipClick = "ASET/ASET_Props/Sounds/click-027";
        private const string ClipKnob = "ASET/ASET_Props/Sounds/Rotary01";
        private const string ClipToggle = "ASET/ASET_Props/Sounds/Toggle01";
        private const string ClipAcrBeep = "ASET/ASET_Props/Sounds/AlarmBeep01";

        // Per-mode "PTT release tail" clips. Real ham / aviation comms drop a short cue when
        // the carrier closes so the listener knows the speaker has finished — we pick that
        // cue per craft mode so the player can hear at a glance whether they're on the
        // plane, rocket or rover net:
        //   - Plane:  beaconStatic.wav     -> the classic VHF squelch-tail static blip.
        //   - Rocket: beep_A_short_x1.wav  -> a single short avionics chirp.
        //   - Rover:  click-027.wav        -> a soft mechanical click (same family as the
        //                                     UI button click — stays understated for the
        //                                     low-stakes rover net).
        // All three live in ASET Avionics; if it's not installed Load() no-ops with a single
        // warning and the radio just goes silent on release (no behaviour regression).
        private const string ClipPttReleasePlane = "ASET/ASET_Props/Sounds/beaconStatic";
        private const string ClipPttReleaseRocket = "ASET/ASET_Props/Sounds/beep_A_short_x1";
        private const string ClipPttReleaseRover = "ASET/ASET_Props/Sounds/click-027";

        // Per-clip volumes tuned by ear: the alarm beep + rotary tick are naturally loud in
        // the source files, so the click/toggle slabs sit a touch under to keep the mix even.
        private const float VolClick = 0.55f;
        private const float VolKnob = 0.45f;
        private const float VolToggle = 0.65f;
        private const float VolAcrBeep = 0.7f;
        // PTT release sits between click and alarm — loud enough to register over engine
        // noise in flight, quiet enough not to clip the speakers when the player has UI
        // volume cranked. Static is naturally hotter than the beep so it gets a slight cut.
        private const float VolPttReleaseStatic = 0.55f;
        private const float VolPttReleaseBeep = 0.7f;
        private const float VolPttReleaseClick = 0.55f;

        // Coalesce window to swallow the ui+iva-comm double-publish that happens when a
        // player has both keyboard PTT and the IVA COMM-radio collider mapped — both sources
        // fire a release edge within ~1 frame and we don't want a double squelch tail.
        private const float PttReleaseCoalesceSec = 0.25f;

        // When a burst of ACARS messages lands at once (e.g. the controller pasted a checklist
        // into chat) we don't want N overlapping beeps — coalesce to one chirp per window.
        // Window is shorter than the alarm clip so successive distinct events still chirp.
        private const float AcrBeepCoalesceSec = 0.6f;

        private static TowerSfx _instance;
        private AudioSource _src;
        private readonly Dictionary<string, AudioClip> _cache = new Dictionary<string, AudioClip>();
        private float _acrBeepLastAt = -1000f;
        private float _pttReleaseLastAt = -1000f;
        private bool _missingClipWarned;
        private bool _pttSubscribed;

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerSfx");
            DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerSfx>();
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            _src = gameObject.AddComponent<AudioSource>();
            _src.playOnAwake = false;
            // 2D UI sound — never panned by the camera or doppler-shifted by a moving vessel.
            _src.spatialBlend = 0f;
            _src.bypassEffects = true;
            _src.bypassListenerEffects = true;
            _src.bypassReverbZones = true;
            // Keep clicks audible while the in-game audio listener is paused (e.g. KSC main menu).
            _src.ignoreListenerPause = true;
        }

        private void OnEnable()
        {
            // Subscribe lazily so the PTT release tail follows the GameObject lifecycle —
            // unsubscribing in OnDisable keeps the bus clean across scene reloads even
            // though DontDestroyOnLoad means we shouldn't actually disable in practice.
            if (!_pttSubscribed)
            {
                TowerPttBus.PttStateChanged += HandlePttStateChanged;
                _pttSubscribed = true;
            }
        }

        private void OnDisable()
        {
            if (_pttSubscribed)
            {
                TowerPttBus.PttStateChanged -= HandlePttStateChanged;
                _pttSubscribed = false;
            }
        }

        private void OnDestroy()
        {
            if (_pttSubscribed)
            {
                TowerPttBus.PttStateChanged -= HandlePttStateChanged;
                _pttSubscribed = false;
            }
            if (_instance == this)
            {
                _instance = null;
            }
        }

        /// <summary>
        /// Fired by <see cref="TowerPttBus"/> on every PTT edge from any source (UI, TWR
        /// pushbutton prop, IVA COMM radio collider). We only care about the falling edge —
        /// the moment the player lets go — to play the squelch / release tail.
        /// </summary>
        private void HandlePttStateChanged(bool open)
        {
            if (open)
            {
                return;
            }

            PlayPttRelease();
        }

        /// <summary>
        /// Resolve a GameDatabase audio URL once and memoise it. Null clips are cached too so
        /// repeat lookups for a missing asset cost nothing — important because the radio panel
        /// re-fires Play* calls on every click and we'd otherwise hit the database scan path.
        /// </summary>
        private AudioClip Load(string path)
        {
            AudioClip clip;
            if (_cache.TryGetValue(path, out clip))
            {
                return clip;
            }

            clip = null;
            // GameDatabase isn't initialised during very early boot frames — guard against the
            // null-instance case so an over-eager caller (e.g. menu scene) doesn't NRE here.
            if (GameDatabase.Instance != null && GameDatabase.Instance.ExistsAudioClip(path))
            {
                clip = GameDatabase.Instance.GetAudioClip(path);
            }

            if (clip == null && !_missingClipWarned)
            {
                _missingClipWarned = true;
                Debug.Log(
                    "[KSCTowerNetwork] SFX clip missing: " + path +
                    " (install ASET Avionics for radio click/beep sounds — panel still works without it).");
            }

            _cache[path] = clip;
            return clip;
        }

        private void PlayClipInternal(string path, float volume)
        {
            if (_src == null)
            {
                return;
            }

            var clip = Load(path);
            if (clip == null)
            {
                return;
            }

            // Scale by the player's KSP UI-volume slider so SFX respect the same mix bus as the
            // rest of the cockpit instead of being inexplicably louder than every other beep.
            var ksp = 1f;
            try
            {
                ksp = GameSettings.UI_VOLUME;
            }
            catch
            {
                // GameSettings can be unloaded between scenes; treat as full volume.
            }

            _src.PlayOneShot(clip, Mathf.Clamp01(volume * ksp));
        }

        /// <summary>Short button press — push-button slabs (ACR/CHK/X, Reconnect, Log out, Power).</summary>
        public static void PlayClick()
        {
            EnsureExists();
            if (_instance != null)
            {
                _instance.PlayClipInternal(ClipClick, VolClick);
            }
        }

        /// <summary>Rotary tick — channel arrows and digit-spinner buttons on the tuner.</summary>
        public static void PlayKnob()
        {
            EnsureExists();
            if (_instance != null)
            {
                _instance.PlayClipInternal(ClipKnob, VolKnob);
            }
        }

        /// <summary>Toggle slap — BCN / CAM / KOS switch row.</summary>
        public static void PlayToggle()
        {
            EnsureExists();
            if (_instance != null)
            {
                _instance.PlayClipInternal(ClipToggle, VolToggle);
            }
        }

        /// <summary>
        /// Mode-aware "carrier dropped" cue, fired on every PTT release: static for plane,
        /// short avionics beep for rocket, soft click for rover. Coalesced so the
        /// keyboard-PTT + IVA-collider double publish doesn't double-fire the tail.
        /// </summary>
        public static void PlayPttRelease()
        {
            EnsureExists();
            if (_instance == null)
            {
                return;
            }

            if (Time.unscaledTime - _instance._pttReleaseLastAt < PttReleaseCoalesceSec)
            {
                return;
            }

            _instance._pttReleaseLastAt = Time.unscaledTime;

            string clip;
            float vol;
            switch (TowerCraftMode.Current)
            {
                case CraftMode.Rocket:
                    clip = ClipPttReleaseRocket;
                    vol = VolPttReleaseBeep;
                    break;
                case CraftMode.Rover:
                    clip = ClipPttReleaseRover;
                    vol = VolPttReleaseClick;
                    break;
                case CraftMode.Plane:
                default:
                    clip = ClipPttReleasePlane;
                    vol = VolPttReleaseStatic;
                    break;
            }

            _instance.PlayClipInternal(clip, vol);
        }

        /// <summary>Annunciator beep for incoming ACARS — coalesced so a burst stays single-chirp.</summary>
        public static void PlayAcrAlert()
        {
            EnsureExists();
            if (_instance == null)
            {
                return;
            }

            if (Time.unscaledTime - _instance._acrBeepLastAt < AcrBeepCoalesceSec)
            {
                return;
            }

            _instance._acrBeepLastAt = Time.unscaledTime;
            _instance.PlayClipInternal(ClipAcrBeep, VolAcrBeep);
        }
    }
}
