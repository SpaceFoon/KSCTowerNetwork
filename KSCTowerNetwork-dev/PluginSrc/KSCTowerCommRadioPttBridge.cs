using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Translates <see cref="TowerPttBus"/> events emitted by the ASET COMM radio prop
    /// (<see cref="KSCTowerCommRadioPtt"/>) into bridge <c>MIC_ON</c> / <c>MIC_OFF</c> sends.
    /// Lives outside the InternalModule so the per-prop poller stays free of Unity / TCP
    /// side effects and re-uses the existing fire-and-forget queue from
    /// <see cref="TowerVoiceBridgeControl.EnqueueSend(string,int,string,System.Action{bool,string})"/>.
    /// </summary>
    /// <remarks>
    /// Filters on <c>source == "iva-comm"</c>: the UI bar (<see cref="TowerRadioGui"/>) and TWR
    /// pushbutton (<see cref="KSCTowerRpmMic"/>) already drive their own bridge sends and we
    /// must not double-send for them.
    /// </remarks>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class KSCTowerCommRadioPttBridge : MonoBehaviour
    {
        private const string IvaCommSource = "iva-comm";

        private bool _bridgeMicLive;

        private void OnEnable()
        {
            TowerPttBus.PttStateChangedWithSource += HandlePttStateChanged;
        }

        private void OnDisable()
        {
            TowerPttBus.PttStateChangedWithSource -= HandlePttStateChanged;
            // Scene unload while the IVA COMM radio asserts PTT must close the bridge mic.
            // KSCTowerCommRadioPtt.OnDestroy will publish false to the bus, but this addon may
            // already be disabled by then so we mirror the close locally as a backstop.
            if (_bridgeMicLive)
            {
                _bridgeMicLive = false;
                SendMicCommand(false);
            }
        }

        private void HandlePttStateChanged(bool open, string source)
        {
            if (!string.Equals(source, IvaCommSource, System.StringComparison.Ordinal))
            {
                return;
            }

            if (open == _bridgeMicLive)
            {
                return;
            }

            _bridgeMicLive = open;
            SendMicCommand(open);
        }

        private static void SendMicCommand(bool on)
        {
            TowerModSettings.EnsureLoaded();
            var host = TowerModSettings.VoiceCtlHost;
            var port = TowerModSettings.VoiceCtlPort;
            var cmd = on ? "MIC_ON" : "MIC_OFF";

            // Fire-and-forget: a stalled bridge must not freeze the IVA OnUpdate frame.
            TowerVoiceBridgeControl.EnqueueSend(host, port, cmd, (ok, resp) =>
            {
                if (!ok && on)
                {
                    TowerMainThreadDispatcher.Run(() =>
                        Debug.LogWarning("[KSCTowerNetwork] IVA COMM radio MIC_ON failed (bridge offline?)"));
                }
            });
        }
    }
}
