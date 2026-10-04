using System;
using System.Collections.Generic;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Tower clearance strip mirrored from <c>POST /v1/telemetry</c> JSON reply
    /// (<c>clearances</c> object), parsed by <see cref="TowerTelemetryPublisher"/>.
    /// </summary>
    public static class TowerClearanceState
    {
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, string> Dispositions = new Dictionary<string, string>(StringComparer.Ordinal);

        public static void Clear()
        {
            lock (Gate)
            {
                Dispositions.Clear();
            }
        }

        /// <summary>Returns <c>cleared</c>, <c>violation</c>, or empty when neutral / unknown.</summary>
        public static string GetDisposition(string kind)
        {
            if (string.IsNullOrEmpty(kind))
            {
                return string.Empty;
            }

            lock (Gate)
            {
                string v;
                return Dispositions.TryGetValue(kind.ToUpperInvariant(), out v) ? v : string.Empty;
            }
        }

        internal static void ApplyFromTelemetryJson(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                Clear();
                return;
            }

            var cKey = "\"clearances\"";
            var ci = json.IndexOf(cKey, StringComparison.Ordinal);
            if (ci < 0)
            {
                Clear();
                return;
            }

            var colon = json.IndexOf(':', ci + cKey.Length);
            if (colon < 0)
            {
                return;
            }

            var afterColon = colon + 1;
            while (afterColon < json.Length && (json[afterColon] == ' ' || json[afterColon] == '\t'))
            {
                afterColon++;
            }

            if (afterColon < json.Length && json[afterColon] == 'n')
            {
                Clear();
                return;
            }

            if (afterColon >= json.Length || json[afterColon] != '{')
            {
                Clear();
                return;
            }

            int depth = 0;
            int objEnd = -1;
            for (int i = afterColon; i < json.Length; i++)
            {
                if (json[i] == '{')
                {
                    depth++;
                }
                else if (json[i] == '}')
                {
                    depth--;
                    if (depth == 0)
                    {
                        objEnd = i;
                        break;
                    }
                }
            }

            if (objEnd < 0)
            {
                return;
            }

            var slice = json.Substring(afterColon, objEnd - afterColon + 1);
            var kinds = new[] { "TAKEOFF", "LANDING", "TAXI", "HOLD_SHORT", "GO_AROUND" };
            lock (Gate)
            {
                Dispositions.Clear();
                foreach (var k in kinds)
                {
                    var v = ExtractKindDisposition(slice, k);
                    if (!string.IsNullOrEmpty(v))
                    {
                        Dispositions[k] = v;
                    }
                }
            }
        }

        private static string ExtractKindDisposition(string json, string kind)
        {
            var needle = "\"" + kind + "\":\"";
            var i = json.IndexOf(needle, StringComparison.Ordinal);
            if (i < 0)
            {
                return string.Empty;
            }

            var start = i + needle.Length;
            var end = json.IndexOf('"', start);
            if (end <= start)
            {
                return string.Empty;
            }

            return json.Substring(start, end - start);
        }
    }
}
