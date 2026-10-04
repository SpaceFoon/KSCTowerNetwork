using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Uploads a parts-tree manifest of the active vessel to the tower backend so the
    /// web Tower Desk's <c>VesselSchematicPanel</c> can render an SVG schematic of
    /// the inbound craft. Pairs with the JS-schematic option in
    /// <c>VESSELVIEW_INTEGRATION_PLAN.md</c>; deliberately does not touch the
    /// in-game VesselView mod (which has no public API surface for "give me the
    /// current frame").
    /// </summary>
    /// <remarks>
    /// Cadence: change-detection rather than fixed-interval. We tick every
    /// <see cref="PollIntervalSeconds"/> and rebuild the manifest only when the
    /// active vessel's persistentId, part count, or per-part stage fingerprint
    /// changed since the last upload. That covers every event the plan called
    /// out (vessel switch, stage activation, dock, undock, decouple) without
    /// having to subscribe to <c>GameEvents</c> individually — events can be
    /// missed during scene transitions and a poll-based detector is naturally
    /// resync-on-its-own. Cost is one tree walk per <see cref="PollIntervalSeconds"/>
    /// regardless of how active the player is.
    /// <para/>
    /// Auth/error model is intentionally identical to <see cref="TowerHullCamRelay"/>:
    /// bearer-token POST, long backoff on 4xx/5xx, quiet logs so the plugin doesn't
    /// drown the player log with the same line every few seconds while the backend
    /// is offline.
    /// <para/>
    /// Suppressed when <see cref="TowerModSettings.StreamAsTower"/> is on — that
    /// client is not a pilot for the purposes of the Tower Desk, and a manifest
    /// from a parked tower-cam craft would clobber whatever real pilot last
    /// published under the same session id (impossible by design, but cheap to
    /// be defensive about).
    /// </remarks>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TowerVesselManifestPublisher : MonoBehaviour
    {
        // 2 s detection cadence — faster than the user can decouple parts in
        // sequence, slow enough that the per-tick walk is invisible on the
        // CPU profile. Below this and we're rebuilding manifests for parts
        // that are still actively splitting from a Decoupler activation.
        private const float PollIntervalSeconds = 2.0f;

        // Long back-off when the backend rejects us (auth misconfigured, version
        // mismatch). Same shape as TowerHullCamRelay's backoff.
        private const float ErrorBackoffSeconds = 30f;

        // Hard cap on parts uploaded in one manifest. Matches the backend Zod
        // schema's PARTS_MAX (600). Anything over and we drop low-signal parts
        // (struts, fuel lines) until we fit; if still over we mark
        // <c>truncated:true</c> on the wire so the web tile can warn.
        private const int MaxPartsHardCap = 600;

        // Soft byte cap. Plan says 48 KB before truncation kicks in (leaves
        // headroom under the 64 KB-equivalent the backend Zod limits enforce
        // via field bounds + parts cap). This is approximate; we measure the
        // serialized JSON length and trim if over.
        private const int SoftBytesCap = 48 * 1024;

        // Per-part name length cap. Matches backend Zod schema (PART_NAME_MAX=96).
        private const int PartNameMax = 96;

        // Per-tag length cap. Matches backend Zod schema (PART_TAG_MAX=24).
        private const int PartTagMax = 24;

        // Tags-per-part cap. Matches backend Zod schema (TAGS_PER_PART_MAX=6).
        private const int TagsPerPartMax = 6;

        private bool _started;
        private float _backoffUntil;
        private uint _lastUploadedPersistentId;
        private int _lastUploadedPartCount;
        private int _lastUploadedFingerprint;
        private float _lastHttpErrorLog;

        private void Start()
        {
            if (_started)
            {
                return;
            }

            _started = true;
            TowerModSettings.EnsureLoaded();
            StartCoroutine(MainLoop());
        }

        private IEnumerator MainLoop()
        {
            // Stagger so we don't compete with TowerTelemetryPublisher's first
            // POST during scene-load.
            yield return new WaitForSeconds(3f);

            while (true)
            {
                if (!ShouldRun())
                {
                    yield return new WaitForSeconds(PollIntervalSeconds);
                    continue;
                }

                if (Time.unscaledTime < _backoffUntil)
                {
                    yield return new WaitForSeconds(PollIntervalSeconds);
                    continue;
                }

                var v = FlightGlobals.ActiveVessel;
                int partCount = v.parts == null ? 0 : v.parts.Count;
                int fingerprint = ComputeStageFingerprint(v);

                bool changed =
                    v.persistentId != _lastUploadedPersistentId ||
                    partCount != _lastUploadedPartCount ||
                    fingerprint != _lastUploadedFingerprint;

                if (changed)
                {
                    yield return StartCoroutine(BuildAndUpload(v));
                }

                yield return new WaitForSeconds(PollIntervalSeconds);
            }
        }

        private bool ShouldRun()
        {
            // Disable if the player is acting as a Tower View streamer — they're
            // not a pilot in this session, and any manifest they POST would be
            // for the wrong craft anyway.
            if (TowerModSettings.StreamAsTower)
            {
                return false;
            }

            if (!FlightGlobals.ready || FlightGlobals.ActiveVessel == null)
            {
                return false;
            }

            var v = FlightGlobals.ActiveVessel;
            if (v.state == Vessel.State.DEAD)
            {
                return false;
            }

            if (v.parts == null || v.parts.Count == 0)
            {
                return false;
            }

            // Same gate as TowerHullCamRelay: backend rejects telemetry / hullcam
            // / manifest without an identified pilot session, so don't bother
            // POSTing until we have a session id.
            if (string.IsNullOrEmpty(TowerModSettings.SessionId))
            {
                return false;
            }

            return true;
        }

        /// <summary>
        /// Cheap O(parts) hash of (inverseStage, parent index, partInfo.name) so a
        /// staging event or decouple/dock changes the value. Doesn't have to be a
        /// great hash — just sensitive to anything that would visually change the
        /// schematic.
        /// </summary>
        private static int ComputeStageFingerprint(Vessel v)
        {
            unchecked
            {
                int hash = 17;
                if (v.parts != null)
                {
                    for (int i = 0; i < v.parts.Count; i++)
                    {
                        var p = v.parts[i];
                        if (p == null) continue;
                        hash = hash * 31 + p.inverseStage;
                        hash = hash * 31 + (p.parent != null ? p.parent.GetInstanceID() : 0);
                        if (p.partInfo != null && p.partInfo.name != null)
                        {
                            hash = hash * 31 + p.partInfo.name.GetHashCode();
                        }
                    }
                }
                return hash;
            }
        }

        private IEnumerator BuildAndUpload(Vessel v)
        {
            string json;
            try
            {
                json = BuildManifestJson(v);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] manifest build failed: " + ex.Message);
                _backoffUntil = Time.unscaledTime + ErrorBackoffSeconds;
                yield break;
            }

            if (string.IsNullOrEmpty(json))
            {
                yield break;
            }

            var url = TowerModSettings.ApiBaseUrl + "/vessel-manifest/"
                + UrlEncode(TowerModSettings.SessionId);
            var body = Encoding.UTF8.GetBytes(json);

            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError)
                {
                    // Backend offline; quiet back-off so we're not spammy.
                    _backoffUntil = Time.unscaledTime + ErrorBackoffSeconds;
                    yield break;
                }

                if (req.isHttpError)
                {
                    if (Time.unscaledTime - _lastHttpErrorLog > 60f)
                    {
                        _lastHttpErrorLog = Time.unscaledTime;
                        Debug.LogWarning("[KSCTowerNetwork] vessel-manifest upload "
                            + req.responseCode + ": " + (req.error ?? string.Empty));
                    }
                    _backoffUntil = Time.unscaledTime + ErrorBackoffSeconds;
                    yield break;
                }
            }

            // Success — remember what we just sent so the next tick's
            // change-detector knows we don't need to re-send.
            _lastUploadedPersistentId = v.persistentId;
            _lastUploadedPartCount = v.parts.Count;
            _lastUploadedFingerprint = ComputeStageFingerprint(v);
        }

        /// <summary>
        /// Walk the vessel's parts list and serialize a manifest matching the
        /// backend Zod schema in <c>routes/api.ts</c>. Two-pass: first pass
        /// records the index map (Part → manifest index) so the second pass
        /// can resolve parent references; KSP itself stores parent as a Part
        /// reference, not an index.
        /// <para/>
        /// Truncation strategy: if the serialized length exceeds
        /// <see cref="SoftBytesCap"/>, we drop low-signal parts (struts, fuel
        /// lines, decals) and re-serialize. If still over, we mark
        /// <c>truncated:true</c> and ship what we have.
        /// </summary>
        private static string BuildManifestJson(Vessel v)
        {
            var allParts = v.parts;
            if (allParts == null || allParts.Count == 0)
            {
                return string.Empty;
            }

            // First pass: build the keep-list. By default keep everything.
            var keep = new List<Part>(allParts.Count);
            for (int i = 0; i < allParts.Count; i++)
            {
                var p = allParts[i];
                if (p == null) continue;
                keep.Add(p);
            }

            string json = SerializeManifest(v, keep, false);
            if (json.Length <= SoftBytesCap && keep.Count <= MaxPartsHardCap)
            {
                return json;
            }

            // Over the soft cap: drop low-signal parts (struts, fuel lines,
            // decals, decorative bits) and re-serialize.
            var trimmed = new List<Part>(keep.Count);
            for (int i = 0; i < keep.Count; i++)
            {
                var p = keep[i];
                if (IsLowSignalPart(p)) continue;
                trimmed.Add(p);
            }

            // After trimming we may have left orphaned children whose parent
            // got removed; re-parent them up the chain to the nearest kept
            // ancestor so the manifest's parent indices are always valid.
            json = SerializeManifest(v, trimmed, true);

            // Hard cap on count regardless of byte size.
            if (trimmed.Count > MaxPartsHardCap)
            {
                trimmed.RemoveRange(MaxPartsHardCap, trimmed.Count - MaxPartsHardCap);
                json = SerializeManifest(v, trimmed, true);
            }

            return json;
        }

        private static bool IsLowSignalPart(Part p)
        {
            if (p == null || p.partInfo == null || p.partInfo.name == null) return false;
            var n = p.partInfo.name;
            // Stock low-signal parts. Modded equivalents will keep their full
            // detail — that's fine, the truncation flag handles the long tail.
            if (n.IndexOf("strut", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (n.IndexOf("fuelLine", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (n.IndexOf("flag", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (n.IndexOf("ladder", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private static string SerializeManifest(Vessel v, List<Part> parts, bool truncated)
        {
            // Build the Part → manifest index map. Anything not in `parts`
            // gets -1 and the parent-resolution loop walks up to find a
            // kept ancestor.
            var indexMap = new Dictionary<Part, int>(parts.Count);
            for (int i = 0; i < parts.Count; i++)
            {
                indexMap[parts[i]] = i;
            }

            // Locate the root in the kept list (KSP's rootPart may have been
            // dropped by truncation, in which case fall back to index 0).
            int rootPartIndex = 0;
            int rootIdx;
            if (v.rootPart != null && indexMap.TryGetValue(v.rootPart, out rootIdx))
            {
                rootPartIndex = rootIdx;
            }

            // Precompute root-relative pose for every part. Root is the origin.
            // Vessel-local frame uses the root's transform as the basis so the
            // web renderer doesn't need any KSP-coordinate-system knowledge.
            var rootTransform = v.rootPart != null ? v.rootPart.transform : v.transform;

            var sb = new StringBuilder(8 * 1024);
            sb.Append('{');

            uint pid = v.persistentId;
            sb.Append("\"persistentId\":\"").Append(pid.ToString(CultureInfo.InvariantCulture)).Append('"');

            sb.Append(",\"craftName\":\"").Append(JsonEscape(ResolveCraftName(v))).Append('"');
            sb.Append(",\"craftMapIcon\":\"").Append(JsonEscape(ComputeCraftMapIcon(v))).Append('"');
            sb.Append(",\"rootPartIndex\":").Append(rootPartIndex.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"truncated\":").Append(truncated ? "true" : "false");

            sb.Append(",\"parts\":[");
            for (int i = 0; i < parts.Count; i++)
            {
                if (i > 0) sb.Append(',');
                AppendPart(sb, parts[i], i, indexMap, rootTransform);
            }
            sb.Append(']');
            sb.Append('}');
            return sb.ToString();
        }

        private static void AppendPart(
            StringBuilder sb,
            Part p,
            int manifestIndex,
            Dictionary<Part, int> indexMap,
            Transform rootTransform)
        {
            sb.Append('{');
            sb.Append("\"i\":").Append(manifestIndex.ToString(CultureInfo.InvariantCulture));

            string name = p.partInfo != null && !string.IsNullOrEmpty(p.partInfo.name)
                ? p.partInfo.name
                : (p.name ?? "unknown");
            if (name.Length > PartNameMax)
            {
                name = name.Substring(0, PartNameMax);
            }
            sb.Append(",\"n\":\"").Append(JsonEscape(name)).Append('"');

            // Position relative to root in the root's local frame.
            Vector3 worldPos = p.transform != null ? p.transform.position : Vector3.zero;
            Vector3 localPos = rootTransform != null
                ? rootTransform.InverseTransformPoint(worldPos)
                : worldPos;
            sb.Append(",\"p\":[")
                .Append(FormatFloat(localPos.x)).Append(',')
                .Append(FormatFloat(localPos.y)).Append(',')
                .Append(FormatFloat(localPos.z)).Append(']');

            // Rotation relative to root, [x, y, z, w] quaternion.
            Quaternion worldRot = p.transform != null ? p.transform.rotation : Quaternion.identity;
            Quaternion rootRot = rootTransform != null ? rootTransform.rotation : Quaternion.identity;
            Quaternion localRot = Quaternion.Inverse(rootRot) * worldRot;
            sb.Append(",\"r\":[")
                .Append(FormatFloat(localRot.x)).Append(',')
                .Append(FormatFloat(localRot.y)).Append(',')
                .Append(FormatFloat(localRot.z)).Append(',')
                .Append(FormatFloat(localRot.w)).Append(']');

            // Bounds extents — use the part's own collider bounds when available
            // and fall back to a tiny default. Always non-negative per the Zod
            // schema. The renderer uses these to size the rectangle on the SVG.
            Vector3 extents = ComputePartExtents(p);
            sb.Append(",\"b\":[")
                .Append(FormatFloat(Math.Max(0f, extents.x))).Append(',')
                .Append(FormatFloat(Math.Max(0f, extents.y))).Append(',')
                .Append(FormatFloat(Math.Max(0f, extents.z))).Append(']');

            // Dry mass in tonnes. Negative or NaN gets clamped to 0 to satisfy
            // the Zod nonnegative+finite constraint.
            float mass = p.mass;
            if (!IsFiniteSingle(mass) || mass < 0f) mass = 0f;
            sb.Append(",\"m\":").Append(FormatFloat(mass));

            // Parent index in the manifest. Walk up if the immediate parent
            // was dropped during truncation.
            int parentIdx = -1;
            var parent = p.parent;
            while (parent != null)
            {
                int idx;
                if (indexMap.TryGetValue(parent, out idx))
                {
                    parentIdx = idx;
                    break;
                }
                parent = parent.parent;
            }
            sb.Append(",\"parent\":").Append(parentIdx.ToString(CultureInfo.InvariantCulture));

            // inverseStage — KSP allows -1 for "not staged"; clamp to the
            // backend's int16 range defensively.
            int stage = p.inverseStage;
            if (stage < -1) stage = -1;
            if (stage > 32767) stage = 32767;
            sb.Append(",\"stage\":").Append(stage.ToString(CultureInfo.InvariantCulture));

            // Tags: cheap classifier the renderer maps to colours. Only a
            // handful of tags ever fire per part; we cap defensively.
            sb.Append(",\"tags\":[");
            int tagCount = 0;
            tagCount = AppendTagIfModule(sb, p, "ModuleEngines", "engine", tagCount);
            tagCount = AppendTagIfModule(sb, p, "ModuleEnginesFX", "engine", tagCount);
            tagCount = AppendTagIfModule(sb, p, "ModuleControlSurface", "control-surface", tagCount);
            tagCount = AppendTagIfModule(sb, p, "ModuleWheelBase", "wheel", tagCount);
            tagCount = AppendTagIfModule(sb, p, "ModuleWheel", "wheel", tagCount);
            tagCount = AppendTagIfModule(sb, p, "ModuleParachute", "parachute", tagCount);
            tagCount = AppendTagIfModule(sb, p, "ModuleDecouple", "decoupler", tagCount);
            tagCount = AppendTagIfModule(sb, p, "ModuleAnchoredDecoupler", "decoupler", tagCount);
            tagCount = AppendTagIfModule(sb, p, "ModuleScienceExperiment", "science", tagCount);
            tagCount = AppendTagIfModule(sb, p, "LaunchClamp", "launchclamp", tagCount);
            // Crewed-cockpit tag drives the highlight in the schematic; we use
            // CrewCapacity since some IVA-only mods don't expose ModuleCommand.
            if (tagCount < TagsPerPartMax && p.CrewCapacity > 0)
            {
                if (tagCount > 0) sb.Append(',');
                sb.Append("\"cockpit\"");
                tagCount++;
            }
            // Resource-based tags. Pretty conservative — we only flag the
            // common ones the renderer actually colours.
            if (tagCount < TagsPerPartMax && PartHasResource(p, "LiquidFuel"))
            {
                if (tagCount > 0) sb.Append(',');
                sb.Append("\"fueltank\"");
                tagCount++;
            }
            if (tagCount < TagsPerPartMax && PartHasResource(p, "Oxidizer"))
            {
                if (tagCount > 0) sb.Append(',');
                sb.Append("\"oxidizer\"");
                tagCount++;
            }
            sb.Append(']');

            sb.Append('}');
        }

        private static int AppendTagIfModule(StringBuilder sb, Part p, string moduleName, string tag, int countSoFar)
        {
            if (countSoFar >= TagsPerPartMax) return countSoFar;
            if (p.Modules == null || !p.Modules.Contains(moduleName)) return countSoFar;
            if (tag.Length > PartTagMax) tag = tag.Substring(0, PartTagMax);
            if (countSoFar > 0) sb.Append(',');
            sb.Append('"').Append(JsonEscape(tag)).Append('"');
            return countSoFar + 1;
        }

        private static bool PartHasResource(Part p, string resourceName)
        {
            if (p.Resources == null) return false;
            for (int i = 0; i < p.Resources.Count; i++)
            {
                var r = p.Resources[i];
                if (r != null && r.resourceName == resourceName && r.maxAmount > 0)
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Pull a sane axis-aligned size for the part. KSP doesn't expose this
        /// uniformly — different mods use different colliders — so we fall
        /// back through several sources and finally to a 0.5 m default cube.
        /// </summary>
        private static Vector3 ComputePartExtents(Part p)
        {
            try
            {
                if (p.collider != null)
                {
                    var b = p.collider.bounds;
                    return b.size;
                }

                var rend = p.GetComponentInChildren<Renderer>();
                if (rend != null)
                {
                    return rend.bounds.size;
                }
            }
            catch
            {
                // Defensive — unusual mod parts can throw on bounds access
                // before rigidbody init. Fall back to default size below.
            }

            return new Vector3(0.5f, 0.5f, 0.5f);
        }

        /// <summary>
        /// Sanitised craft name. Vessel.vesselName can hold a raw localizer
        /// tag like "#autoLOC_501174"; we resolve it the same way
        /// TowerTelemetryPublisher.ResolveCraftDisplayName does, but keep this
        /// duplicate inline to avoid making that helper public.
        /// </summary>
        private static string ResolveCraftName(Vessel v)
        {
            if (v == null) return "Aircraft";
            var raw = v.vesselName ?? string.Empty;
            if (raw.Length == 0) return "Aircraft";
            try
            {
                var resolved = KSP.Localization.Localizer.Format(raw);
                return string.IsNullOrEmpty(resolved) ? raw : resolved;
            }
            catch
            {
                return raw;
            }
        }

        /// <summary>
        /// Mirror the simple craftMapIcon classifier in
        /// <see cref="TowerTelemetryPublisher.ComputeCraftMapIcon"/> so the
        /// manifest's icon hint matches what the strip view shows. Kept inline
        /// rather than exposed publicly so refactors of the telemetry side
        /// don't have to coordinate with this file.
        /// </summary>
        private static string ComputeCraftMapIcon(Vessel v)
        {
            if (v == null) return "plane";
            if (v.vesselType == VesselType.Plane) return "plane";

            if (v.vesselType != VesselType.Plane && v.LandedOrSplashed)
            {
                if (v.parts != null)
                {
                    for (int i = 0; i < v.parts.Count; i++)
                    {
                        var p = v.parts[i];
                        if (p != null && p.Modules != null && p.Modules.Contains("ModuleWheel"))
                        {
                            return "rover";
                        }
                    }
                }
            }

            return "rocket";
        }

        private static string FormatFloat(float f)
        {
            // Round to mm so the manifest stays compact; the schematic only
            // needs cm-ish precision for layout.
            if (!IsFiniteSingle(f)) return "0";
            return f.ToString("0.###", CultureInfo.InvariantCulture);
        }

        private static bool IsFiniteSingle(float f)
        {
            return !float.IsNaN(f) && !float.IsInfinity(f);
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            // Same escape policy TowerTelemetryPublisher uses on the hot path:
            // backslash + quote, with newline collapsed to a space and CR
            // dropped. Anything else is passed through (the backend Zod
            // schema rejects anything truly hostile via field bounds).
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", "");
        }

        private static string UrlEncode(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            return UnityWebRequest.EscapeURL(s);
        }
    }
}
