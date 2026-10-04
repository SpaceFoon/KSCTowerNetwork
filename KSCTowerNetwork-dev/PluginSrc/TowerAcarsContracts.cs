using System;
using System.Collections.Generic;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// One ACARS line (session / lobby / DM). Lives at namespace scope so
    /// <see cref="UnityEngine.JsonUtility"/> can reliably deserialize backend JSON
    /// (nested private types are a known Unity footgun for API envelopes).
    /// </summary>
    [Serializable]
    public class AcarsMessage
    {
        public string id;
        public string sessionId;
        public string fromUserId;
        public string body;
        public string createdAt;
    }

    [Serializable]
    public class AcarsMessagesEnvelope
    {
        public bool ok;
        public AcarsMessage[] messages;
    }

    [Serializable]
    public class AcarsSendEnvelope
    {
        public bool ok;
        public AcarsMessage message;
    }

    /// <summary>
    /// One DM directory row from <c>GET /v1/dm/peers</c>. Namespace scope so
    /// <see cref="JsonUtility"/> can deserialize the envelope (nested types are brittle).
    /// </summary>
    [Serializable]
    public class AcarsDmPeer
    {
        public string userId;
        public string displayName;
        public string email;
        public string role;
    }

    [Serializable]
    public class AcarsPeersEnvelope
    {
        public bool ok;
        public AcarsDmPeer[] peers;
    }

    /// <summary>
    /// Fallback when <see cref="JsonUtility"/> leaves <c>messages</c> null but the
    /// payload clearly contains objects (Unity version / envelope quirks).
    /// </summary>
    internal static class AcarsJsonFallback
    {
        internal static bool TryReadBalancedObject(string json, int startBrace, out int endBraceInclusive)
        {
            endBraceInclusive = -1;
            if (startBrace < 0 || startBrace >= json.Length || json[startBrace] != '{')
            {
                return false;
            }

            var depth = 0;
            var inStr = false;
            var esc = false;
            for (var i = startBrace; i < json.Length; i++)
            {
                var c = json[i];
                if (esc)
                {
                    esc = false;
                    continue;
                }

                if (c == '\\' && inStr)
                {
                    esc = true;
                    continue;
                }

                if (c == '"')
                {
                    inStr = !inStr;
                    continue;
                }

                if (inStr)
                {
                    continue;
                }

                if (c == '{')
                {
                    depth++;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0)
                    {
                        endBraceInclusive = i;
                        return true;
                    }
                }
            }

            return false;
        }

        internal static int IndexOfQuotedKey(string json, string quotedKey)
        {
            return json.IndexOf(quotedKey, StringComparison.Ordinal);
        }

        internal static int IndexOfObjectAfterKey(string json, string quotedKey)
        {
            var k = IndexOfQuotedKey(json, quotedKey);
            if (k < 0)
            {
                return -1;
            }

            var brace = json.IndexOf('{', k + quotedKey.Length);
            return brace;
        }

        internal static bool TryParsePostMessageEcho(string json, out AcarsMessage msg)
        {
            msg = null;
            var brace = IndexOfObjectAfterKey(json, "\"message\"");
            if (brace < 0)
            {
                return false;
            }

            int end;
            if (!TryReadBalancedObject(json, brace, out end))
            {
                return false;
            }

            var slice = json.Substring(brace, end - brace + 1);
            var row = JsonUtility.FromJson<AcarsMessage>(slice);
            if (row == null || string.IsNullOrEmpty(row.id))
            {
                return false;
            }

            msg = row;
            return true;
        }

        internal static List<AcarsMessage> ParseMessagesArrayObjects(string json)
        {
            var list = new List<AcarsMessage>(32);
            var k = IndexOfQuotedKey(json, "\"messages\"");
            if (k < 0)
            {
                return list;
            }

            var lb = json.IndexOf('[', k);
            if (lb < 0)
            {
                return list;
            }

            var i = lb + 1;
            while (i < json.Length)
            {
                int end;
                while (i < json.Length && char.IsWhiteSpace(json[i]))
                {
                    i++;
                }

                if (i >= json.Length)
                {
                    break;
                }

                if (json[i] == ']')
                {
                    break;
                }

                if (json[i] != '{')
                {
                    break;
                }

                if (!TryReadBalancedObject(json, i, out end))
                {
                    break;
                }

                var slice = json.Substring(i, end - i + 1);
                var row = JsonUtility.FromJson<AcarsMessage>(slice);
                if (row != null && !string.IsNullOrEmpty(row.id))
                {
                    list.Add(row);
                }

                i = end + 1;
                while (i < json.Length && char.IsWhiteSpace(json[i]))
                {
                    i++;
                }

                if (i < json.Length && json[i] == ',')
                {
                    i++;
                }
            }

            return list;
        }

        internal static List<AcarsDmPeer> ParsePeersArrayObjects(string json)
        {
            var list = new List<AcarsDmPeer>(16);
            var k = IndexOfQuotedKey(json, "\"peers\"");
            if (k < 0)
            {
                return list;
            }

            var lb = json.IndexOf('[', k);
            if (lb < 0)
            {
                return list;
            }

            var i = lb + 1;
            while (i < json.Length)
            {
                int end;
                while (i < json.Length && char.IsWhiteSpace(json[i]))
                {
                    i++;
                }

                if (i >= json.Length)
                {
                    break;
                }

                if (json[i] == ']')
                {
                    break;
                }

                if (json[i] != '{')
                {
                    break;
                }

                if (!TryReadBalancedObject(json, i, out end))
                {
                    break;
                }

                var slice = json.Substring(i, end - i + 1);
                var row = JsonUtility.FromJson<AcarsDmPeer>(slice);
                if (row != null && !string.IsNullOrEmpty(row.userId))
                {
                    list.Add(row);
                }

                i = end + 1;
                while (i < json.Length && char.IsWhiteSpace(json[i]))
                {
                    i++;
                }

                if (i < json.Length && json[i] == ',')
                {
                    i++;
                }
            }

            return list;
        }
    }
}
