using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// RasterPropMonitor JSIActionGroupSwitch plugin handler: push-to-talk to the
    /// Node voice-bridge (<c>MIC_ON</c> / <c>MIC_OFF</c>) using <see cref="TowerModSettings"/>.
    /// </summary>
    public class KSCTowerRpmMic : InternalModule
    {
        private bool _micLive;

        /// <summary>RPM calls this with <c>true</c> when the switch goes on and <c>false</c> when off (momentary release).</summary>
        public void TowerMicSet(bool on)
        {
            TowerModSettings.EnsureLoaded();
            var host = TowerModSettings.VoiceCtlHost;
            var port = TowerModSettings.VoiceCtlPort;
            var cmd = on ? "MIC_ON" : "MIC_OFF";

            // Publish to the bus before queuing the TCP round trip so chatter ducking happens on
            // the same frame as the button press; otherwise Chatterer / the ASET COMM radio's own
            // ATC sample keeps playing during the bridge response window.
            TowerPttBus.Publish(on, "twr-pushbutton");

            // RPM invokes this from the main thread on every PTT press; the previous
            // synchronous call could freeze the cockpit for ~20s when the voice bridge
            // wasn't running. Queue the TCP round trip and update _micLive when it lands.
            TowerVoiceBridgeControl.EnqueueSend(host, port, cmd, (ok, resp) =>
            {
                TowerMainThreadDispatcher.Run(() =>
                {
                    if (!ok)
                    {
                        _micLive = false;
                        if (on)
                        {
                            ScreenMessages.PostScreenMessage("Tower mic: voice app not running.", 4f, ScreenMessageStyle.UPPER_LEFT);
                        }
                        return;
                    }

                    if (!string.IsNullOrEmpty(resp) && resp.StartsWith("OK"))
                    {
                        _micLive = on;
                    }
                    else
                    {
                        _micLive = false;
                        if (on)
                        {
                            Debug.LogWarning("[KSCTowerNetwork] RPM mic: " + (resp ?? "(no reply)"));
                            ScreenMessages.PostScreenMessage("Tower mic: couldn't start.", 4f, ScreenMessageStyle.UPPER_LEFT);
                        }
                    }
                });
            });
        }

        /// <summary>Optional state for non-momentary (toggle) setups.</summary>
        public bool TowerMicSetState()
        {
            return _micLive;
        }

        private void OnDestroy()
        {
            if (_micLive)
            {
                TowerModSettings.EnsureLoaded();
                // Release the bus *first* — vessel switch / scene unload must not strand subscribers
                // (chatter ducking, bridge MIC_ON state) thinking the button is still held.
                TowerPttBus.Publish(false, "twr-pushbutton");

                // OnDestroy must not block the scene teardown frame on TCP.
                TowerVoiceBridgeControl.EnqueueSend(
                    TowerModSettings.VoiceCtlHost,
                    TowerModSettings.VoiceCtlPort,
                    "MIC_OFF",
                    null);
                _micLive = false;
            }
        }
    }
}
