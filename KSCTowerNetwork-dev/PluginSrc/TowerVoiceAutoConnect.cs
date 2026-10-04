using System.Collections;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// After a short delay, connects in-game TCP listen to the voice-bridge and optionally enables bridge mic (PC mic to LiveKit).
    /// </summary>
    [KSPAddon(KSPAddon.Startup.FlightAndKSC, true)]
    public class TowerVoiceAutoConnect : MonoBehaviour
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
            if (!TowerModSettings.AutoConnectVoiceListen && !TowerModSettings.AutoBridgeMicAfterListen)
            {
                return;
            }

            StartCoroutine(ConnectRoutine());
        }

        private IEnumerator ConnectRoutine()
        {
            if (TowerModSettings.AutoConnectDelaySeconds > 0f)
            {
                yield return new WaitForSeconds(TowerModSettings.AutoConnectDelaySeconds);
            }

            // Dev bridge instances can boot with a stale/default room (e.g. dev-shared).
            // Always push the currently configured SessionId once on startup.
            var sid = TowerModSettings.SessionId;
            if (!string.IsNullOrEmpty(sid))
            {
                TowerVoiceBridgeControl.EnqueueSend(
                    TowerModSettings.VoiceCtlHost,
                    TowerModSettings.VoiceCtlPort,
                    "SESSION:" + sid,
                    (ok, resp) =>
                    {
                        TowerMainThreadDispatcher.Run(() =>
                        {
                            if (ok && !string.IsNullOrEmpty(resp) && resp.StartsWith("OK"))
                            {
                                Debug.Log("[KSCTowerNetwork] Auto session sync -> " + sid);
                            }
                            else
                            {
                                Debug.LogWarning("[KSCTowerNetwork] Auto session sync failed - " + (resp ?? "(null)"));
                            }
                        });
                    });
            }

            if (TowerModSettings.AutoConnectVoiceListen)
            {
                TowerVoicePlayback.EnsureExists();
                var v = TowerVoicePlayback.Instance;
                if (v != null && !v.IsConnectingOrConnected)
                {
                    v.StartBridgeConnection(TowerModSettings.VoiceListenHost, TowerModSettings.VoiceListenPort);
                    Debug.Log(
                        "[KSCTowerNetwork] Auto-connect helmet audio → " + TowerModSettings.VoiceListenHost + ":" +
                        TowerModSettings.VoiceListenPort);
                    StartCoroutine(NotifyWhenPcmHeaderReady());
                }
            }

            if (!TowerModSettings.AutoBridgeMicAfterListen)
            {
                yield break;
            }

            var timeout = 20f;
            var t = 0f;
            while (t < timeout)
            {
                var v = TowerVoicePlayback.Instance;
                if (v != null && v.HasStreamHeader)
                {
                    TowerVoiceBridgeControl.EnqueueSend(
                            TowerModSettings.VoiceCtlHost,
                            TowerModSettings.VoiceCtlPort,
                            "MIC_ON",
                            (ok, resp) =>
                            {
                                TowerMainThreadDispatcher.Run(() =>
                                {
                                    if (ok && !string.IsNullOrEmpty(resp) && resp.StartsWith("OK"))
                                    {
                                        Debug.Log("[KSCTowerNetwork] Auto mic on (MIC_ON OK).");
                                    }
                                    else
                                    {
                                        Debug.LogWarning("[KSCTowerNetwork] Auto mic: MIC_ON failed — " + (resp ?? "(null)"));
                                    }
                                });
                            });

                    yield break;
                }

                t += Time.deltaTime;
                yield return null;
            }

            Debug.LogWarning("[KSCTowerNetwork] Auto mic skipped: no audio from voice bridge in time.");
        }

        /// <summary>Confirms tower → game PCM path is live (user often had autoConnect off or bridge not streaming).</summary>
        private IEnumerator NotifyWhenPcmHeaderReady()
        {
            var wait = 0f;
            const float maxWait = 25f;
            while (wait < maxWait)
            {
                var v = TowerVoicePlayback.Instance;
                if (v != null && v.HasStreamHeader)
                {
                    Debug.Log("[KSCTowerNetwork] Helmet audio stream ready.");
                    yield break;
                }

                wait += Time.deltaTime;
                yield return null;
            }

            Debug.LogWarning(
                "[KSCTowerNetwork] No audio header from bridge at " + TowerModSettings.VoiceListenHost + ":" +
                TowerModSettings.VoiceListenPort + " (run voice bridge; match GameData settings).");
        }
    }
}

