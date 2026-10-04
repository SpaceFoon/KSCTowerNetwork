using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// One-shot scan of the running KSP install: home body, navaids, launch sites, and map-relevant
    /// mods (planet packs, KK, MAS, …). Posts to the Tower backend so the web map can re-plot itself
    /// for whatever world the player is actually flying in (Kerbin, RSS Earth, JNSQ, GPP, …).
    /// </summary>
    [KSPAddon(KSPAddon.Startup.SpaceCentre, true)]
    public class TowerWorldInventory : MonoBehaviour
    {
        private static bool _publishedThisGameSession;

        private void Start()
        {
            if (_publishedThisGameSession)
            {
                return;
            }

            TowerModSettings.EnsureLoaded();
            if (string.IsNullOrEmpty(TowerModSettings.SessionId))
            {
                return;
            }

            // Wait one frame so PSystemSetup / GameDatabase are stable on first SC entry of the game
            // session (KSP populates them late on cold-start campaigns).
            StartCoroutine(PublishOnce());
        }

        private IEnumerator PublishOnce()
        {
            yield return null;
            yield return new WaitForSeconds(0.25f);

            string json;
            try
            {
                json = BuildInventoryJson();
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] world-inventory scan failed: " + ex);
                yield break;
            }

            // Three quick attempts on transient backend hiccups (cold-start nodemon, port flap).
            for (int attempt = 0; attempt < 3; attempt++)
            {
                bool ok = false;
                yield return StartCoroutine(PostInventory(json, success => { ok = success; }));
                if (ok)
                {
                    _publishedThisGameSession = true;
                    yield break;
                }
                yield return new WaitForSeconds(2.5f * (attempt + 1));
            }
        }

        private IEnumerator PostInventory(string json, Action<bool> done)
        {
            var url = TowerModSettings.ApiBaseUrl + "/world-inventory/" + TowerModSettings.SessionId;
            var body = Encoding.UTF8.GetBytes(json);
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] world-inventory POST failed: " + req.error);
                    done(false);
                    yield break;
                }

                done(true);
            }
        }

        // ----- inventory builder ------------------------------------------------------

        private static string BuildInventoryJson()
        {
            var sb = new StringBuilder(4096);
            sb.Append('{');

            AppendString(sb, "schemaVersion", "1", first: true);
            // Avoid DateTimeOffset.ToUnixTimeSeconds (.NET 4.6+) so we stay portable across KSP's
            // older Unity Mono runtimes that some installs still ship with.
            var nowEpoch = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
            AppendNum(sb, "scannedAt", nowEpoch, first: false);

            CelestialBody home = null;
            try { home = FlightGlobals.GetHomeBody(); } catch { /* may be null pre-flight init */ }

            sb.Append(",\"home\":");
            AppendHomeBody(sb, home);

            sb.Append(",\"mods\":");
            AppendMods(sb);

            sb.Append(",\"navaids\":");
            AppendNavaids(sb);

            sb.Append(",\"launchSites\":");
            AppendLaunchSites(sb, home);

            sb.Append(",\"runways\":");
            AppendRunways(sb, home);

            sb.Append('}');
            return sb.ToString();
        }

        private static void AppendHomeBody(StringBuilder sb, CelestialBody home)
        {
            sb.Append('{');
            if (home == null)
            {
                AppendString(sb, "name", "Kerbin", first: true);
                AppendNum(sb, "radiusM", 600000d, first: false);
                AppendBool(sb, "hasAtmosphere", true, first: false);
                AppendNum(sb, "rotationPeriodSec", 21549.425d, first: false);
                AppendBool(sb, "fallback", true, first: false);
                sb.Append('}');
                return;
            }

            var bodyName = string.IsNullOrEmpty(home.bodyName) ? "Kerbin" : home.bodyName;
            var bodyDisplay = StripDisplayTag(home.displayName);
            if (string.IsNullOrEmpty(bodyDisplay)) bodyDisplay = bodyName;
            AppendString(sb, "name", bodyName, first: true);
            AppendString(sb, "displayName", bodyDisplay, first: false);
            AppendNum(sb, "radiusM", home.Radius, first: false);
            AppendBool(sb, "hasAtmosphere", home.atmosphere, first: false);
            AppendNum(sb, "atmosphereDepthM", home.atmosphereDepth, first: false);
            AppendNum(sb, "rotationPeriodSec", home.rotationPeriod, first: false);
            AppendNum(sb, "gravityParameterM3S2", home.gravParameter, first: false);
            AppendBool(sb, "fallback", false, first: false);
            sb.Append('}');
        }

        // ----- mod scan ---------------------------------------------------------------

        private struct KnownMod
        {
            public readonly string Token;
            public readonly string Friendly;
            public readonly string Category;
            /// <summary>Optional extra folder / assembly name matched only with exact <c>HashSet.Contains</c>
            /// (no substring pass). Used for OPM: token <c>OuterPlanetsMod</c> plus exact <c>OPM</c>.</summary>
            public readonly string AltExactToken;
            public KnownMod(string token, string friendly, string category)
                : this(token, friendly, category, null) { }
            public KnownMod(string token, string friendly, string category, string altExactToken)
            {
                Token = token;
                Friendly = friendly;
                Category = category;
                AltExactToken = altExactToken;
            }
        }

        /// <summary>
        /// (assemblyOrFolderToken, friendlyName, category)
        /// category: planet-pack | locations | navaids | dlc | physics | other
        /// Tokens are matched case-insensitively against both loaded assembly names AND top-level
        /// GameData/* folder names — most planet packs ship configs without a dll.
        /// (Plain struct rather than a C#7 ValueTuple because the KSP build script pins to C# 5.)
        /// </summary>
        private static readonly KnownMod[] KnownMods = new[]
        {
            new KnownMod("Kopernicus",          "Kopernicus",                       "planet-pack"),
            new KnownMod("RealSolarSystem",     "Real Solar System",                "planet-pack"),
            new KnownMod("RSSVE",               "RSS Visual Enhancements",          "planet-pack"),
            new KnownMod("RSS-CanaveralHD",     "RSS Canaveral HD",                 "locations"),
            new KnownMod("RealismOverhaul",     "Realism Overhaul",                 "physics"),
            new KnownMod("RP-1",                "Realistic Progression One",        "other"),
            new KnownMod("JNSQ",                "JNSQ planet pack",                 "planet-pack"),
            new KnownMod("GalileosPlanetPack",  "Galileo's Planet Pack (GPP)",      "planet-pack"),
            new KnownMod("GPP",                 "Galileo's Planet Pack (GPP)",      "planet-pack"),
            new KnownMod("OuterPlanetsMod",     "Outer Planets Mod",                "planet-pack", "OPM"),
            new KnownMod("BeyondHome",          "Beyond Home",                      "planet-pack"),
            new KnownMod("WhirligigWorld",      "Whirligig World",                  "planet-pack"),
            new KnownMod("Kcalbeloh",           "Kcalbeloh System",                 "planet-pack"),
            new KnownMod("GEP",                 "Grannus Expansion Pack",           "planet-pack"),
            new KnownMod("AlternisKerbol",      "Alternis Kerbol Rekerjiggered",    "planet-pack"),
            new KnownMod("MPE",                 "Minor Planets Expansion",          "planet-pack"),
            new KnownMod("Quack",               "Quack Pack",                       "planet-pack"),
            new KnownMod("KerbalKonstructs",    "Kerbal Konstructs",                "locations"),
            new KnownMod("KerbinSideRemastered","Kerbin Side Remastered",           "locations"),
            new KnownMod("OmegaTechnology",     "Omega's Stockalike Structures",    "locations"),
            new KnownMod("TundraSpaceCenter",   "Tundra's Space Center",            "locations"),
            new KnownMod("MAS",                 "MOARdV Avionics Systems (MAS)",    "navaids"),
            new KnownMod("MOARdV",              "MOARdV Avionics Systems (MAS)",    "navaids"),
            new KnownMod("RasterPropMonitor",   "RasterPropMonitor",                "navaids"),
            new KnownMod("MakingHistory",       "Making History (DLC)",             "dlc"),
            new KnownMod("SquadExpansion",      "Squad Expansion (DLC)",            "dlc"),
            new KnownMod("Serenity",            "Breaking Ground (DLC)",            "dlc"),
            new KnownMod("BreakingGround",      "Breaking Ground (DLC)",            "dlc"),
            new KnownMod("FerramAerospaceResearch", "Ferram Aerospace Research",    "physics"),
            new KnownMod("FAR",                 "Ferram Aerospace Research",        "physics"),
            new KnownMod("Kerbalism",           "Kerbalism",                        "physics")
        };

        private static void AppendMods(StringBuilder sb)
        {
            sb.Append('[');

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var assemblies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                var asms = AppDomain.CurrentDomain.GetAssemblies();
                for (int i = 0; i < asms.Length; i++)
                {
                    var n = asms[i] != null ? asms[i].GetName().Name : null;
                    if (!string.IsNullOrEmpty(n)) assemblies.Add(n);
                }
            }
            catch { /* ignore */ }

            var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                var gd = Path.Combine(KSPUtil.ApplicationRootPath, "GameData");
                if (Directory.Exists(gd))
                {
                    foreach (var d in Directory.GetDirectories(gd))
                    {
                        var nm = Path.GetFileName(d);
                        if (!string.IsNullOrEmpty(nm)) folders.Add(nm);
                    }
                }
            }
            catch { /* ignore */ }

            // Squad expansions ship under GameData/SquadExpansion/<name>; include their subfolder names too.
            try
            {
                var seDir = Path.Combine(Path.Combine(KSPUtil.ApplicationRootPath, "GameData"), "SquadExpansion");
                if (Directory.Exists(seDir))
                {
                    foreach (var d in Directory.GetDirectories(seDir))
                    {
                        var nm = Path.GetFileName(d);
                        if (!string.IsNullOrEmpty(nm)) folders.Add(nm);
                    }
                }
            }
            catch { /* ignore */ }

            bool firstMod = true;
            for (int i = 0; i < KnownMods.Length; i++)
            {
                var entry = KnownMods[i];
                if (!seen.Add(entry.Friendly))
                {
                    continue;
                }

                bool fromAsm = ContainsTokenIgnoreCase(assemblies, entry.Token);
                bool fromCfg = ContainsTokenIgnoreCase(folders, entry.Token);
                if (!string.IsNullOrEmpty(entry.AltExactToken))
                {
                    fromAsm = fromAsm || assemblies.Contains(entry.AltExactToken);
                    fromCfg = fromCfg || folders.Contains(entry.AltExactToken);
                }
                if (!fromAsm && !fromCfg)
                {
                    continue;
                }

                if (!firstMod) sb.Append(',');
                firstMod = false;
                sb.Append('{');
                AppendString(sb, "id", entry.Token, first: true);
                AppendString(sb, "name", entry.Friendly, first: false);
                AppendString(sb, "category", entry.Category, first: false);
                AppendBool(sb, "fromAssembly", fromAsm, first: false);
                AppendBool(sb, "fromGameData", fromCfg, first: false);
                sb.Append('}');
            }

            sb.Append(']');
        }

        private static bool ContainsTokenIgnoreCase(HashSet<string> set, string token)
        {
            if (set == null || string.IsNullOrEmpty(token))
            {
                return false;
            }

            // Direct match wins; otherwise look for the token as a substring of any element so e.g.
            // "Kopernicus" matches "Kopernicus.Components" and the GameData folder name "Kopernicus".
            if (set.Contains(token))
            {
                return true;
            }

            // Very short tokens are substring hazards ("OPM" matches "RasterPropMonitor").
            if (token.Length <= 3)
            {
                return false;
            }

            foreach (var s in set)
            {
                if (s.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }

            return false;
        }

        // ----- navaid scan (MAS) ------------------------------------------------------

        private static void AppendNavaids(StringBuilder sb)
        {
            sb.Append('[');
            if (GameDatabase.Instance == null)
            {
                sb.Append(']');
                return;
            }

            var nodes = GameDatabase.Instance.GetConfigNodes("MAS_NAVAID");
            if (nodes == null || nodes.Length == 0)
            {
                sb.Append(']');
                return;
            }

            bool first = true;
            for (int i = 0; i < nodes.Length; i++)
            {
                var n = nodes[i];
                if (n == null)
                {
                    continue;
                }

                var id = (n.GetValue("id") ?? n.GetValue("ident") ?? "").Trim();
                var name = (n.GetValue("name") ?? "").Trim();
                var kind = (n.GetValue("type") ?? n.GetValue("kind") ?? "").Trim().ToUpperInvariant();
                var bodyName = (n.GetValue("celestialName") ?? n.GetValue("body") ?? "").Trim();

                double lat, lon, freq;
                if (!TryParseDouble(n.GetValue("latitude"), out lat))
                {
                    if (!TryParseDouble(n.GetValue("lat"), out lat)) continue;
                }
                if (!TryParseDouble(n.GetValue("longitude"), out lon))
                {
                    if (!TryParseDouble(n.GetValue("lon"), out lon)) continue;
                }
                TryParseDouble(n.GetValue("frequency"), out freq);

                if (string.IsNullOrEmpty(id) && string.IsNullOrEmpty(name))
                {
                    continue;
                }

                if (kind != "VOR" && kind != "ILS" && kind != "NDB")
                {
                    // Unknown MAS subtype; default to VOR so the marker still appears on the map.
                    kind = "VOR";
                }

                if (!first) sb.Append(',');
                first = false;
                sb.Append('{');
                AppendString(sb, "id", string.IsNullOrEmpty(id) ? name : id, first: true);
                AppendString(sb, "name", string.IsNullOrEmpty(name) ? id : name, first: false);
                AppendString(sb, "kind", kind, first: false);
                AppendNum(sb, "frequency", freq, first: false);
                AppendNum(sb, "lat", lat, first: false);
                AppendNum(sb, "lon", lon, first: false);
                if (!string.IsNullOrEmpty(bodyName))
                {
                    AppendString(sb, "bodyName", bodyName, first: false);
                }
                sb.Append('}');
            }

            sb.Append(']');
        }

        // ----- launch site scan -------------------------------------------------------

        private static void AppendLaunchSites(StringBuilder sb, CelestialBody home)
        {
            sb.Append('[');

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            bool first = true;

            // 1) PSystemSetup launch sites (stock + Making History). These are always on the home body.
            try
            {
                var setup = PSystemSetup.Instance;
                if (setup != null && setup.LaunchSites != null)
                {
                    var sites = setup.LaunchSites;
                    for (int i = 0; i < sites.Count; i++)
                    {
                        var s = sites[i];
                        if (s == null || string.IsNullOrEmpty(s.name))
                        {
                            continue;
                        }

                        var siteBody = s.Body ?? home;
                        if (siteBody == null) continue;

                        double lat, lon;
                        if (!TryGetLaunchSiteLatLon(s, siteBody, out lat, out lon))
                        {
                            continue;
                        }

                        var id = s.name.Trim();
                        if (!seen.Add(id)) continue;

                        string displayName = null;
                        try { displayName = s.GetName(); } catch { /* localized lookup may throw early in scene */ }
                        displayName = StripDisplayTag(displayName);
                        if (string.IsNullOrEmpty(displayName)) displayName = id;

                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append('{');
                        AppendString(sb, "id", id, first: true);
                        AppendString(sb, "name", displayName, first: false);
                        AppendNum(sb, "lat", lat, first: false);
                        AppendNum(sb, "lon", lon, first: false);
                        AppendString(sb, "source", "psystem", first: false);
                        sb.Append('}');
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] PSystemSetup launch site scan failed: " + ex.Message);
            }

            // 2) Kerbal Konstructs launch sites: cfg nodes named LaunchSite with RefLatitude/RefLongitude.
            //    KK is the dominant source of extra runways/pads, so we want them even when its dll isn't loaded
            //    (some packs ship raw cfgs that other systems read).
            try
            {
                if (GameDatabase.Instance != null)
                {
                    var kkNodes = GameDatabase.Instance.GetConfigNodes("LaunchSite");
                    if (kkNodes != null)
                    {
                        for (int i = 0; i < kkNodes.Length; i++)
                        {
                            var n = kkNodes[i];
                            if (n == null) continue;

                            var id = (n.GetValue("LaunchSiteName") ?? n.GetValue("name") ?? "").Trim();
                            if (string.IsNullOrEmpty(id) || !seen.Add(id)) continue;

                            double lat, lon;
                            if (!TryParseDouble(n.GetValue("RefLatitude"), out lat))
                            {
                                if (!TryParseDouble(n.GetValue("latitude"), out lat)) continue;
                            }
                            if (!TryParseDouble(n.GetValue("RefLongitude"), out lon))
                            {
                                if (!TryParseDouble(n.GetValue("longitude"), out lon)) continue;
                            }

                            var bodyName = (n.GetValue("body") ?? n.GetValue("celestialBody") ?? "").Trim();
                            if (!string.IsNullOrEmpty(bodyName) && home != null && !string.Equals(bodyName, home.bodyName, StringComparison.OrdinalIgnoreCase))
                            {
                                continue;
                            }

                            if (!first) sb.Append(',');
                            first = false;
                            sb.Append('{');
                            AppendString(sb, "id", id, first: true);
                            AppendString(sb, "name", id, first: false);
                            AppendNum(sb, "lat", lat, first: false);
                            AppendNum(sb, "lon", lon, first: false);
                            AppendString(sb, "source", "kerbal-konstructs", first: false);
                            sb.Append('}');
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] KK launch site scan failed: " + ex.Message);
            }

            sb.Append(']');
        }

        /// <summary>
        /// One runway threshold JSON object (C# 5 build: no local functions inside <see cref="AppendRunways"/>).
        /// </summary>
        private static void AppendRunwayThresholdJson(
            StringBuilder sb,
            bool first,
            CelestialBody home,
            string aerodromeId,
            string designator,
            double thrLat,
            double thrLon,
            double thrElevM,
            double hdg)
        {
            if (!first)
            {
                sb.Append(',');
            }

            sb.Append('{');
            AppendString(sb, "bodyName", home.bodyName, first: true);
            AppendString(sb, "aerodromeId", aerodromeId, first: false);
            AppendString(sb, "designator", designator, first: false);
            AppendNum(sb, "thresholdLat", thrLat, first: false);
            AppendNum(sb, "thresholdLon", thrLon, first: false);
            AppendNum(sb, "thresholdElevationM", thrElevM, first: false);
            AppendNum(sb, "headingDeg", hdg, first: false);
            sb.Append('}');
        }

        /// <summary>
        /// Published runway thresholds for tower map overlays (stock Kerbin only for v1).
        /// </summary>
        private static void AppendRunways(StringBuilder sb, CelestialBody home)
        {
            sb.Append('[');
            if (home == null || !string.Equals(home.bodyName, "Kerbin", StringComparison.OrdinalIgnoreCase))
            {
                sb.Append(']');
                return;
            }

            // Game-surveyed stock coordinates — matches `kerbinAeroCharts.ts` / web map defaults.
            AppendRunwayThresholdJson(sb, true, home, "KKSC", "09", -0.050278, -74.488611, 69.2, 89.85);
            AppendRunwayThresholdJson(sb, false, home, "KKSC", "27", -0.048611, -74.728333, 68.9, 270.15);
            AppendRunwayThresholdJson(sb, false, home, "KAFD", "09", -1.516111, -71.967222, 133.7, 90.0);
            AppendRunwayThresholdJson(sb, false, home, "KAFD", "27", -1.516111, -71.855278, 133.7, 270.0);
            sb.Append(']');
        }

        /// <summary>
        /// Resolves (lat, lon) for a stock LaunchSite from its world transform. Some sites have
        /// no transform until selected (KSP only spawns the active one in the SC scene), in which
        /// case we skip them; the player's home pad will always resolve at SC entry.
        /// </summary>
        private static bool TryGetLaunchSiteLatLon(LaunchSite site, CelestialBody body, out double lat, out double lon)
        {
            lat = 0; lon = 0;
            if (site == null || body == null) return false;

            try
            {
                if (site.launchSiteTransform != null)
                {
                    Vector3 p = site.launchSiteTransform.position;
                    Vector3d pos = new Vector3d(p.x, p.y, p.z);
                    return TryLatLonFromWorld(body, pos, out lat, out lon);
                }
            }
            catch { /* fall through */ }

            return false;
        }

        private static bool TryLatLonFromWorld(CelestialBody body, Vector3d pos, out double lat, out double lon)
        {
            lat = body.GetLatitude(pos);
            lon = NormalizeLon(body.GetLongitude(pos));
            if (double.IsNaN(lat) || double.IsNaN(lon)) return false;
            // GetLatitude returns 0 for a zero vector — guard against an uninitialised transform.
            if (pos.sqrMagnitude < 0.0001) return false;
            return true;
        }

        private static double NormalizeLon(double lon)
        {
            // Match the web map's [-180, 180] convention.
            while (lon > 180) lon -= 360;
            while (lon < -180) lon += 360;
            return lon;
        }

        // ----- helpers ----------------------------------------------------------------

        private static string StripDisplayTag(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return s;
            }

            // KSP localized display names often look like "Kerbin^N"; strip the trailing tag.
            var caret = s.IndexOf('^');
            if (caret > 0)
            {
                return s.Substring(0, caret).Trim();
            }
            return s.Trim();
        }

        private static bool TryParseDouble(string s, out double v)
        {
            if (string.IsNullOrEmpty(s))
            {
                v = 0;
                return false;
            }

            return double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v);
        }

        private static void AppendNum(StringBuilder sb, string name, double value, bool first)
        {
            if (!first) sb.Append(',');
            sb.Append('"').Append(name).Append("\":");
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                sb.Append("null");
                return;
            }
            sb.Append(value.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void AppendString(StringBuilder sb, string name, string value, bool first)
        {
            if (!first) sb.Append(',');
            sb.Append('"').Append(name).Append("\":\"").Append(JsonEscape(value)).Append('"');
        }

        private static void AppendBool(StringBuilder sb, string name, bool value, bool first)
        {
            if (!first) sb.Append(',');
            sb.Append('"').Append(name).Append("\":").Append(value ? "true" : "false");
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }

            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", "");
        }
    }
}
