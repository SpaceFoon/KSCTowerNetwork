using System.Collections;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Aligns <see cref="TowerModSettings.SessionId"/> with <c>GET /v1/me/active-room</c> once per
    /// game launch. Session ACARS (<see cref="TowerAcarsGui"/>) and <see cref="TowerVoiceAutoConnect"/>
    /// both read SessionId from disk — if the player joined or moved rooms from the web while KSP was
    /// closed, auth.cfg can still name <c>dev-shared</c> or an old UUID, so ops chat and voice target the
    /// wrong LiveKit room until the radio dial is touched. The web shell uses server active-room as
    /// truth; this brings the plugin in line without waiting for a manual retune.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.FlightAndKSC, true)]
    public class TowerAcarsActiveRoomSync : MonoBehaviour
    {
        private static bool _started;

        private void Start()
        {
            if (_started)
            {
                return;
            }

            _started = true;
            TowerModSettings.EnsureLoaded();
            StartCoroutine(SyncRoutine());
        }

        private IEnumerator SyncRoutine()
        {
            if (!TowerModSettings.SkipTowerLogin)
            {
                var waited = 0f;
                while (string.IsNullOrEmpty(TowerModSettings.TowerAuthToken))
                {
                    if (waited >= 300f)
                    {
                        yield break;
                    }

                    yield return new WaitForSeconds(1f);
                    waited += 1f;
                }
            }

            // Short delay so TowerSessionAutoCall / auth settle, but short enough to beat
            // the ACARS poll loop (which waits ~1.5s before first fetch) so SessionId matches
            // server active-room before the first channel key is latched (avoids a false
            // "channel switch" that clears the log right after send).
            yield return new WaitForSeconds(0.35f);

            var url = TowerModSettings.ApiBaseUrl + "/me/active-room";
            using (var req = UnityWebRequest.Get(url))
            {
                req.downloadHandler = new DownloadHandlerBuffer();
                req.timeout = 10;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    yield break;
                }

                var body = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(body))
                {
                    yield break;
                }

                if (Regex.IsMatch(body, "\"activeRoom\"\\s*:\\s*null"))
                {
                    yield break;
                }

                var rid = ExtractRoomId(body);
                if (string.IsNullOrEmpty(rid))
                {
                    yield break;
                }

                var cur = TowerModSettings.SessionId ?? string.Empty;
                if (string.Equals(rid, cur, System.StringComparison.Ordinal))
                {
                    yield break;
                }

                Debug.Log(
                    "[KSCTowerNetwork] ACARS/voice session sync from active-room: \"" + cur + "\" -> \"" + rid + "\"");
                TowerModSettings.SetActiveChannel(rid);
            }
        }

        private static string ExtractRoomId(string json)
        {
            var m = Regex.Match(json, "\"roomId\"\\s*:\\s*\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : null;
        }
    }
}
