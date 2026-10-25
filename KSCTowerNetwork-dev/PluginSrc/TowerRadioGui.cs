using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// IMGUI radio-panel UI (replaces the stock <c>MultiOptionDialog</c> popup). Renders a fixed-size
    /// "tower radio" with: power toggle (Listen), tune dial (channel/session), RX + TX VU meters,
    /// hold-to-talk bar, status LEDs, settings popover, and a minimize affordance.
    /// </summary>
    /// <remarks>
    /// The component lives across scene loads (DontDestroyOnLoad). Toolbar code only flips
    /// <see cref="Visible"/> — minimize keeps audio + bridge running. PTT key handling lives here too
    /// (used to live in TowerToolbar) so the radio works even when the panel is minimized.
    /// </remarks>
    public class TowerRadioGui : MonoBehaviour
    {
        private static TowerRadioGui _instance;

        public static TowerRadioGui Instance
        {
            get { return _instance; }
        }

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerRadioGui");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerRadioGui>();
        }

        /// <summary>
        /// ASET COMM radio (IVA): when the cockpit dial / SET updates <c>ASET_COMM_RADIO_ACTIVE_FREQ</c>,
        /// <see cref="TowerCommRadioFreqSync"/> calls this so tuning matches the floating panel (lobby
        /// lookup + <c>/session/call</c>) without requiring <c>FREQUENCY_CHANNEL_MAP</c>.
        /// </summary>
        public static void RequestTuneFromIvaCommRadio(double freqMhz)
        {
            EnsureExists();
            if (_instance == null)
            {
                return;
            }

            var canonical = FormatMhzDoubleToCanonical(freqMhz);
            if (string.IsNullOrEmpty(canonical) || !Regex.IsMatch(canonical, FreqFormatRegex))
            {
                return;
            }

            _instance.TuneToTypedFrequency(canonical, "IVA");
        }

        /// <summary>
        /// For <see cref="TowerCommRadioFreqSync"/> reverse direction: write the cockpit dial when the
        /// tower channel changes and we know this session's MHz from the lobby cache (no map entry needed).
        /// </summary>
        public static bool TryGetLobbyFrequencyMhzForSession(string sessionId, out double mhz)
        {
            mhz = 0.0;
            if (_instance == null || string.IsNullOrEmpty(sessionId))
            {
                return false;
            }

            LobbyRoomInfo room;
            if (!_instance._sessionIdToRoom.TryGetValue(sessionId, out room)
                || string.IsNullOrEmpty(room.FrequencyMhz))
            {
                return false;
            }

            return double.TryParse(room.FrequencyMhz, NumberStyles.Float, CultureInfo.InvariantCulture, out mhz);
        }

        /// <summary>
        /// VHF COM channel grid: 25 kHz spacing (0.025 MHz). Uses integer kilohertz rounding so
        /// values like <c>127.549999</c> don't land on bogus thousandths.
        /// </summary>
        private static double SnapMhzTo25KhzChannel(double mhz)
        {
            if (double.IsNaN(mhz) || double.IsInfinity(mhz))
            {
                return mhz;
            }

            var khz = mhz * 1000.0;
            var snappedKhz = System.Math.Round(khz / 25.0) * 25.0;
            return snappedKhz / 1000.0;
        }

        /// <summary>
        /// Parses canonical <c>NNN.NNN</c> MHz to a double, or false if the string does not match <see cref="FreqFormatRegex"/>.
        /// </summary>
        private static bool TryParseCanonicalFreqMhzToDouble(string canon, out double mhz)
        {
            mhz = 0.0;
            if (string.IsNullOrEmpty(canon) || !Regex.IsMatch(canon, FreqFormatRegex))
            {
                return false;
            }

            int whole;
            if (!int.TryParse(canon.Substring(0, 3), NumberStyles.None, CultureInfo.InvariantCulture, out whole))
            {
                return false;
            }

            int frac;
            if (!int.TryParse(canon.Substring(4, 3), NumberStyles.None, CultureInfo.InvariantCulture, out frac))
            {
                return false;
            }

            mhz = whole + frac / 1000.0;
            return true;
        }

        /// <summary>
        /// Snaps a canonical <c>NNN.NNN</c> string to the 25 kHz grid and returns canonical form again.
        /// </summary>
        private static string SnapCanonicalFreqString(string canon)
        {
            double d;
            if (!TryParseCanonicalFreqMhzToDouble(canon, out d))
            {
                return canon;
            }

            return FormatMhzDoubleToCanonical(d);
        }

        /// <summary>
        /// True when <paramref name="a"/> and <paramref name="b"/> denote the same 25 kHz COM channel
        /// (canonical strings snapped and compared), or when they are identical (covers UUID session ids).
        /// </summary>
        private static bool FrequenciesMatchOn25KhzGrid(string a, string b)
        {
            if (string.Equals(a ?? string.Empty, b ?? string.Empty, StringComparison.Ordinal))
            {
                return true;
            }

            var aa = (a ?? string.Empty).Trim();
            var bb = (b ?? string.Empty).Trim();
            if (!Regex.IsMatch(aa, FreqFormatRegex) || !Regex.IsMatch(bb, FreqFormatRegex))
            {
                return false;
            }

            return string.Equals(SnapCanonicalFreqString(aa), SnapCanonicalFreqString(bb), StringComparison.Ordinal);
        }

        /// <summary>
        /// Converts RPM/MAS dial MHz (double) to canonical <c>NNN.NNN</c> for <see cref="TuneToTypedFrequency"/>,
        /// after snapping to the 25 kHz COM grid (same as real VHF 25 kHz channel spacing).
        /// </summary>
        private static string FormatMhzDoubleToCanonical(double freqMhz)
        {
            if (double.IsNaN(freqMhz) || double.IsInfinity(freqMhz))
            {
                return string.Empty;
            }

            var snapped = SnapMhzTo25KhzChannel(freqMhz);
            var scaled = (long)System.Math.Round(snapped * 1000.0);
            if (scaled < 0)
            {
                scaled = -scaled;
            }

            var whole = scaled / 1000;
            var frac = (int)(scaled % 1000);
            if (whole < 0L || whole > 999L)
            {
                return string.Empty;
            }

            return string.Format(CultureInfo.InvariantCulture, "{0:000}.{1:000}", whole, frac);
        }

        /// <summary>
        /// Trims useless trailing fractional zeros from a canonical <c>NNN.NNN</c> string for human-readable MHz.
        /// When <paramref name="snapTo25Khz"/> is true, snaps to the 25 kHz grid first (committed / ATIS strings).
        /// </summary>
        private static string FormatCanonicalMhzHumanTrimTrailingZeros(string canon, bool snapTo25Khz)
        {
            if (string.IsNullOrEmpty(canon))
            {
                return canon;
            }

            var src = snapTo25Khz ? SnapCanonicalFreqString(canon) : canon;
            if (!Regex.IsMatch(src, FreqFormatRegex))
            {
                return canon;
            }

            int w;
            if (!int.TryParse(src.Substring(0, 3), NumberStyles.None, CultureInfo.InvariantCulture, out w))
            {
                return canon;
            }

            int fracInt;
            if (!int.TryParse(src.Substring(4, 3), NumberStyles.None, CultureInfo.InvariantCulture, out fracInt))
            {
                return canon;
            }

            var fstr = fracInt.ToString("000", CultureInfo.InvariantCulture);
            while (fstr.Length > 2 && fstr[fstr.Length - 1] == '0')
            {
                fstr = fstr.Substring(0, fstr.Length - 1);
            }

            if (fstr.Length == 0)
            {
                return w.ToString(CultureInfo.InvariantCulture);
            }

            return string.Format(CultureInfo.InvariantCulture, "{0}.{1}", w, fstr);
        }

        /// <summary>
        /// Human / ASET-style MHz without trailing fractional zeros (e.g. <c>128.25</c>, <c>118.025</c>); 25 kHz snap first.
        /// </summary>
        private static string FormatCanonicalMhzHumanNoTrailingZeros(string canon)
        {
            return FormatCanonicalMhzHumanTrimTrailingZeros(canon, true);
        }

        /// <summary>
        /// Seven-character LCD string <c>NNN.DDD</c> (blank third fractional cell when it would only show a trailing zero).
        /// <paramref name="snapToGrid"/> false = staged knob string as-is (no snap); true = 25 kHz snap first.
        /// </summary>
        private static string FormatCanonicalMhzForAviationLcdSeven(string canon, bool snapToGrid)
        {
            if (string.IsNullOrEmpty(canon))
            {
                return canon;
            }

            if (!Regex.IsMatch(canon, FreqFormatRegex))
            {
                return canon;
            }

            var source = snapToGrid ? SnapCanonicalFreqString(canon) : canon;
            int whole;
            int frac;
            if (!int.TryParse(source.Substring(0, 3), NumberStyles.None, CultureInfo.InvariantCulture, out whole)
                || !int.TryParse(source.Substring(4, 3), NumberStyles.None, CultureInfo.InvariantCulture, out frac))
            {
                return canon;
            }

            if (whole < 0 || whole > 999)
            {
                return canon;
            }

            var fracStr = frac.ToString("000", CultureInfo.InvariantCulture);
            while (fracStr.Length > 2 && fracStr[fracStr.Length - 1] == '0')
            {
                fracStr = fracStr.Substring(0, fracStr.Length - 1);
            }

            if (fracStr.Length < 2)
            {
                fracStr = fracStr.PadLeft(2, '0');
            }

            var fracDisplay = (fracStr + "   ").Substring(0, 3);
            return string.Format(CultureInfo.InvariantCulture, "{0:000}.{1}", whole, fracDisplay);
        }

        /// <summary>
        /// Seven-character MHz LCD after 25 kHz snap (wrapper for <c>snapToGrid: true</c>).
        /// </summary>
        private static string FormatCanonicalMhzForAviationLcdSeven(string canon)
        {
            return FormatCanonicalMhzForAviationLcdSeven(canon, true);
        }

        /// <summary>
        /// Lobby / API frequency string → 7-char MHz LCD (snapped 25 kHz, trimmed fractional zeros for display).
        /// </summary>
        private static string FreqOrLobbyStringToAviationLcdSeven(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return LcdFreqPlaceholder;
            }

            var t = raw.Trim();
            if (Regex.IsMatch(t, FreqFormatRegex))
            {
                return FormatCanonicalMhzForAviationLcdSeven(SnapCanonicalFreqString(t));
            }

            var extracted = ExtractFrequencyFromText(t);
            if (!string.IsNullOrEmpty(extracted))
            {
                return FormatCanonicalMhzForAviationLcdSeven(extracted);
            }

            return SessionIdToFreqDisplay(t);
        }

        public bool Visible
        {
            get { return _visible; }
            set
            {
                if (_visible == value)
                {
                    return;
                }

                _visible = value;
                if (_visible)
                {
                    SyncDialDigitsFromActiveSession();
                }
                else
                {
                    // Release IMGUI capture so a knob drag cannot outlive the panel.
                    GUIUtility.hotControl = 0;
                    _tuneKnobCaptureControl = 0;
                    _tuneKnobActiveDigit = -1;
                    _tuneKnobNextRepeatUnscaled = -1f;
                    _tuneKnobDragAccumX = 0f;
                    CloseCompanionTowerWindows();
                }
            }
        }

        /// <summary>
        /// Hides satellite tower windows opened from the title bar so minimizing the radio does
        /// not leave ACARS / radars / checklist / notes floating over the flight scene.
        /// </summary>
        private static void CloseCompanionTowerWindows()
        {
            if (TowerAcarsGui.Instance != null)
            {
                TowerAcarsGui.Instance.Visible = false;
            }
            if (TowerDragonRadarGui.Instance != null)
            {
                TowerDragonRadarGui.Instance.Visible = false;
            }
            if (TowerTrafficRadarGui.Instance != null)
            {
                TowerTrafficRadarGui.Instance.Visible = false;
            }
            if (TowerChecklistGui.Instance != null)
            {
                TowerChecklistGui.Instance.Visible = false;
            }
            if (TowerNotesGui.Instance != null)
            {
                TowerNotesGui.Instance.Visible = false;
            }
        }

        public Action OnRequestLogout;
        public Action OnRequestMinimize;

        // Bumped from 360 → 420 so the four cockpit lamps/switches and the GHOST row
        // ("MY GHOST: AUTO (vessel type)") have breathing room without truncation.
        private const float PanelWidth = 420f;
        // Bumped from 520 → 560 when the LED row was split into a 4-lamp annunciator row + a
        // 2-switch toggle row (cockpit-style). The old single 28px row didn't need this; the
        // new two-row layout adds ~36px so the tuner / VU / PTT below shift down. Bumped
        // again to 600 for GHOST FLEET row. COPY / PASTE / SET row under the knobs. +96 for
        // D-ATIS text readout when tuned to ATIS (128.250 MHz). +4 for slightly taller digit dials.
        // +8 for larger LCD-style MHz readout row. +4 for an in-panel clearance strip row.
        private const float PanelHeight = 744f;
        private const string PttLabelIdle = "PUSH TO TALK";
        private const string PttLabelLive = "▶  TRANSMITTING  ◀";

        // MHz channel (NNN.NNN). Knobs only stage values; SET on the LCD or row commits (no auto-commit).
        private const string FreqFormatRegex = "^[0-9]{3}\\.[0-9]{3}$";

        /// <summary>
        /// Main LCD placeholder when <see cref="TowerModSettings.SessionId"/> is a slug/UUID
        /// and the lobby row has not arrived yet — without a dial fallback the player only
        /// sees em dashes and subtitle "MANUAL" even while tuned to a real channel.
        /// </summary>
        private const string LcdFreqPlaceholder = "\u2014\u2014\u2014.\u2014\u2014\u2014";

        /// <summary>◀ / ▶ column width in <see cref="DrawTuneDial"/>; knob row uses the same LCD geometry via <see cref="ComputeTuneDialLayout"/>.</summary>
        private const float QuickTuneArrowW = 28f;
        private const float QuickTuneArrowGap = 4f;

        /// <summary>Reserved height under the big MHz digits for preset label / STAGED (must match <see cref="DrawTuneDial"/>).</summary>
        private const float TuneDialSubBarH = 20f;

        /// <summary>Decimal column is <c>this ×</c> one digit column width — tighter than 1:1 so the middle knob gap matches avionics.</summary>
        private const float TuneDialDecimalColWeight = 0.32f;

        /// <summary>Point size for the big MHz LCD strip (monospace / segment-style via OS font).</summary>
        private const int TuneDialLcdFontSize = 24;
        /// <summary>
        /// Quick-tune list for ◀ / ▶ (fixed channels, not accumulated session history). Must match
        /// <c>backend/src/config/radioPresets.ts</c> and <c>GET /v1/site/info</c> → <c>plugin.radioPresets</c>.
        /// </summary>
        private struct RadioQuickPreset
        {
            public readonly string Id;
            public readonly string Label;
            public readonly string FrequencyMhz;

            public RadioQuickPreset(string id, string label, string frequencyMhz)
            {
                Id = id;
                Label = label;
                FrequencyMhz = frequencyMhz;
            }
        }

        private static readonly RadioQuickPreset[] QuickPresets =
        {
            new RadioQuickPreset("twr", "TWR", "122.000"),
            new RadioQuickPreset("gnd", "GND", "121.700"),
            new RadioQuickPreset("atis", "ATIS", "128.250"),
            new RadioQuickPreset("emrg", "EMRG", "121.500"),
        };

        /// <summary>Which <see cref="QuickPresets"/> slot the arrows will move from next.</summary>
        private int _presetArrowIndex;

        // Digit tuner knobs (<see cref="DrawDigitTuneKnob"/>): split-face click, drag-to-scrub, hold-to-repeat.
        private int _tuneKnobActiveDigit = -1;
        /// <summary>IMGUI control id while a knob owns <see cref="GUIUtility.hotControl"/> — cleared on mouse-up
        /// or by <see cref="SanitizeTuneKnobInputState"/> when the OS reports the button released but we never saw MouseUp.</summary>
        private int _tuneKnobCaptureControl;
        private float _tuneKnobDragAccumX;
        private float _tuneKnobLastPointerX;
        private float _tuneKnobNextRepeatUnscaled = -1f;
        private float _tuneKnobSfxNextUnscaled;

        // "Request launch" cooldown — matches the previous in-flight corner-pill widget so spam-clicks
        // don't pummel the controller with countdown/request POSTs.
        private const float LaunchRequestCooldownSec = 8f;

        private bool _visible;
        private string _statusLine = "Standby.";
        private Rect _windowRect = new Rect(40f, 80f, PanelWidth, PanelHeight);
        private int _windowId;

        private int[] _dialDigits = new int[6];
        private bool _dialDirty;

        /// <summary>Last 7-char LCD string from <see cref="DrawTuneDial"/> so <see cref="DrawTuneKnobs"/> can hide the mHz knob when the third fractional column is blank.</summary>
        private string _lastTuneDialLcdSeven = LcdFreqPlaceholder;
        /// <summary>
        /// True while the dial shows ATIS MHz but <see cref="TowerModSettings.SessionId"/> remains
        /// the operational tower room. ATIS is receive-only; storing MHz as SessionId breaks the
        /// voice bridge (POST /session/{id}/livekit-token expects a server session slug/UUID).
        /// </summary>
        private bool _atisLocalReceiveOnly;
        private float _bridgePingNextAt;

        private bool _micUiHeld;
        private bool _micKeyHeld;
        private bool _pttCombinedPrev;
        private bool _bridgeMicLive;
        private bool _suppressPttKeyUntilRelease;

        private float _rxRmsSmooth;
        private float _rxPeakHold;
        private float _rxPeakHoldDecayAt;
        private float _txRmsSmooth;
        private float _txPeakHold;
        private float _txPeakHoldDecayAt;

        private float _launchRequestLastAtRealtime = -1000f;
        private bool _launchRequestBusy;

        /// <summary>
        /// After the active vessel actually leaves the pad (flying / orbit-class), hide the
        /// REQUEST LAUNCH row until the player flies a different vessel (new <see cref="Guid"/>).
        /// </summary>
        private Guid _launchAssistTrackedVesselId;

        private bool _launchAssistTakeoffDismissed;

        // Unread-ACARS annunciator. The ACR button pulses red until the player opens the ACARS
        // panel (TowerAcarsGui calls NotifyAcarsRead() on Visible=true). _acrUnreadCount is
        // informational; the visual state only depends on >0.
        private int _acrUnreadCount;
        private float _acrUnreadFlashAt;

        /// <summary>
        /// Traffic scope (TRF): set when <see cref="TowerTrafficRadarGui"/> sees a new other-pilot
        /// contact inside 25 km while that window is closed; cleared when the player opens TRF.
        /// </summary>
        private int _trfNearbyAlert;
        private float _trfNearbyFlashAt;

        // Cached frequency → room-name map populated by RefreshLobbyRooms(). Lets the LCD
        // subtitle replace the generic "CH 2 / 5" with the actual room/callsign anyone has
        // booked at the currently-tuned frequency, which is what the player asked for so
        // tuning into a populated room is obvious instead of just "MANUAL" / "CH ?".
        private Dictionary<string, string> _freqToRoomName = new Dictionary<string, string>(StringComparer.Ordinal);

        // Companion map keyed by session id (== room id). Used so a slug-shaped active
        // sessionId like "fooney-ec0d" can still resolve to its server-assigned (frequencyMhz,
        // roomName) and the LCD can render a real number + tower name instead of the placeholder
        // em-dashes the digit-only path falls back to. Tracked separately from _freqToRoomName
        // because the same room id is the canonical key here (frequencies can collide on closed
        // rooms; slugs are guaranteed unique).
        private struct LobbyRoomInfo
        {
            public string FrequencyMhz;
            public string RoomName;
            public string Callsign;
        }
        private Dictionary<string, LobbyRoomInfo> _sessionIdToRoom = new Dictionary<string, LobbyRoomInfo>(StringComparer.Ordinal);
        private float _lobbyRoomsNextFetchAt;
        private bool _lobbyRoomsFetchBusy;
        private const float LobbyRoomsRefreshSecondsVisible = 10f;

        /// <summary>Must match <c>RadioQuickPreset</c> ATIS entry and <c>radioPresets.ts</c>.</summary>
        private const string AtisPresetMhz = "128.250";
        private static readonly string[] ClearanceKindsShort = { "TO", "LDG", "TXI", "HS", "GA" };
        private static readonly string[] ClearanceKindsWire = { "TAKEOFF", "LANDING", "TAXI", "HOLD_SHORT", "GO_AROUND" };
        /// <summary>Hover tooltips for <see cref="DrawClearanceRow"/>; order matches <see cref="ClearanceKindsShort"/>.</summary>
        private static readonly string[] ClearanceKindsTooltips =
        {
            "Takeoff — tower clearance to begin takeoff / roll. Green: cleared. Red: violation. Gray: no ruling from tower yet.",
            "Landing — tower clearance to land on the assigned runway. Green: cleared. Red: violation. Gray: no ruling from tower yet.",
            "Taxi — tower clearance to taxi on assigned routes. Green: cleared. Red: violation. Gray: no ruling from tower yet.",
            "Hold short — stay short of the runway or intersection until tower clears you across. Green: OK / compliant. Red: violation. Gray: no ruling from tower yet.",
            "Go around — discontinue the approach and climb away (missed approach or tower instruction). Green: cleared path / OK. Red: violation. Gray: no ruling from tower yet."
        };

        private const float AtisBlockHeight = 90f;
        private const float AtisPollIntervalSeconds = 18f;
        private float _atisNextFetchAt;
        private bool _atisFetchBusy;
        private bool _atisTunedIn;
        private string _atisLetter = "";
        private string _atisBody = "";
        private string _atisHint = "";
        private string _atisErr = "";
        private Vector2 _atisScroll;

        /// <summary>Local loop of <c>GET /v1/atis/current.wav</c> — same GameObject as the radio UI.</summary>
        private AudioSource _atisLoopSource;
        private AudioClip _atisLoopClip;
        private string _atisLoopLastContentHash = "";
        private float _atisLoopNextPollUnscaled;
        private bool _atisLoopBusy;
        private const float AtisLoopPollSeconds = 12f;

        private GUIStyle _panelStyle;
        private GUIStyle _titleStyle;
        private GUIStyle _ledLabelStyle;
        private GUIStyle _channelStyle;
        /// <summary>Per-column MHz cells on the LCD so glyphs line up with the six tuning knobs.</summary>
        private GUIStyle _channelDigitCellStyle;
        private GUIStyle _smallStyle;
        /// <summary>Title bar second line: muted &quot;CALLSIGN&quot; + bold pilot id (rich text).</summary>
        private GUIStyle _pilotStripStyle;
        private GUIStyle _atisReadoutStyle;
        private GUIStyle _powerOnStyle;
        private GUIStyle _powerOffStyle;
        private GUIStyle _pttIdleStyle;
        private GUIStyle _pttLiveStyle;
        private GUIStyle _iconBtnStyle;
        private GUIStyle _statusStyle;
        private GUIStyle _topBarBtnStyle;
        private GUIStyle _topBarBtnActiveStyle;
        private GUIStyle _topBarBtnAlertStyle;
        /// <summary>Invisible <see cref="GUI.Button"/> chrome over each preset arrow (bezel drawn underneath).</summary>
        private GUIStyle _arrowHitStyle;
        private GUIStyle _utilityBtnStyle;
        private GUIStyle _launchBtnStyle;
        private GUIStyle _launchBtnApprovedStyle;
        private GUIStyle _launchBtnDisabledStyle;
        private GUIStyle _switchLabelStyle;
        private GUIStyle _switchStateOnStyle;
        private GUIStyle _switchStateOffStyle;
        private GUIStyle _clearanceStyle;
        /// <summary>Word-wrapped label for <see cref="DrawWindowTooltipIfNeeded"/> (drawn over <see cref="_texTooltipBg"/>).</summary>
        private GUIStyle _tooltipLabelStyle;
        private bool _stylesReady;

        private static Texture2D _texPanelDark;
        private static Texture2D _texInset;
        /// <summary>Slightly lighter than <see cref="_texInset"/> so tooltip body text reads clearly on top.</summary>
        private static Texture2D _texTooltipBg;
        private static Texture2D _texLcdBack;
        private static Texture2D _texLedGreen;
        private static Texture2D _texLedAmber;
        private static Texture2D _texLedRed;
        private static Texture2D _texLedDim;
        private static Texture2D _texVuBg;
        private static Texture2D _texVuGreen;
        private static Texture2D _texVuYellow;
        private static Texture2D _texVuRed;
        private static Texture2D _texVuPeak;
        private static Texture2D _texPwrOn;
        private static Texture2D _texPwrOff;
        private static Texture2D _texPttIdle;
        private static Texture2D _texPttLive;
        private static Texture2D _texDivider;
        private static Texture2D _texLaunchBtn;
        private static Texture2D _texLaunchBtnDim;
        private static Texture2D _texLaunchBtnApproved;
        private static Texture2D _texLampBezel;
        private static Texture2D _texSwitchOff;
        private static Texture2D _texSwitchOffHover;
        private static Texture2D _texSwitchOn;
        private static Texture2D _texSwitchOnHover;
        private static Texture2D _texSwitchBevelOff;
        private static Texture2D _texSwitchBevelOn;
        private static Texture2D _texAcrAlertDim;
        /// <summary>Round bezel for digit dials and preset thumbwheels (<see cref="MakeKnobBezelTex"/>).</summary>
        private static Texture2D _texKnobBezel;
        /// <summary>Recessed avionics well behind each digit knob and the knob strip.</summary>
        private static Texture2D _texKnobWell;
        /// <summary>Flat dark face under the round bezel (GA-style matte knob).</summary>
        private static Texture2D _texKnobFace;
        /// <summary>Fully transparent 1×1 for IMGUI styles that must not paint over knob bezels.</summary>
        private static Texture2D _texClear;
        /// <summary>Symmetric ◀ / ▶ drawn inside the round preset buttons (Unicode skin glyphs sit off-center).</summary>
        private static Texture2D _texArrowLeft;
        private static Texture2D _texArrowRight;

        /// <summary>Solid white pixel used as a tinted segment fill (combined with <see cref="GUI.color"/>).</summary>
        private static Texture2D _texSegmentFill;
        /// <summary>Lit segment color for the MHz strip — same amber as the channel readout, slightly hotter.</summary>
        private static readonly Color SegmentOnColor = new Color(1f, 0.74f, 0.22f, 1f);
        /// <summary>Faintly visible "off" ghost behind every digit cell (real LCDs show all segments dim).</summary>
        private static readonly Color SegmentOffColor = new Color(1f, 0.74f, 0.22f, 0.10f);

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            _windowId = GetInstanceID();
            EnsureAtisLoopAudioSource();
            _atisLoopNextPollUnscaled = 0f;
        }

        private void OnDestroy()
        {
            TeardownAtisLoopAudio();
            if (_instance == this)
            {
                _instance = null;
            }

        }

        private void Update()
        {
            if (!HighLogic.LoadedSceneIsGame)
            {
                return;
            }

            HandlePttKey();
            HandleBridgePing();
            HandleLobbyRoomsRefresh();
            HandleAtisPoll();
            HandleAtisLoopAudio();
        }

        /// <summary>
        /// Called by <see cref="TowerAcarsGui"/> when one or more new incoming messages arrive
        /// while the ACARS panel is hidden. Bumps the unread counter, pulses the ACR button
        /// red, and fires a single coalesced beep through <see cref="TowerSfx"/>. Safe to call
        /// before the radio panel has been spawned (silently no-ops in that case).
        /// </summary>
        public static void NotifyAcarsUnread(int newCount)
        {
            if (_instance == null || newCount <= 0)
            {
                return;
            }

            _instance._acrUnreadCount += newCount;
            _instance._acrUnreadFlashAt = Time.unscaledTime;
            TowerSfx.PlayAcrAlert();
        }

        /// <summary>
        /// Called by <see cref="TowerAcarsGui"/> when the player opens the ACARS panel —
        /// clears the red annunciator on the ACR button.
        /// </summary>
        public static void NotifyAcarsRead()
        {
            if (_instance == null)
            {
                return;
            }

            _instance._acrUnreadCount = 0;
        }

        /// <summary>
        /// Called by <see cref="TowerTrafficRadarGui"/> when a new other-pilot contact appears
        /// within traffic scope range while the TRF window is hidden — same alarm clip as ACARS.
        /// </summary>
        public static void NotifyTrafficRadarNearby()
        {
            if (_instance == null)
            {
                return;
            }

            _instance._trfNearbyAlert = 1;
            _instance._trfNearbyFlashAt = Time.unscaledTime;
            TowerSfx.EnsureExists();
            TowerSfx.PlayAcrAlert();
        }

        /// <summary>
        /// Called when the player opens the traffic scope window — clears the TRF annunciator.
        /// </summary>
        public static void NotifyTrafficRadarRead()
        {
            if (_instance == null)
            {
                return;
            }

            _instance._trfNearbyAlert = 0;
        }

        /// <summary>
        /// Periodically PINGs the voice bridge so the BRIDGE LED reflects "process is up
        /// and the control port is bound" rather than "we personally spawned it" — which
        /// is what the previous IsSpawnedVoiceBridgeAlive-only check returned, and which
        /// always read OFF when the bridge was launched manually (npm start).
        /// </summary>
        private void HandleBridgePing()
        {
            if (Time.unscaledTime < _bridgePingNextAt)
            {
                return;
            }

            // Slow cadence when the panel is hidden so we don't pin a worker thread on a
            // dead bridge port forever; faster while visible so the LED feels live.
            _bridgePingNextAt = Time.unscaledTime + (_visible ? 2.0f : 6.0f);

            // Already known alive via the spawn check, or no bridge configured → skip the probe.
            if (TowerModSettings.IsSpawnedVoiceBridgeAlive
                || string.IsNullOrEmpty(TowerModSettings.BridgeExecutable))
            {
                return;
            }

            TowerVoiceBridgeControl.EnqueueSend(
                TowerModSettings.VoiceCtlHost,
                TowerModSettings.VoiceCtlPort,
                "PING",
                null);
        }

        // JsonUtility populates these via reflection — suppress CS0649 ("never assigned").
#pragma warning disable 0649
        [Serializable]
        private class LobbyRoomDto
        {
            public string roomId;
            public string roomName;
            public string frequencyMhz;
            public string status;
            public string callsign;
        }

        [Serializable]
        private class LobbyRoomsResponse
        {
            public bool ok;
            public LobbyRoomDto[] rooms;
        }

        [Serializable]
        private class AtisCurrentDto
        {
            public bool ok;
            public string letter;
            public string text;
            public string contentHash;
        }

#pragma warning restore 0649

        /// <summary>
        /// Periodically refreshes the frequency → room-name map from <c>GET /lobby/rooms</c>
        /// while the panel is open. The map drives the LCD subtitle so tuning to a frequency
        /// somebody else has booked shows their callsign instead of just "MANUAL". We only
        /// poll while the radio is visible — a hidden panel doesn't need fresh names and the
        /// map is only read by <see cref="DrawTuneDial"/>.
        /// </summary>
        private void HandleLobbyRoomsRefresh()
        {
            if (!_visible || _lobbyRoomsFetchBusy)
            {
                return;
            }

            if (Time.unscaledTime < _lobbyRoomsNextFetchAt)
            {
                return;
            }

            // Need an auth token (or skipTowerLogin). Without it /lobby/rooms returns 401 and
            // we'd just spam the log; skip and try again after the normal interval.
            if (!TowerModSettings.SkipTowerLogin && string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
            {
                _lobbyRoomsNextFetchAt = Time.unscaledTime + LobbyRoomsRefreshSecondsVisible;
                return;
            }

            _lobbyRoomsNextFetchAt = Time.unscaledTime + LobbyRoomsRefreshSecondsVisible;
            StartCoroutine(FetchLobbyRooms());
        }

        private IEnumerator FetchLobbyRooms()
        {
            _lobbyRoomsFetchBusy = true;
            var url = TowerModSettings.ApiBaseUrl + "/lobby/rooms";
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                _lobbyRoomsFetchBusy = false;

                if (req.isNetworkError || req.isHttpError)
                {
                    // Don't clobber the existing map on a transient blip — last-good wins
                    // until we get a real refresh. 401/403 just means the player isn't
                    // logged in yet; that's handled at the call site.
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(text))
                {
                    yield break;
                }

                LobbyRoomsResponse parsed = null;
                try
                {
                    parsed = JsonUtility.FromJson<LobbyRoomsResponse>(text);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[KSCTowerNetwork] /lobby/rooms parse failed: " + ex.Message);
                    yield break;
                }

                if (parsed == null || parsed.rooms == null)
                {
                    // Treat null as "no live rooms" — wipe the caches so a stale name doesn't
                    // linger forever after the room closed.
                    _freqToRoomName.Clear();
                    _sessionIdToRoom.Clear();
                    yield break;
                }

                var freshFreq = new Dictionary<string, string>(StringComparer.Ordinal);
                var freshSession = new Dictionary<string, LobbyRoomInfo>(StringComparer.Ordinal);
                for (var i = 0; i < parsed.rooms.Length; i++)
                {
                    var room = parsed.rooms[i];
                    if (room == null)
                    {
                        continue;
                    }

                    var name = string.IsNullOrEmpty(room.roomName) ? room.roomId : room.roomName;

                    if (!string.IsNullOrEmpty(room.frequencyMhz) && !string.IsNullOrEmpty(name))
                    {
                        // Backend already de-dupes "closed" sessions but be defensive: if two open
                        // rooms claim the same frequency the latest wins, matching how the lobby
                        // UI surfaces them. Last-write-wins is fine for a cosmetic readout.
                        freshFreq[room.frequencyMhz] = name;
                    }

                    if (!string.IsNullOrEmpty(room.roomId))
                    {
                        freshSession[room.roomId] = new LobbyRoomInfo
                        {
                            FrequencyMhz = room.frequencyMhz ?? string.Empty,
                            RoomName = string.IsNullOrEmpty(room.roomName) ? room.roomId : room.roomName,
                            Callsign = room.callsign ?? string.Empty
                        };
                    }
                }

                _freqToRoomName = freshFreq;
                _sessionIdToRoom = freshSession;

                var curSid = TowerModSettings.SessionId ?? string.Empty;
                LobbyRoomInfo curRoom;
                if (!string.IsNullOrEmpty(curSid) && freshSession.TryGetValue(curSid, out curRoom)
                    && !string.IsNullOrEmpty(curRoom.Callsign))
                {
                    TowerModSettings.SetSessionCallsign(curRoom.Callsign);
                }
            }
        }

        /// <summary>
        /// Resolves the committed tower MHz (lobby row beats slug-shaped session id; staged dial
        /// digits only when <see cref="_dialDirty"/>). Mirrors <see cref="DrawTuneDial"/> logic.
        /// </summary>
        private bool TryGetCommittedCanonicalMhz(out string canonMhz)
        {
            canonMhz = null;
            if (_atisLocalReceiveOnly && !_dialDirty)
            {
                canonMhz = AtisPresetMhz;
                return true;
            }

            var current = TowerModSettings.SessionId ?? string.Empty;
            LobbyRoomInfo activeRoom = default(LobbyRoomInfo);
            var haveLiveRoom = !_dialDirty
                && !string.IsNullOrEmpty(current)
                && _sessionIdToRoom.TryGetValue(current, out activeRoom);

            if (haveLiveRoom && !string.IsNullOrEmpty(activeRoom.FrequencyMhz))
            {
                var rawF = activeRoom.FrequencyMhz.Trim();
                if (Regex.IsMatch(rawF, FreqFormatRegex))
                {
                    canonMhz = SnapCanonicalFreqString(rawF);
                }
                else
                {
                    var extracted = ExtractFrequencyFromText(rawF);
                    canonMhz = string.IsNullOrEmpty(extracted) ? rawF : extracted;
                }

                return true;
            }

            if (!_dialDirty && !string.IsNullOrEmpty(current) && Regex.IsMatch(current, FreqFormatRegex))
            {
                canonMhz = SnapCanonicalFreqString(current);
                return true;
            }

            if (!_dialDirty)
            {
                var dialCanon = FormatDialDigits();
                if (Regex.IsMatch(dialCanon, FreqFormatRegex))
                {
                    canonMhz = SnapCanonicalFreqString(dialCanon);
                    return true;
                }
            }

            return false;
        }

        private void EnsureAtisLoopAudioSource()
        {
            if (_atisLoopSource != null)
            {
                return;
            }

            _atisLoopSource = gameObject.AddComponent<AudioSource>();
            _atisLoopSource.playOnAwake = false;
            // Never rely on loop for UWR WAV clips — we restart manually + random entry point.
            _atisLoopSource.loop = false;
            _atisLoopSource.spatialBlend = 0f;
            _atisLoopSource.volume = 0.42f;
            _atisLoopSource.priority = 100;
            _atisLoopSource.bypassListenerEffects = true;
            _atisLoopSource.ignoreListenerPause = true;
        }

        /// <summary>
        /// UWR WAV clips often ignore or mishandle <see cref="AudioSource.loop"/>. Drive repeats
        /// explicitly and start each pass at a random <see cref="AudioSource.time"/> so it does
        /// not always begin at word one (feels like catching the broadcast mid-cycle).
        /// </summary>
        private void TickAtisManualLoopPlayback()
        {
            if (_atisLoopBusy || _atisLoopSource == null || _atisLoopClip == null)
            {
                return;
            }

            if (string.IsNullOrEmpty(_atisLoopLastContentHash))
            {
                return;
            }

            var len = _atisLoopClip.length;
            if (len <= 0.05f)
            {
                return;
            }

            var sameClip = _atisLoopSource.clip == _atisLoopClip;
            var atOrPastEnd = sameClip && _atisLoopSource.time >= len - 0.08f;
            if (_atisLoopSource.isPlaying && !atOrPastEnd)
            {
                return;
            }

            RestartAtisClipWithRandomEntry(len);
        }

        private void RestartAtisClipWithRandomEntry(float clipLengthSeconds)
        {
            _atisLoopSource.Stop();
            _atisLoopSource.clip = _atisLoopClip;
            _atisLoopSource.loop = false;
            var slack = Mathf.Min(1.25f, Mathf.Max(0.2f, clipLengthSeconds * 0.12f));
            var hi = Mathf.Max(0f, clipLengthSeconds - slack);
            _atisLoopSource.time = hi <= 0.02f ? 0f : UnityEngine.Random.Range(0f, hi);
            _atisLoopSource.Play();
        }

        private void TeardownAtisLoopAudio()
        {
            if (_atisLoopSource != null && _atisLoopSource.isPlaying)
            {
                _atisLoopSource.Stop();
            }

            if (_atisLoopSource != null)
            {
                _atisLoopSource.clip = null;
            }

            if (_atisLoopClip != null)
            {
                Destroy(_atisLoopClip);
                _atisLoopClip = null;
            }
        }

        /// <summary>
        /// When tuned to ATIS MHz, poll JSON for <c>contentHash</c> then download WAV and loop locally
        /// (not mixed into <see cref="TowerVoicePlayback"/> bridge PCM).
        /// </summary>
        private void HandleAtisLoopAudio()
        {
            if (!HighLogic.LoadedSceneIsGame)
            {
                return;
            }

            TowerModSettings.EnsureLoaded();
            string canon;
            var tunedAtis = TryGetCommittedCanonicalMhz(out canon) && string.Equals(canon, AtisPresetMhz, StringComparison.Ordinal);
            var voice = TowerVoicePlayback.Instance;
            var listenPowered = voice != null && voice.WantsHelmetVoiceListen;
            var authSatisfied = TowerModSettings.SkipTowerLogin || !string.IsNullOrEmpty(TowerModSettings.TowerAuthToken);
            if (!TowerVoiceListenUiLogic.ShouldRunAtisLoop(listenPowered, tunedAtis, authSatisfied))
            {
                TeardownAtisLoopAudio();
                _atisLoopNextPollUnscaled = 0f;
                if (!tunedAtis)
                {
                    _atisLoopLastContentHash = "";
                }
                return;
            }

            EnsureAtisLoopAudioSource();

            if (_atisLoopBusy)
            {
                return;
            }

            TickAtisManualLoopPlayback();

            if (_atisLoopNextPollUnscaled > 0f && Time.unscaledTime < _atisLoopNextPollUnscaled)
            {
                return;
            }

            _atisLoopBusy = true;
            StartCoroutine(FetchAtisLoopWavCoroutine());
        }

        private IEnumerator FetchAtisLoopWavCoroutine()
        {
            try
            {
                var jsonUrl = TowerModSettings.ApiBaseUrl + "/atis/current";
                using (var j = UnityWebRequest.Get(jsonUrl))
                {
                    j.timeout = 15;
                    TowerApiAuth.ApplyBearer(j);
                    yield return j.SendWebRequest();

                    if (j.isNetworkError || j.isHttpError)
                    {
                        yield break;
                    }

                    var body = j.downloadHandler != null ? j.downloadHandler.text : string.Empty;
                    if (string.IsNullOrEmpty(body))
                    {
                        yield break;
                    }

                    AtisCurrentDto cur;
                    try
                    {
                        cur = JsonUtility.FromJson<AtisCurrentDto>(body);
                    }
                    catch (Exception ex)
                    {
                        Debug.LogWarning("[KSCTowerNetwork] ATIS loop JSON: " + ex.Message);
                        yield break;
                    }

                    if (cur == null || !cur.ok || string.IsNullOrEmpty(cur.contentHash))
                    {
                        yield break;
                    }

                    // Same broadcast: skip WAV re-download even if Unity stopped playback (manual loop handles restart).
                    if (cur.contentHash == _atisLoopLastContentHash && _atisLoopClip != null)
                    {
                        yield break;
                    }

                    var wavUrl = TowerModSettings.ApiBaseUrl + "/atis/current.wav";
                    using (var w = UnityWebRequestMultimedia.GetAudioClip(wavUrl, AudioType.WAV))
                    {
                        w.timeout = 120;
                        var wavDh = w.downloadHandler as DownloadHandlerAudioClip;
                        if (wavDh != null)
                        {
                            wavDh.streamAudio = false;
                        }

                        TowerApiAuth.ApplyBearer(w);
                        yield return w.SendWebRequest();

                        if (w.isNetworkError || w.isHttpError)
                        {
                            Debug.LogWarning("[KSCTowerNetwork] ATIS WAV HTTP " + w.responseCode + " " + w.error);
                            yield break;
                        }

                        var clip = DownloadHandlerAudioClip.GetContent(w);
                        if (clip == null || clip.length <= 0.01f)
                        {
                            Debug.LogWarning("[KSCTowerNetwork] ATIS WAV decode failed or empty clip.");
                            yield break;
                        }

                        var loadWait = 0;
                        while (clip.loadState == AudioDataLoadState.Loading && loadWait < 600)
                        {
                            loadWait++;
                            yield return null;
                        }

                        if (clip.loadState == AudioDataLoadState.Failed)
                        {
                            Debug.LogWarning("[KSCTowerNetwork] ATIS WAV clip failed to load.");
                            yield break;
                        }

                        TeardownAtisLoopAudio();
                        _atisLoopClip = clip;
                        _atisLoopSource.clip = _atisLoopClip;
                        _atisLoopLastContentHash = cur.contentHash;
                        RestartAtisClipWithRandomEntry(clip.length);
                    }
                }
            }
            finally
            {
                _atisLoopBusy = false;
                _atisLoopNextPollUnscaled = Time.unscaledTime + AtisLoopPollSeconds;
            }
        }

        private void HandleAtisPoll()
        {
            if (!_visible)
            {
                return;
            }

            string canon;
            var onAtis = TryGetCommittedCanonicalMhz(out canon) && string.Equals(canon, AtisPresetMhz, StringComparison.Ordinal);
            if (!onAtis)
            {
                if (_atisTunedIn)
                {
                    _atisTunedIn = false;
                    _atisLetter = "";
                    _atisBody = "";
                    _atisHint = "";
                    _atisErr = "";
                    _atisScroll = Vector2.zero;
                }

                return;
            }

            if (!_atisTunedIn)
            {
                _atisTunedIn = true;
                _atisNextFetchAt = 0f;
            }

            if (!TowerModSettings.SkipTowerLogin && string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
            {
                _atisHint = "Log in to the tower to load ATIS.";
                _atisErr = "";
                return;
            }

            _atisHint = "";

            if (_atisFetchBusy)
            {
                return;
            }

            if (Time.unscaledTime < _atisNextFetchAt)
            {
                return;
            }

            _atisNextFetchAt = Time.unscaledTime + AtisPollIntervalSeconds;
            StartCoroutine(FetchAtisCurrent());
        }

        private IEnumerator FetchAtisCurrent()
        {
            _atisFetchBusy = true;
            var url = TowerModSettings.ApiBaseUrl + "/atis/current";
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 12;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                _atisFetchBusy = false;

                if (req.isNetworkError)
                {
                    _atisErr = "ATIS: can't reach tower API.";
                    yield break;
                }

                if (req.isHttpError)
                {
                    if (req.responseCode == 401 || req.responseCode == 403)
                    {
                        _atisErr = "ATIS: sign in to the tower (launcher).";
                    }
                    else
                    {
                        _atisErr = "ATIS: HTTP " + req.responseCode + ".";
                    }

                    yield break;
                }

                var raw = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(raw))
                {
                    _atisErr = "ATIS: empty response.";
                    yield break;
                }

                AtisCurrentDto parsed = null;
                try
                {
                    parsed = JsonUtility.FromJson<AtisCurrentDto>(raw);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[KSCTowerNetwork] ATIS JSON parse failed: " + ex.Message);
                    _atisErr = "ATIS: parse error.";
                    yield break;
                }

                if (parsed == null || !parsed.ok)
                {
                    _atisErr = "ATIS: not available.";
                    yield break;
                }

                _atisErr = "";
                _atisLetter = string.IsNullOrEmpty(parsed.letter) ? "" : parsed.letter;
                _atisBody = string.IsNullOrEmpty(parsed.text) ? "" : parsed.text;
            }
        }

        private void DrawAtisReadout(Rect r)
        {
            GUI.DrawTexture(r, _texInset);
            var inner = new Rect(r.x + 5f, r.y + 3f, r.width - 10f, r.height - 6f);
            var hdr = new Rect(inner.x, inner.y, inner.width, 12f);
            GUI.Label(hdr, "INFORMATION (ATIS)", _smallStyle);

            var body = new Rect(inner.x, inner.y + 13f, inner.width, inner.height - 14f);
            string canon;
            var onAtis = TryGetCommittedCanonicalMhz(out canon) && string.Equals(canon, AtisPresetMhz, StringComparison.Ordinal);
            if (!onAtis)
            {
                GUI.Label(body,
                    "Quick-tune \u25C0 / \u25B6 to ATIS (" + AtisPresetMhz
                    + " MHz). ATIS is the automatic information service: a repeating broadcast of weather, winds, and other published field information.",
                    _atisReadoutStyle);
                return;
            }

            if (!TowerModSettings.SkipTowerLogin && string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
            {
                GUI.Label(body, _atisHint, _atisReadoutStyle);
                return;
            }

            if (_atisFetchBusy && string.IsNullOrEmpty(_atisBody))
            {
                GUI.Label(body, "Receiving ATIS\u2026", _atisReadoutStyle);
                return;
            }

            if (!string.IsNullOrEmpty(_atisErr))
            {
                GUI.Label(body, _atisErr, _atisReadoutStyle);
                return;
            }

            if (string.IsNullOrEmpty(_atisBody))
            {
                GUI.Label(body, "No ATIS text yet. Check tower API / auth.", _atisReadoutStyle);
                return;
            }

            var letterLine = "Information " + _atisLetter + ".";
            var letterH = _atisReadoutStyle.CalcHeight(new GUIContent(letterLine), body.width);
            letterH = Mathf.Max(letterH, 14f);
            var letterRect = new Rect(body.x, body.y, body.width, letterH);
            GUI.Label(letterRect, letterLine, _atisReadoutStyle);

            var scrollRect = new Rect(body.x, letterRect.yMax + 2f, body.width, body.yMax - letterRect.yMax - 2f);
            if (scrollRect.height < 8f)
            {
                return;
            }

            var textH = _atisReadoutStyle.CalcHeight(new GUIContent(_atisBody), scrollRect.width - 18f);
            textH = Mathf.Max(textH, scrollRect.height);
            _atisScroll = GUI.BeginScrollView(scrollRect, _atisScroll, new Rect(0f, 0f, scrollRect.width - 16f, textH));
            GUI.Label(new Rect(0f, 0f, scrollRect.width - 20f, textH), _atisBody, _atisReadoutStyle);
            GUI.EndScrollView();
        }

        private void HandlePttKey()
        {
            var key = TowerModSettings.PushToTalkKey;
            if (key == KeyCode.None)
            {
                if (_micKeyHeld)
                {
                    _micKeyHeld = false;
                    SyncPttHoldAfterSourceChange();
                }

                return;
            }

            var rawDown = Input.GetKey(key);
            if (_suppressPttKeyUntilRelease)
            {
                if (!rawDown)
                {
                    _suppressPttKeyUntilRelease = false;
                }
                else
                {
                    rawDown = false;
                }
            }

            if (rawDown == _micKeyHeld)
            {
                return;
            }

            _micKeyHeld = rawDown;
            SyncPttHoldAfterSourceChange();
        }

        private void OnApplicationQuit()
        {
            if (!_bridgeMicLive)
            {
                return;
            }

            // Release ducking before the TCP MIC_OFF so any in-flight Chatterer/ATC mute is restored
            // even if shutdown beats the bridge round trip.
            TowerPttBus.Publish(false, "ui");

            // Fire-and-forget: OnApplicationQuit must not stall the shutdown frame on TCP.
            TowerVoiceBridgeControl.EnqueueSend(
                TowerModSettings.VoiceCtlHost,
                TowerModSettings.VoiceCtlPort,
                "MIC_OFF",
                null);
        }

        private void OnGUI()
        {
            if (!_visible)
            {
                return;
            }

            EnsureTextures();
            EnsureStyles();

            // Clamp window inside screen so a resolution change doesn't strand it offscreen.
            var maxX = Mathf.Max(0f, Screen.width - PanelWidth);
            var maxY = Mathf.Max(0f, Screen.height - PanelHeight);
            _windowRect.x = Mathf.Clamp(_windowRect.x, 0f, maxX);
            _windowRect.y = Mathf.Clamp(_windowRect.y, 0f, maxY);

            _windowRect = TowerClickBlock.GUIWindow(_windowId, _windowRect, DrawWindow, GUIContent.none, _panelStyle);
        }

        /// <summary>
        /// Ctrl+V / Cmd+V stages clipboard into the dial (same as PASTE) — KSP has no text field
        /// for "paste into radio" otherwise.
        /// </summary>
        private void HandlePasteHotkey()
        {
            var ev = Event.current;
            if (ev == null || ev.type != EventType.KeyDown || ev.keyCode != KeyCode.V)
            {
                return;
            }

            if (!ev.control && !ev.command)
            {
                return;
            }

            ApplyClipboardToDial();
            ev.Use();
        }

        /// <summary>
        /// If a digit knob captured <see cref="GUIUtility.hotControl"/> but KSP/Unity never delivered
        /// <see cref="EventType.MouseUp"/> (focus steal, window edge, another mod), every control that
        /// respects hotControl — including preset arrows — stops responding. Clear our capture once
        /// the primary mouse button is up.
        /// </summary>
        private void SanitizeTuneKnobInputState()
        {
            var e = Event.current;
            if (e == null || e.type != EventType.Layout)
            {
                return;
            }

            if (Input.GetMouseButton(0))
            {
                return;
            }

            if (_tuneKnobCaptureControl == 0)
            {
                return;
            }

            if (GUIUtility.hotControl == _tuneKnobCaptureControl)
            {
                GUIUtility.hotControl = 0;
            }

            _tuneKnobCaptureControl = 0;
            _tuneKnobActiveDigit = -1;
            _tuneKnobNextRepeatUnscaled = -1f;
            _tuneKnobDragAccumX = 0f;
        }

        private void DrawWindow(int id)
        {
            SanitizeTuneKnobInputState();
            HandlePasteHotkey();
            UpdateLaunchAssistTakeoffDismiss();
            const float pad = 12f;
            var contentRect = new Rect(pad, pad, PanelWidth - pad * 2f, PanelHeight - pad * 2f);
            var av = FlightGlobals.ActiveVessel;
            var pilotYouLine = (TowerVesselCallsignStore.GetEffectivePilotCallsign(av) ?? string.Empty).Trim();
            var titleOuterH = pilotYouLine.Length > 0 ? 56f : 32f;
            DrawTitleBar(contentRect, titleOuterH, pilotYouLine);
            var below = new Rect(contentRect.x, contentRect.y + titleOuterH, contentRect.width, contentRect.height - titleOuterH);
            DrawLedRow(below);
            // LED + switches block is ~64px tall (lamps row + toggles row). The new GHOST
            // FLEET row sits directly under the toggles so it reads as part of the cockpit
            // panel rather than a separate utility, then the tuner cascades from there.
            var ghostRow = new Rect(below.x, below.y + 72f, below.width, 30f);
            DrawGhostRow(ghostRow);
            const float tuneDialRowH = 72f;
            var tuneRect = new Rect(below.x, ghostRow.yMax + 6f, below.width, tuneDialRowH);
            DrawTuneDial(tuneRect);
            var knobRect = new Rect(below.x, tuneRect.yMax + 4f, below.width, 34f);
            DrawTuneKnobs(knobRect, tuneRect);
            // Frequency clipboard row — COPY current dial + PASTE clipboard as freq. Sits
            // directly under the knobs so it reads as part of the tuner widget; mirrors the
            // copy/paste affordances added to ACARS and Notes so the same vocabulary works
            // across all three surfaces.
            var clipRect = new Rect(below.x, knobRect.yMax + 4f, below.width, 28f);
            DrawTuneClipboardRow(clipRect);
            var atisRect = new Rect(below.x, clipRect.yMax + 8f, below.width, AtisBlockHeight);
            DrawAtisReadout(atisRect);
            var rxRect = new Rect(below.x, atisRect.yMax + 8f, below.width, 28f);
            DrawVuMeter(rxRect, "RX  TOWER", GetRxRms(), ref _rxRmsSmooth, ref _rxPeakHold, ref _rxPeakHoldDecayAt);
            var txRect = new Rect(below.x, rxRect.yMax + 6f, below.width, 28f);
            DrawVuMeter(txRect, "TX  PILOT", GetTxRms(), ref _txRmsSmooth, ref _txPeakHold, ref _txPeakHoldDecayAt);
            var powerRect = new Rect(below.x, txRect.yMax + 14f, below.width, 44f);
            DrawPowerRow(powerRect);
            var pttRect = new Rect(below.x, powerRect.yMax + 10f, below.width, 60f);
            DrawPttBar(pttRect);
            var statusRect = new Rect(below.x, pttRect.yMax + 10f, below.width, 30f);
            DrawStatusFooter(statusRect);
            var clearanceRect = new Rect(below.x, statusRect.yMax + 2f, below.width, 20f);
            DrawClearanceRow(clearanceRect);
            var launchH = _launchAssistTakeoffDismissed ? 0f : 30f;
            var launchGap = _launchAssistTakeoffDismissed ? 0f : 6f;
            var launchRect = new Rect(below.x, clearanceRect.yMax + launchGap, below.width, launchH);
            if (launchH > 0f)
            {
                DrawLaunchRequestRow(launchRect);
            }

            var utilRect = new Rect(below.x, launchRect.yMax + 4f, below.width, 22f);
            DrawUtilityFooter(utilRect);

            // Title bar: six slab buttons on the right (ACR, RAD, TRF, CHK, NTS, close); keep
            // the drag handle clear of them (~6×42px + gaps).
            GUI.DragWindow(new Rect(0f, 0f, PanelWidth - 282f, titleOuterH));
            TowerImguiClickSink.UseUnhandledMouseInLocalWindow(new Rect(0f, 0f, PanelWidth, PanelHeight));
            DrawWindowTooltipIfNeeded();
        }

        private void DrawTitleBar(Rect content, float titleOuterH, string pilotYou)
        {
            // Title bar layout, right-to-left: close (X), notes (NTS), checklist (CHK),
            // traffic scope (TRF), dragon radar (RAD), ACARS (ACR). The settings/gear button is gone — beacon and hull-cam moved into
            // the LED row, manual tune is now the digital dial, and reconnect/log-out live
            // in the utility footer at the bottom of the panel. NTS opens the local
            // pilot-scratchpad (TowerNotesGui) — never sent to the backend, lives in
            // PluginData/notes.txt next to settings.cfg.
            const float btnW = 42f;
            const float gap = 4f;
            var rightEdge = content.xMax;

            var minRect = new Rect(rightEdge - btnW, content.y, btnW, 24f);
            rightEdge -= btnW + gap;
            var ntsRect = new Rect(rightEdge - btnW, content.y, btnW, 24f);
            rightEdge -= btnW + gap;
            var chkRect = new Rect(rightEdge - btnW, content.y, btnW, 24f);
            rightEdge -= btnW + gap;
            var trfRect = new Rect(rightEdge - btnW, content.y, btnW, 24f);
            rightEdge -= btnW + gap;
            var radRect = new Rect(rightEdge - btnW, content.y, btnW, 24f);
            rightEdge -= btnW + gap;
            var acrRect = new Rect(rightEdge - btnW, content.y, btnW, 24f);

            var titleW = acrRect.x - content.x - gap;
            var titleTextH = Mathf.Max(22f, titleOuterH - 8f);
            var titleRect = new Rect(content.x, content.y, titleW, titleTextH);
            var titleCs = (TowerModSettings.SessionCallsign ?? string.Empty).Trim();
            var sid = TowerModSettings.SessionId ?? string.Empty;
            // Server-owned channels (ksc-radio-twr, …) use a *facility* callsign (e.g. KSC-TWR)
            // from the backend — that is not the pilot's personal identity. "YOU" is the effective
            // pilot callsign (per-vessel override or account default; see TowerVesselCallsignStore).
            var serverRadioChannel = sid.StartsWith("ksc-radio-", StringComparison.OrdinalIgnoreCase);

            if (pilotYou.Length > 0)
            {
                const float line1H = 20f;
                const float stripGap = 5f;
                const float line2H = 22f;
                var line1 = new Rect(titleRect.x, titleRect.y, titleRect.width, line1H);
                var line2 = new Rect(titleRect.x, titleRect.y + line1H + stripGap, titleRect.width, line2H);
                if (serverRadioChannel)
                {
                    GUI.Label(line1, "TOWER  RADIO", _titleStyle);
                }
                else if (titleCs.Length > 0)
                {
                    GUI.Label(line1, "TWR  " + TruncateForLcd(titleCs, 26), _titleStyle);
                }
                else
                {
                    GUI.Label(line1, "TOWER  RADIO", _titleStyle);
                }

                var cs = TruncateForLcd(pilotYou, 34);
                GUI.Label(
                    line2,
                    "<color=#6e6a5c>CALLSIGN</color>  <b><color=#f0e6c8>" + EscapeForRichTextLabel(cs) + "</color></b>",
                    _pilotStripStyle);
            }
            else if (serverRadioChannel)
            {
                GUI.Label(titleRect, "TOWER  RADIO", _titleStyle);
            }
            else if (titleCs.Length > 0)
            {
                var titleText = "TWR  " + TruncateForLcd(titleCs, 26);
                GUI.Label(titleRect, titleText, _titleStyle);
            }
            else
            {
                GUI.Label(titleRect, "TOWER  RADIO", _titleStyle);
            }

            // ACR button doubles as the unread-message annunciator: when TowerAcarsGui has
            // told us there's incoming traffic we haven't read yet, the slab pulses red
            // (with a slow ~1Hz blink) until the player opens the ACARS panel.
            var acrActive = TowerAcarsGui.Instance != null && TowerAcarsGui.Instance.Visible;
            var acrAlert = _acrUnreadCount > 0 && !acrActive;
            DrawTopBarButton(
                acrRect,
                "ACR",
                acrActive,
                acrAlert,
                acrAlert ? _acrUnreadFlashAt : 0f,
                ToggleAcarsPanel,
                "ACARS — tower text datalink (incoming/outgoing messages). Opens the ACARS window; red blink means unread.");
            DrawTopBarButton(
                radRect,
                "RAD",
                TowerDragonRadarGui.Instance != null && TowerDragonRadarGui.Instance.Visible,
                false,
                0f,
                ToggleRadarPanel,
                "Dragon radar — scope-style room radar for Dragon Ball traffic. Opens or closes the radar window.");
            var trfActive = TowerTrafficRadarGui.Instance != null && TowerTrafficRadarGui.Instance.Visible;
            var trfAlert = _trfNearbyAlert > 0 && !trfActive;
            DrawTopBarButton(
                trfRect,
                "TRF",
                trfActive,
                trfAlert,
                trfAlert ? _trfNearbyFlashAt : 0f,
                ToggleTrafficRadarPanel,
                "Traffic scope — tower-style PPI of other pilots in this room (25 km). Red blink: new contact in range while this window is closed.");
            DrawTopBarButton(
                chkRect,
                "CHK",
                TowerChecklistGui.Instance != null && TowerChecklistGui.Instance.Visible,
                false,
                0f,
                ToggleChecklistPanel,
                "Checklists — tower-managed checklists and phases. Opens the checklist window.");
            DrawTopBarButton(
                ntsRect,
                "NTS",
                TowerNotesGui.Instance != null && TowerNotesGui.Instance.Visible,
                false,
                0f,
                ToggleNotesPanel,
                "Notes — local pilot scratchpad only (saved under PluginData; never sent to the tower).");
            DrawTopBarButton(
                minRect,
                "\u2715",
                false,
                false,
                0f,
                () =>
                {
                    Visible = false;
                    if (OnRequestMinimize != null)
                    {
                        OnRequestMinimize();
                    }
                },
                "Minimize — hides this panel. Voice bridge and session stay running; reopen from the toolbar.");

            var dividerRect = new Rect(content.x, content.y + titleOuterH - 2f, content.width, 2f);
            GUI.DrawTexture(dividerRect, _texDivider);
        }

        private void DrawTopBarButton(
            Rect r,
            string label,
            bool active,
            bool alert,
            float alertFlashUnscaled,
            Action onClick,
            string tooltip)
        {
            // Draw an inset background so the buttons read as physical keys instead of the
            // bare text labels they used to be (which is what the user called out as "meh").
            // Alert state (ACR unread, TRF contact): tint the slab red and slow-blink it so it grabs the eye
            // even when the player is scanning the LED row instead of the title bar. Blink
            // uses unscaled time so it pulses at the same rate during physics warp.
            Texture2D bg;
            if (alert)
            {
                var blink = Mathf.PingPong(Time.unscaledTime - alertFlashUnscaled, 0.5f) / 0.5f;
                bg = blink > 0.5f ? _texLedRed : _texAcrAlertDim;
            }
            else if (active)
            {
                bg = _texLcdBack;
            }
            else
            {
                bg = _texInset;
            }
            GUI.DrawTexture(r, bg);

            GUIStyle style;
            if (alert)
            {
                style = _topBarBtnAlertStyle;
            }
            else if (active)
            {
                style = _topBarBtnActiveStyle;
            }
            else
            {
                style = _topBarBtnStyle;
            }

            var tip = tooltip ?? string.Empty;
            var content = string.IsNullOrEmpty(tip) ? new GUIContent(label) : new GUIContent(label, tip);
            if (GUI.Button(r, content, style))
            {
                TowerSfx.PlayClick();
                if (onClick != null)
                {
                    onClick();
                }
            }
        }

        private static void ToggleAcarsPanel()
        {
            TowerAcarsGui.EnsureExists();
            var gui = TowerAcarsGui.Instance;
            if (gui == null)
            {
                return;
            }

            gui.Visible = !gui.Visible;
        }

        private static void ToggleChecklistPanel()
        {
            TowerChecklistGui.EnsureExists();
            var gui = TowerChecklistGui.Instance;
            if (gui == null)
            {
                return;
            }

            gui.Visible = !gui.Visible;
        }

        private static void ToggleRadarPanel()
        {
            TowerDragonRadarGui.EnsureExists();
            var gui = TowerDragonRadarGui.Instance;
            if (gui == null)
            {
                return;
            }

            gui.Visible = !gui.Visible;
        }

        private static void ToggleTrafficRadarPanel()
        {
            TowerTrafficRadarGui.EnsureExists();
            var gui = TowerTrafficRadarGui.Instance;
            if (gui == null)
            {
                return;
            }

            gui.Visible = !gui.Visible;
        }

        private static void ToggleNotesPanel()
        {
            TowerNotesGui.EnsureExists();
            var gui = TowerNotesGui.Instance;
            if (gui == null)
            {
                return;
            }

            gui.Visible = !gui.Visible;
        }

        private void DrawLedRow(Rect content)
        {
            // BRIDGE LED is now "process actually answers TCP", not "we ourselves spawned it".
            // Manual `npm start` runs (and the dev workflow more generally) used to leave this
            // LED dark forever; we now treat any reply within the last 7s as proof of life.
            var v = TowerVoicePlayback.Instance;
            var bridgeControlOk = TowerModSettings.IsSpawnedVoiceBridgeAlive
                                  || string.IsNullOrEmpty(TowerModSettings.BridgeExecutable)
                                  || TowerVoiceBridgeControl.RecentlyAlive(7.0);
            // If the player asked for helmet audio but the PCM path is dead (TCP drop, long
            // reconnect, tune failure where we stopped the stream), dim BRIDGE too — otherwise
            // control pings stay green while ON AIR is lying.
            var bridgeAlive = TowerVoiceListenUiLogic.BridgeLedLit(
                bridgeControlOk,
                v != null && v.IsConnectingOrConnected,
                v != null && v.WantsHelmetVoiceListen,
                v != null && v.IsListenUiOnAir);
            var streamLocked = v != null && v.HasStreamHeader;
            var micLive = _bridgeMicLive || _micUiHeld || _micKeyHeld;
            var beaconOn = TowerModSettings.BeaconActive;
            var hullCamOn = TowerModSettings.EnableHullCamRelay;
            var kosStreamOn = TowerModSettings.KosScreenStreamActive;
            var dsnState = ReadDsnState();

            // Two-row cockpit layout. Top row = four flush annunciator lamps that just *report*
            // (BRIDGE / AUDIO / MIC / DSN). Bottom row = two raised toggle switches the player
            // can press (BCN telemetry beacon, CAM HullCam relay). The split is the whole point:
            // before this, all six slots were rendered the same way and nothing about BCN/CAM
            // hinted that they were clickable — and "STREAM" wasn't obvious to anyone who hadn't
            // read the source. Renamed STREAM → AUDIO so the meaning ("downstream audio
            // received") is plain at a glance.
            const float lampH = 24f;
            const float swH = 32f;
            const float gap = 4f;
            var lampW = (content.width - gap * 3f) / 4f;
            var lampY = content.y;
            DrawIndicatorLamp(new Rect(content.x + (lampW + gap) * 0f, lampY, lampW, lampH),
                              "BRIDGE", bridgeAlive, _texLedGreen,
                              bridgeAlive
                                  ? "Voice-bridge control port is reachable and helmet PCM path is not stalled"
                                  : "Bridge control unreachable, or listen is on but no fresh PCM (see AUDIO)");
            DrawIndicatorLamp(new Rect(content.x + (lampW + gap) * 1f, lampY, lampW, lampH),
                              "AUDIO", streamLocked, _texLedAmber,
                              "Receiving downstream audio from the voice bridge");
            DrawIndicatorLamp(new Rect(content.x + (lampW + gap) * 2f, lampY, lampW, lampH),
                              "MIC", micLive, _texLedRed,
                              "Mic is hot — bridge is transmitting your voice");
            DrawDsnIndicatorLamp(new Rect(content.x + (lampW + gap) * 3f, lampY, lampW, lampH), dsnState);

            // Four-up toggle row: BCN (telemetry), CAM (hullcam), KOS (kOS screen mirror),
            // TWR (Stream-as-Tower). The KOS slot replaces the old opt-in script flow — kOS
            // screen output streams to the web Tower desk by default whenever kOS is installed,
            // and this switch is the player's one-click "stop streaming my CPU output" affordance.
            // The TWR slot flips this client into "broadcast my view as the tower window" mode:
            // hullcam re-targets a KSC-TOWER-* session id and the telemetry beacon is muted so
            // the player isn't both a ghost AND a tower view at the same time.
            var streamAsTowerOn = TowerModSettings.StreamAsTower;
            var swY = lampY + lampH + gap;
            var swW = (content.width - gap * 3f) / 4f;
            DrawToggleSwitch(new Rect(content.x, swY, swW, swH),
                             "BCN", "TLM BEACON", beaconOn, ToggleBeacon,
                             "Click to toggle telemetry beacon");
            DrawToggleSwitch(new Rect(content.x + (swW + gap) * 1f, swY, swW, swH),
                             "CAM", "HULL CAM", hullCamOn, ToggleHullCamRelay,
                             "Click to toggle HullCam snapshot relay");
            DrawToggleSwitch(new Rect(content.x + (swW + gap) * 2f, swY, swW, swH),
                             "KOS", "kOS SCREEN", kosStreamOn, ToggleKosScreenStream,
                             "Click to toggle kOS terminal mirror to web");
            DrawToggleSwitch(new Rect(content.x + (swW + gap) * 3f, swY, swW, swH),
                             "TWR", "STREAM AS TOWER", streamAsTowerOn, ToggleStreamAsTower,
                             "Stream this view as the tower window for other pilots; mutes telemetry beacon");
        }

        /// <summary>Tri-state for the DSN LED, derived from the active vessel's stock CommNet link.</summary>
        private enum DsnLedState
        {
            /// <summary>CommNet disabled in difficulty settings, no active vessel, or vessel has no Connection.</summary>
            Unavailable,
            /// <summary>Vessel currently has a path back to home (KSC).</summary>
            Linked,
            /// <summary>CommNet active but the link is down — i.e. comms blackout.</summary>
            Blackout
        }

        private static DsnLedState ReadDsnState()
        {
            if (!FlightGlobals.ready)
            {
                return DsnLedState.Unavailable;
            }

            var v = FlightGlobals.ActiveVessel;
            if (v == null || v.state == Vessel.State.DEAD)
            {
                return DsnLedState.Unavailable;
            }

            var conn = v.Connection;
            if (conn == null)
            {
                return DsnLedState.Unavailable;
            }

            return conn.IsConnected ? DsnLedState.Linked : DsnLedState.Blackout;
        }

        /// <summary>
        /// Stock-CommNet link indicator — annunciator-lamp variant of <see cref="DrawIndicatorLamp"/>
        /// that swaps colors based on link/blackout/unavailable. Not clickable.
        /// </summary>
        private void DrawDsnIndicatorLamp(Rect r, DsnLedState state)
        {
            Texture2D tex;
            string tip;
            switch (state)
            {
                case DsnLedState.Linked:
                    tex = _texLedGreen;
                    tip = "CommNet link to KSC is up";
                    break;
                case DsnLedState.Blackout:
                    tex = _texLedRed;
                    tip = "Comms blackout — CommNet path to KSC is broken";
                    break;
                default:
                    tex = _texLedDim;
                    tip = "CommNet unavailable in this save / no active vessel";
                    break;
            }

            DrawIndicatorLamp(r, "DSN", state == DsnLedState.Linked || state == DsnLedState.Blackout, tex, tip);
        }

        /// <summary>
        /// Avionics-style annunciator lamp: a recessed dark bezel with a colored LED dot and
        /// a label. Deliberately *not* clickable and has no hover affordance — these slots
        /// only report status, so they shouldn't look like the BCN/CAM toggle switches that
        /// sit underneath them.
        /// </summary>
        private void DrawIndicatorLamp(Rect r, string label, bool on, Texture2D onTex, string tooltip)
        {
            // Recessed bezel makes the lamp read as a status field, not a button.
            GUI.DrawTexture(r, _texLampBezel);

            const float ledSize = 10f;
            var ledRect = new Rect(r.x + 6f, r.y + (r.height - ledSize) * 0.5f, ledSize, ledSize);
            // Halo behind the LED when lit — looks like the bezel is glowing, not just a flat dot.
            if (on)
            {
                var halo = new Rect(ledRect.x - 2f, ledRect.y - 2f, ledSize + 4f, ledSize + 4f);
                GUI.DrawTexture(halo, onTex);
            }
            GUI.DrawTexture(ledRect, on ? onTex : _texLedDim);

            var labelRect = new Rect(ledRect.xMax + 5f, r.y, r.width - ledSize - 12f, r.height);
            GUI.Label(labelRect, new GUIContent(label, tooltip), _ledLabelStyle);
        }

        private void ToggleBeacon()
        {
            var next = !TowerModSettings.BeaconActive;
            TowerModSettings.SetBeaconActive(next);
            _statusLine = next ? "Beacon ON — broadcasting telemetry." : "Beacon OFF — telemetry suppressed.";
        }

        /// <summary>
        /// Cockpit-style toggle switch: a raised metallic-looking slab with a colored status
        /// LED, a long label ("TLM BEACON" / "HULL CAM"), and an explicit ON/OFF marker on the
        /// right edge. Hover and press states are visible so the player can tell it's a real
        /// button — that's the whole reason this exists separately from <see cref="DrawIndicatorLamp"/>.
        /// </summary>
        private void DrawToggleSwitch(Rect r, string shortLabel, string longLabel, bool on, Action toggle, string tooltip)
        {
            // Fold the descriptive long label ("HULL CAM" / "TLM BEACON") into the tooltip
            // since the slot is no longer wide enough to render it inline next to the short
            // marker — see the bodyRect comment below for why.
            if (!string.IsNullOrEmpty(longLabel))
            {
                tooltip = string.IsNullOrEmpty(tooltip) ? longLabel : longLabel + " — " + tooltip;
            }

            // Hover detection so the switch lights up under the mouse — normal annunciator
            // lamps above never do this, which is the visual cue that *this* slot is clickable.
            var e = Event.current;
            var hovered = e != null && r.Contains(e.mousePosition);

            Texture2D bg;
            if (on)
            {
                bg = hovered ? _texSwitchOnHover : _texSwitchOn;
            }
            else
            {
                bg = hovered ? _texSwitchOffHover : _texSwitchOff;
            }
            GUI.DrawTexture(r, bg);

            // Thin top highlight to fake a beveled, raised edge — this is what sells the
            // "physical switch" look at a glance, even with flat 2x2 textures.
            var bevel = new Rect(r.x, r.y, r.width, 1f);
            GUI.DrawTexture(bevel, on ? _texSwitchBevelOn : _texSwitchBevelOff);

            const float ledSize = 10f;
            var ledRect = new Rect(r.x + 8f, r.y + (r.height - ledSize) * 0.5f, ledSize, ledSize);
            if (on)
            {
                var halo = new Rect(ledRect.x - 2f, ledRect.y - 2f, ledSize + 4f, ledSize + 4f);
                GUI.DrawTexture(halo, _texLedAmber);
            }
            GUI.DrawTexture(ledRect, on ? _texLedAmber : _texLedDim);

            // ON/OFF state marker on the right — explicit toggle affordance. Lifted off the
            // baseline so it sits with the body label in the middle of the slot.
            const float stateW = 28f;
            var stateRect = new Rect(r.xMax - stateW - 6f, r.y, stateW, r.height);
            GUI.Label(stateRect, on ? "ON" : "OFF", on ? _switchStateOnStyle : _switchStateOffStyle);

            // Short marker (BCN/CAM/KOS) fills the body of the slot between the LED and the
            // ON/OFF state marker. The previous layout tried to render a separate long label
            // ("HULL CAM" / "kOS SCREEN") in a tiny gap, which collapsed to ~3px wide once we
            // went from a 2-up to a 3-up switch row — Unity's IMGUI then wrapped the letters
            // vertically (the "L / L" stack the user spotted). The short marker is unambiguous
            // on its own and the tooltip carries the long form for new players.
            var bodyRect = new Rect(ledRect.xMax + 6f, r.y, stateRect.x - ledRect.xMax - 10f, r.height);
            GUI.Label(bodyRect, shortLabel, _switchLabelStyle);

            // Whole slot is the click target. GUIContent carries the tooltip.
            if (GUI.Button(r, new GUIContent(string.Empty, tooltip), GUIStyle.none))
            {
                TowerSfx.PlayToggle();
                toggle();
            }
        }

        private void ToggleHullCamRelay()
        {
            var next = !TowerModSettings.EnableHullCamRelay;
            TowerModSettings.SetHullCamRelayEnabled(next);
            _statusLine = next ? "HullCam relay ON (1 fps)." : "HullCam relay OFF.";
        }

        private void ToggleKosScreenStream()
        {
            var next = !TowerModSettings.KosScreenStreamActive;
            TowerModSettings.SetKosScreenStreamActive(next);
            _statusLine = next
                ? "kOS screen ON — terminal output mirroring to web."
                : "kOS screen OFF — terminal output stays local.";
        }

        /// <summary>
        /// Flip Stream-as-Tower mode. When turning ON we also force the telemetry beacon OFF so
        /// the player isn't broadcasting both a hullcam tower view AND a telemetry ghost (the
        /// backend rejects telemetry under KSC-TOWER-* anyway, but this keeps the ghost-fleet
        /// poll quiet for the rest of the lobby and matches what controllers expect: "the tower
        /// view is one of the players, you can't see them on the map at the same time").
        /// </summary>
        private void ToggleStreamAsTower()
        {
            var next = !TowerModSettings.StreamAsTower;
            TowerModSettings.SetStreamAsTower(next);
            if (next)
            {
                if (TowerModSettings.BeaconActive)
                {
                    TowerModSettings.SetBeaconActive(false);
                }
                if (!TowerModSettings.EnableHullCamRelay)
                {
                    TowerModSettings.SetHullCamRelayEnabled(true);
                }
                _statusLine = "Streaming as Tower — telemetry beacon muted, hullcam re-targeted.";
            }
            else
            {
                _statusLine = "Stream as Tower OFF.";
            }
        }

        /// <summary>
        /// Ghost-fleet row: a single horizontal strip with the GHO toggle (opt out of seeing /
        /// being seen by other pilots) on the left and the MY GHOST cycler on the right (which
        /// stock craft other players see this pilot as). Both controls write to
        /// <see cref="TowerModSettings"/> immediately and persist via auth.cfg.
        ///
        /// The two are paired here intentionally: a player who turns off the ghost fleet
        /// rarely cares about their craft selection, and a player tweaking their selection is
        /// the one who's most likely to want to verify the toggle is on. Putting them side by
        /// side avoids hunting across the panel.
        /// </summary>
        private void DrawGhostRow(Rect r)
        {
            const float gap = 4f;
            // ~38% width for the toggle (it's a fixed two-state widget); the cycler gets the
            // remaining ~62% because the craft labels ("STEARWING A300") need horizontal room.
            float toggleW = (r.width - gap) * 0.38f;
            float cyclerW = r.width - toggleW - gap;

            var toggleRect = new Rect(r.x, r.y, toggleW, r.height);
            var cyclerRect = new Rect(toggleRect.xMax + gap, r.y, cyclerW, r.height);

            // Toggle uses the same DrawToggleSwitch widget as the LED row above so the visual
            // language is consistent ("this is a cockpit switch you can flip").
            DrawToggleSwitch(toggleRect,
                             "GHO", "GHOST FLEET",
                             TowerModSettings.EnableGhostFleet,
                             ToggleGhostFleet,
                             "Show other pilots as ghost aircraft (and let them see you). Off = solo flying.");

            // Cycler is a flat utility-style button: pressing it advances to the next entry in
            // the roster and shows the new label. Disabled-looking when the fleet is off (the
            // selection still matters because telemetry still carries it, but visually it
            // hints "this won't change anything you can see right now").
            GUI.DrawTexture(cyclerRect, _texInset);
            var entry = ResolveActiveGhostEntry();
            var label = "MY GHOST:  " + entry.Label + "  \u25B6";
            if (GUI.Button(cyclerRect, new GUIContent(label, "Cycle which stock craft other pilots see you as"), _utilityBtnStyle))
            {
                TowerSfx.PlayClick();
                CycleGhostCraft();
            }
        }

        private static TowerGhostRoster.Entry ResolveActiveGhostEntry()
        {
            var key = TowerModSettings.GhostCraftKey;
            var idx = TowerGhostRoster.IndexOf(key);
            return TowerGhostRoster.All[idx];
        }

        private void ToggleGhostFleet()
        {
            var next = !TowerModSettings.EnableGhostFleet;
            TowerModSettings.SetGhostFleetEnabled(next);
            // Bidirectional: the local poll halts AND the next telemetry POST flips
            // ghostOptOut=true, which the backend honors by stripping us from the
            // /v1/tower/active-aircraft feed other clients render from. Up to ~2 s of
            // grace before the ghost vanishes from peers (one telemetry tick).
            _statusLine = next
                ? "Ghost fleet ON — other pilots visible, you appear in their view."
                : "Ghost fleet OFF — solo flight, hidden from other pilots' views.";
        }

        private void CycleGhostCraft()
        {
            var current = TowerModSettings.GhostCraftKey;
            var nextEntry = TowerGhostRoster.Next(current);
            TowerModSettings.SetGhostCraftKey(nextEntry.Key);
            _statusLine = "Ghost livery: " + nextEntry.Label.Trim() + ".";
        }

        /// <summary>
        /// Shared ◀ / LCD / ▶ geometry for <see cref="DrawTuneDial"/> and <see cref="DrawTuneKnobs"/> so MHz digits and knobs share columns.
        /// </summary>
        private static void ComputeTuneDialLayout(Rect tuneRowRect, out Rect inner, out Rect leftArrow, out Rect lcdRect, out Rect rightArrow)
        {
            inner = new Rect(tuneRowRect.x + 6f, tuneRowRect.y + 6f, tuneRowRect.width - 12f, tuneRowRect.height - 12f);
            var fullH = inner.height - 8f;
            var rowTop = inner.y + 4f;
            var tuneBtnSize = Mathf.Min(QuickTuneArrowW, fullH - 4f);
            // Center ◀ / ▶ on the main digit band only — the subtitle strip below made the arrows sit low vs the MHz readout.
            var digitBandH = Mathf.Max(fullH - TuneDialSubBarH, tuneBtnSize);
            var digitBandMidY = rowTop + digitBandH * 0.5f;
            leftArrow = new Rect(inner.x + 4f, digitBandMidY - tuneBtnSize * 0.5f, tuneBtnSize, tuneBtnSize);
            lcdRect = new Rect(
                leftArrow.xMax + QuickTuneArrowGap,
                rowTop,
                inner.width - 8f - tuneBtnSize * 2f - QuickTuneArrowGap * 2f,
                fullH);
            rightArrow = new Rect(lcdRect.xMax + QuickTuneArrowGap, digitBandMidY - tuneBtnSize * 0.5f, tuneBtnSize, tuneBtnSize);
        }

        /// <summary>Horizontal width of one digit column in the NNN.NNN strip (decimal column uses <see cref="TuneDialDecimalColWeight"/> × this).</summary>
        private static float TuneDialDigitUnit(float lcdWidth)
        {
            return lcdWidth / (6f + TuneDialDecimalColWeight);
        }

        private static float TuneDialColumnX(float lcdLeft, float lcdWidth, int colIndex)
        {
            var u = TuneDialDigitUnit(lcdWidth);
            var decW = u * TuneDialDecimalColWeight;
            if (colIndex <= 2)
            {
                return lcdLeft + colIndex * u;
            }

            if (colIndex == 3)
            {
                return lcdLeft + 3f * u;
            }

            return lcdLeft + 3f * u + decW + (colIndex - 4) * u;
        }

        private static float TuneDialColumnWidth(float lcdWidth, int colIndex)
        {
            if (colIndex == 3)
            {
                return TuneDialDigitUnit(lcdWidth) * TuneDialDecimalColWeight;
            }

            return TuneDialDigitUnit(lcdWidth);
        }

        private static Rect ComputeTuneDialLcdRect(Rect tuneRowRect)
        {
            Rect inner, leftArrow, lcdRect, rightArrow;
            ComputeTuneDialLayout(tuneRowRect, out inner, out leftArrow, out lcdRect, out rightArrow);
            return lcdRect;
        }

        /// <summary>
        /// Digital frequency LCD — real-radio-style "121.500" readout; slug/UUID session ids resolve
        /// to server frequency via lobby cache when possible. ◀ / ▶ step fixed quick presets
        /// (<see cref="QuickPresets"/>); knobs below stage digits; SET commits staged input.
        /// </summary>
        private void DrawTuneDial(Rect r)
        {
            GUI.DrawTexture(r, _texInset);
            Rect inner, leftArrow, lcdRect, rightArrow;
            ComputeTuneDialLayout(r, out inner, out leftArrow, out lcdRect, out rightArrow);

            GUI.DrawTexture(leftArrow, _texInset);
            GUI.DrawTexture(lcdRect, _texLcdBack);
            GUI.DrawTexture(rightArrow, _texInset);

            var ev = Event.current;
            if (ev != null && ev.type == EventType.Repaint)
            {
                GUI.DrawTexture(leftArrow, _texKnobBezel);
                GUI.DrawTexture(rightArrow, _texKnobBezel);
            }

            if (GUI.Button(
                    leftArrow,
                    new GUIContent(
                        string.Empty,
                        "Previous quick preset — cycles TWR \u2192 GND \u2192 ATIS \u2192 EMRG (fixed COM channels from the server preset list)."),
                    _arrowHitStyle))
            {
                StepQuickPreset(-1);
            }
            if (GUI.Button(
                    rightArrow,
                    new GUIContent(
                        string.Empty,
                        "Next quick preset — cycles TWR \u2192 GND \u2192 ATIS \u2192 EMRG (fixed COM channels from the server preset list)."),
                    _arrowHitStyle))
            {
                StepQuickPreset(1);
            }
            if (ev != null && ev.type == EventType.Repaint)
            {
                DrawPresetArrowInCircle(leftArrow, false);
                DrawPresetArrowInCircle(rightArrow, true);
            }

            var current = TowerModSettings.SessionId ?? string.Empty;
            var atisOverlay = _atisLocalReceiveOnly && !_dialDirty;

            // Big amber MHz readout: same trimmed-fractional LCD rules as the live channel. While a knob edit is
            // pending, format staged digits without 25 kHz snap so the readout matches the knobs until SET.
            //
            // Slug-shaped session ids (e.g. "fooney-ec0d", "kspstock-a4f9" — what the backend
            // mints in /v1/session/call) don't parse as digits, so without help we'd render the
            // placeholder em-dashes "———.———" and the player would have no idea what frequency
            // they're actually on. The lobby cache resolves the slug → server-assigned
            // `frequencyMhz` (deterministic via defaultFrequencyMhz) so we can show real digits.
            string freq;
            // Pre-initialize to default(): C# 5's definite-assignment analysis can't tell
            // that the short-circuited `&& TryGetValue(out activeRoom)` definitely assigns
            // when `haveLiveRoom` is true (the `&&` may skip the call), so reading
            // activeRoom.FrequencyMhz / .RoomName below would otherwise be CS0170. The
            // `if (!haveLiveRoom)` reset is now redundant for correctness but kept for
            // intent-readability.
            LobbyRoomInfo activeRoom = default(LobbyRoomInfo);
            bool haveLiveRoom = !atisOverlay
                && !_dialDirty
                && !string.IsNullOrEmpty(current)
                && _sessionIdToRoom.TryGetValue(current, out activeRoom);
            if (!haveLiveRoom)
            {
                activeRoom = default(LobbyRoomInfo);
            }

            if (_dialDirty)
            {
                var staged = FormatDialDigits();
                freq = Regex.IsMatch(staged, FreqFormatRegex)
                    ? FormatCanonicalMhzForAviationLcdSeven(staged, false)
                    : staged;
            }
            else if (atisOverlay)
            {
                freq = FreqOrLobbyStringToAviationLcdSeven(AtisPresetMhz);
            }
            else if (haveLiveRoom && !string.IsNullOrEmpty(activeRoom.FrequencyMhz))
            {
                freq = FreqOrLobbyStringToAviationLcdSeven(activeRoom.FrequencyMhz);
            }
            else
            {
                freq = SessionIdToFreqDisplay(current);
                // Slug session id + lobby cache miss (e.g. right after claim-pilot, before the
                // next /lobby/rooms poll): the dial still holds the human channel — show it on
                // the big readout instead of "---.---" until the server row lands.
                if (freq == LcdFreqPlaceholder)
                {
                    var dialStr = FormatDialDigits();
                    if (Regex.IsMatch(dialStr, FreqFormatRegex))
                    {
                        freq = FormatCanonicalMhzForAviationLcdSeven(SnapCanonicalFreqString(dialStr));
                    }
                }
            }

            string canonMhz = null;
            if (!_dialDirty)
            {
                if (atisOverlay)
                {
                    canonMhz = AtisPresetMhz;
                }
                else if (haveLiveRoom && !string.IsNullOrEmpty(activeRoom.FrequencyMhz))
                {
                    var rawC = activeRoom.FrequencyMhz.Trim();
                    if (Regex.IsMatch(rawC, FreqFormatRegex))
                    {
                        canonMhz = SnapCanonicalFreqString(rawC);
                    }
                    else
                    {
                        var extractedC = ExtractFrequencyFromText(rawC);
                        canonMhz = string.IsNullOrEmpty(extractedC) ? rawC : extractedC;
                    }
                }
                else if (!string.IsNullOrEmpty(current) && Regex.IsMatch(current, FreqFormatRegex))
                {
                    canonMhz = current;
                }
                else
                {
                    var dialCanon = FormatDialDigits();
                    if (Regex.IsMatch(dialCanon, FreqFormatRegex))
                    {
                        canonMhz = dialCanon;
                    }
                }

                if (!string.IsNullOrEmpty(canonMhz) && Regex.IsMatch(canonMhz, FreqFormatRegex))
                {
                    canonMhz = SnapCanonicalFreqString(canonMhz);
                }

                if (!string.IsNullOrEmpty(canonMhz))
                {
                    for (var qi = 0; qi < QuickPresets.Length; qi++)
                    {
                        if (string.Equals(QuickPresets[qi].FrequencyMhz, canonMhz, StringComparison.Ordinal))
                        {
                            _presetArrowIndex = qi;
                            break;
                        }
                    }
                }
            }

            _lastTuneDialLcdSeven = freq ?? LcdFreqPlaceholder;

            // Reserve a strip under the MHz readout for preset/room/STAGED text. Use the full
            // strip height for GUI.Label — a former fixed 12px-tall rect clipped 10pt captions
            // (e.g. "EMRG") against the LCD bottom edge on some skins/DPI.
            const float subBarH = TuneDialSubBarH;
            var lcdMain = new Rect(lcdRect.x, lcdRect.y, lcdRect.width, lcdRect.height - subBarH);
            DrawFrequencyLcdMainDigits(lcdMain, freq);

            // Subtitle: channel name when committed, "STAGED" + inline SET while digits differ from live channel,
            // OR the actual room/callsign so the player can see whose frequency they just
            // dialed into (e.g. "118.300" → "JEB-LIFTOFF-LOX"; "fooney-ec0d" → "FOONEY-FOO
            // Tower") instead of just "MANUAL". Live-room lookup wins over the preset position
            // because the room name is more useful. Two lookups: by frequency (covers manually
            // dialed freq numbers that match a live room) and by session id (covers the
            // currently-active slug-shaped channel which is otherwise opaque).
            var subY = lcdRect.yMax - subBarH;
            string sub;
            string liveName;
            string qpLabel;
            if (_dialDirty)
            {
                const float setBtnW = 44f;
                var subLabelW = lcdRect.width - setBtnW - 4f;
                GUI.Label(new Rect(lcdRect.x, subY, subLabelW, subBarH), "STAGED", _smallStyle);
                var setBtnRect = new Rect(lcdRect.x + subLabelW + 4f, subY + 1f, setBtnW, subBarH - 2f);
                GUI.DrawTexture(setBtnRect, _texInset);
                if (GUI.Button(
                        setBtnRect,
                        new GUIContent(
                            "SET",
                            "Commit staged MHz digits as the active tune (same as [ SET ] under the knobs). Applies 25 kHz COM grid and joins the channel."),
                        _utilityBtnStyle))
                {
                    TowerSfx.PlayClick();
                    CommitDialFrequency();
                }
            }
            else if (atisOverlay)
            {
                sub = "ATIS";
                GUI.Label(new Rect(lcdRect.x, subY, lcdRect.width, subBarH), sub, _smallStyle);
            }
            else
            {
                var dispCs = (TowerModSettings.SessionCallsign ?? string.Empty).Trim();
                if (string.IsNullOrEmpty(dispCs) && haveLiveRoom)
                {
                    dispCs = (activeRoom.Callsign ?? string.Empty).Trim();
                }

                if (!string.IsNullOrEmpty(dispCs))
                {
                    var staChannel = !string.IsNullOrEmpty(current)
                        && current.StartsWith("ksc-radio-", StringComparison.OrdinalIgnoreCase);
                    sub = TruncateForLcd(staChannel ? ("STA " + dispCs) : dispCs, 22);
                    GUI.Label(new Rect(lcdRect.x, subY, lcdRect.width, subBarH), sub, _smallStyle);
                }
                else if (haveLiveRoom && !string.IsNullOrEmpty(activeRoom.RoomName))
                {
                    sub = TruncateForLcd(activeRoom.RoomName, 22);
                    GUI.Label(new Rect(lcdRect.x, subY, lcdRect.width, subBarH), sub, _smallStyle);
                }
                else if (!string.IsNullOrEmpty(current) && _freqToRoomName.TryGetValue(current, out liveName))
                {
                    sub = TruncateForLcd(liveName, 22);
                    GUI.Label(new Rect(lcdRect.x, subY, lcdRect.width, subBarH), sub, _smallStyle);
                }
                else if (!string.IsNullOrEmpty(canonMhz) && TryQuickPresetLabel(canonMhz, out qpLabel))
                {
                    sub = qpLabel;
                    GUI.Label(new Rect(lcdRect.x, subY, lcdRect.width, subBarH), sub, _smallStyle);
                }
                else if (!string.IsNullOrEmpty(canonMhz))
                {
                    // Known MHz from dial (or session id) but not a named quick preset — show the
                    // channel explicitly instead of the opaque "MANUAL" label.
                    sub = Regex.IsMatch(canonMhz, FreqFormatRegex)
                        ? TruncateForLcd(FormatCanonicalMhzHumanNoTrailingZeros(canonMhz) + " MHz", 22)
                        : TruncateForLcd(canonMhz + " MHz", 22);
                    GUI.Label(new Rect(lcdRect.x, subY, lcdRect.width, subBarH), sub, _smallStyle);
                }
                else
                {
                    sub = "MANUAL";
                    GUI.Label(new Rect(lcdRect.x, subY, lcdRect.width, subBarH), sub, _smallStyle);
                }
            }
        }

        /// <summary>
        /// Renders <c>NNN.DDD</c> (blank third fractional cell allowed) or <see cref="LcdFreqPlaceholder"/> as procedurally drawn 7-segment glyphs
        /// in seven columns (narrow decimal) so glyphs line up with the tuning knobs. The decimal column is
        /// drawn as a dot in the lower-right of its cell instead of as a segment mask.
        /// </summary>
        private void DrawFrequencyLcdMainDigits(Rect lcdMain, string freq)
        {
            if (Event.current == null || Event.current.type != EventType.Repaint)
            {
                return;
            }

            if (string.IsNullOrEmpty(freq) || freq.Length != 7)
            {
                GUI.Label(lcdMain, freq ?? string.Empty, _channelDigitCellStyle);
                return;
            }

            const int cols = 7;
            for (var i = 0; i < cols; i++)
            {
                var colX = TuneDialColumnX(lcdMain.x, lcdMain.width, i);
                var colW = TuneDialColumnWidth(lcdMain.width, i);
                var cell = new Rect(colX, lcdMain.y, colW, lcdMain.height);
                var ch = freq[i];
                if (ch == ' ')
                {
                    // MHz path uses a blank third fractional cell when trailing zeros are trimmed (25 kHz style).
                    continue;
                }

                if (ch == '.')
                {
                    DrawSevenSegmentDot(cell, SegmentOnColor);
                }
                else
                {
                    DrawSevenSegmentDigit(cell, ch, SegmentOnColor, SegmentOffColor);
                }
            }
        }

        private static bool TryQuickPresetLabel(string canonicalMhz, out string label)
        {
            if (string.IsNullOrEmpty(canonicalMhz))
            {
                label = null;
                return false;
            }

            for (var i = 0; i < QuickPresets.Length; i++)
            {
                if (string.Equals(QuickPresets[i].FrequencyMhz, canonicalMhz, StringComparison.Ordinal))
                {
                    label = QuickPresets[i].Label;
                    return true;
                }
            }

            label = null;
            return false;
        }

        /// <summary>
        /// Cycles <see cref="QuickPresets"/> and tunes immediately to the picked preset.
        /// Used to only stage the digits and require a SET press, but in practice players
        /// (especially during a busy traffic pattern) hit the arrows expecting the channel
        /// to actually change — and ended up wondering why the lobby still showed the old
        /// room. The dial digits are still updated for visual feedback so the LCD shows
        /// what was tuned even before the server round-trip completes.
        /// </summary>
        private void StepQuickPreset(int delta)
        {
            var n = QuickPresets.Length;
            if (n == 0)
            {
                return;
            }

            _presetArrowIndex = ((_presetArrowIndex + delta) % n + n) % n;
            var p = QuickPresets[_presetArrowIndex];
            TowerSfx.PlayClick();

            if (!TryParseFreqDigits(p.FrequencyMhz, _dialDigits))
            {
                _statusLine = "Preset " + p.Label + " has invalid frequency.";
                return;
            }

            _dialDirty = false;
            TuneToTypedFrequency(p.FrequencyMhz, p.Label);
        }

        /// <summary>Escape user-supplied text for Unity IMGUI <c>richText</c> labels.</summary>
        private static string EscapeForRichTextLabel(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }

            return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        }

        /// <summary>
        /// Trim a room/callsign label to fit the LCD subtitle line. The IMGUI label clips
        /// silently when it overflows, which produces "JEB-LIFTOFF-LOX-D…" with no ellipsis;
        /// we add the ellipsis ourselves so the player can tell the name is truncated.
        /// </summary>
        private static string TruncateForLcd(string s, int max)
        {
            if (string.IsNullOrEmpty(s) || s.Length <= max)
            {
                return s ?? string.Empty;
            }

            return s.Substring(0, Mathf.Max(1, max - 1)) + "\u2026";
        }

        /// <summary>
        /// Knob row for manual tuning — six rotary dials under each digit of the LCD
        /// (left half = down, right = up; drag horizontally to scrub; hold to repeat),
        /// plus a CLR (clear/cancel) button. Changes stage until SET.
        /// </summary>
        /// <param name="r">Full-width knob row rect (same width as <paramref name="tuneDialRowRect"/>).</param>
        /// <param name="tuneDialRowRect">Tune dial row above — drives LCD horizontal bounds so knobs align with MHz columns.</param>
        private void DrawTuneKnobs(Rect r, Rect tuneDialRowRect)
        {
            GUI.DrawTexture(r, _texInset);
            var inner = new Rect(r.x + 6f, r.y, r.width - 12f, r.height);
            var lcdRect = ComputeTuneDialLcdRect(tuneDialRowRect);

            const float clrW = 40f;
            const float gapAfterLcd = 6f;
            var clrX = lcdRect.xMax + gapAfterLcd;
            if (clrX + clrW > inner.xMax - 2f)
            {
                clrX = inner.xMax - clrW - 2f;
            }

            var clrRect = new Rect(clrX, r.y + 4f, clrW, r.height - 8f);

            var evStrip = Event.current;
            if (evStrip != null && evStrip.type == EventType.Repaint)
            {
                var stripLeft = lcdRect.x - 3f;
                var stripRight = clrRect.x - 3f;
                if (stripRight > stripLeft + 4f)
                {
                    var stripRect = new Rect(stripLeft, r.y + 2f, stripRight - stripLeft, r.height - 4f);
                    GUI.DrawTexture(stripRect, _texKnobWell);
                }
            }

            // Six glyph columns + narrow decimal gap — same horizontal layout as <see cref="DrawFrequencyLcdMainDigits"/>.
            const int totalCols = 7;
            var lcdLeft = lcdRect.x;
            var lcdWidth = lcdRect.width;
            var digitU = TuneDialDigitUnit(lcdWidth);
            var knobSize = Mathf.Min(r.height - 4f, Mathf.Min(digitU - 2f, 30f));
            var knobY = r.y + (r.height - knobSize) * 0.5f;

            var lcdSeven = _lastTuneDialLcdSeven ?? LcdFreqPlaceholder;
            var showMhzKnob = lcdSeven.Length != 7 || lcdSeven[6] != ' ';

            for (var i = 0; i < totalCols; i++)
            {
                if (i == 3)
                {
                    continue;
                }

                if (i == 6 && !showMhzKnob)
                {
                    continue;
                }

                var colX = TuneDialColumnX(lcdLeft, lcdWidth, i);
                var colW = TuneDialColumnWidth(lcdWidth, i);
                var digitIdx = i < 3 ? i : i - 1;
                var knobX = colX + (colW - knobSize) * 0.5f;
                var knobRect = new Rect(knobX, knobY, knobSize, knobSize);
                DrawDigitTuneKnob(knobRect, digitIdx);
            }

            // CLR — abandons an in-progress dial edit and snaps digits to the active session.
            GUI.enabled = _dialDirty;
            if (GUI.Button(
                    clrRect,
                    new GUIContent(
                        "CLR",
                        "Clear staged dial — snaps digit knobs back to the currently active session / frequency and exits STAGED mode (only while editing)."),
                    _iconBtnStyle))
            {
                TowerSfx.PlayClick();
                SyncDialDigitsFromActiveSession();
                _dialDirty = false;
                _statusLine = "Dial cleared.";
            }
            GUI.enabled = true;
        }

        /// <summary>
        /// Single digit control: circular dial — left semicircle / left drag decreases, right increases;
        /// hold to repeat; horizontal drag scrubs. Uses <see cref="GUIUtility.hotControl"/> so drags
        /// track outside the dial until mouse-up.
        /// </summary>
        private void DrawDigitTuneKnob(Rect r, int digitIdx)
        {
            const float pxPerDragStep = 7f;
            const float holdRepeatInitialSec = 0.34f;
            const float holdRepeatIntervalSec = 0.085f;
            const float repeatPauseAfterDragSec = 0.22f;

            var id = GUIUtility.GetControlID(("KSCTNTuneKnob".GetHashCode() ^ (digitIdx + 1) * 7919), FocusType.Passive);

            var cx = r.x + r.width * 0.5f;
            var cy = r.y + r.height * 0.5f;
            var dialR = Mathf.Min(r.width, r.height) * 0.5f - 1f;

            var e = Event.current;
            var m = e.mousePosition;

            switch (e.type)
            {
                case EventType.MouseDown:
                    if (e.button != 0 || GUIUtility.hotControl != 0)
                    {
                        break;
                    }

                    var ddx = m.x - cx;
                    var ddy = m.y - cy;
                    if (ddx * ddx + ddy * ddy > dialR * dialR)
                    {
                        break;
                    }

                    GUIUtility.hotControl = id;
                    _tuneKnobCaptureControl = id;
                    _tuneKnobActiveDigit = digitIdx;
                    _tuneKnobDragAccumX = 0f;
                    _tuneKnobLastPointerX = m.x;
                    var downDir = m.x >= cx ? 1 : -1;
                    BumpDialDigitThrottledSfx(digitIdx, downDir, true);
                    _tuneKnobNextRepeatUnscaled = Time.unscaledTime + holdRepeatInitialSec;
                    e.Use();
                    break;

                case EventType.MouseUp:
                    if (e.button == 0 && GUIUtility.hotControl == id)
                    {
                        GUIUtility.hotControl = 0;
                        _tuneKnobCaptureControl = 0;
                        _tuneKnobActiveDigit = -1;
                        _tuneKnobNextRepeatUnscaled = -1f;
                        _tuneKnobDragAccumX = 0f;
                        e.Use();
                    }

                    break;

                case EventType.MouseDrag:
                    if (GUIUtility.hotControl != id || e.button != 0)
                    {
                        break;
                    }

                    var dx = m.x - _tuneKnobLastPointerX;
                    _tuneKnobLastPointerX = m.x;
                    _tuneKnobDragAccumX += dx;
                    while (_tuneKnobDragAccumX >= pxPerDragStep)
                    {
                        _tuneKnobDragAccumX -= pxPerDragStep;
                        BumpDialDigitThrottledSfx(digitIdx, 1, false);
                    }

                    while (_tuneKnobDragAccumX <= -pxPerDragStep)
                    {
                        _tuneKnobDragAccumX += pxPerDragStep;
                        BumpDialDigitThrottledSfx(digitIdx, -1, false);
                    }

                    _tuneKnobNextRepeatUnscaled = Time.unscaledTime + repeatPauseAfterDragSec;
                    e.Use();
                    break;

                case EventType.Repaint:
                    if (GUIUtility.hotControl != id || _tuneKnobActiveDigit != digitIdx)
                    {
                        break;
                    }

                    if (!Input.GetMouseButton(0))
                    {
                        break;
                    }

                    var rdx = m.x - cx;
                    var rdy = m.y - cy;
                    if (rdx * rdx + rdy * rdy > dialR * dialR || Time.unscaledTime < _tuneKnobNextRepeatUnscaled)
                    {
                        break;
                    }

                    var repDir = m.x >= cx ? 1 : -1;
                    BumpDialDigitThrottledSfx(digitIdx, repDir, false);
                    _tuneKnobNextRepeatUnscaled = Time.unscaledTime + holdRepeatIntervalSec;
                    break;
            }

            if (e.type == EventType.Repaint)
            {
                const float wellPad = 1.5f;
                var well = new Rect(r.x - wellPad, r.y - wellPad, r.width + wellPad * 2f, r.height + wellPad * 2f);
                GUI.DrawTexture(well, _texKnobWell);
                GUI.DrawTexture(r, _texKnobFace);
                var bezelRect = new Rect(cx - dialR, cy - dialR, dialR * 2f, dialR * 2f);
                GUI.DrawTexture(bezelRect, _texKnobBezel);
                var oldC = GUI.color;
                GUI.color = new Color(1f, 0.96f, 0.82f, 0.12f);
                var oldM = GUI.matrix;
                GUIUtility.RotateAroundPivot(-26f, new Vector2(cx, cy));
                var glintH = Mathf.Max(2f, dialR * 0.1f);
                var glintW = dialR * 1.5f;
                GUI.DrawTexture(new Rect(cx - glintW * 0.5f, cy - dialR * 0.78f, glintW, glintH), _texVuPeak);
                GUI.matrix = oldM;
                GUI.color = oldC;
                var digit = _dialDigits[digitIdx];
                var ang = -90f + digit * 36f;
                var ptrH = dialR * 0.72f;
                var ptrW = Mathf.Max(2f, dialR * 0.12f);
                oldM = GUI.matrix;
                GUIUtility.RotateAroundPivot(ang, new Vector2(cx, cy));
                GUI.DrawTexture(new Rect(cx - ptrW * 0.5f, cy - ptrH, ptrW, ptrH), _texLedAmber);
                GUI.matrix = oldM;
            }
        }

        private void BumpDialDigitThrottledSfx(int digitIdx, int delta, bool alwaysPlaySfx)
        {
            BumpDialDigit(digitIdx, delta);
            if (alwaysPlaySfx)
            {
                TowerSfx.PlayKnob();
                _tuneKnobSfxNextUnscaled = Time.unscaledTime + 0.05f;
                return;
            }

            if (Time.unscaledTime >= _tuneKnobSfxNextUnscaled)
            {
                TowerSfx.PlayKnob();
                _tuneKnobSfxNextUnscaled = Time.unscaledTime + 0.05f;
            }
        }

        /// <summary>
        /// COPY / PASTE / SET row. COPY copies frequency string; PASTE (and Ctrl+V) stages
        /// clipboard into the dial; SET commits (same as the SET chip on the LCD).
        /// </summary>
        private void DrawTuneClipboardRow(Rect r)
        {
            const float gap = 4f;
            var colW = (r.width - gap * 2f) / 3f;

            var copyRect = new Rect(r.x, r.y, colW, r.height);
            GUI.DrawTexture(copyRect, _texInset);
            if (GUI.Button(
                    copyRect,
                    new GUIContent(
                        "[ COPY ]",
                        "Copy frequency text to the clipboard — uses staged MHz if you are editing, otherwise the live tuned channel."),
                    _utilityBtnStyle))
            {
                TowerSfx.PlayClick();
                CopyCurrentFrequencyToClipboard();
            }

            var pasteRect = new Rect(copyRect.xMax + gap, r.y, colW, r.height);
            GUI.DrawTexture(pasteRect, _texInset);
            if (GUI.Button(
                    pasteRect,
                    new GUIContent(
                        "[ PASTE ]",
                        "Paste from the clipboard into the MHz dial (stages digits). Also works with Ctrl+V while this panel is focused."),
                    _utilityBtnStyle))
            {
                TowerSfx.PlayClick();
                ApplyClipboardToDial();
            }

            var setRowRect = new Rect(pasteRect.xMax + gap, r.y, colW, r.height);
            GUI.DrawTexture(setRowRect, _texInset);
            GUI.enabled = _dialDirty;
            if (GUI.Button(
                    setRowRect,
                    new GUIContent(
                        "[ SET ]",
                        "Commit staged MHz as the active tune (disabled until the dial differs from the live channel). Same as SET on the LCD strip."),
                    _utilityBtnStyle))
            {
                TowerSfx.PlayClick();
                CommitDialFrequency();
            }

            GUI.enabled = true;
        }

        /// <summary>
        /// Best-effort "what frequency are we on right now?" — preferring the dial-pending
        /// digits (so you can copy a freq you're typing without committing it), then the
        /// lobby cache's room → frequency mapping (handles slug ids), then the raw session
        /// id (passes through if it's already "NNN.NNN").
        /// </summary>
        private void CopyCurrentFrequencyToClipboard()
        {
            string freq;
            if (_dialDirty)
            {
                freq = FormatDialDigits();
            }
            else
            {
                var current = TowerModSettings.SessionId ?? string.Empty;
                LobbyRoomInfo room;
                if (!string.IsNullOrEmpty(current)
                    && _sessionIdToRoom.TryGetValue(current, out room)
                    && !string.IsNullOrEmpty(room.FrequencyMhz))
                {
                    freq = room.FrequencyMhz;
                }
                else
                {
                    freq = current;
                }
            }

            if (string.IsNullOrEmpty(freq))
            {
                _statusLine = "Nothing to copy — radio not tuned.";
                return;
            }

            GUIUtility.systemCopyBuffer = freq;
            _statusLine = "Copied " + freq + " to clipboard.";
        }

        /// <summary>
        /// Reads <see cref="GUIUtility.systemCopyBuffer"/> and stages a parsed NNN.NNN frequency
        /// on the dial (same as PASTE button / Ctrl+V). Does not tune until <see cref="CommitDialFrequency"/>.
        /// </summary>
        private void ApplyClipboardToDial()
        {
            var raw = GUIUtility.systemCopyBuffer ?? string.Empty;
            if (string.IsNullOrEmpty(raw))
            {
                _statusLine = "Clipboard empty.";
                return;
            }

            var parsed = ExtractFrequencyFromText(raw);
            if (string.IsNullOrEmpty(parsed))
            {
                _statusLine = "Clipboard has no recognizable frequency.";
                return;
            }

            if (!TryParseFreqDigits(parsed, _dialDigits))
            {
                _statusLine = "Could not load frequency into dial.";
                return;
            }

            _dialDirty = true;
            _statusLine = "Staged " + parsed + " — press SET on the display.";
        }

        /// <summary>
        /// Shared tune entry point used by both the dial-commit path and the PASTE FREQ button
        /// (and now the quick-preset arrows too). Always routes through
        /// <c>POST /v1/session/claim-pilot</c> so provisioned tower / ground /
        /// emergency frequencies resolve to server-owned channels. ATIS stays local:
        /// the radio can tune it for the readout / WAV loop without joining voice.
        /// The previous flow optimistically called <see cref="AdoptRoomId"/> for a locally
        /// cached lobby hit, which only updated <see cref="TowerModSettings.SessionId"/> and
        /// never told the backend our membership had changed — so the web UI kept seeing us
        /// as a spectator (or worse, not a member at all) of the room our plugin was actively
        /// publishing telemetry to.
        /// </summary>
        private void TuneToTypedFrequency(string targetFreq, string sourceLabel)
        {
            if (string.IsNullOrEmpty(targetFreq))
            {
                return;
            }

            var freqCandidate = targetFreq.Trim();
            if (Regex.IsMatch(freqCandidate, FreqFormatRegex))
            {
                freqCandidate = SnapCanonicalFreqString(freqCandidate);
            }

            if (!string.Equals(freqCandidate, AtisPresetMhz, StringComparison.Ordinal))
            {
                _atisLocalReceiveOnly = false;
            }

            if (string.Equals(freqCandidate, AtisPresetMhz, StringComparison.Ordinal))
            {
                StopHelmetVoiceAfterTuneFailure();
                _atisLocalReceiveOnly = true;
                if (!TryParseFreqDigits(AtisPresetMhz, _dialDigits))
                {
                    _atisLocalReceiveOnly = false;
                    _statusLine = "ATIS tune failed.";
                    return;
                }

                _dialDirty = false;
                for (var qi = 0; qi < QuickPresets.Length; qi++)
                {
                    if (string.Equals(QuickPresets[qi].FrequencyMhz, AtisPresetMhz, StringComparison.Ordinal))
                    {
                        _presetArrowIndex = qi;
                        break;
                    }
                }

                _lobbyRoomsNextFetchAt = 0f;
                _statusLine = "Receiving ATIS on " + FormatCanonicalMhzHumanNoTrailingZeros(AtisPresetMhz) + " MHz.";
                return;
            }

            if (IsCurrentRoomOnFrequency(freqCandidate))
            {
                _dialDirty = false;
                if (Regex.IsMatch(freqCandidate, FreqFormatRegex))
                {
                    _statusLine = "Already on "
                        + FormatCanonicalMhzHumanNoTrailingZeros(freqCandidate)
                        + " MHz.";
                }
                else
                {
                    _statusLine = "Already on " + freqCandidate + ".";
                }

                return;
            }

            if (Regex.IsMatch(freqCandidate, FreqFormatRegex))
            {
                var human = FormatCanonicalMhzHumanNoTrailingZeros(freqCandidate);
                _statusLine = string.IsNullOrEmpty(sourceLabel)
                    ? "Tuning to " + human + " MHz\u2026"
                    : "Tuning to " + human + " MHz (" + sourceLabel + ")\u2026";
            }
            else
            {
                _statusLine = string.IsNullOrEmpty(sourceLabel)
                    ? "Tuning to " + freqCandidate + "\u2026"
                    : "Tuning to " + freqCandidate + " (" + sourceLabel + ")\u2026";
            }

            // Hint: TryFindRoomIdForFrequency() looks at the cached lobby roster; passing it
            // through as `sessionId` lets the server handle stale-id 404s gracefully and just
            // fall back to the freq match. Either way the pilot claim is server-authoritative.
            string hintRoomId;
            if (!TryFindRoomIdForFrequency(freqCandidate, out hintRoomId))
            {
                hintRoomId = null;
            }
            StartCoroutine(ClaimPilotAtFrequencyRoutine(freqCandidate, hintRoomId));
        }

        /// <summary>
        /// Pull a 6-digit "NNN.NNN" frequency out of an arbitrary text blob. Tries an exact
        /// match first, then scans for the first DDD[.,]DDD substring, then for a single
        /// decimal "DDD.D" / "DDD.DD" form which gets zero-padded to 3 fractional digits.
        /// Returns the canonical "NNN.NNN" string, or empty if nothing usable was found.
        /// </summary>
        private static string ExtractFrequencyFromText(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return string.Empty;
            }

            var trimmed = raw.Trim();
            int[] digitScratch = new int[6];
            if (TryParseFreqDigits(trimmed, digitScratch))
            {
                return SnapCanonicalFreqString(trimmed);
            }

            // Look for the first "DDD[.,]D{1,3}" run in the text.
            var m = System.Text.RegularExpressions.Regex.Match(trimmed, "([0-9]{3})[\\.,]([0-9]{1,3})");
            if (!m.Success)
            {
                return string.Empty;
            }

            var whole = m.Groups[1].Value;
            var frac = m.Groups[2].Value;
            // Pad the fractional side to 3 digits ("121.5" → "121.500"); truncate if longer.
            if (frac.Length < 3)
            {
                frac = frac.PadRight(3, '0');
            }
            else if (frac.Length > 3)
            {
                frac = frac.Substring(0, 3);
            }
            var candidate = whole + "." + frac;
            if (TryParseFreqDigits(candidate, digitScratch))
            {
                return SnapCanonicalFreqString(candidate);
            }
            return string.Empty;
        }

        private void BumpDialDigit(int digitIdx, int delta)
        {
            if (digitIdx < 0 || digitIdx >= _dialDigits.Length)
            {
                return;
            }

            // Arm the dial from the active session before the *first* edit so the knob shows
            // a sensible starting point instead of jumping from "000.000" to "100.000".
            if (!_dialDirty)
            {
                SyncDialDigitsFromActiveSession();
            }

            var d = (_dialDigits[digitIdx] + delta + 10) % 10;
            _dialDigits[digitIdx] = d;
            _dialDirty = true;
            var staged = FormatDialDigits();
            var stagedHuman = FormatCanonicalMhzHumanTrimTrailingZeros(staged, false);
            _statusLine = "Staged " + stagedHuman + " — press SET on the display.";
        }

        private string FormatDialDigits()
        {
            return string.Concat(
                _dialDigits[0], _dialDigits[1], _dialDigits[2],
                ".",
                _dialDigits[3], _dialDigits[4], _dialDigits[5]);
        }

        /// <summary>
        /// Commits whatever the knobs are currently showing as the active channel.
        /// <para/>
        /// Real-radio model: the player types a 6-digit frequency and expects the
        /// backend to resolve it to a provisioned channel. If the server does not
        /// publish that frequency, tuning fails instead of creating a new room.
        /// </summary>
        private void CommitDialFrequency()
        {
            var f = FormatDialDigits();
            if (!Regex.IsMatch(f, FreqFormatRegex))
            {
                _statusLine = "Set a full NNN.NNN frequency, then SET.";
                return;
            }

            var snapped = SnapCanonicalFreqString(f);
            if (!string.Equals(f, snapped, StringComparison.Ordinal))
            {
                if (TryParseFreqDigits(snapped, _dialDigits))
                {
                    _statusLine = "Snapped to " + FormatCanonicalMhzHumanNoTrailingZeros(snapped) + " MHz (25 kHz channel).";
                }
            }

            TuneToTypedFrequency(snapped, null);
        }

        /// <summary>
        /// True when the active SessionId is either the typed freq itself, OR a UUID-shaped
        /// room id whose server-assigned <c>frequencyMhz</c> matches the typed freq. Without
        /// the second branch the player would dial their own room's freq, get "Tuning…", and
        /// then bounce because we'd treat it as a different freq and try to recreate.
        /// </summary>
        private bool IsCurrentRoomOnFrequency(string target)
        {
            if (_atisLocalReceiveOnly && FrequenciesMatchOn25KhzGrid(target, AtisPresetMhz))
            {
                return true;
            }

            var current = TowerModSettings.SessionId ?? string.Empty;
            if (FrequenciesMatchOn25KhzGrid(target, current))
            {
                return true;
            }

            LobbyRoomInfo info;
            if (_sessionIdToRoom.TryGetValue(current, out info)
                && FrequenciesMatchOn25KhzGrid(target, info.FrequencyMhz ?? string.Empty))
            {
                return true;
            }

            return false;
        }

        private bool TryFindRoomIdForFrequency(string freq, out string roomId)
        {
            foreach (var kv in _sessionIdToRoom)
            {
                if (FrequenciesMatchOn25KhzGrid(kv.Value.FrequencyMhz ?? string.Empty, freq))
                {
                    roomId = kv.Key;
                    return !string.IsNullOrEmpty(roomId);
                }
            }

            roomId = null;
            return false;
        }

        /// <summary>
        /// Switch the plugin's active channel to <paramref name="roomId"/> (a server UUID),
        /// respawn the bridge, and refresh the in-game voice listen connection so audio
        /// follows the new room. The status line uses <paramref name="dialedFreq"/> for the
        /// human-facing "On channel NNN.NNN" feedback even when the underlying SessionId is
        /// a UUID — the player typed digits, the digits is what they want to see confirmed.
        /// </summary>
        private void AdoptRoomId(string roomId, string dialedFreq, bool newlyCreated)
        {
            if (!TowerModSettings.SetActiveChannel(roomId))
            {
                StopHelmetVoiceAfterTuneFailure();
                _statusLine = "Tune failed (bridge respawn).";
                return;
            }

            _atisLocalReceiveOnly = false;

            var v = TowerVoicePlayback.Instance;
            if (v != null && v.IsConnectingOrConnected)
            {
                v.StopBridgeConnection();
                v.StartBridgeConnection(TowerModSettings.VoiceListenHost, TowerModSettings.VoiceListenPort);
            }

            if (Regex.IsMatch(dialedFreq, FreqFormatRegex))
            {
                var humanDial = FormatCanonicalMhzHumanNoTrailingZeros(SnapCanonicalFreqString(dialedFreq));
                _statusLine = newlyCreated
                    ? "Created room on " + humanDial + " MHz."
                    : "On channel " + humanDial + " MHz.";
            }
            else
            {
                _statusLine = newlyCreated
                    ? "Created room on " + dialedFreq + "."
                    : "On channel " + dialedFreq + ".";
            }

            _dialDirty = false;

            // Force an early lobby refresh so the LCD subtitle picks up the new room name
            // instead of waiting up to LobbyRoomsRefreshSecondsVisible (~10s).
            _lobbyRoomsNextFetchAt = 0f;
        }

        /// <summary>
        /// POSTs <c>/v1/session/claim-pilot</c> to take pilot of the server-owned
        /// channel for <paramref name="targetFreq"/>. Replaces the old create-room + local-only
        /// <see cref="AdoptRoomId"/> shortcut: that flow updated <see cref="TowerModSettings.SessionId"/>
        /// purely on the client when a lobby cache hit happened, which left the backend
        /// believing the previous pilot still owned the room — so the web UI saw the in-game
        /// player as a spectator of the room their plugin was publishing telemetry to.
        ///
        /// <paramref name="hintRoomId"/> is an optional sessionId from the local lobby cache.
        /// We send both fields and let the server reconcile (it falls back to the freq match
        /// if the hint id is stale).
        ///
        /// On 403: the bearer isn't a plugin_session — surface that and stay on the old
        ///   channel. (Same wording as the old route since the cause is identical.)
        /// On 410: the requested room is closed; retry without the stale hint so the
        ///   backend can re-open the provisioned channel if applicable.
        /// On other HTTP errors / network failure / bad JSON: <see cref="TowerModSettings.SessionId"/>
        ///   is unchanged, but helmet PCM listen is stopped so the radio UI does not read "ON AIR".
        /// </summary>
        private IEnumerator ClaimPilotAtFrequencyRoutine(string targetFreq, string hintRoomId)
        {
            yield return ClaimPilotRequest(targetFreq, hintRoomId, allowFallback: true);
        }

        /// <summary>
        /// Stops the local PCM listen thread after a failed tune so ON AIR / BRIDGE annunciators
        /// match reality. Caller can tap power again to retry once the channel issue is fixed.
        /// </summary>
        private static void StopHelmetVoiceAfterTuneFailure()
        {
            var v = TowerVoicePlayback.Instance;
            if (v == null)
            {
                return;
            }

            v.StopBridgeConnection();
        }

        private IEnumerator ClaimPilotRequest(string targetFreq, string hintRoomId, bool allowFallback)
        {
            var url = TowerModSettings.ApiBaseUrl + "/session/claim-pilot";
            var sb = new StringBuilder();
            sb.Append('{');
            var first = true;
            if (!string.IsNullOrEmpty(hintRoomId))
            {
                sb.Append("\"sessionId\":\"").Append(EscapeJson(hintRoomId)).Append('"');
                first = false;
            }
            if (!string.IsNullOrEmpty(targetFreq))
            {
                if (!first) sb.Append(',');
                sb.Append("\"frequencyMhz\":\"").Append(EscapeJson(targetFreq)).Append('"');
                sb.Append(",\"name\":\"").Append(EscapeJson(targetFreq)).Append('"');
            }
            sb.Append('}');

            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(sb.ToString()));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 12;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError)
                {
                    StopHelmetVoiceAfterTuneFailure();
                    _statusLine = "Tune failed (network).";
                    Debug.LogWarning("[KSCTowerNetwork] ClaimPilot network: " + req.error);
                    yield break;
                }

                if (req.isHttpError)
                {
                    var code = req.responseCode;
                    if (code == 403)
                    {
                        StopHelmetVoiceAfterTuneFailure();
                        _statusLine = "Tune failed: log out and back in (token not plugin-grade).";
                        Debug.LogWarning("[KSCTowerNetwork] ClaimPilot 403: "
                            + (req.downloadHandler != null ? req.downloadHandler.text : ""));
                        yield break;
                    }
                    if ((code == 404 || code == 410) && allowFallback && !string.IsNullOrEmpty(hintRoomId))
                    {
                        // Stale hint id (room dropped on backend restart, or just closed). Retry
                        // without the hint so the server resolves the provisioned frequency.
                        Debug.Log("[KSCTowerNetwork] ClaimPilot retry without stale hint sessionId="
                            + hintRoomId + " freq=" + targetFreq);
                        yield return ClaimPilotRequest(targetFreq, null, allowFallback: false);
                        yield break;
                    }
                    StopHelmetVoiceAfterTuneFailure();
                    _statusLine = "Tune failed (HTTP " + code + ").";
                    Debug.LogWarning("[KSCTowerNetwork] ClaimPilot HTTP " + code
                        + ": " + (req.downloadHandler != null ? req.downloadHandler.text : ""));
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                var sid = ExtractJsonString(text, "sessionId");
                if (string.IsNullOrEmpty(sid))
                {
                    StopHelmetVoiceAfterTuneFailure();
                    _statusLine = "Tune failed (bad server reply).";
                    Debug.LogWarning("[KSCTowerNetwork] ClaimPilot missing sessionId: " + text);
                    yield break;
                }
                var claimedCallsign = ExtractJsonString(text, "callsign");
                AdoptRoomId(sid, targetFreq, /*newlyCreated:*/false);
                if (claimedCallsign != null)
                {
                    TowerModSettings.SetSessionCallsign(claimedCallsign);
                }
            }
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            // Conservative escaper for ASCII-only freq/uuid strings; the values fed in are
            // either a 7-char NNN.NNN frequency or a server-issued sessionId slug, so we
            // don't need full UTF-16 escaping here.
            var sb = new StringBuilder(s.Length);
            foreach (var c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20) { /* drop control chars */ }
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private static string ExtractJsonString(string json, string key)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(key))
            {
                return null;
            }

            var pattern = "\"" + System.Text.RegularExpressions.Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]+)\"";
            var m = System.Text.RegularExpressions.Regex.Match(json, pattern);
            return m.Success ? m.Groups[1].Value : null;
        }

        /// <summary>
        /// Snaps the knob digits to match the currently-tuned session id — used on panel open
        /// and after CLR. Falls back to craft default (Plane=TWR 122.000, other=GND 121.700)
        /// if the session id isn't a valid xxx.xxx number.
        /// </summary>
        private void SyncDialDigitsFromActiveSession()
        {
            if (_atisLocalReceiveOnly)
            {
                if (!TryParseFreqDigits(AtisPresetMhz, _dialDigits))
                {
                    var fallback = TowerCraftMode.Current == CraftMode.Plane ? "122.000" : "121.700";
                    TryParseFreqDigits(fallback, _dialDigits);
                }

                return;
            }

            var s = TowerModSettings.SessionId ?? string.Empty;
            if (!TryParseFreqDigits(s, _dialDigits))
            {
                var fallback = TowerCraftMode.Current == CraftMode.Plane ? "122.000" : "121.700";
                TryParseFreqDigits(fallback, _dialDigits);
            }
        }

        /// <summary>
        /// Renders the active session id as a 7-character LCD string. If the id is already a
        /// "121.500"-style frequency we just upper-case it; otherwise we display "---.---" so
        /// the player can tell at a glance that the current room can't be re-dialed by digits.
        /// </summary>
        private static string SessionIdToFreqDisplay(string sessionId)
        {
            int[] tmp = new int[6];
            if (TryParseFreqDigits(sessionId, tmp))
            {
                var canon = string.Concat(tmp[0], tmp[1], tmp[2], ".", tmp[3], tmp[4], tmp[5]);
                return FormatCanonicalMhzForAviationLcdSeven(SnapCanonicalFreqString(canon));
            }

            return LcdFreqPlaceholder;
        }

        private static bool TryParseFreqDigits(string s, int[] outDigits)
        {
            if (string.IsNullOrEmpty(s) || outDigits == null || outDigits.Length < 6)
            {
                return false;
            }

            var t = s.Trim();
            if (System.Text.RegularExpressions.Regex.IsMatch(t, FreqFormatRegex))
            {
                outDigits[0] = t[0] - '0';
                outDigits[1] = t[1] - '0';
                outDigits[2] = t[2] - '0';
                outDigits[3] = t[4] - '0';
                outDigits[4] = t[5] - '0';
                outDigits[5] = t[6] - '0';
                return true;
            }

            return false;
        }

        private float GetRxRms()
        {
            var v = TowerVoicePlayback.Instance;
            if (v == null || !v.HasStreamHeader)
            {
                return 0f;
            }

            return v.LastOutputRms;
        }

        private float GetTxRms()
        {
            var m = TowerMicMeter.Instance;
            if (m == null)
            {
                return 0f;
            }

            // Boost a bit so quiet speech is visible without clipping shouting.
            return Mathf.Clamp01(m.Rms * 1.6f);
        }

        private void DrawVuMeter(
            Rect r,
            string label,
            float rawLevel,
            ref float smoothed,
            ref float peakHold,
            ref float peakHoldDecayAt)
        {
            var labelRect = new Rect(r.x, r.y, 70f, r.height);
            GUI.Label(labelRect, label, _ledLabelStyle);

            var barOuter = new Rect(r.x + 74f, r.y + 4f, r.width - 78f, r.height - 8f);
            GUI.DrawTexture(barOuter, _texVuBg);

            // Convert linear-ish RMS to a perceptual 0..1 fill using a soft dB curve.
            var lvl = LinearToVuFraction(rawLevel);
            smoothed = Mathf.Lerp(smoothed, lvl, 0.4f);
            if (smoothed > peakHold)
            {
                peakHold = smoothed;
                peakHoldDecayAt = Time.unscaledTime + 0.7f;
            }
            else if (Time.unscaledTime > peakHoldDecayAt)
            {
                peakHold = Mathf.Max(smoothed, peakHold - Time.unscaledDeltaTime * 0.6f);
            }

            DrawVuFill(barOuter, smoothed);
            DrawVuPeakMarker(barOuter, peakHold);
        }

        private static float LinearToVuFraction(float rms)
        {
            if (rms <= 0.00005f)
            {
                return 0f;
            }

            // -60 dBFS .. 0 dBFS mapped to 0..1, with a knee that keeps speech sitting around 0.4..0.7.
            var db = 20f * Mathf.Log10(Mathf.Max(rms, 1e-5f));
            var f = Mathf.InverseLerp(-60f, -3f, db);
            return Mathf.Clamp01(f);
        }

        private void DrawVuFill(Rect bar, float fill)
        {
            if (fill <= 0f)
            {
                return;
            }

            const int seg = 18;
            var inner = new Rect(bar.x + 2f, bar.y + 2f, bar.width - 4f, bar.height - 4f);
            var segW = (inner.width - (seg - 1) * 1f) / seg;
            var lit = Mathf.RoundToInt(fill * seg);
            for (var i = 0; i < lit; i++)
            {
                var x = inner.x + i * (segW + 1f);
                Texture2D tex;
                if (i < seg * 0.6f)
                {
                    tex = _texVuGreen;
                }
                else if (i < seg * 0.85f)
                {
                    tex = _texVuYellow;
                }
                else
                {
                    tex = _texVuRed;
                }

                GUI.DrawTexture(new Rect(x, inner.y, segW, inner.height), tex);
            }
        }

        private void DrawVuPeakMarker(Rect bar, float peak)
        {
            if (peak <= 0f)
            {
                return;
            }

            var inner = new Rect(bar.x + 2f, bar.y + 2f, bar.width - 4f, bar.height - 4f);
            var x = inner.x + Mathf.Clamp01(peak) * (inner.width - 2f);
            GUI.DrawTexture(new Rect(x, inner.y, 2f, inner.height), _texVuPeak);
        }

        /// <summary>Helmet listen output steps for the VOL button (cycles each tap).</summary>
        private static readonly float[] ListenVolCycleSteps = { 0f, 0.25f, 0.5f, 0.75f, 1f };

        private void DrawPowerRow(Rect r)
        {
            const float volW = 58f;
            const float gap = 6f;
            var volRect = new Rect(r.xMax - volW, r.y, volW, r.height);
            var pwrRect = new Rect(r.x, r.y, Mathf.Max(80f, volRect.x - gap - r.x), r.height);
            DrawPowerSwitch(pwrRect);
            DrawListenVolumeButton(volRect);
        }

        private void DrawPowerSwitch(Rect r)
        {
            var v = TowerVoicePlayback.Instance;
            var on = v != null && v.IsListenUiOnAir;
            var label = on ? "● ON  AIR  (LISTENING)" : "○  OFF  —  TAP TO POWER ON";
            var style = on ? _powerOnStyle : _powerOffStyle;
            var pwrTip = on
                ? "Tower listen is ON — you hear the voice stream from the bridge. Tap to mute / stop listening (does not log out of the tower)."
                : "Tower listen is OFF. Tap to power on and connect the listen path (requires the local voice bridge and valid listen settings).";
            if (GUI.Button(r, new GUIContent(label, pwrTip), style))
            {
                TowerSfx.PlayClick();
                ToggleListen();
            }
        }

        private void DrawListenVolumeButton(Rect r)
        {
            GUI.DrawTexture(r, _texInset);
            TowerModSettings.EnsureLoaded();
            var v = Mathf.Clamp01(TowerModSettings.VoiceListenVolume);
            var pct = Mathf.RoundToInt(v * 100f);
            var label = pct <= 0 ? "VOL\nMUTE" : ("VOL\n" + pct + "%");
            var volTip = "Tower listen output level — tap to cycle mute, 25%, 50%, 75%, 100%. Does not change your mic / transmit level.";
            if (GUI.Button(r, new GUIContent(label, volTip), _utilityBtnStyle))
            {
                TowerSfx.PlayClick();
                CycleListenVolume();
            }
        }

        private void CycleListenVolume()
        {
            TowerModSettings.EnsureLoaded();
            var cur = Mathf.Clamp01(TowerModSettings.VoiceListenVolume);
            var bestIdx = 0;
            var bestDist = float.MaxValue;
            for (var i = 0; i < ListenVolCycleSteps.Length; i++)
            {
                var d = Mathf.Abs(cur - ListenVolCycleSteps[i]);
                if (d < bestDist)
                {
                    bestDist = d;
                    bestIdx = i;
                }
            }

            var next = ListenVolCycleSteps[(bestIdx + 1) % ListenVolCycleSteps.Length];
            TowerModSettings.SetVoiceListenVolume(next);
            _statusLine = next <= 0.001f ? "Tower listen muted." : ("Tower listen " + Mathf.RoundToInt(next * 100f) + "%");
        }

        private void ToggleListen()
        {
            TowerVoicePlayback.EnsureExists();
            var v = TowerVoicePlayback.Instance;
            if (v == null)
            {
                _statusLine = "Helmet audio component unavailable.";
                return;
            }

            if (v.IsConnectingOrConnected)
            {
                v.StopBridgeConnection();
                _statusLine = "Powered off.";
                return;
            }

            // Make sure the bridge process is alive before we open the TCP listen, otherwise the user just
            // sees "no audio" and has no obvious next action.
            if (!string.IsNullOrEmpty(TowerModSettings.BridgeExecutable)
                && !TowerModSettings.IsSpawnedVoiceBridgeAlive)
            {
                TowerModSettings.TryRespawnVoiceBridgeProcess();
            }

            v.StartBridgeConnection(TowerModSettings.VoiceListenHost, TowerModSettings.VoiceListenPort);
            _statusLine = "Powered on. Acquiring stream…";
        }

        private void DrawPttBar(Rect r)
        {
            var live = _micUiHeld || _micKeyHeld || _bridgeMicLive;
            var radioBlocked = TowerRadioState.Blocked;
            var radioBusy = TowerRadioState.Busy;
            var style = live ? _pttLiveStyle : _pttIdleStyle;
            var pttKey = TowerModSettings.PushToTalkKey;
            var bottomHint = pttKey == KeyCode.None
                ? "(no PTT key bound — set pushToTalkKey in settings.cfg)"
                : radioBlocked
                    ? "Blocked - release and say again"
                    : radioBusy && !live
                        ? "Frequency busy - wait for the gap, or override"
                        : "Hold this bar  ·  or hold [" + pttKey + "]";
            var pttTip = "Push-to-talk — hold to open the mic to the tower (voice bridge MIC_ON). Release to close. " + bottomHint;

            GUI.Box(r, new GUIContent(string.Empty, pttTip), style);

            var labelRect = new Rect(r.x, r.y + 6f, r.width, 26f);
            var label = radioBlocked
                ? "BLOCKED - SAY AGAIN"
                : live
                    ? PttLabelLive
                    : radioBusy
                        ? "FREQ BUSY"
                        : PttLabelIdle;
            GUI.Label(labelRect, new GUIContent(label, pttTip), _channelStyle);

            var hintRect = new Rect(r.x, r.yMax - 22f, r.width, 18f);
            GUI.Label(hintRect, new GUIContent(bottomHint, pttTip), _smallStyle);

            HandlePttBarMouse(r);
        }

        private void HandlePttBarMouse(Rect r)
        {
            var e = Event.current;
            if (e == null)
            {
                return;
            }

            var inside = r.Contains(e.mousePosition);
            switch (e.type)
            {
                case EventType.MouseDown:
                    if (inside && e.button == 0)
                    {
                        _micUiHeld = true;
                        SyncPttHoldAfterSourceChange();
                        e.Use();
                    }

                    break;
                case EventType.MouseUp:
                    if (_micUiHeld && e.button == 0)
                    {
                        _micUiHeld = false;
                        SyncPttHoldAfterSourceChange();
                        e.Use();
                    }

                    break;
                case EventType.MouseDrag:
                    // If the user drags off the bar with the button still down, treat it like a release.
                    if (_micUiHeld && !inside)
                    {
                        _micUiHeld = false;
                        SyncPttHoldAfterSourceChange();
                    }

                    break;
            }
        }

        private void SyncPttHoldAfterSourceChange()
        {
            var combined = _micUiHeld || _micKeyHeld;
            if (combined == _pttCombinedPrev)
            {
                return;
            }

            _pttCombinedPrev = combined;
            TowerMicMeter.EnsureExists();
            var meter = TowerMicMeter.Instance;
            if (combined)
            {
                if (meter != null)
                {
                    meter.StartSampling();
                }

                if (!_bridgeMicLive)
                {
                    TrySendBridgeMicCommand(true);
                }
            }
            else
            {
                if (meter != null)
                {
                    meter.StopSampling();
                }

                if (_bridgeMicLive)
                {
                    TrySendBridgeMicCommand(false);
                }
            }
        }

        private void TrySendBridgeMicCommand(bool wantOn)
        {
            // Optimistic UI: assume the bridge accepts the command; the worker thread will
            // overwrite the status line once the real reply arrives. Never block OnGUI/PTT
            // on a TCP round trip — that froze the whole game when the bridge was missing.
            _statusLine = wantOn ? "Mic: opening…" : "Mic: closing…";

            // Publish before the TCP send so the chatter-ducking subscriber can mute Chatterer
            // and the COMM radio's own ATC clips on the same frame as the keystroke; otherwise
            // the next chatter sample plays for ~150 ms before MIC_ON returns.
            TowerPttBus.Publish(wantOn, "ui");

            TowerVoiceBridgeControl.EnqueueSend(
                TowerModSettings.VoiceCtlHost,
                TowerModSettings.VoiceCtlPort,
                wantOn ? "MIC_ON" : "MIC_OFF",
                (ok, resp) =>
                {
                    TowerMainThreadDispatcher.Run(() =>
                    {
                        if (!ok)
                        {
                            _statusLine = "Mic: voice bridge unreachable.";
                            return;
                        }

                        if (!string.IsNullOrEmpty(resp) && resp.StartsWith("OK"))
                        {
                            _bridgeMicLive = wantOn;
                            _statusLine = wantOn ? "Mic open." : "Mic closed.";
                            return;
                        }

                        _statusLine = "Mic: bridge replied " + (resp ?? "(null)");
                    });
                });
        }

        private void DrawStatusFooter(Rect r)
        {
            var radioMessage = TowerRadioState.Message;
            if (!string.IsNullOrEmpty(radioMessage))
            {
                double freq;
                if (TowerRadioState.TryGetFreqMhz(out freq) && freq > 0.0)
                {
                    GUI.Label(r, radioMessage + " · " + freq.ToString("0.000", CultureInfo.InvariantCulture) + " MHz", _statusStyle);
                    return;
                }

                GUI.Label(r, radioMessage, _statusStyle);
                return;
            }

            GUI.Label(r, _statusLine ?? string.Empty, _statusStyle);
        }

        /// <summary>
        /// Compact clearance strip moved from the old floating HUD into the radio panel footer.
        /// </summary>
        private void DrawClearanceRow(Rect r)
        {
            GUI.DrawTexture(r, _texInset);
            const float sidePad = 6f;
            const float gap = 4f;
            var chipW = (r.width - sidePad * 2f - gap * (ClearanceKindsShort.Length - 1)) / ClearanceKindsShort.Length;
            var chipRect = new Rect(r.x + sidePad, r.y + 1f, chipW, r.height - 2f);
            for (var i = 0; i < ClearanceKindsShort.Length; i++)
            {
                var prevColor = GUI.color;
                GUI.color = GetClearanceColor(TowerClearanceState.GetDisposition(ClearanceKindsWire[i]));
                GUI.Label(chipRect, ClearanceKindsShort[i], _clearanceStyle);
                GUI.color = prevColor;
                var tip = i < ClearanceKindsTooltips.Length ? ClearanceKindsTooltips[i] : string.Empty;
                // Colored glyphs: Label (above). Tooltip hover: same pattern as preset ◀ / ▶ — transparent
                // Button on top so KSP sets GUI.tooltip without replacing the label chrome.
                if (GUI.Button(chipRect, new GUIContent(string.Empty, tip), _arrowHitStyle))
                {
                    // Hover-only: no click action.
                }

                chipRect.x += chipW + gap;
            }
        }

        /// <summary>
        /// Draws <see cref="GUI.tooltip"/> for the current window. KSP runtime IMGUI does not paint
        /// <c>GUIContent.tooltip</c> automatically (unlike the Unity Editor); every control still sets
        /// <c>GUI.tooltip</c> on hover, so we must blit it here. Call last in <see cref="DrawWindow"/>
        /// on <see cref="EventType.Repaint"/> so it stacks above the rest of the panel chrome.
        /// </summary>
        private void DrawWindowTooltipIfNeeded()
        {
            if (Event.current.type != EventType.Repaint)
            {
                return;
            }

            var tip = GUI.tooltip;
            if (string.IsNullOrEmpty(tip))
            {
                return;
            }

            const float maxInnerW = 280f;
            const float framePad = 10f;
            var content = new GUIContent(tip);
            var innerW = Mathf.Min(maxInnerW, Mathf.Max(48f, _tooltipLabelStyle.CalcSize(content).x));
            var innerH = _tooltipLabelStyle.CalcHeight(content, innerW);
            var mouse = Event.current.mousePosition;
            var r = new Rect(
                mouse.x + 14f,
                mouse.y + 18f,
                innerW + framePad * 2f,
                innerH + framePad * 2f);
            r.x = Mathf.Clamp(r.x, 6f, PanelWidth - r.width - 6f);
            r.y = Mathf.Clamp(r.y, 6f, PanelHeight - r.height - 6f);
            var shadow = new Rect(r.x + 2f, r.y + 2f, r.width, r.height);
            var prev = GUI.color;
            GUI.color = new Color(0f, 0f, 0f, 0.55f);
            GUI.DrawTexture(shadow, _texTooltipBg);
            GUI.color = prev;
            GUI.DrawTexture(r, _texTooltipBg);
            var textRect = new Rect(r.x + framePad, r.y + framePad, innerW, innerH);
            GUI.Label(textRect, tip, _tooltipLabelStyle);
        }

        private static Color GetClearanceColor(string disposition)
        {
            if (string.Equals(disposition, "cleared", StringComparison.Ordinal))
            {
                return new Color(0.35f, 0.85f, 0.45f, 1f);
            }

            if (string.Equals(disposition, "violation", StringComparison.Ordinal))
            {
                return new Color(0.95f, 0.35f, 0.35f, 1f);
            }

            return new Color(0.65f, 0.65f, 0.7f, 1f);
        }

        /// <summary>
        /// Bottom-of-panel utility row — replaces the deleted settings popover. Hosts the
        /// "Reconnect bridge" and "Log out" actions as small inset buttons so they're always
        /// one click away without cluttering the title bar.
        /// </summary>
        private void DrawUtilityFooter(Rect r)
        {
            // Footer: RECONNECT BRIDGE | [optional PARK AT KSC TWR] | LOG OUT.
            // Park-at-tower is gated by TowerJumpToWindow.TowerParkKscTwrEnabled (currently
            // false — camera instability); when off, IsAvailable is false and this row is
            // two-up only. When enabled, the middle button snaps the camera to the tower.
            const float gap = 4f;
            var canPark = TowerJumpToWindow.IsAvailable;
            float thirdW = canPark ? (r.width - gap * 2f) / 3f : (r.width - gap) * 0.5f;

            var rcRect = new Rect(r.x, r.y, thirdW, r.height);
            GUI.DrawTexture(rcRect, _texInset);
            if (GUI.Button(
                    rcRect,
                    new GUIContent(
                        "\u21BB  RECONNECT  BRIDGE",
                        "Reconnect — reopens TCP control to the local voice bridge (mic on/off, health). Use after restarting the bridge process."),
                    _utilityBtnStyle))
            {
                TowerSfx.PlayClick();
                ReconnectBridge();
            }

            float nextX = rcRect.xMax + gap;
            if (canPark)
            {
                var pkRect = new Rect(nextX, r.y, thirdW, r.height);
                GUI.DrawTexture(pkRect, _texInset);
                // Toggle label: when already parked, the button un-parks (restores the
                // previous camera pose). Keeps the same glyph so layout doesn't jitter.
                var pkLabel = TowerJumpToWindow.IsParked
                    ? "\u29BF  EXIT KSC TWR VIEW"
                    : "\u29BF  PARK AT KSC TWR";
                var pkTip = TowerJumpToWindow.IsParked
                    ? "Return camera / focus to where you were before parking at KSC tower view."
                    : "Snap camera to the KSC tower vantage (experimental — may be disabled if unstable).";
                if (GUI.Button(pkRect, new GUIContent(pkLabel, pkTip), _utilityBtnStyle))
                {
                    TowerSfx.PlayClick();
                    _statusLine = TowerJumpToWindow.JumpToTower();
                }
                nextX = pkRect.xMax + gap;
            }

            var loRect = new Rect(nextX, r.y, thirdW, r.height);
            GUI.DrawTexture(loRect, _texInset);
            if (GUI.Button(
                    loRect,
                    new GUIContent(
                        "\u23FB  LOG  OUT",
                        "Log out — ends voice and clears this login. Open the Tower toolbar button again to sign in or change servers."),
                    _utilityBtnStyle))
            {
                TowerSfx.PlayClick();
                if (OnRequestLogout != null)
                {
                    OnRequestLogout();
                }
            }
        }

        /// <summary>
        /// Once per frame while the radio window is up: latch dismissal when the active vessel
        /// is clearly off the ground (flying or orbit-class). Resets when the active vessel id changes.
        /// </summary>
        private void UpdateLaunchAssistTakeoffDismiss()
        {
            if (FlightGlobals.fetch == null)
            {
                return;
            }

            var v = FlightGlobals.ActiveVessel;
            if (v == null)
            {
                return;
            }

            if (v.id != _launchAssistTrackedVesselId)
            {
                _launchAssistTrackedVesselId = v.id;
                _launchAssistTakeoffDismissed = false;
            }

            // Same vessel recovered / rolled back to the pad: show the row again.
            switch (v.situation)
            {
                case Vessel.Situations.LANDED:
                case Vessel.Situations.PRELAUNCH:
                case Vessel.Situations.SPLASHED:
                    _launchAssistTakeoffDismissed = false;
                    return;
            }

            if (_launchAssistTakeoffDismissed)
            {
                return;
            }

            switch (v.situation)
            {
                case Vessel.Situations.FLYING:
                case Vessel.Situations.SUB_ORBITAL:
                case Vessel.Situations.ORBITING:
                case Vessel.Situations.ESCAPING:
                case Vessel.Situations.DOCKED:
                    _launchAssistTakeoffDismissed = true;
                    break;
            }
        }

        /// <summary>
        /// Rockets: <c>REQUEST LAUNCH</c> → countdown pipeline (tower sees structured request).
        /// Planes / rovers: <c>REQUEST TAKEOFF</c> → chat-only alert on the same HTTP route with <c>{"kind":"takeoff"}</c>.
        /// </summary>
        private void DrawLaunchRequestRow(Rect r)
        {
            var hasSession = !string.IsNullOrEmpty(TowerModSettings.SessionId);
            var hasAuth = TowerModSettings.SkipTowerLogin || !string.IsNullOrEmpty(TowerModSettings.TowerAuthToken);
            var countdownActive = TowerCountdownState.Active;
            var craft = TowerCraftMode.Current;
            var isSurfaceCraft = craft == CraftMode.Plane || craft == CraftMode.Rover;
            var countdownBlocksRequest = countdownActive && !isSurfaceCraft;
            var sinceLast = Time.realtimeSinceStartup - _launchRequestLastAtRealtime;
            var inCooldown = sinceLast < LaunchRequestCooldownSec;
            var takeoffCleared = isSurfaceCraft && TowerTakeoffClearanceState.IsActive;

            string noSessionVerb = isSurfaceCraft ? "TAKEOFF" : "LAUNCH";
            string label;
            if (takeoffCleared)
            {
                label = "\u2714  APPROVED  (takeoff)";
            }
            else if (!hasSession || !hasAuth)
            {
                label = "REQUEST  " + noSessionVerb + "  (no session)";
            }
            else if (countdownBlocksRequest)
            {
                label = "● COUNTDOWN  RUNNING";
            }
            else if (_launchRequestBusy)
            {
                label = "SENDING\u2026";
            }
            else if (inCooldown)
            {
                label = "WAIT  " + Mathf.CeilToInt(LaunchRequestCooldownSec - sinceLast) + "s\u2026";
            }
            else
            {
                label = isSurfaceCraft ? "\u25B2  REQUEST  TAKEOFF" : "\u25B2  REQUEST  LAUNCH";
            }

            var canClick =
                hasSession &&
                hasAuth &&
                !countdownBlocksRequest &&
                !_launchRequestBusy &&
                !inCooldown &&
                !takeoffCleared;
            var style = takeoffCleared ? _launchBtnApprovedStyle : (canClick ? _launchBtnStyle : _launchBtnDisabledStyle);

            string launchTip;
            if (takeoffCleared)
            {
                launchTip = "Takeoff already approved — nothing more to request for this surface craft.";
            }
            else if (!hasSession)
            {
                launchTip = "No session — tune the dial to a tower channel or complete login so the tower knows which room you are in.";
            }
            else if (!hasAuth)
            {
                launchTip = "Not authenticated — sign in to the tower (or use dev skip-login) before the server can accept launch / takeoff requests.";
            }
            else if (countdownBlocksRequest)
            {
                launchTip = "Launch countdown is active — wait for the current sequence to finish before requesting again.";
            }
            else if (_launchRequestBusy)
            {
                launchTip = "Request in progress — wait for the HTTP reply from the tower.";
            }
            else if (inCooldown)
            {
                launchTip = "Cooldown between requests — prevents spamming the tower with duplicate launch / takeoff calls.";
            }
            else if (isSurfaceCraft)
            {
                launchTip = "Takeoff request — tells the tower you are ready for surface departure (plane / rover). Uses the session countdown/request API with kind takeoff.";
            }
            else
            {
                launchTip = "Launch request — asks the tower to start or acknowledge a rocket launch (countdown / structured flow). Uses the session countdown/request API with kind launch.";
            }

            GUI.enabled = canClick;
            if (GUI.Button(r, new GUIContent(label, launchTip), style))
            {
                TowerSfx.PlayClick();
                _launchRequestLastAtRealtime = Time.realtimeSinceStartup;
                StartCoroutine(PostLaunchRequest());
            }
            GUI.enabled = true;
        }

        private IEnumerator PostLaunchRequest()
        {
            _launchRequestBusy = true;
            var craft = TowerCraftMode.Current;
            var isSurfaceCraft = craft == CraftMode.Plane || craft == CraftMode.Rover;
            _statusLine = isSurfaceCraft
                ? "Sending takeoff request to tower\u2026"
                : "Requesting launch from tower\u2026";

            var url = TowerModSettings.ApiBaseUrl + "/session/" +
                      UnityWebRequest.EscapeURL(TowerModSettings.SessionId) +
                      "/countdown/request";

            var bodyJson = isSurfaceCraft ? "{\"kind\":\"takeoff\"}" : "{\"kind\":\"launch\"}";
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(bodyJson));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);

                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    _statusLine = (isSurfaceCraft ? "Takeoff request failed: " : "Launch request failed: ") + req.error;
                    Debug.LogWarning("[KSCTowerNetwork] countdown/request failed: " + req.error);
                }
                else
                {
                    _statusLine = isSurfaceCraft
                        ? "Tower notified (takeoff clearance)."
                        : "Tower notified. Standing by for count.";
                }
            }

            _launchRequestBusy = false;
        }

        private void ReconnectBridge()
        {
            _statusLine = "Restarting voice bridge…";
            if (!TowerModSettings.TryRespawnVoiceBridgeProcess())
            {
                _statusLine = "Bridge respawn failed (see log).";
                return;
            }

            TowerVoicePlayback.EnsureExists();
            var v = TowerVoicePlayback.Instance;
            if (v != null)
            {
                v.StopBridgeConnection();
                v.StartBridgeConnection(TowerModSettings.VoiceListenHost, TowerModSettings.VoiceListenPort);
            }

            _statusLine = "Voice bridge restarted.";
        }

        public void RequestPttKeySuppressUntilRelease()
        {
            _suppressPttKeyUntilRelease = TowerModSettings.PushToTalkKey != KeyCode.None;
        }

        /// <summary>Draws a geometric arrow texture centered inside the round preset hit rect.</summary>
        private static void DrawPresetArrowInCircle(Rect circle, bool pointRight)
        {
            var tex = pointRight ? _texArrowRight : _texArrowLeft;
            if (tex == null)
            {
                return;
            }

            var m = Mathf.Clamp(circle.width * 0.2f, 3f, 8f);
            var r = new Rect(circle.x + m, circle.y + m, circle.width - 2f * m, circle.height - 2f * m);
            GUI.DrawTexture(r, tex, ScaleMode.ScaleToFit, true);
        }

        /// <summary>Lazily creates a 1×1 white texture used as the segment fill (tinted via <see cref="GUI.color"/>).</summary>
        private static Texture2D EnsureSegmentFillTex()
        {
            if (_texSegmentFill != null)
            {
                return _texSegmentFill;
            }

            var t = new Texture2D(1, 1, TextureFormat.RGBA32, false)
            {
                hideFlags = HideFlags.DontUnloadUnusedAsset,
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Point,
                name = "KSCTowerNetwork.SegmentFill"
            };
            t.SetPixel(0, 0, Color.white);
            t.Apply(false, true);
            _texSegmentFill = t;
            return _texSegmentFill;
        }

        /// <summary>
        /// Returns the 7-segment bitmask for <paramref name="ch"/> (bit 0=a, 1=b, 2=c, 3=d, 4=e, 5=f, 6=g),
        /// or <c>0</c> for blanks/unsupported. Em-dash (<c>U+2014</c>) and ASCII <c>'-'</c> render as the middle segment.
        /// </summary>
        private static int SegmentLitCount(int mask)
        {
            var m = mask & 0x7F;
            var c = 0;
            while (m != 0)
            {
                c += m & 1;
                m >>= 1;
            }

            return c;
        }

        private static int SegmentMaskForChar(char ch)
        {
            switch (ch)
            {
                case '0': return 0x3F;
                case '1': return 0x06;
                case '2': return 0x5B;
                case '3': return 0x4F;
                case '4': return 0x66;
                case '5': return 0x6D;
                case '6': return 0x7D;
                case '7': return 0x07;
                case '8': return 0x7F;
                case '9': return 0x6F;
                case '-':
                case '\u2014':
                    return 0x40;
                default:
                    return 0;
            }
        }

        /// <summary>
        /// Draws one 7-segment digit inside <paramref name="cell"/>, with a faint ghost of every off segment so
        /// the readout looks like a real LCD even when only some segments are lit.
        /// </summary>
        private static void DrawSevenSegmentDigit(Rect cell, char ch, Color on, Color off)
        {
            var fill = EnsureSegmentFillTex();
            if (fill == null)
            {
                return;
            }

            var pad = Mathf.Max(1f, Mathf.Min(cell.width, cell.height) * 0.08f);
            var rawW = cell.width - pad * 2f;
            var h = cell.height - pad * 2f;
            var w = rawW * 0.70f;
            var x = cell.x + (cell.width - w) * 0.5f;
            var y = cell.y + pad;

            var t = Mathf.Max(1.5f, h * 0.13f);
            var hSegLen = Mathf.Max(1f, w - t * 1.4f);
            var vSegLen = Mathf.Max(1f, (h - t * 3f) * 0.5f);

            var segA = new Rect(x + (w - hSegLen) * 0.5f, y, hSegLen, t);
            var segG = new Rect(x + (w - hSegLen) * 0.5f, y + (h - t) * 0.5f, hSegLen, t);
            var segD = new Rect(x + (w - hSegLen) * 0.5f, y + h - t, hSegLen, t);
            var segF = new Rect(x, y + t * 0.5f, t, vSegLen);
            var segB = new Rect(x + w - t, y + t * 0.5f, t, vSegLen);
            var segE = new Rect(x, y + h * 0.5f + t * 0.5f, t, vSegLen);
            var segC = new Rect(x + w - t, y + h * 0.5f + t * 0.5f, t, vSegLen);

            var mask = SegmentMaskForChar(ch);
            var prev = GUI.color;

            // Digits like <c>1</c> and <c>7</c> light few segments; painting every "off" segment first makes them
            // look washed out next to <c>8</c>. Skip the ghost pass when at most three segments are on.
            if (SegmentLitCount(mask) > 3)
            {
                GUI.color = off;
                GUI.DrawTexture(segA, fill);
                GUI.DrawTexture(segB, fill);
                GUI.DrawTexture(segC, fill);
                GUI.DrawTexture(segD, fill);
                GUI.DrawTexture(segE, fill);
                GUI.DrawTexture(segF, fill);
                GUI.DrawTexture(segG, fill);
            }

            GUI.color = on;
            if ((mask & 0x01) != 0) GUI.DrawTexture(segA, fill);
            if ((mask & 0x02) != 0) GUI.DrawTexture(segB, fill);
            if ((mask & 0x04) != 0) GUI.DrawTexture(segC, fill);
            if ((mask & 0x08) != 0) GUI.DrawTexture(segD, fill);
            if ((mask & 0x10) != 0) GUI.DrawTexture(segE, fill);
            if ((mask & 0x20) != 0) GUI.DrawTexture(segF, fill);
            if ((mask & 0x40) != 0) GUI.DrawTexture(segG, fill);

            GUI.color = prev;
        }

        /// <summary>Draws an LCD decimal point centered horizontally in the lower-right of <paramref name="cell"/>.</summary>
        private static void DrawSevenSegmentDot(Rect cell, Color on)
        {
            var fill = EnsureSegmentFillTex();
            if (fill == null)
            {
                return;
            }

            var size = Mathf.Max(2f, Mathf.Min(cell.width, cell.height) * 0.18f);
            var dot = new Rect(
                cell.x + (cell.width - size) * 0.5f,
                cell.y + cell.height - size - Mathf.Max(1f, cell.height * 0.06f),
                size,
                size);
            var prev = GUI.color;
            GUI.color = on;
            GUI.DrawTexture(dot, fill);
            GUI.color = prev;
        }


        private void EnsureStyles()
        {
            if (_stylesReady)
            {
                return;
            }

            _stylesReady = true;

            _panelStyle = new GUIStyle(GUI.skin.box)
            {
                alignment = TextAnchor.UpperLeft,
                padding = new RectOffset(0, 0, 0, 0),
                border = new RectOffset(0, 0, 0, 0),
                normal = { background = _texPanelDark, textColor = Color.white }
            };

            _titleStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 14,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.95f, 0.93f, 0.78f, 1f) }
            };

            _ledLabelStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 11,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.85f, 0.83f, 0.7f, 1f) }
            };

            _channelStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 16,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(1f, 0.78f, 0.32f, 1f) }
            };

            // Digits in the MHz strip are rendered procedurally as 7-segment shapes (see DrawSevenSegmentDigit),
            // so this style is only used for the rare non-7-char fallback path. Bold is intentionally off.
            _channelDigitCellStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = TuneDialLcdFontSize,
                fontStyle = FontStyle.Normal,
                clipping = TextClipping.Overflow,
                wordWrap = false,
                richText = false,
                normal = { textColor = new Color(1f, 0.78f, 0.32f, 1f) }
            };

            _smallStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 11,
                fontStyle = FontStyle.Normal,
                normal = { textColor = new Color(0.75f, 0.7f, 0.55f, 1f) }
            };

            _clearanceStyle = new GUIStyle(_smallStyle)
            {
                fontSize = 12,
                fontStyle = FontStyle.Bold
            };

            // Tooltip: KSP's GUI.Box often fails to apply custom textColor on the default skin; use
            // DrawTexture + Label (see DrawWindowTooltipIfNeeded) for reliable contrast.
            _tooltipLabelStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.UpperLeft,
                fontSize = 11,
                fontStyle = FontStyle.Normal,
                wordWrap = true,
                richText = false,
                clipping = TextClipping.Clip,
                padding = new RectOffset(0, 0, 0, 0),
                normal = { textColor = new Color(1f, 0.99f, 0.94f, 1f) }
            };

            _pilotStripStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 12,
                fontStyle = FontStyle.Normal,
                richText = true,
                wordWrap = false,
                clipping = TextClipping.Clip,
                normal = { textColor = new Color(0.88f, 0.84f, 0.7f, 1f) }
            };

            _atisReadoutStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.UpperLeft,
                fontSize = 10,
                wordWrap = true,
                normal = { textColor = new Color(0.72f, 0.95f, 0.78f, 1f) }
            };

            _powerOnStyle = MakeButtonStyle(_texPwrOn, new Color(0f, 0f, 0f, 1f));
            _powerOnStyle.fontSize = 14;
            _powerOnStyle.fontStyle = FontStyle.Bold;

            _powerOffStyle = MakeButtonStyle(_texPwrOff, new Color(0.85f, 0.85f, 0.85f, 1f));
            _powerOffStyle.fontSize = 14;
            _powerOffStyle.fontStyle = FontStyle.Bold;

            _pttIdleStyle = new GUIStyle(GUI.skin.box)
            {
                normal = { background = _texPttIdle }
            };

            _pttLiveStyle = new GUIStyle(GUI.skin.box)
            {
                normal = { background = _texPttLive }
            };

            _iconBtnStyle = new GUIStyle(GUI.skin.button)
            {
                fontSize = 14,
                fontStyle = FontStyle.Bold,
                padding = new RectOffset(0, 0, 0, 0),
                alignment = TextAnchor.MiddleCenter
            };

            _statusStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleLeft,
                fontSize = 11,
                fontStyle = FontStyle.Italic,
                normal = { textColor = new Color(0.8f, 0.78f, 0.62f, 1f) }
            };

            // Top-bar buttons (ACR/CHK/close): inset background drawn separately so the button
            // itself has a transparent bg, leaving only the bold amber label on top of the inset.
            // Label-based style (so the inset background underneath stays untouched), but the
            // default label baseline sits low inside a 24px button — bump the text up with
            // contentOffset so ACR / CHK / X read centered instead of clinging to the bottom.
            _topBarBtnStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 12,
                fontStyle = FontStyle.Bold,
                padding = new RectOffset(0, 0, 0, 0),
                contentOffset = new Vector2(0f, -2f),
                normal = { textColor = new Color(0.85f, 0.83f, 0.7f, 1f) },
                hover = { textColor = new Color(1f, 0.95f, 0.78f, 1f) },
                active = { textColor = new Color(1f, 0.85f, 0.4f, 1f) }
            };

            _topBarBtnActiveStyle = new GUIStyle(_topBarBtnStyle)
            {
                normal = { textColor = new Color(0.5f, 1f, 0.6f, 1f) },
                hover = { textColor = new Color(0.7f, 1f, 0.8f, 1f) }
            };

            // High-contrast white-on-red for the ACR-unread alert: the red background already
            // carries the urgency, the label needs to read clearly across the blink phases.
            _topBarBtnAlertStyle = new GUIStyle(_topBarBtnStyle)
            {
                normal = { textColor = new Color(1f, 1f, 1f, 1f) },
                hover = { textColor = new Color(1f, 1f, 1f, 1f) },
                active = { textColor = new Color(1f, 0.95f, 0.95f, 1f) }
            };

            // ◀ / ▶: hit test only — arrows are <see cref="DrawPresetArrowInCircle"/> textures on Repaint.
            _arrowHitStyle = new GUIStyle(GUI.skin.box)
            {
                padding = new RectOffset(0, 0, 0, 0),
                margin = new RectOffset(0, 0, 0, 0),
                border = new RectOffset(0, 0, 0, 0),
                normal = { background = _texClear },
                hover = { background = _texClear },
                active = { background = _texClear },
                focused = { background = _texClear },
                onNormal = { background = _texClear },
                onHover = { background = _texClear },
                onActive = { background = _texClear },
                onFocused = { background = _texClear }
            };

            _utilityBtnStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 10,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.85f, 0.83f, 0.7f, 1f) },
                hover = { textColor = new Color(1f, 0.95f, 0.78f, 1f) },
                active = { textColor = new Color(1f, 0.85f, 0.4f, 1f) }
            };

            // "REQUEST LAUNCH" call-to-action: solid amber slab with bold black text so it
            // visually anchors the bottom of the panel without copying the green ON-AIR power
            // button's affordance. Disabled state uses a dim slab + grey text.
            _launchBtnStyle = MakeButtonStyle(_texLaunchBtn, new Color(0.05f, 0.04f, 0.02f, 1f));
            _launchBtnStyle.fontSize = 13;
            _launchBtnStyle.fontStyle = FontStyle.Bold;

            _launchBtnDisabledStyle = MakeButtonStyle(_texLaunchBtnDim, new Color(0.7f, 0.68f, 0.6f, 1f));
            _launchBtnDisabledStyle.fontSize = 13;
            _launchBtnDisabledStyle.fontStyle = FontStyle.Bold;

            _launchBtnApprovedStyle = MakeButtonStyle(_texLaunchBtnApproved, new Color(0.02f, 0.07f, 0.03f, 1f));
            _launchBtnApprovedStyle.fontSize = 13;
            _launchBtnApprovedStyle.fontStyle = FontStyle.Bold;

            // BCN/CAM toggle-switch labels. The body label ("TLM BEACON" / "HULL CAM") sits
            // centered in the slot; the right-aligned ON/OFF marker is bold and tinted by state
            // so the player can read the toggle position from across the screen without
            // hunting for the LED color.
            _switchLabelStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 11,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.9f, 0.88f, 0.78f, 1f) }
            };

            _switchStateOnStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleRight,
                fontSize = 11,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(1f, 0.85f, 0.4f, 1f) }
            };

            _switchStateOffStyle = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleRight,
                fontSize = 11,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.55f, 0.52f, 0.45f, 1f) }
            };
        }

        private static GUIStyle MakeButtonStyle(Texture2D bg, Color text)
        {
            var s = new GUIStyle(GUI.skin.button)
            {
                alignment = TextAnchor.MiddleCenter,
                normal = { background = bg, textColor = text },
                hover = { background = bg, textColor = text },
                active = { background = bg, textColor = text },
                focused = { background = bg, textColor = text },
                padding = new RectOffset(8, 8, 6, 6)
            };
            return s;
        }

        private static void EnsureTextures()
        {
            if (_texPanelDark != null)
            {
                return;
            }

            _texPanelDark = MakeTex(new Color32(28, 24, 20, 240));
            _texInset = MakeTex(new Color32(16, 14, 12, 255));
            _texTooltipBg = MakeTex(new Color32(54, 50, 44, 255));
            _texLcdBack = MakeTex(new Color32(8, 16, 8, 255));
            _texLedGreen = MakeTex(new Color32(70, 230, 90, 255));
            _texLedAmber = MakeTex(new Color32(255, 175, 60, 255));
            _texLedRed = MakeTex(new Color32(240, 70, 60, 255));
            _texLedDim = MakeTex(new Color32(40, 38, 32, 255));
            _texVuBg = MakeTex(new Color32(10, 10, 10, 255));
            _texVuGreen = MakeTex(new Color32(70, 200, 90, 255));
            _texVuYellow = MakeTex(new Color32(230, 200, 60, 255));
            _texVuRed = MakeTex(new Color32(230, 70, 50, 255));
            _texVuPeak = MakeTex(new Color32(255, 255, 255, 220));
            _texPwrOn = MakeTex(new Color32(70, 200, 90, 255));
            _texPwrOff = MakeTex(new Color32(50, 46, 40, 255));
            _texPttIdle = MakeTex(new Color32(60, 56, 48, 255));
            _texPttLive = MakeTex(new Color32(220, 60, 50, 255));
            _texDivider = MakeTex(new Color32(110, 95, 70, 255));
            _texLaunchBtn = MakeTex(new Color32(255, 175, 60, 255));
            _texLaunchBtnDim = MakeTex(new Color32(60, 50, 36, 255));
            // Full-slab green (same pattern as launch amber) when tower clears takeoff — not just green text on yellow.
            _texLaunchBtnApproved = MakeTex(new Color32(52, 175, 78, 255));

            // Annunciator-lamp bezel: very dark, slightly cooler than the inset so the lamps
            // read as "embedded in the panel face" rather than "another inset readout".
            _texLampBezel = MakeTex(new Color32(12, 11, 10, 255));

            // Toggle-switch backgrounds. Off = dim metallic grey-brown, on = warm amber-tinted
            // grey. Hover variants are a noticeable step lighter so the player gets a clear
            // "this is clickable" visual signal that the lamps above never give.
            _texSwitchOff = MakeTex(new Color32(58, 54, 46, 255));
            _texSwitchOffHover = MakeTex(new Color32(78, 72, 60, 255));
            _texSwitchOn = MakeTex(new Color32(96, 70, 28, 255));
            _texSwitchOnHover = MakeTex(new Color32(120, 88, 36, 255));

            // 1px top bevel — fakes a raised edge on a flat 2x2 texture.
            _texSwitchBevelOff = MakeTex(new Color32(110, 100, 84, 255));
            _texSwitchBevelOn = MakeTex(new Color32(220, 170, 80, 255));

            // Dim half of the ACR-alert blink — a deep bronze rather than full red so the
            // pulse reads as "annunciator flashing", not "two distinct buttons appearing".
            _texAcrAlertDim = MakeTex(new Color32(110, 30, 28, 255));
            // Recessed avionics panel + matte knob face (digit dials draw bezel on top).
            _texKnobWell = MakeTex(new Color32(5, 6, 8, 255));
            _texKnobFace = MakeKnobFaceTex();
            _texKnobBezel = MakeKnobBezelTex();
            _texClear = MakeTex(new Color32(0, 0, 0, 0));
            _texArrowLeft = MakePresetArrowTex(false);
            _texArrowRight = MakePresetArrowTex(true);
        }

        /// <summary>Brushed-metal-ish knob cap (IMGUI has no knob widget lib — this fakes depth).</summary>
        private static Texture2D MakeKnobFaceTex()
        {
            const int s = 32;
            var t = new Texture2D(s, s, TextureFormat.ARGB32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            var c = (s - 1) * 0.5f;
            var rMax = s * 0.46f;
            for (var y = 0; y < s; y++)
            {
                for (var x = 0; x < s; x++)
                {
                    var dx = x - c;
                    var dy = y - c;
                    var d = Mathf.Sqrt(dx * dx + dy * dy);
                    if (d > rMax)
                    {
                        t.SetPixel(x, y, new Color32(0, 0, 0, 0));
                        continue;
                    }

                    var u = d / rMax;
                    var ang = Mathf.Atan2(dy, dx);
                    var brush = Mathf.Sin(ang * 22f) * 0.04f + Mathf.Sin(ang * 9f + u * 10f) * 0.03f;
                    var lum = Mathf.Lerp(16f, 58f, u) + brush * 14f;
                    lum = Mathf.Clamp(lum, 10f, 68f);
                    var g = (byte)lum;
                    t.SetPixel(
                        x,
                        y,
                        new Color32(g, (byte)Mathf.Clamp(g - 4, 0, 255), (byte)Mathf.Clamp(g - 9, 0, 255), 255));
                }
            }

            t.Apply(false, true);
            return t;
        }

        private static Texture2D MakeKnobBezelTex()
        {
            const int s = 48;
            var t = new Texture2D(s, s, TextureFormat.ARGB32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            var c = (s - 1) * 0.5f;
            var rOuter = s * 0.49f;
            var rMid = s * 0.40f;
            var rInner = s * 0.30f;
            for (var y = 0; y < s; y++)
            {
                for (var x = 0; x < s; x++)
                {
                    var dx = x - c;
                    var dy = y - c;
                    var d = Mathf.Sqrt(dx * dx + dy * dy);
                    Color32 col;
                    if (d > rOuter)
                    {
                        col = new Color32(0, 0, 0, 0);
                    }
                    else if (d > rMid)
                    {
                        var u = (d - rMid) / (rOuter - rMid);
                        col = new Color32(
                            (byte)Mathf.Lerp(95f, 72f, u),
                            (byte)Mathf.Lerp(86f, 66f, u),
                            (byte)Mathf.Lerp(68f, 54f, u),
                            255);
                    }
                    else if (d > rInner)
                    {
                        var u = (d - rInner) / (rMid - rInner);
                        col = new Color32(
                            (byte)Mathf.Lerp(44f, 88f, u),
                            (byte)Mathf.Lerp(40f, 78f, u),
                            (byte)Mathf.Lerp(34f, 60f, u),
                            255);
                    }
                    else
                    {
                        var u = rInner > 0.01f ? d / rInner : 0f;
                        col = new Color32(
                            (byte)Mathf.Lerp(18f, 32f, u),
                            (byte)Mathf.Lerp(16f, 28f, u),
                            (byte)Mathf.Lerp(13f, 22f, u),
                            255);
                    }

                    t.SetPixel(x, y, col);
                }
            }

            t.Apply(false, true);
            return t;
        }

        private static Texture2D MakePresetArrowTex(bool pointRight)
        {
            const int s = 32;
            var t = new Texture2D(s, s, TextureFormat.ARGB32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            var fill = new Color32(224, 215, 175, 255);
            var clear = new Color32(0, 0, 0, 0);
            Vector2 tip;
            Vector2 leg1;
            Vector2 leg2;
            if (!pointRight)
            {
                tip = new Vector2(7f, s * 0.5f);
                leg1 = new Vector2(25f, 7f);
                leg2 = new Vector2(25f, s - 7f);
            }
            else
            {
                tip = new Vector2(s - 7f, s * 0.5f);
                leg1 = new Vector2(7f, 7f);
                leg2 = new Vector2(7f, s - 7f);
            }

            for (var y = 0; y < s; y++)
            {
                for (var x = 0; x < s; x++)
                {
                    var p = new Vector2(x + 0.5f, y + 0.5f);
                    t.SetPixel(x, y, PointInTriangle2d(p, tip, leg1, leg2) ? fill : clear);
                }
            }

            t.Apply(false, true);
            return t;
        }

        private static bool PointInTriangle2d(Vector2 p, Vector2 a, Vector2 b, Vector2 c)
        {
            var d1 = TriangleCrossSign(p, a, b);
            var d2 = TriangleCrossSign(p, b, c);
            var d3 = TriangleCrossSign(p, c, a);
            var hasNeg = (d1 < 0f) || (d2 < 0f) || (d3 < 0f);
            var hasPos = (d1 > 0f) || (d2 > 0f) || (d3 > 0f);
            return !(hasNeg && hasPos);
        }

        private static float TriangleCrossSign(Vector2 p1, Vector2 p2, Vector2 p3)
        {
            return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
        }

        private static Texture2D MakeTex(Color32 c)
        {
            var t = new Texture2D(2, 2, TextureFormat.ARGB32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                filterMode = FilterMode.Point,
                wrapMode = TextureWrapMode.Clamp
            };
            var px = new Color32[4] { c, c, c, c };
            t.SetPixels32(px);
            t.Apply(false, true);
            return t;
        }
    }
}
