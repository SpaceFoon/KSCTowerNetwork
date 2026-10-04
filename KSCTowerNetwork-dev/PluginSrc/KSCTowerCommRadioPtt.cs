using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// IVA-side hook for the ASET COMM Radio prop. Polls the per-pod persistent variable that
    /// the ASET RasterPropMonitor variant (<c>ASET_COMM_RADIO_PTT</c>, written by the
    /// <see cref="!:JSIActionGroupSwitch"/> on collider press) and the MOARdV MAS variant
    /// (<c>ASET_COMM_RADIO_PTT_PRESS</c>, written by <c>MAS_ASET_COMM_PTT_In/Out()</c> in
    /// <c>ASET_COMM_Radio.lua</c>) both touch. On a 0 → 1 / 1 → 0 transition we publish to
    /// <see cref="TowerPttBus"/>; the actual MIC_ON / MIC_OFF TCP send is owned by
    /// <see cref="KSCTowerCommRadioPttBridge"/> so this module stays a pure observer.
    /// </summary>
    /// <remarks>
    /// We poll instead of patching either prop's modules so the same hook works across RPM
    /// cockpits, MAS cockpits, and Reviva swaps with no risk of breaking the ASET radio's own
    /// ATC chatter / recovery / animator features.
    /// </remarks>
    public class KSCTowerCommRadioPtt : InternalModule
    {
        // Per-pod state. Don't publish on first frame: the persistent var may legitimately be 1
        // when the pod loads (e.g. user quick-saved with PTT held); we only fire on transitions.
        private bool _lastPttHeld;
        private bool _everSawValue;
        private bool _publishedOpen;

        public override void OnUpdate()
        {
            if (internalProp == null || internalProp.part == null)
            {
                return;
            }

            // OR the two known names: RPM uses ASET_COMM_RADIO_PTT (raw collider state),
            // MAS uses ASET_COMM_RADIO_PTT_PRESS (set in Lua). Whichever flips first wins.
            var rpmRaw = TowerCommRadioPersistents.Read(internalProp.part, "ASET_COMM_RADIO_PTT");
            var masRaw = TowerCommRadioPersistents.Read(internalProp.part, "ASET_COMM_RADIO_PTT_PRESS");
            if (rpmRaw == null && masRaw == null)
            {
                return;
            }

            var held = TowerCommRadioPersistentValueParsing.AsBool(rpmRaw)
                || TowerCommRadioPersistentValueParsing.AsBool(masRaw);

            if (!_everSawValue)
            {
                _everSawValue = true;
                _lastPttHeld = held;
                _publishedOpen = false;
                return;
            }

            if (held == _lastPttHeld)
            {
                return;
            }

            _lastPttHeld = held;
            _publishedOpen = held;
            TowerPttBus.Publish(held, "iva-comm");
        }

        private void OnDestroy()
        {
            // Vessel switch / scene unload while the user is mid-transmit must release any
            // subscribers (chatter ducking, bridge MIC_ON) — otherwise Chatterer stays muted and
            // the bridge stays open until the next press.
            if (_publishedOpen)
            {
                _publishedOpen = false;
                TowerPttBus.Publish(false, "iva-comm");
            }
        }

    }
}
