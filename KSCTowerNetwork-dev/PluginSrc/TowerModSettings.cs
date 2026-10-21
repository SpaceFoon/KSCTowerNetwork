using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;
using SysDiag = System.Diagnostics;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Optional <c>GameData/KSCTowerNetwork/PluginData/settings.cfg</c> (node KSCTOWERNETWORK). Safe defaults if missing.
    /// </summary>
    public static class TowerModSettings
    {
        private const string RelPath = "GameData/KSCTowerNetwork/PluginData/settings.cfg";
        private const string AuthRelPath = "GameData/KSCTowerNetwork/PluginData/auth.cfg";
        private static bool _loaded;

        public static string ApiBaseUrl { get; private set; }

        /// <summary>
        /// Base URL of the tower web SPA, used for the toolbar's "open this in the browser"
        /// shortcuts (charts viewer, lobby deep links). Defaults to the Vite dev server on
        /// <c>http://127.0.0.1:45173</c> (see <c>web/vite.config.ts</c> which pins
        /// <c>strictPort: 45173</c>); override via <c>webBaseUrl = ...</c> in settings.cfg
        /// for prod deployments where the SPA is hosted alongside the API.
        /// </summary>
        public static string WebBaseUrl { get; private set; }
        public static string SessionId { get; private set; }
        /// <summary>ATC callsign for the active tower session (from claim-pilot or lobby). Sent as telemetry <c>callsign</c>.</summary>
        public static string SessionCallsign { get; private set; }
        /// <summary>Account default pilot callsign (login / auth.cfg). Per-vessel overrides live in <c>vessel_callsigns.cfg</c> — see <see cref="TowerVesselCallsignStore"/>.</summary>
        public static string PilotCallsign { get; private set; }
        public static string VoiceListenHost { get; private set; }
        public static int VoiceListenPort { get; private set; }
        public static string VoiceCtlHost { get; private set; }
        public static int VoiceCtlPort { get; private set; }

        /// <summary>
        /// Helmet listen output gain (0..1) for <see cref="TowerVoicePlayback"/>. Persisted to
        /// <c>auth.cfg</c>; optional <c>voiceListenVolume</c> in <c>settings.cfg</c> seeds the default.
        /// </summary>
        public static float VoiceListenVolume { get; private set; }

        public static bool AutoStartVoiceBridge { get; private set; }
        public static string BridgeExecutable { get; private set; }
        public static string BridgeWorkingDirectory { get; private set; }
        public static string BridgeArguments { get; private set; }

        public static bool AutoConnectVoiceListen { get; private set; }
        public static bool AutoBridgeMicAfterListen { get; private set; }

        /// <summary>
        /// When <c>true</c>, Chatterer + ASET fake ATC clips stay muted for the entire Flight scene
        /// (see <see cref="TowerChattererDuck"/>). When <c>false</c>, only PTT-based ducking applies.
        /// </summary>
        public static bool BlockChattererInFlight { get; private set; }

        public static float AutoConnectDelaySeconds { get; private set; }

        /// <summary>Hold this key in flight/KSC for tower mic PTT (Unity <see cref="KeyCode"/> name). <see cref="KeyCode.None"/> disables keyboard PTT.</summary>
        public static KeyCode PushToTalkKey { get; private set; }

        /// <summary>JWT from <c>POST /auth/login</c> (<c>tower_web</c>). Empty until login (unless <see cref="SkipTowerLogin"/>).</summary>
        public static string TowerAuthToken { get; private set; }

        /// <summary>Account email from the last successful login (for UI).</summary>
        public static string TowerAccountEmail { get; private set; }

        /// <summary>When true, KSP skips the login window and does not send a bearer token (for dev servers with <c>DEV_OPEN_AUTH</c>).</summary>
        public static bool SkipTowerLogin { get; private set; }

        /// <summary>Prefill email in the login form from settings.</summary>
        public static string SavedTowerEmail { get; private set; }

        /// <summary>Persist <see cref="SavedTowerEmail"/> when saving settings.</summary>
        public static bool RememberTowerEmail { get; private set; }

        /// <summary>Persist <see cref="TowerAuthToken"/> to settings.cfg when saving.</summary>
        public static bool PersistSessionToken { get; private set; }

        /// <summary>Channel presets shown on the radio's tune dial (comma-separated <c>channels</c> in settings.cfg). Always contains <see cref="SessionId"/>.</summary>
        public static string[] ChannelPresets { get; private set; }

        /// <summary>Enable the kOS &lt;-&gt; ACARS file-mailbox bridge. Disable to fully suppress reads/writes under the kOS Archive.</summary>
        public static bool KosBridgeEnabled { get; private set; }

        /// <summary>Path to the kOS Archive volume (relative to KSP root or absolute). Defaults to <c>Ships/Script</c>.</summary>
        public static string KosBridgeArchivePath { get; private set; }

        /// <summary>If true, the bridge auto-deploys <c>acars.ks</c> / <c>acars_lib.ks</c> to the Archive on first run when missing.</summary>
        public static bool KosBridgeAutoInstallScript { get; private set; }

        /// <summary>How often the bridge polls the backend and tails <c>acars-out.txt</c> (seconds). Clamped 1..60.</summary>
        public static float KosBridgePollSeconds { get; private set; }

        /// <summary>
        /// Player-facing "stream kOS to web" master switch. When true, <see cref="TowerKosScreenAutoCapture"/>
        /// reflectively walks every active kOS CPU's <c>IScreenBuffer</c> and forwards changed lines to the
        /// web Tower desk's kOS screen panel. Off = capture loop sleeps. Persisted to auth.cfg so it survives
        /// scene changes; defaults true so freshly-installed kOS "just works" with no opt-in steps.
        /// </summary>
        public static bool KosScreenStreamActive { get; private set; }

        /// <summary>
        /// Player-facing "telemetry beacon" master switch. When false, <see cref="TowerTelemetryPublisher"/>
        /// stops POSTing position/biome/etc. to the tower backend (the controller's screen freezes on the
        /// last known sample). Persisted to auth.cfg so it survives scene changes and game restarts.
        /// </summary>
        public static bool BeaconActive { get; private set; }

        /// <summary>
        /// When true, <see cref="TowerHullCamRelay"/> polls the local JustReadTheInstructions
        /// (JRTI) HTTP server during flight and pushes JPEG snapshots to the tower backend.
        /// Off by default — opt-in because it touches an external mod and consumes uplink.
        /// </summary>
        public static bool EnableHullCamRelay { get; private set; }

        /// <summary>Frames per second to push to tower (1 or 2; clamped at load).</summary>
        public static int HullCamFps { get; private set; }

        /// <summary>Base URL for JRTI's local HTTP server (default <c>http://127.0.0.1:8080</c>, JRTI's <c>StreamPort</c>).</summary>
        public static string HullCamJrtiBaseUrl { get; private set; }

        /// <summary>Hard cap on per-frame upload size; bigger frames are dropped to protect the backend body limit.</summary>
        public static int HullCamMaxBytes { get; private set; }

        /// <summary>
        /// When true, <see cref="TowerGhostFleet"/> polls <c>/v1/tower/active-aircraft</c> while the
        /// player is at KSC (and optionally in flight) and spawns render-only proxy aircraft so the
        /// player can see other live pilots in their world. Render-only — no physics, no collisions.
        /// Defaults true; the only reason to switch off is performance on very weak hardware.
        /// </summary>
        public static bool EnableGhostFleet { get; private set; }

        /// <summary>How often <see cref="TowerGhostFleet"/> hits the active-aircraft endpoint, seconds (1..10).</summary>
        public static float GhostFleetPollSeconds { get; private set; }

        /// <summary>Hard cap on simultaneously-spawned ghost proxies. Defaults 16.</summary>
        public static int GhostFleetMaxCount { get; private set; }

        /// <summary>
        /// Optional local-development UDP. Authenticated live traffic uses HTTPS; keep this disabled for normal use.
        /// </summary>
        public static bool UseUdpLiveTransport { get; private set; }

        /// <summary>UDP host for live traffic (backend listener).</summary>
        public static string LiveUdpHost { get; private set; }

        /// <summary>UDP port for live traffic (backend listener).</summary>
        public static int LiveUdpPort { get; private set; }

        /// <summary>Socket receive timeout (ms) for UDP request/reply calls.</summary>
        public static int LiveUdpTimeoutMs { get; private set; }

        /// <summary>If UDP fails, allow HTTP fallback paths for telemetry/ghost updates.</summary>
        public static bool LiveUdpFallbackHttp { get; private set; }

        /// <summary>
        /// Player's chosen "stock craft" silhouette key sent to other clients in telemetry so they
        /// see this pilot as a recognizable aircraft instead of a generic primitive. Valid keys are
        /// the canonical roster in <see cref="TowerGhostRoster"/>; an unknown / empty value falls
        /// back to the auto-derived <c>craftMapIcon</c> on the receiving side. Persisted to auth.cfg.
        /// </summary>
        public static string GhostCraftKey { get; private set; }

        /// <summary>
        /// Runtime flag: when true the local client is acting as a "Tower View" streamer rather than
        /// a pilot — the hullcam relay re-targets a <c>KSC-TOWER-*</c> session id and the telemetry
        /// publisher / scoring beacon is suppressed. Persisted to auth.cfg so it survives scene changes
        /// (the player toggles it from the radio panel; defaults off because it suppresses scoring).
        /// </summary>
        public static bool StreamAsTower { get; private set; }

        /// <summary>
        /// When true, after <see cref="TowerSessionAutoCall"/> creates or adopts the local pilot
        /// session it also POSTs <c>/v1/session/:id/claim-tower</c> so the same account holds the
        /// controller seat — i.e. solo "self-serve" mode where the player is both the pilot AND the
        /// tower for their own room. Useful for solo / dev play; the backend allows it because
        /// nothing in the role model forbids the same user from being both pilotUserId and
        /// assignedTowerUserId on a single session row. Backend gates the request on the
        /// <c>controller:assume</c> capability so a pure-pilot account can't bypass the queue this
        /// way.
        /// <para/>
        /// Default <c>true</c>: matches what most users intuitively expect ("if I'm a controller
        /// and I launch the game, my own room should be self-served unless someone else is already
        /// there"). Multiplayer setups can flip this off in <c>settings.cfg</c> via
        /// <c>selfServeTower = false</c> when they want the controller queue to do the assignment.
        /// </summary>
        public static bool SelfServeTower { get; private set; }

        /// <summary>
        /// Server-issued role string from the most recent <c>POST /auth/login</c> response
        /// (e.g. "guest", "pilot", "controller", "mod", "owner"). Used by UI to decide whether
        /// to show controller-only affordances (Stream as Tower toggle; Space Centre
        /// "Park at KSC tower" remains off — see docs/DISABLED_FEATURES.md).
        /// Empty until the next successful login.
        /// </summary>
        public static string TowerUserRole { get; private set; }

        /// <summary>
        /// Derived, stable per-account session id used when the local client is in Tower View
        /// stream mode. Hashes the lowercased <see cref="TowerAccountEmail"/> so the same account
        /// always streams under the same id (avoiding ghost proliferation on re-login). Backend
        /// gates this namespace via <c>isKscTowerSessionId</c>.
        /// </summary>
        public static string TowerStreamSessionId
        {
            get
            {
                EnsureLoaded();
                return ComputeTowerStreamSessionId(TowerAccountEmail);
            }
        }

        /// <summary>
        /// Maps an IVA COMM-radio dial frequency (MHz, e.g. <c>121.50</c>) to the corresponding
        /// KSCTowerNetwork channel session id. Populated from the <c>FREQUENCY_CHANNEL_MAP</c>
        /// node in <see cref="RelPath"/>; empty when no map is defined.
        /// </summary>
        /// <remarks>
        /// Comparison is by float key with a small epsilon in <see cref="TryResolveChannelForFrequency"/>;
        /// callers should never lookup the dictionary directly.
        /// </remarks>
        public static IDictionary<double, string> FrequencyChannelMap { get; private set; }

        /// <summary>Fired after <see cref="SessionId"/> changes (e.g. via <see cref="SetActiveChannel"/>) so IVA radio displays can re-tune.</summary>
        public static event Action<string> OnSessionIdChanged;

        private static SysDiag.Process _spawnedBridge;
        private static bool _registeredQuitHook;

        /// <summary>
        /// KSP may quit from the main menu before Flight/KSC addons run; still stop a child bridge if one was spawned.
        /// </summary>
        public static void EnsureVoiceBridgeKilledOnQuit()
        {
            if (_registeredQuitHook)
            {
                return;
            }

            _registeredQuitHook = true;
            Application.quitting += StopSpawnedVoiceBridgeIfAny;
        }

        public static void EnsureLoaded()
        {
            if (_loaded)
            {
                return;
            }

            _loaded = true;
            ApiBaseUrl = "http://127.0.0.1:48787/v1";
            WebBaseUrl = "http://127.0.0.1:45173";
            SessionId = "dev-shared";
            SessionCallsign = string.Empty;
            PilotCallsign = string.Empty;
            VoiceListenHost = "127.0.0.1";
            VoiceListenPort = 47372;
            VoiceCtlHost = "127.0.0.1";
            VoiceCtlPort = 47373;
            VoiceListenVolume = 1f;
            AutoStartVoiceBridge = false;
            BridgeExecutable = string.Empty;
            BridgeWorkingDirectory = string.Empty;
            BridgeArguments = string.Empty;
            AutoConnectVoiceListen = true;
            AutoBridgeMicAfterListen = false;
            // Default on: real tower + IVA PTT should not compete with Chatterer. Set
            // blockChattererInFlight = False in settings.cfg to allow stock chatter in flight.
            BlockChattererInFlight = true;
            AutoConnectDelaySeconds = 2.5f;
            PushToTalkKey = KeyCode.R;
            TowerAuthToken = string.Empty;
            TowerAccountEmail = string.Empty;
            SkipTowerLogin = false;
            SavedTowerEmail = string.Empty;
            RememberTowerEmail = true;
            PersistSessionToken = true;
            ChannelPresets = new[] { SessionId };
            KosBridgeEnabled = true;
            KosBridgeArchivePath = "Ships/Script";
            KosBridgeAutoInstallScript = true;
            KosBridgePollSeconds = 3f;
            KosScreenStreamActive = true;
            EnableHullCamRelay = false;
            HullCamFps = 1;
            HullCamJrtiBaseUrl = "http://127.0.0.1:8080";
            HullCamMaxBytes = 192000;
            BeaconActive = true;
            EnableGhostFleet = true;
            GhostFleetPollSeconds = 2f;
            GhostFleetMaxCount = 16;
            UseUdpLiveTransport = false;
            LiveUdpHost = "127.0.0.1";
            LiveUdpPort = 48788;
            LiveUdpTimeoutMs = 500;
            LiveUdpFallbackHttp = true;
            GhostCraftKey = string.Empty;
            StreamAsTower = false;
            SelfServeTower = true;
            TowerUserRole = string.Empty;
            FrequencyChannelMap = new Dictionary<double, string>();

            var root = KSPUtil.ApplicationRootPath;
            var cfgPath = Path.Combine(root, RelPath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(cfgPath))
            {
                // Still merge auth.cfg (voice volume, JWT, cockpit toggles) when settings.cfg
                // is missing — first install or hand-deleted file.
                LoadAuthOverlayIfPresent();
                return;
            }

            var file = ConfigNode.Load(cfgPath);
            if (file == null)
            {
                Debug.LogWarning("[KSCTowerNetwork] could not parse settings.cfg");
                LoadAuthOverlayIfPresent();
                return;
            }

            var node = file.GetNode("KSCTOWERNETWORK") ?? file;

            ApiBaseUrl = ResolveTowerApiBaseUrl(node);
            WebBaseUrl = NormalizeUrl(ReadString(node, "webBaseUrl", WebBaseUrl), WebBaseUrl);
            SessionId = ReadString(node, "sessionId", SessionId);
            PilotCallsign = ReadString(node, "pilotCallsign", PilotCallsign);
            if (string.IsNullOrEmpty(PilotCallsign))
            {
                PilotCallsign = ReadString(node, "pilotDisplayName", string.Empty);
            }
            VoiceListenHost = ReadString(node, "voiceListenHost", VoiceListenHost);
            VoiceCtlHost = ReadString(node, "voiceCtlHost", VoiceCtlHost);

            int p;
            if (int.TryParse(node.GetValue("voiceListenPort"), out p))
            {
                VoiceListenPort = p;
            }

            if (int.TryParse(node.GetValue("voiceCtlPort"), out p))
            {
                VoiceCtlPort = p;
            }

            float listenVol;
            if (float.TryParse(node.GetValue("voiceListenVolume"), NumberStyles.Float, CultureInfo.InvariantCulture, out listenVol))
            {
                VoiceListenVolume = Mathf.Clamp01(listenVol);
            }

            bool b;
            if (bool.TryParse(node.GetValue("autoStartVoiceBridge"), out b))
            {
                AutoStartVoiceBridge = b;
            }

            if (bool.TryParse(node.GetValue("autoConnectVoiceListen"), out b))
            {
                AutoConnectVoiceListen = b;
            }

            if (bool.TryParse(node.GetValue("autoBridgeMicAfterListen"), out b))
            {
                AutoBridgeMicAfterListen = b;
            }

            if (bool.TryParse(node.GetValue("blockChattererInFlight"), out b))
            {
                BlockChattererInFlight = b;
            }

            if (bool.TryParse(node.GetValue("selfServeTower"), out b))
            {
                SelfServeTower = b;
            }

            float delay;
            if (float.TryParse(node.GetValue("autoConnectDelaySeconds"), out delay) && delay >= 0f && delay < 60f)
            {
                AutoConnectDelaySeconds = delay;
            }

            PushToTalkKey = ParsePushToTalkKey(node);

            TowerAuthToken = ReadString(node, "towerAuthToken", TowerAuthToken);
            TowerAccountEmail = ReadString(node, "towerAccountEmail", TowerAccountEmail);
            SavedTowerEmail = ReadString(node, "savedTowerEmail", SavedTowerEmail);
            if (bool.TryParse(node.GetValue("skipTowerLogin"), out b))
            {
                SkipTowerLogin = b;
            }

            if (bool.TryParse(node.GetValue("rememberTowerEmail"), out b))
            {
                RememberTowerEmail = b;
            }

            if (bool.TryParse(node.GetValue("persistTowerSessionToken"), out b))
            {
                PersistSessionToken = b;
            }

            ChannelPresets = ParseChannelPresets(node.GetValue("channels"), SessionId);

            if (bool.TryParse(node.GetValue("kosBridgeEnabled"), out b))
            {
                KosBridgeEnabled = b;
            }

            KosBridgeArchivePath = ReadString(node, "kosBridgeArchivePath", KosBridgeArchivePath);

            if (bool.TryParse(node.GetValue("kosBridgeAutoInstallScript"), out b))
            {
                KosBridgeAutoInstallScript = b;
            }

            float kosPoll;
            if (float.TryParse(
                    node.GetValue("kosBridgePollSeconds"),
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out kosPoll)
                && kosPoll >= 1f
                && kosPoll <= 60f)
            {
                KosBridgePollSeconds = kosPoll;
            }

            // Honor legacy `kosScreenEnabled` settings.cfg key as the seed value for the new
            // runtime KosScreenStreamActive toggle, so existing installs that explicitly opted
            // out via kosScreenEnabled=false don't suddenly start streaming after upgrade.
            if (bool.TryParse(node.GetValue("kosScreenStreamActive"), out b)
                || bool.TryParse(node.GetValue("kosScreenEnabled"), out b))
            {
                KosScreenStreamActive = b;
            }

            if (bool.TryParse(node.GetValue("enableHullCamRelay"), out b))
            {
                EnableHullCamRelay = b;
            }

            int hullFps;
            if (int.TryParse(node.GetValue("hullCamFps"), out hullFps))
            {
                HullCamFps = Mathf.Clamp(hullFps, 1, 2);
            }

            var hullUrl = node.GetValue("hullCamJrtiBaseUrl");
            if (!string.IsNullOrEmpty(hullUrl))
            {
                var u = StripOuterQuotes(hullUrl.Trim());
                if (LooksLikeHttpUrl(u))
                {
                    // Strip trailing slash so request building can always concatenate "/cameras" etc.
                    HullCamJrtiBaseUrl = u.TrimEnd('/');
                }
            }

            int hullMax;
            if (int.TryParse(node.GetValue("hullCamMaxBytes"), out hullMax) && hullMax >= 8000 && hullMax <= 524288)
            {
                HullCamMaxBytes = hullMax;
            }

            if (bool.TryParse(node.GetValue("enableGhostFleet"), out b))
            {
                EnableGhostFleet = b;
            }

            float ghostPoll;
            if (float.TryParse(
                    node.GetValue("ghostFleetPollSeconds"),
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out ghostPoll)
                && ghostPoll >= 1f
                && ghostPoll <= 10f)
            {
                GhostFleetPollSeconds = ghostPoll;
            }

            int ghostMax;
            if (int.TryParse(node.GetValue("ghostFleetMaxCount"), out ghostMax) && ghostMax >= 0 && ghostMax <= 64)
            {
                GhostFleetMaxCount = ghostMax;
            }

            if (bool.TryParse(node.GetValue("useUdpLiveTransport"), out b))
            {
                UseUdpLiveTransport = b;
            }

            var udpHost = node.GetValue("liveUdpHost");
            if (!string.IsNullOrEmpty(udpHost))
            {
                LiveUdpHost = udpHost.Trim();
            }

            int udpPort;
            if (int.TryParse(node.GetValue("liveUdpPort"), out udpPort) && udpPort >= 1 && udpPort <= 65535)
            {
                LiveUdpPort = udpPort;
            }

            int udpTimeout;
            if (int.TryParse(node.GetValue("liveUdpTimeoutMs"), out udpTimeout) && udpTimeout >= 100 && udpTimeout <= 30000)
            {
                LiveUdpTimeoutMs = udpTimeout;
            }

            if (bool.TryParse(node.GetValue("liveUdpFallbackHttp"), out b))
            {
                LiveUdpFallbackHttp = b;
            }

            var ghostKey = node.GetValue("ghostCraftKey");
            if (!string.IsNullOrEmpty(ghostKey))
            {
                GhostCraftKey = TowerGhostRoster.Normalize(ghostKey.Trim());
            }

            var exe = node.GetValue("bridgeExecutable");
            if (!string.IsNullOrEmpty(exe))
            {
                BridgeExecutable = exe.Trim();
            }

            var wd = node.GetValue("bridgeWorkingDirectory");
            if (!string.IsNullOrEmpty(wd))
            {
                BridgeWorkingDirectory = wd.Trim();
            }

            var args = node.GetValue("bridgeArguments");
            if (args != null)
            {
                BridgeArguments = args.Trim();
            }

            FrequencyChannelMap = ParseFrequencyChannelMap(file);

            // auth.cfg is plugin-owned and overrides settings.cfg auth keys. settings.cfg is left
            // alone (preserving user comments) and is only read for legacy installs.
            LoadAuthOverlayIfPresent();
        }

        /// <summary>
        /// Reads a top-level <c>FREQUENCY_CHANNEL_MAP { 121.50 = ksc-tower ... }</c> node from
        /// settings.cfg. Returns a fresh dictionary so callers can swap pointers safely.
        /// </summary>
        private static IDictionary<double, string> ParseFrequencyChannelMap(ConfigNode file)
        {
            var map = new Dictionary<double, string>();
            if (file == null)
            {
                return map;
            }

            var node = file.GetNode("FREQUENCY_CHANNEL_MAP");
            if (node == null)
            {
                return map;
            }

            foreach (ConfigNode.Value v in node.values)
            {
                double freq;
                if (string.IsNullOrEmpty(v.name) ||
                    !double.TryParse(v.name, NumberStyles.Float, CultureInfo.InvariantCulture, out freq))
                {
                    continue;
                }

                var channel = (v.value ?? string.Empty).Trim();
                if (channel.Length == 0)
                {
                    continue;
                }

                map[freq] = channel;
            }

            return map;
        }

        /// <summary>
        /// Look up the channel session id for an IVA COMM-radio frequency. Uses a small epsilon so
        /// floating-point persisted dial values (e.g. 121.4999999) still match a 121.50 entry.
        /// </summary>
        public static bool TryResolveChannelForFrequency(double freqMhz, out string channel)
        {
            channel = null;
            EnsureLoaded();
            var map = FrequencyChannelMap;
            if (map == null || map.Count == 0)
            {
                return false;
            }

            const double epsilon = 0.005; // 5 kHz — tighter than any legal IVA tune step (25 kHz).
            foreach (var kvp in map)
            {
                if (Math.Abs(kvp.Key - freqMhz) <= epsilon)
                {
                    channel = kvp.Value;
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Reverse direction of <see cref="TryResolveChannelForFrequency"/>: given the active
        /// session id, find the matching IVA frequency (so a UI channel switch can write the
        /// dial). First match wins when multiple frequencies map to the same channel.
        /// </summary>
        public static bool TryResolveFrequencyForChannel(string channel, out double freqMhz)
        {
            freqMhz = 0;
            EnsureLoaded();
            if (string.IsNullOrEmpty(channel))
            {
                return false;
            }

            var map = FrequencyChannelMap;
            if (map == null || map.Count == 0)
            {
                return false;
            }

            foreach (var kvp in map)
            {
                if (string.Equals(kvp.Value, channel, StringComparison.Ordinal))
                {
                    freqMhz = kvp.Key;
                    return true;
                }
            }

            return false;
        }

        private static void LoadAuthOverlayIfPresent()
        {
            var root = KSPUtil.ApplicationRootPath;
            var authPath = Path.Combine(root, AuthRelPath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(authPath))
            {
                return;
            }

            var file = ConfigNode.Load(authPath);
            if (file == null)
            {
                Debug.LogWarning("[KSCTowerNetwork] could not parse auth.cfg");
                return;
            }

            var node = file.GetNode("KSCTOWERNETWORK_AUTH") ?? file;
            var v = node.GetValue("towerAuthToken");
            if (v != null)
            {
                TowerAuthToken = TowerSecureStore.Unprotect(v.Trim());
            }

            v = node.GetValue("towerAccountEmail");
            if (v != null)
            {
                TowerAccountEmail = TowerSecureStore.Unprotect(v.Trim());
            }

            v = node.GetValue("savedTowerEmail");
            if (v != null)
            {
                SavedTowerEmail = TowerSecureStore.Unprotect(v.Trim());
            }

            v = node.GetValue("pilotCallsign");
            if (!string.IsNullOrEmpty(v))
            {
                PilotCallsign = v.Trim();
            }
            else
            {
                v = node.GetValue("pilotDisplayName");
                if (!string.IsNullOrEmpty(v))
                {
                    PilotCallsign = v.Trim();
                }
            }

            v = node.GetValue("activeSessionId");
            if (!string.IsNullOrEmpty(v))
            {
                SessionId = v.Trim();
                // Older builds stored ATIS MHz here; SessionId must be a server room slug/UUID for LiveKit tokens.
                if (string.Equals(SessionId, "128.250", StringComparison.Ordinal))
                {
                    SessionId = "ksc-radio-twr";
                    SaveSettingsToDisk();
                }
            }

            v = node.GetValue("sessionCallsign");
            if (!string.IsNullOrEmpty(v))
            {
                var sc = v.Trim();
                SessionCallsign = sc.Length > 64 ? sc.Substring(0, 64) : sc;
            }

            v = node.GetValue("channels");
            if (!string.IsNullOrEmpty(v))
            {
                ChannelPresets = ParseChannelPresets(v, SessionId);
            }
            else
            {
                ChannelPresets = new[] { SessionId };
            }

            bool b;
            if (bool.TryParse(node.GetValue("rememberTowerEmail"), out b))
            {
                RememberTowerEmail = b;
            }

            if (bool.TryParse(node.GetValue("persistTowerSessionToken"), out b))
            {
                PersistSessionToken = b;
            }

            if (bool.TryParse(node.GetValue("enableHullCamRelay"), out b))
            {
                EnableHullCamRelay = b;
            }

            if (bool.TryParse(node.GetValue("beaconActive"), out b))
            {
                BeaconActive = b;
            }

            if (bool.TryParse(node.GetValue("kosScreenStreamActive"), out b))
            {
                KosScreenStreamActive = b;
            }

            if (bool.TryParse(node.GetValue("enableGhostFleet"), out b))
            {
                EnableGhostFleet = b;
            }

            v = node.GetValue("ghostCraftKey");
            if (!string.IsNullOrEmpty(v))
            {
                GhostCraftKey = TowerGhostRoster.Normalize(v.Trim());
            }

            if (bool.TryParse(node.GetValue("streamAsTower"), out b))
            {
                StreamAsTower = b;
            }

            v = node.GetValue("towerUserRole");
            if (!string.IsNullOrEmpty(v))
            {
                TowerUserRole = v.Trim();
            }

            v = node.GetValue("voiceListenVolume");
            if (!string.IsNullOrEmpty(v))
            {
                float listenVol;
                if (float.TryParse(v.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out listenVol))
                {
                    VoiceListenVolume = Mathf.Clamp01(listenVol);
                }
            }

        }

        private static string ReadString(ConfigNode node, string key, string fallback)
        {
            var v = node.GetValue(key);
            return string.IsNullOrEmpty(v) ? fallback : v.Trim();
        }

        /// <summary>Persist pilot callsign to <see cref="RelPath"/> and update <see cref="PilotCallsign"/>.</summary>
        public static void SavePilotCallsign(string name)
        {
            EnsureLoaded();
            var t = (name ?? string.Empty).Trim();
            if (t.Length > 120)
            {
                t = t.Substring(0, 120);
            }

            PilotCallsign = t;
            SaveSettingsToDisk();
            Debug.Log("[KSCTowerNetwork] pilotCallsign saved to " + Path.Combine(KSPUtil.ApplicationRootPath, RelPath.Replace('/', Path.DirectorySeparatorChar)));
        }

        /// <summary>Persist <see cref="SessionCallsign"/> to auth.cfg (max 64 chars). No-op if unchanged.</summary>
        public static void SetSessionCallsign(string callsign)
        {
            EnsureLoaded();
            var t = (callsign ?? string.Empty).Trim();
            if (t.Length > 64)
            {
                t = t.Substring(0, 64);
            }

            if (string.Equals(SessionCallsign ?? string.Empty, t, StringComparison.Ordinal))
            {
                return;
            }

            SessionCallsign = t;
            SaveSettingsToDisk();
        }

        /// <summary>Persist helmet listen output level (0..1) and push it to <see cref="TowerVoicePlayback"/> if present.</summary>
        public static void SetVoiceListenVolume(float volume)
        {
            EnsureLoaded();
            var v = Mathf.Clamp01(volume);
            if (Mathf.Abs(VoiceListenVolume - v) < 0.0005f)
            {
                return;
            }

            VoiceListenVolume = v;
            SaveSettingsToDisk();
            TowerVoicePlayback.RefreshListenVolumeFromSettings();
        }

        /// <summary>After successful <c>POST /auth/login</c>: store JWT, optional email prefs, pilot callsign from login or account email.</summary>
        /// <param name="pilotNameFromLogin">Trimmed callsign from the login form; empty uses email local-part when <see cref="PilotCallsign"/> is unset.</param>
        public static void ApplyTowerLoginSuccess(
            string token,
            string accountEmail,
            string typedEmailForRemember,
            bool rememberEmail,
            bool persistToken,
            string pilotNameFromLogin = null)
        {
            EnsureLoaded();
            TowerAuthToken = token ?? string.Empty;
            RememberTowerEmail = rememberEmail;
            PersistSessionToken = persistToken;
            SavedTowerEmail = rememberEmail ? (typedEmailForRemember ?? string.Empty).Trim() : string.Empty;

            var em = (accountEmail ?? typedEmailForRemember ?? string.Empty).Trim();
            TowerAccountEmail = em;

            var requested = (pilotNameFromLogin ?? string.Empty).Trim();
            if (requested.Length > 0)
            {
                PilotCallsign = requested.Length > 120 ? requested.Substring(0, 120) : requested;
            }
            else if (string.IsNullOrEmpty(PilotCallsign))
            {
                // Seed from email local-part when the user has not set a callsign (settings.cfg / auth.cfg).
                var pilot = em;
                var at = em.IndexOf('@');
                if (at > 0)
                {
                    pilot = em.Substring(0, at);
                }

                pilot = pilot.Trim();
                if (pilot.Length > 120)
                {
                    pilot = pilot.Substring(0, 120);
                }

                PilotCallsign = pilot;
            }

            SaveSettingsToDisk();
        }

        /// <summary>
        /// Replace the persisted auth token in place — used by the tower_web → plugin_session
        /// self-heal in <see cref="TowerSessionAutoCall"/> when an old auth.cfg still holds a
        /// `tower_web` JWT (predates the exchange step in <see cref="TowerLoginGui"/>) and
        /// the backend keeps 403'ing pilot-rank /v1/session/call. No-op when the new token
        /// matches the existing one or is empty (we never want to clobber a working token
        /// with a failed-exchange null).
        /// </summary>
        public static void SetTowerAuthToken(string token)
        {
            EnsureLoaded();
            var t = token ?? string.Empty;
            if (t.Length == 0 || string.Equals(t, TowerAuthToken ?? string.Empty, StringComparison.Ordinal))
            {
                return;
            }

            TowerAuthToken = t;
            SaveSettingsToDisk();
        }

        /// <summary>Persist the in-game HullCam relay toggle. Reads back via <see cref="EnableHullCamRelay"/>.</summary>
        public static void SetHullCamRelayEnabled(bool enabled)
        {
            EnsureLoaded();
            if (EnableHullCamRelay == enabled)
            {
                return;
            }

            EnableHullCamRelay = enabled;
            SaveSettingsToDisk();
        }

        /// <summary>Toggle the ghost-fleet rendering pass at runtime. Persisted to auth.cfg.</summary>
        public static void SetGhostFleetEnabled(bool enabled)
        {
            EnsureLoaded();
            if (EnableGhostFleet == enabled)
            {
                return;
            }

            EnableGhostFleet = enabled;
            SaveSettingsToDisk();
        }

        /// <summary>
        /// Persist the player's chosen "what stock craft do other pilots see me as" key. Unknown
        /// keys are normalized to the closest valid roster entry (or empty for "auto-detect from
        /// vessel type"). Persisted to auth.cfg so the next session uses the same livery.
        /// </summary>
        public static void SetGhostCraftKey(string key)
        {
            EnsureLoaded();
            var normalized = TowerGhostRoster.Normalize(key ?? string.Empty);
            if (string.Equals(GhostCraftKey ?? string.Empty, normalized, StringComparison.Ordinal))
            {
                return;
            }

            GhostCraftKey = normalized;
            SaveSettingsToDisk();
        }

        /// <summary>
        /// Flip the "Stream as Tower" mode on/off and persist. When on, the hullcam relay re-targets
        /// the user's stable <see cref="TowerStreamSessionId"/> and the telemetry beacon is forced off
        /// (so the player doesn't appear as both a ghost AND a tower window for everyone else).
        /// </summary>
        public static void SetStreamAsTower(bool active)
        {
            EnsureLoaded();
            if (StreamAsTower == active)
            {
                return;
            }

            StreamAsTower = active;
            SaveSettingsToDisk();
        }

        /// <summary>Persist the role string from <c>POST /auth/login</c>'s response.</summary>
        public static void SetTowerUserRole(string role)
        {
            EnsureLoaded();
            var t = (role ?? string.Empty).Trim();
            if (string.Equals(TowerUserRole, t, StringComparison.Ordinal))
            {
                return;
            }

            TowerUserRole = t;
            SaveSettingsToDisk();
        }

        /// <summary>
        /// Stable, per-account session id used in tower-stream mode. We hash the account email so
        /// every login of the same account produces the same id (no orphan ghost streams). The
        /// fallback path (no email yet) returns a transient id that the backend will accept but
        /// that won't survive a restart — that's deliberate: anonymous guests shouldn't be able to
        /// silently accumulate persistent stream ids.
        /// </summary>
        private static string ComputeTowerStreamSessionId(string accountEmail)
        {
            var seed = (accountEmail ?? string.Empty).Trim().ToLowerInvariant();
            if (seed.Length == 0)
            {
                seed = "anon-" + Environment.MachineName;
            }

            // Stable, short, URL-safe digest. SHA-1 is plenty for a user-id namespace and matches
            // the [A-Za-z0-9_-]{1,40} regex enforced by isKscTowerSessionId in the backend.
            using (var sha = System.Security.Cryptography.SHA1.Create())
            {
                var bytes = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(seed));
                var sb = new System.Text.StringBuilder(2 * bytes.Length);
                for (int i = 0; i < bytes.Length && i < 16; i++)
                {
                    sb.Append(bytes[i].ToString("x2"));
                }
                return "KSC-TOWER-" + sb.ToString();
            }
        }

        /// <summary>Toggle the telemetry beacon. Off = no telemetry POSTs leave the game until re-enabled.</summary>
        public static void SetBeaconActive(bool active)
        {
            EnsureLoaded();
            if (BeaconActive == active)
            {
                return;
            }

            BeaconActive = active;
            SaveSettingsToDisk();
        }

        /// <summary>
        /// Toggle the kOS-screen stream. Off = <see cref="TowerKosScreenAutoCapture"/> stops walking
        /// kOS CPUs and posting changed lines. Persisted to auth.cfg, so the player's choice survives
        /// scene changes and game restarts (matches the Beacon/HullCam pattern).
        /// </summary>
        public static void SetKosScreenStreamActive(bool active)
        {
            EnsureLoaded();
            if (KosScreenStreamActive == active)
            {
                return;
            }

            KosScreenStreamActive = active;
            SaveSettingsToDisk();
        }

        /// <summary>Clear session token (logout). Does not change <see cref="SkipTowerLogin"/>.</summary>
        public static void ClearTowerAuth()
        {
            EnsureLoaded();
            TowerAuthToken = string.Empty;
            TowerAccountEmail = string.Empty;
            SessionCallsign = string.Empty;
            SaveSettingsToDisk();
        }

        /// <summary>
        /// Persist auth + pilot bits to <see cref="AuthRelPath"/>. We deliberately do NOT touch
        /// <see cref="RelPath"/> because <see cref="ConfigNode.Save"/> would strip the user's // comments
        /// and any keys we do not know about.
        /// </summary>
        private static void SaveSettingsToDisk()
        {
            var root = KSPUtil.ApplicationRootPath;
            var authPath = Path.Combine(root, AuthRelPath.Replace('/', Path.DirectorySeparatorChar));
            var dir = Path.GetDirectoryName(authPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var file = new ConfigNode();
            var knode = file.AddNode("KSCTOWERNETWORK_AUTH");
            knode.AddValue("pilotCallsign", PilotCallsign ?? string.Empty);
            knode.AddValue("pilotDisplayName", PilotCallsign ?? string.Empty);
            // Email is mildly identifying PII; encrypt it on Windows alongside the JWT so a
            // copied auth.cfg doesn't reveal who the player logs in as.
            knode.AddValue("towerAccountEmail", TowerSecureStore.Protect(TowerAccountEmail ?? string.Empty));
            knode.AddValue("savedTowerEmail", TowerSecureStore.Protect(SavedTowerEmail ?? string.Empty));
            knode.AddValue("rememberTowerEmail", RememberTowerEmail.ToString());
            knode.AddValue("persistTowerSessionToken", PersistSessionToken.ToString());
            knode.AddValue("enableHullCamRelay", EnableHullCamRelay.ToString());
            knode.AddValue("beaconActive", BeaconActive.ToString());
            knode.AddValue("kosScreenStreamActive", KosScreenStreamActive.ToString());
            knode.AddValue("enableGhostFleet", EnableGhostFleet.ToString());
            knode.AddValue("ghostCraftKey", GhostCraftKey ?? string.Empty);
            knode.AddValue("streamAsTower", StreamAsTower.ToString());
            knode.AddValue("towerUserRole", TowerUserRole ?? string.Empty);
            knode.AddValue("voiceListenVolume", VoiceListenVolume.ToString(CultureInfo.InvariantCulture));
            knode.AddValue("activeSessionId", SessionId ?? string.Empty);
            knode.AddValue("sessionCallsign", SessionCallsign ?? string.Empty);
            if (ChannelPresets != null && ChannelPresets.Length > 0)
            {
                knode.AddValue("channels", string.Join(",", ChannelPresets));
            }
            if (PersistSessionToken && !string.IsNullOrEmpty(TowerAuthToken))
            {
                // DPAPI on Windows; legacy plaintext on other platforms with a one-time warning.
                knode.AddValue("towerAuthToken", TowerSecureStore.Protect(TowerAuthToken));
            }

            file.Save(authPath);
        }

        /// <summary>
        /// Optional <c>channels=</c> from settings (comma/semicolon). Ensures <paramref name="currentSession"/>
        /// appears once. Used only when loading settings — runtime channel changes use a single id.
        /// </summary>
        private static string[] ParseChannelPresets(string raw, string currentSession)
        {
            var list = new System.Collections.Generic.List<string>();
            var seen = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);

            if (!string.IsNullOrEmpty(raw))
            {
                foreach (var part in raw.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    AppendPresetIfNew(list, seen, part);
                }
            }

            AppendPresetIfNew(list, seen, currentSession);
            return list.ToArray();
        }

        private static void AppendPresetIfNew(
            System.Collections.Generic.List<string> list,
            System.Collections.Generic.HashSet<string> seen,
            string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return;
            }

            var t = raw.Trim();
            if (t.Length == 0 || !seen.Add(t))
            {
                return;
            }

            list.Add(t);
        }

        /// <summary>
        /// Switches the active tower channel (session id) at runtime: updates <see cref="SessionId"/>,
        /// saves to disk, and force-respawns the voice bridge with the new <c>SESSION_ID</c> env so audio
        /// follows the new room. Returns true if the bridge was respawned (or no respawn was needed).
        /// </summary>
        public static bool SetActiveChannel(string newSessionId)
        {
            EnsureLoaded();
            var t = (newSessionId ?? string.Empty).Trim();
            if (t.Length == 0 || string.Equals(t, SessionId, StringComparison.Ordinal))
            {
                return true;
            }

            SessionId = t;
            SessionCallsign = string.Empty;
            // One logical channel at a time — do not accumulate every visited room id into a
            // preset list (that produced endless UUID/slug "channels" when stepping arrows).
            ChannelPresets = new[] { t };
            SaveSettingsToDisk();

            // Fire AFTER persistence so subscribers (e.g. TowerCommRadioFreqSync writing the dial)
            // see the new SessionId on disk too. Wrap in try/catch so a buggy subscriber can't
            // block the bridge respawn below.
            var handler = OnSessionIdChanged;
            if (handler != null)
            {
                try
                {
                    handler(t);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[KSCTowerNetwork] OnSessionIdChanged subscriber threw: " + ex);
                }
            }

            // Tell any already-running bridge to follow the tune even if we don't
            // (or can't) respawn its process. Two cases this matters for:
            //   - Dev: `npm run dev` spawns the bridge once with SESSION_ID env-locked
            //     to "dev-shared". We can't restart it from here, so without this the
            //     bridge would stay on dev-shared no matter what the player tuned to.
            //   - Prod: even when we DO respawn (BridgeExecutable set), the new bridge
            //     boots with the new SESSION_ID env. Sending SESSION: is a no-op there
            //     (the new process won't see it until its control port is bound). We
            //     send anyway, harmlessly: the older process will just have already
            //     exited, and the send fails silently in TowerVoiceBridgeControl.
            try
            {
                TowerVoiceBridgeControl.EnqueueSend(
                    VoiceCtlHost,
                    VoiceCtlPort,
                    "SESSION:" + t,
                    null);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] SESSION: send threw — " + ex.Message);
            }

            if (string.IsNullOrEmpty(BridgeExecutable))
            {
                Debug.Log("[KSCTowerNetwork] Channel changed to \"" + t + "\" (no bridge respawn — bridgeExecutable empty).");
                return true;
            }

            return TryRespawnVoiceBridgeProcess();
        }

        private static KeyCode ParsePushToTalkKey(ConfigNode node)
        {
            var def = KeyCode.R;
            var raw = node.GetValue("pushToTalkKey");
            if (string.IsNullOrEmpty(raw))
            {
                return def;
            }

            raw = raw.Trim();
            if (raw.Equals("None", StringComparison.OrdinalIgnoreCase) || raw == "-")
            {
                return KeyCode.None;
            }

            try
            {
                return (KeyCode)Enum.Parse(typeof(KeyCode), raw, true);
            }
            catch (Exception)
            {
                Debug.LogWarning(
                    "[KSCTowerNetwork] settings.cfg pushToTalkKey invalid: \"" + raw +
                    "\" (Unity KeyCode name, e.g. R, BackQuote, LeftShift). Using R.");
                return def;
            }
        }

        /// <summary>
        /// KSP <see cref="ConfigNode"/> treats <c>//</c> in a value as the start of an end-of-line comment, so
        /// <c>towerApiBaseUrl = http://127.0.0.1:48787/v1</c> is parsed as <c>http:</c> only. Prefer
        /// <c>towerApiHost</c>/<c>towerApiPort</c>/<c>towerApiPath</c>, or a quoted full URL.
        /// </summary>
        private static string ResolveTowerApiBaseUrl(ConfigNode node)
        {
            var raw = node.GetValue("towerApiBaseUrl");
            if (!string.IsNullOrEmpty(raw))
            {
                var u = StripOuterQuotes(raw.Trim());
                if (LooksLikeHttpUrl(u))
                {
                    return u;
                }

                Debug.LogWarning(
                    "[KSCTowerNetwork] settings.cfg towerApiBaseUrl looks broken (KSP comments strip after //). " +
                    "Using towerApiHost/towerApiPort/towerApiPath instead. Parsed value was: \"" + u + "\"");
            }

            var host = ReadString(node, "towerApiHost", "127.0.0.1");
            var path = ReadString(node, "towerApiPath", "/v1");
            if (string.IsNullOrEmpty(path))
            {
                path = "/v1";
            }

            if (!path.StartsWith("/", StringComparison.Ordinal))
            {
                path = "/" + path;
            }

            var port = 48787;
            int parsedPort;
            if (int.TryParse(node.GetValue("towerApiPort"), out parsedPort) && parsedPort > 0 && parsedPort < 65536)
            {
                port = parsedPort;
            }

            var tls = false;
            bool parsedTls;
            if (bool.TryParse(node.GetValue("towerApiTls"), out parsedTls))
            {
                tls = parsedTls;
            }

            var scheme = tls ? "https" : "http";
            return scheme + "://" + host + ":" + port + path;
        }

        /// <summary>
        /// Validate a URL pulled from <c>settings.cfg</c>. KSP's ConfigNode treats <c>//</c> as a
        /// comment, so unquoted <c>http://...</c> values get truncated to <c>http:</c>; we strip
        /// outer quotes, sanity-check, then trim a trailing slash so callers can always do
        /// <c>WebBaseUrl + "/some/path"</c>. Empty/invalid input falls back to <paramref name="def"/>.
        /// </summary>
        private static string NormalizeUrl(string raw, string def)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return def;
            }

            var u = StripOuterQuotes(raw.Trim());
            if (!LooksLikeHttpUrl(u))
            {
                Debug.LogWarning(
                    "[KSCTowerNetwork] settings.cfg URL looks broken (KSP comments strip after //): \"" +
                    u + "\". Falling back to \"" + def + "\".");
                return def;
            }

            return u.TrimEnd('/');
        }

        private static string StripOuterQuotes(string s)
        {
            if (string.IsNullOrEmpty(s) || s.Length < 2)
            {
                return s;
            }

            var a = s[0];
            var b = s[s.Length - 1];
            if ((a == '"' && b == '"') || (a == '\'' && b == '\''))
            {
                return s.Substring(1, s.Length - 2).Trim();
            }

            return s;
        }

        private static bool LooksLikeHttpUrl(string u)
        {
            if (string.IsNullOrEmpty(u) || u.Length < 12)
            {
                return false;
            }

            if (u.IndexOf("://", StringComparison.Ordinal) < 0)
            {
                return false;
            }

            Uri uri;
            return Uri.TryCreate(u, UriKind.Absolute, out uri) &&
                   (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);
        }

        /// <summary>True when a bridge process was spawned by us and is still running.</summary>
        public static bool IsSpawnedVoiceBridgeAlive
        {
            get
            {
                if (_spawnedBridge == null)
                {
                    return false;
                }

                try
                {
                    return !_spawnedBridge.HasExited;
                }
                catch
                {
                    return false;
                }
            }
        }

        /// <summary>PID of the spawned bridge process (0 if none).</summary>
        public static int SpawnedVoiceBridgePid
        {
            get
            {
                try
                {
                    return _spawnedBridge != null ? _spawnedBridge.Id : 0;
                }
                catch
                {
                    return 0;
                }
            }
        }

        /// <summary>Starts the bridge process if configured; safe to call once at game boot.</summary>
        public static void TrySpawnVoiceBridgeProcess()
        {
            EnsureLoaded();
            if (!AutoStartVoiceBridge)
            {
                return;
            }

            SpawnVoiceBridgeProcessCore(forceRestart: false);
        }

        /// <summary>
        /// Force-(re)spawn the bridge process regardless of <see cref="AutoStartVoiceBridge"/>. Intended for
        /// recovery when the bridge has died mid-session. Returns true if a live process exists after the call.
        /// </summary>
        public static bool TryRespawnVoiceBridgeProcess()
        {
            EnsureLoaded();
            return SpawnVoiceBridgeProcessCore(forceRestart: true);
        }

        private static bool SpawnVoiceBridgeProcessCore(bool forceRestart)
        {
            if (_spawnedBridge != null)
            {
                bool alive;
                try
                {
                    alive = !_spawnedBridge.HasExited;
                }
                catch
                {
                    alive = false;
                }

                if (alive && !forceRestart)
                {
                    return true;
                }

                if (alive)
                {
                    StopSpawnedVoiceBridgeIfAny();
                }
                else
                {
                    try
                    {
                        _spawnedBridge.Dispose();
                    }
                    catch
                    {
                        /* ignore */
                    }

                    _spawnedBridge = null;
                }
            }

            if (string.IsNullOrEmpty(BridgeExecutable))
            {
                Debug.LogWarning("[KSCTowerNetwork] cannot (re)spawn voice bridge: bridgeExecutable is empty in settings.cfg");
                return false;
            }

            var root = KSPUtil.ApplicationRootPath;
            var exePath = ResolveUnderKspRoot(root, BridgeExecutable);
            if (string.IsNullOrEmpty(exePath))
            {
                // ResolveUnderKspRoot already logged the rejection reason.
                return false;
            }
            if (!File.Exists(exePath))
            {
                Debug.LogWarning("[KSCTowerNetwork] bridge executable not found: " + exePath);
                return false;
            }

            var workDir = string.IsNullOrEmpty(BridgeWorkingDirectory)
                ? Path.GetDirectoryName(exePath)
                : ResolveUnderKspRoot(root, BridgeWorkingDirectory);
            if (string.IsNullOrEmpty(workDir) || !Directory.Exists(workDir))
            {
                Debug.LogWarning("[KSCTowerNetwork] bridge working directory missing: " + workDir);
                return false;
            }

            try
            {
                var psi = new SysDiag.ProcessStartInfo
                {
                    FileName = exePath,
                    Arguments = BridgeArguments ?? string.Empty,
                    WorkingDirectory = workDir,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                psi.EnvironmentVariables["SESSION_ID"] = SessionId;
                psi.EnvironmentVariables["TOWER_API_BASE"] = ApiBaseUrl;

                var file = ConfigNode.Load(Path.Combine(root, RelPath.Replace('/', Path.DirectorySeparatorChar)));
                if (file != null)
                {
                    var node = file.GetNode("KSCTOWERNETWORK") ?? file;
                    ApplyOptionalBridgeEnv(psi, node, "bridgeEnv_PCM_HOST", "PCM_HOST");
                    ApplyOptionalBridgeEnv(psi, node, "bridgeEnv_PCM_PORT", "PCM_PORT");
                    ApplyOptionalBridgeEnv(psi, node, "bridgeEnv_CTL_HOST", "CTL_HOST");
                    ApplyOptionalBridgeEnv(psi, node, "bridgeEnv_CTL_PORT", "CTL_PORT");
                    ApplyOptionalBridgeEnv(psi, node, "bridgeEnv_BRIDGE_IDENTITY", "BRIDGE_IDENTITY");
                }

                _spawnedBridge = SysDiag.Process.Start(psi);
                if (_spawnedBridge == null)
                {
                    Debug.LogWarning("[KSCTowerNetwork] Process.Start returned null for voice bridge");
                    return false;
                }

                EnsureVoiceBridgeKilledOnQuit();
                Debug.Log("[KSCTowerNetwork] started voice bridge process pid=" + _spawnedBridge.Id);
                return true;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] failed to start voice bridge: " + ex);
                return false;
            }
        }

        private static void ApplyOptionalBridgeEnv(
            SysDiag.ProcessStartInfo psi,
            ConfigNode node,
            string cfgKey,
            string envKey)
        {
            var v = node.GetValue(cfgKey);
            if (!string.IsNullOrEmpty(v))
            {
                psi.EnvironmentVariables[envKey] = v.Trim();
            }
        }

        public static void StopSpawnedVoiceBridgeIfAny()
        {
            if (_spawnedBridge == null)
            {
                return;
            }

            try
            {
                if (!_spawnedBridge.HasExited)
                {
                    // start-bridge.cmd is usually cmd.exe spawning node.exe; Kill(parent) often orphans node on Windows.
                    if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                    {
                        try
                        {
                            var taskkill = Path.Combine(Environment.SystemDirectory, "taskkill.exe");
                            if (File.Exists(taskkill))
                            {
                                using (var killer = SysDiag.Process.Start(
                                    new SysDiag.ProcessStartInfo
                                    {
                                        FileName = taskkill,
                                        Arguments = "/F /T /PID " + _spawnedBridge.Id,
                                        CreateNoWindow = true,
                                        UseShellExecute = false,
                                        WindowStyle = SysDiag.ProcessWindowStyle.Hidden
                                    }))
                                {
                                    if (killer != null)
                                    {
                                        killer.WaitForExit(8000);
                                    }
                                }
                            }
                        }
                        catch
                        {
                            /* ignore */
                        }
                    }

                    try
                    {
                        if (!_spawnedBridge.HasExited)
                        {
                            _spawnedBridge.Kill();
                        }
                    }
                    catch
                    {
                        /* ignore */
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] voice bridge stop: " + ex.Message);
            }
            finally
            {
                try
                {
                    _spawnedBridge.Dispose();
                }
                catch
                {
                    /* ignore */
                }

                _spawnedBridge = null;
            }
        }

        /// <summary>
        /// Resolve a settings.cfg path (relative or absolute) to a full path that is required to
        /// live under the KSP install root. Returns <c>null</c> and logs a warning if the resolved
        /// path escapes the root — this is the only thing standing between a poisoned settings.cfg
        /// and an arbitrary <c>Process.Start</c> at game launch, so callers must treat a null
        /// result as "do not spawn".
        /// </summary>
        private static string ResolveUnderKspRoot(string kspRoot, string pathOrRelative)
        {
            string resolved;
            try
            {
                resolved = Path.IsPathRooted(pathOrRelative)
                    ? Path.GetFullPath(pathOrRelative)
                    : Path.GetFullPath(Path.Combine(kspRoot, pathOrRelative.Replace('/', Path.DirectorySeparatorChar)));
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] could not resolve settings path '" + pathOrRelative + "': " + ex.Message);
                return null;
            }

            string rootFull;
            try
            {
                rootFull = Path.GetFullPath(kspRoot);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] could not resolve KSP root '" + kspRoot + "': " + ex.Message);
                return null;
            }

            // Append a trailing separator so a sibling like "C:\KSP-evil" doesn't satisfy a
            // StartsWith check against "C:\KSP". OrdinalIgnoreCase matches Windows filesystem
            // semantics; KSP only ships on Win/macOS/Linux desktop and the plugin is Windows-first.
            var sep = Path.DirectorySeparatorChar.ToString();
            var rootWithSep = rootFull.TrimEnd(Path.DirectorySeparatorChar) + sep;
            var resolvedWithSep = resolved.TrimEnd(Path.DirectorySeparatorChar) + sep;
            if (!resolvedWithSep.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
            {
                Debug.LogWarning(
                    "[KSCTowerNetwork] refusing settings.cfg path that escapes KSP root: '"
                    + pathOrRelative + "' -> '" + resolved + "' (root: '" + rootFull + "')");
                return null;
            }

            return resolved;
        }
    }
}
