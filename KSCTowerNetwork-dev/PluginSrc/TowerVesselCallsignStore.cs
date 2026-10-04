using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Per-<see cref="Vessel.persistentId"/> pilot callsign for tower telemetry (<c>pilotName</c>).
    /// Account-level <see cref="TowerModSettings.PilotCallsign"/> is the fallback when a vessel has no entry.
    /// </summary>
    public static class TowerVesselCallsignStore
    {
        private const string RelPath = "GameData/KSCTowerNetwork/PluginData/vessel_callsigns.cfg";
        private static bool _loaded;
        private static readonly Dictionary<uint, string> Map = new Dictionary<uint, string>();

        private static readonly string[] RoleplayPrefixes =
        {
            "HEAVY", "FAST", "IRON", "LUCKY", "JOLLY", "BLUE", "RED", "SILVER", "NIGHT", "MOON",
            "STAR", "VOID", "SUNNY", "SKY", "LOW", "HIGH", "SANDY", "CLEVER", "BOLD", "STEADY"
        };

        private static readonly string[] RoleplaySuffixes =
        {
            "ONE", "TWO", "DOG", "CAT", "BOX", "KITE", "AXE", "HAMMER", "GHOST", "EAGLE",
            "FANG", "WING", "ROCK", "ARCH", "RIDER", "SPEAR", "ARROW", "HAWK", "LARK", "FINCH"
        };

        private static string FullPath
        {
            get
            {
                return Path.Combine(KSPUtil.ApplicationRootPath, RelPath.Replace('/', Path.DirectorySeparatorChar));
            }
        }

        public static void EnsureLoaded()
        {
            if (_loaded)
            {
                return;
            }

            _loaded = true;
            Map.Clear();
            var p = FullPath;
            if (!File.Exists(p))
            {
                return;
            }

            var root = ConfigNode.Load(p);
            if (root == null)
            {
                return;
            }

            foreach (var n in root.GetNodes("VESSEL"))
            {
                var idStr = n.GetValue("persistentId");
                var cs = n.GetValue("callsign");
                if (string.IsNullOrEmpty(idStr))
                {
                    continue;
                }

                uint id;
                if (!uint.TryParse(idStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out id))
                {
                    continue;
                }

                var trimmed = cs != null ? cs.Trim() : string.Empty;
                if (string.IsNullOrEmpty(trimmed))
                {
                    continue;
                }

                Map[id] = trimmed;
            }
        }

        /// <summary>True when this vessel has a saved callsign (non-empty).</summary>
        public static bool IsConfigured(uint persistentId)
        {
            EnsureLoaded();
            string cs;
            return Map.TryGetValue(persistentId, out cs) && !string.IsNullOrWhiteSpace(cs);
        }

        /// <summary>Vessel-specific callsign if set; otherwise account <see cref="TowerModSettings.PilotCallsign"/>.</summary>
        public static string GetEffectivePilotCallsign(Vessel v)
        {
            EnsureLoaded();
            TowerModSettings.EnsureLoaded();
            if (v == null)
            {
                return (TowerModSettings.PilotCallsign ?? string.Empty).Trim();
            }

            string vs;
            if (Map.TryGetValue(v.persistentId, out vs) && !string.IsNullOrWhiteSpace(vs))
            {
                return vs.Trim();
            }

            return (TowerModSettings.PilotCallsign ?? string.Empty).Trim();
        }

        public static void SetVesselCallsign(uint persistentId, string callsign)
        {
            EnsureLoaded();
            var t = (callsign ?? string.Empty).Trim();
            if (t.Length > 120)
            {
                t = t.Substring(0, 120);
            }

            if (t.Length == 0)
            {
                Map.Remove(persistentId);
            }
            else
            {
                Map[persistentId] = t;
            }

            SaveToDisk();
        }

        /// <summary>ATC-style suggestion from craft name + stable roleplay suffix from <see cref="Vessel.persistentId"/>.</summary>
        /// <param name="rerollSalt">Non-zero changes the suffix when the player asks for another idea.</param>
        public static string SuggestRoleplayCallsign(Vessel v, int rerollSalt = 0)
        {
            if (v == null)
            {
                return "NIGHT RIDER";
            }

            var raw = StripDisplayTag(v.vesselName);
            if (string.IsNullOrEmpty(raw))
            {
                raw = "UNNAMED";
            }

            var compact = SanitizeToCallsignWords(raw);
            if (compact.Length < 3)
            {
                compact = "FLIGHT";
            }

            var mix = (uint)rerollSalt * 2166136261u;
            var si = (int)(((v.persistentId ^ mix) >> 3) % RoleplaySuffixes.Length);
            var suf = RoleplaySuffixes[si];
            var maxCompact = Math.Max(3, 22 - (suf.Length + 1));
            if (compact.Length > maxCompact)
            {
                compact = compact.Substring(0, maxCompact).Trim();
            }

            if (compact.Length < 3)
            {
                var pi = (int)((v.persistentId ^ mix) % RoleplayPrefixes.Length);
                return RoleplayPrefixes[pi] + " " + suf;
            }

            return (compact + " " + suf).Trim();
        }

        private static string StripDisplayTag(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }

            var i = s.IndexOf('^');
            return i >= 0 ? s.Substring(0, i).Trim() : s.Trim();
        }

        private static string SanitizeToCallsignWords(string raw)
        {
            var sb = new StringBuilder(raw.Length);
            foreach (var c in raw.ToUpperInvariant())
            {
                if (char.IsLetterOrDigit(c))
                {
                    sb.Append(c);
                }
                else if (sb.Length > 0 && sb[sb.Length - 1] != ' ')
                {
                    sb.Append(' ');
                }
            }

            var s = Regex.Replace(sb.ToString().Trim(), @"\s+", " ");
            return s;
        }

        private static void SaveToDisk()
        {
            var path = FullPath;
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var root = new ConfigNode("VESSEL_CALLSIGNS");
            foreach (var kv in Map)
            {
                if (string.IsNullOrWhiteSpace(kv.Value))
                {
                    continue;
                }

                var n = root.AddNode("VESSEL");
                n.AddValue("persistentId", kv.Key.ToString(CultureInfo.InvariantCulture));
                n.AddValue("callsign", kv.Value);
            }

            root.Save(path);
        }
    }
}
