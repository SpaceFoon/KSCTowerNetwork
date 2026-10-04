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
    /// Extracts the home body's basemap as raw PNG textures and POSTs them to the Tower backend.
    /// Replaces the previous "sample PQS at 720x360 and emit hypsometric SVG" pipeline because
    /// KSP already keeps the data we need in memory:
    ///
    /// • Altimetry / "what the planet looks like": <c>body.scaledBody</c> carries the same color
    ///   texture KSP itself draws in map view. Pre-baked from PQS at game build time, includes
    ///   noise/modifier output, identical for every player on the same pack version.
    /// • Biomes: <c>body.BiomeMap</c> wraps a Texture2D — literally the same PNG Squad shipped.
    ///   We <see cref="CBAttributeMapSO.CompileToTexture"/> it for a clean, readable copy.
    ///
    /// PQS sampling is fundamentally lossy (260k samples → 7-band hypsometric chart) and slow
    /// (minutes for stock's 17 PQS-having bodies). Texture extraction is exact and finishes in
    /// milliseconds per body, so this also unlocks Phase C (multi-body bake) trivially.
    ///
    /// The previous slope layer required the height grid. We drop it from the live bake; the
    /// elevation-derived slope SVG bundled in <c>web/public/maps/</c> is still served as the
    /// static fallback. If anyone wants a quantitative live slope layer later we can re-add it
    /// behind an opt-in toggle.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.SpaceCentre, true)]
    public class TowerBasemapBaker : MonoBehaviour
    {
        // The web overlays (graticule, picks, vessel pins) project lat/lon into a 596x298 viewBox.
        // We declare the manifest with that viewBox regardless of the source texture's pixel size —
        // PNGs are raster and the browser scales them to fit. Keeps overlay registration stable.
        // MUST stay in sync with KERBIN_MAP_VB_W/H in KerbinTowerMap.tsx.
        private const int OverlayVbWidth = 596;
        private const int OverlayVbHeight = 298;

        // Schema version sent in the JSON envelope. Bump when the wire format changes.
        // v1: SVG sampling pipeline. v2: SVG + biome/slope. v3: PNG texture extraction.
        // v4: + anomaly features (PQSCity / PQSCity2 enumeration).
        private const string SchemaVersion = "4";

        // One bake per game session. After Alt-F9 → load, this resets and we extract for the new save's body.
        private static bool _bakedThisGameSession;

        private void Start()
        {
            if (_bakedThisGameSession)
            {
                return;
            }

            TowerModSettings.EnsureLoaded();
            if (string.IsNullOrEmpty(TowerModSettings.SessionId))
            {
                return;
            }

            // PSystemSetup / PQS / scaledBody may not be wired up on the very first frame after
            // a cold-start campaign load. Same one-frame settle as TowerWorldInventory.
            StartCoroutine(BakeOnce());
        }

        private IEnumerator BakeOnce()
        {
            yield return null;
            yield return new WaitForSeconds(0.35f);

            CelestialBody home;
            try
            {
                home = FlightGlobals.GetHomeBody();
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] basemap bake skipped — GetHomeBody threw: " + ex.Message);
                yield break;
            }

            if (home == null)
            {
                Debug.LogWarning("[KSCTowerNetwork] basemap bake skipped — home body is null.");
                yield break;
            }

            var bodyName = string.IsNullOrEmpty(home.bodyName) ? "Kerbin" : home.bodyName;
            var cacheKey = bodyName + "_" + ((long)home.Radius).ToString(CultureInfo.InvariantCulture)
                           + "_v" + SchemaVersion;

            byte[] altPng = TryReadCacheBytes(ResolveCachePath(cacheKey, "alt"));
            byte[] biomePng = TryReadCacheBytes(ResolveCachePath(cacheKey, "biome"));

            if (altPng == null)
            {
                altPng = ExtractScaledColorPng(home);
                if (altPng != null)
                {
                    TryWriteCacheBytes(ResolveCachePath(cacheKey, "alt"), altPng);
                }
            }

            if (biomePng == null)
            {
                biomePng = ExtractBiomePng(home);
                if (biomePng != null)
                {
                    TryWriteCacheBytes(ResolveCachePath(cacheKey, "biome"), biomePng);
                }
            }

            if (altPng == null && biomePng == null)
            {
                Debug.LogWarning("[KSCTowerNetwork] basemap bake — no extractable textures on " + bodyName + " (no scaledBody color, no BiomeMap). Skipping.");
                yield break;
            }

            // Anomalies are cheap to enumerate (PQSCity[] is usually <50 instances per body),
            // and they're invariant for a given pack version, so we don't bother caching them
            // separately on disk — a re-extraction takes microseconds.
            var features = ExtractAnomalyFeatures(home);
            if (features != null && features.Count > 0)
            {
                Debug.Log("[KSCTowerNetwork] basemap bake — found " + features.Count
                          + " anomaly feature(s) on " + bodyName + ".");
            }

            var manifestJson = BuildManifestJson(bodyName, home, altPng, biomePng, features);
            for (int attempt = 0; attempt < 3; attempt++)
            {
                bool ok = false;
                yield return StartCoroutine(PostManifest(manifestJson, success => { ok = success; }));
                if (ok)
                {
                    _bakedThisGameSession = true;
                    yield break;
                }
                yield return new WaitForSeconds(2.5f * (attempt + 1));
            }
        }

        // ----- texture extraction -----------------------------------------------------

        /// <summary>
        /// Pulls the color texture off <c>body.scaledBody</c>'s renderer material. This is the
        /// same texture KSP itself shows in map view — pre-baked by Squad/Kopernicus from PQS,
        /// pixel-perfect, no sampling. Returns PNG bytes or null if the body has no scaled-space
        /// renderer (uncommon — even gas giants have one for the map view sphere).
        /// </summary>
        private static byte[] ExtractScaledColorPng(CelestialBody body)
        {
            try
            {
                var scaled = body.scaledBody;
                if (scaled == null) return null;

                var mr = scaled.GetComponent<MeshRenderer>();
                if (mr == null || mr.sharedMaterial == null) return null;

                Texture src = null;
                // _MainTex is the universal Unity convention. KSP's scaled-space shader honors it
                // for both stock and Kopernicus-spawned bodies. Some custom shaders rename it but
                // _MainTex is always wired up as a fallback by the engine.
                if (mr.sharedMaterial.HasProperty("_MainTex"))
                {
                    src = mr.sharedMaterial.GetTexture("_MainTex");
                }
                if (src == null && mr.sharedMaterial.mainTexture != null)
                {
                    src = mr.sharedMaterial.mainTexture;
                }
                if (src == null)
                {
                    Debug.LogWarning("[KSCTowerNetwork] basemap bake — " + body.bodyName + " scaledBody has no _MainTex.");
                    return null;
                }

                // Log native dims so the user can see exactly what the source resolution is —
                // stock Kerbin is 2048x1024 (~1.8 km/px), RSS Earth tends to be 8192x4096
                // (~5 km/px). Anything coarser than the user's screen at max zoom means they're
                // looking at upscaled pixels; ROI for a vector contour layer comes from this number.
                Debug.Log("[KSCTowerNetwork] basemap bake — " + body.bodyName
                          + " scaled color source " + src.width + "x" + src.height + ".");

                return ReadableCopyPng(src, body.bodyName + " scaled color");
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] basemap bake — scaled color extract threw on " + body.bodyName + ": " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// Compiles the body's BiomeMap (a <see cref="CBAttributeMapSO"/>) into a fresh Texture2D
        /// and PNG-encodes it. Pixel-perfect, pulls straight from the same data the in-game biome
        /// detector reads. Null when the body has no biome map (gas giants in some packs, or
        /// pre-init bodies that haven't loaded yet).
        /// </summary>
        private static byte[] ExtractBiomePng(CelestialBody body)
        {
            try
            {
                if (body.BiomeMap == null) return null;

                Texture2D tex = body.BiomeMap.CompileToTexture();
                if (tex == null)
                {
                    Debug.LogWarning("[KSCTowerNetwork] basemap bake — " + body.bodyName + " BiomeMap.CompileToTexture returned null.");
                    return null;
                }

                Debug.Log("[KSCTowerNetwork] basemap bake — " + body.bodyName
                          + " biome source " + tex.width + "x" + tex.height + ".");

                // CompileToTexture returns a fresh, readable Texture2D — direct EncodeToPNG works.
                // We still destroy it after to free GPU memory; the BiomeMap keeps its own copy.
                byte[] png;
                try
                {
                    png = tex.EncodeToPNG();
                }
                finally
                {
                    UnityEngine.Object.Destroy(tex);
                }
                return png;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] basemap bake — biome extract threw on " + body.bodyName + ": " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// Returns a PNG-encoded copy of <paramref name="src"/>, working around two common KSP
        /// gotchas:
        ///   1. Asset-bundle textures are usually <c>!isReadable</c> so <c>EncodeToPNG</c> on them
        ///      throws "Texture is not readable".
        ///   2. Some scaled-space textures are sRGB and Unity's GPU readback path needs the right
        ///      RenderTexture format or colors come out gamma-shifted.
        /// We Blit through a temporary RenderTexture, ReadPixels into a fresh Texture2D, then encode.
        /// </summary>
        private static byte[] ReadableCopyPng(Texture src, string label)
        {
            int w = src.width;
            int h = src.height;
            // Cap absurdly large textures — some Kopernicus packs ship 16384x8192 scaledSpace maps
            // which after PNG encoding can blow past the backend cap. 8192 is enough for any
            // practical zoom (~460 m/px on Kerbin, ~5 km/px on Earth in RSS) and PNGs at that
            // size compress to roughly 10-20 MB depending on content — covered by the bumped
            // backend ceiling. Above this, vector contours from PQS sampling are the right tool,
            // not bigger raster textures.
            int maxDim = 8192;
            if (w > maxDim || h > maxDim)
            {
                if (w >= h)
                {
                    h = Mathf.RoundToInt((float)h * maxDim / w);
                    w = maxDim;
                }
                else
                {
                    w = Mathf.RoundToInt((float)w * maxDim / h);
                    h = maxDim;
                }
                Debug.Log("[KSCTowerNetwork] basemap bake — " + label + " downscaled to " + w + "x" + h
                          + " (source " + src.width + "x" + src.height + ").");
            }

            RenderTexture rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            RenderTexture prev = RenderTexture.active;
            Texture2D readable = null;
            try
            {
                Graphics.Blit(src, rt);
                RenderTexture.active = rt;
                readable = new Texture2D(w, h, TextureFormat.RGBA32, false, false);
                readable.ReadPixels(new Rect(0, 0, w, h), 0, 0, false);
                readable.Apply(false, false);
                return readable.EncodeToPNG();
            }
            finally
            {
                RenderTexture.active = prev;
                RenderTexture.ReleaseTemporary(rt);
                if (readable != null) UnityEngine.Object.Destroy(readable);
            }
        }

        // ----- anomalies / features ---------------------------------------------------

        /// <summary>
        /// One named point on the body's surface — extracted from <c>PQSCity</c> / <c>PQSCity2</c>
        /// MonoBehaviours under the body's PQS. Stock anomalies (Mun arches, KSC2, monoliths,
        /// pyramids, the Duna face) all show up this way; modded anomalies (e.g., Kopernicus
        /// packs, Anomaly Surveyor mod, Sentinel Mission targets) do too because they reuse
        /// the same PQSCity primitive.
        /// </summary>
        private struct Feature
        {
            public string Name;
            public double Lat;
            public double Lon;
            public string Kind; // "anomaly" | "facility" | "unknown"
        }

        private static List<Feature> ExtractAnomalyFeatures(CelestialBody body)
        {
            var pqs = body.pqsController;
            if (pqs == null) return null;

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var list = new List<Feature>();

            // PQSCity is the legacy primitive that stock + most older mods use. PQSCity2 is the
            // newer (KSP 1.4+) variant that supports per-vertex blending and is more common in
            // recent Kopernicus packs. Both expose a Transform we can ask the body to reverse-
            // project into lat/lon — that's more robust than reading repositionRadial directly,
            // because some mods relocate cities at runtime via PlanetRelativePosition or by
            // re-parenting the GameObject under a different anchor.
            try
            {
                var cities = pqs.GetComponentsInChildren<PQSCity>(true);
                foreach (var c in cities)
                {
                    AddFeatureFromTransform(body, c == null ? null : c.gameObject, seen, list);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] basemap bake — PQSCity enumeration threw: " + ex.Message);
            }

            try
            {
                var cities2 = pqs.GetComponentsInChildren<PQSCity2>(true);
                foreach (var c in cities2)
                {
                    AddFeatureFromTransform(body, c == null ? null : c.gameObject, seen, list);
                }
            }
            catch (Exception ex)
            {
                // PQSCity2 not present in some KSP versions / modded distros — non-fatal.
                Debug.LogWarning("[KSCTowerNetwork] basemap bake — PQSCity2 enumeration threw: " + ex.Message);
            }

            return list;
        }

        private static void AddFeatureFromTransform(
            CelestialBody body,
            GameObject go,
            HashSet<string> seen,
            List<Feature> list)
        {
            if (go == null) return;
            var name = go.name;
            if (string.IsNullOrEmpty(name)) return;

            try
            {
                var pos = go.transform.position;
                double lat = body.GetLatitude(pos);
                double lon = body.GetLongitude(pos);
                if (double.IsNaN(lat) || double.IsNaN(lon)) return;

                // Some PQSCity instances share names across rebake passes; dedupe on (name + 1° cell)
                // so we don't ship two markers for one anomaly while still letting genuinely distinct
                // features (e.g. the three Mun arches, all named "MunRockArch" variants) coexist.
                var key = name + "@" + Math.Round(lat, 1).ToString(CultureInfo.InvariantCulture)
                              + "," + Math.Round(lon, 1).ToString(CultureInfo.InvariantCulture);
                if (!seen.Add(key)) return;

                list.Add(new Feature
                {
                    Name = name,
                    Lat = lat,
                    Lon = lon,
                    Kind = ClassifyFeatureName(name)
                });
            }
            catch
            {
                // GetLatitude/GetLongitude can throw if the body's transform is mid-rebuild.
                // Skip silently — the next bake (next SC entry) will retry.
            }
        }

        /// <summary>
        /// Classify a PQSCity name as launch facility vs anomaly vs unknown. The web side renders
        /// anomalies with one icon style and lets controllers toggle them; facilities are usually
        /// already drawn from the world-inventory launch-site list so we tag them here so the
        /// frontend can dedupe instead of double-rendering KSC's child buildings.
        /// </summary>
        private static string ClassifyFeatureName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "unknown";
            var n = name.ToLowerInvariant();
            // Stock KSC building names — every one of these is a child of "KSC" in the PQS tree
            // and would clutter the map if rendered as an "anomaly" pin. KSC2 is NOT in this list
            // because it's the actual eastern-continent abandoned-base anomaly.
            if (n == "ksc") return "facility";
            if (n.Contains("launchpad")) return "facility";
            if (n.Contains("runway")) return "facility";
            if (n.Contains("vehicleassembly") || n == "vab") return "facility";
            if (n.Contains("spaceplanehangar") || n == "sph") return "facility";
            if (n.Contains("trackingstation")) return "facility";
            if (n.Contains("administration")) return "facility";
            if (n.Contains("astronautcomplex")) return "facility";
            if (n.Contains("missioncontrol")) return "facility";
            if (n.Contains("researchanddevelopment") || n == "rnd") return "facility";
            if (n.Contains("flagpole")) return "facility";
            if (n.Contains("crawlerway")) return "facility";
            if (n.Contains("helipad")) return "facility";
            if (n.Contains("fuelpipe")) return "facility";
            if (n.Contains("kerbincentral")) return "facility";
            return "anomaly";
        }

        // ----- on-disk cache ----------------------------------------------------------

        private static byte[] TryReadCacheBytes(string path)
        {
            if (!File.Exists(path)) return null;
            try
            {
                var bytes = File.ReadAllBytes(path);
                Debug.Log("[KSCTowerNetwork] basemap bake — using cached PNG (" + bytes.Length + " bytes) " + path);
                return bytes;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] basemap bake — cache read failed (" + ex.Message + "), re-extracting.");
                return null;
            }
        }

        private static void TryWriteCacheBytes(string path, byte[] bytes)
        {
            try
            {
                var dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }
                File.WriteAllBytes(path, bytes);
                Debug.Log("[KSCTowerNetwork] basemap bake — wrote " + bytes.Length + " bytes to " + path);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] basemap bake — cache write failed: " + ex.Message);
            }
        }

        private static string ResolveCachePath(string cacheKey, string layerId)
        {
            // PluginData/maps/<safeKey>__<layer>.png. One file per (body, schema, layer) so
            // shipping a future layer doesn't invalidate the existing two.
            var root = KSPUtil.ApplicationRootPath;
            var dir = Path.Combine(
                Path.Combine(Path.Combine(root, "GameData"), "KSCTowerNetwork"),
                Path.Combine("PluginData", "maps"));
            var safe = MakeFilenameSafe(cacheKey + "__" + layerId);
            return Path.Combine(dir, safe + ".png");
        }

        private static string MakeFilenameSafe(string s)
        {
            if (string.IsNullOrEmpty(s)) return "_";
            var sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.')
                {
                    sb.Append(c);
                }
                else
                {
                    sb.Append('_');
                }
            }
            return sb.ToString();
        }

        // ----- backend POST -----------------------------------------------------------

        private static string BuildManifestJson(
            string bodyName,
            CelestialBody body,
            byte[] altPng,
            byte[] biomePng,
            List<Feature> features)
        {
            // Wire format (v4): { schemaVersion, scannedAt,
            //                     body: { name, displayName, radiusM },
            //                     layers: [{ id, label, contentType, viewBoxW, viewBoxH, hypsometryKey, bytesBase64 }],
            //                     features: [{ name, lat, lon, kind }]? }
            // bytesBase64 carries PNG bytes (or, in future, SVG). contentType discriminates.
            // features is optional (empty/missing for bodies with no PQSCity).
            int totalLen = (altPng != null ? altPng.Length : 0) + (biomePng != null ? biomePng.Length : 0);
            int featCount = features == null ? 0 : features.Count;
            var sb = new StringBuilder(totalLen * 2 + 1024 + featCount * 96);
            sb.Append('{');
            AppendJsonString(sb, "schemaVersion", SchemaVersion, first: true);
            var nowEpoch = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
            AppendJsonNum(sb, "scannedAt", nowEpoch, first: false);

            sb.Append(",\"body\":{");
            AppendJsonString(sb, "name", bodyName, first: true);
            var disp = StripDisplayTag(body == null ? null : body.displayName);
            if (string.IsNullOrEmpty(disp)) disp = bodyName;
            AppendJsonString(sb, "displayName", disp, first: false);
            AppendJsonNum(sb, "radiusM", body == null ? 600000d : body.Radius, first: false);
            sb.Append('}');

            sb.Append(",\"layers\":[");
            bool firstLayer = true;
            if (altPng != null)
            {
                AppendLayerObject(sb, firstLayer, "alt", "Altimetry", "image/png", "generic", altPng);
                firstLayer = false;
            }
            if (biomePng != null)
            {
                AppendLayerObject(sb, firstLayer, "biome", "Biomes", "image/png", "generic", biomePng);
                firstLayer = false;
            }
            sb.Append(']');

            if (featCount > 0)
            {
                sb.Append(",\"features\":[");
                for (int i = 0; i < features.Count; i++)
                {
                    var f = features[i];
                    if (i > 0) sb.Append(',');
                    sb.Append('{');
                    AppendJsonString(sb, "name", f.Name, first: true);
                    AppendJsonNum(sb, "lat", f.Lat, first: false);
                    AppendJsonNum(sb, "lon", f.Lon, first: false);
                    AppendJsonString(sb, "kind", f.Kind, first: false);
                    sb.Append('}');
                }
                sb.Append(']');
            }

            sb.Append('}');
            return sb.ToString();
        }

        private static void AppendLayerObject(
            StringBuilder sb,
            bool first,
            string id,
            string label,
            string contentType,
            string hypsoKey,
            byte[] bytes)
        {
            if (!first) sb.Append(',');
            sb.Append('{');
            AppendJsonString(sb, "id", id, first: true);
            AppendJsonString(sb, "label", label, first: false);
            AppendJsonString(sb, "contentType", contentType, first: false);
            AppendJsonNum(sb, "viewBoxW", OverlayVbWidth, first: false);
            AppendJsonNum(sb, "viewBoxH", OverlayVbHeight, first: false);
            AppendJsonString(sb, "hypsometryKey", hypsoKey, first: false);
            sb.Append(",\"bytesBase64\":\"").Append(Convert.ToBase64String(bytes)).Append('"');
            sb.Append('}');
        }

        private IEnumerator PostManifest(string json, Action<bool> done)
        {
            var url = TowerModSettings.ApiBaseUrl + "/world-maps/" + TowerModSettings.SessionId;
            var body = Encoding.UTF8.GetBytes(json);
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                // Bigger timeout than the 8s used for world-inventory — 4 MB upload over loopback
                // is still fast, but we don't want a slow first byte to nuke the bake on remote setups.
                req.timeout = 30;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    Debug.LogWarning("[KSCTowerNetwork] world-maps POST failed: " + req.responseCode + " " + req.error);
                    done(false);
                    yield break;
                }

                done(true);
            }
        }

        // ----- helpers ---------------------------------------------------------------

        private static string StripDisplayTag(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            var caret = s.IndexOf('^');
            return caret > 0 ? s.Substring(0, caret).Trim() : s.Trim();
        }

        private static void AppendJsonString(StringBuilder sb, string name, string value, bool first)
        {
            if (!first) sb.Append(',');
            sb.Append('"').Append(name).Append("\":\"").Append(JsonEscape(value)).Append('"');
        }

        private static void AppendJsonNum(StringBuilder sb, string name, double value, bool first)
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

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", "");
        }
    }
}
