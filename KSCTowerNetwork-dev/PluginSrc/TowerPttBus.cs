using System;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Single broadcast point that every PTT source publishes to: keyboard / radio-bar UI
    /// (<see cref="TowerRadioGui"/>), the dedicated TWR pushbutton prop (<see cref="KSCTowerRpmMic"/>),
    /// and the in-IVA ASET COMM radio's PTT collider (<see cref="KSCTowerCommRadioPtt"/>).
    /// </summary>
    /// <remarks>
    /// Subscribers ("does this affect TX state?"):
    /// <list type="bullet">
    /// <item><see cref="TowerVoiceBridgeControl"/> wrappers in each source path drive the actual MIC_ON / MIC_OFF TCP send.</item>
    /// <item><see cref="TowerChattererDuck"/> mutes Chatterer + ASET COMM radio's own ATC clips while open.</item>
    /// <item><see cref="KSCTowerCommRadioPttBridge"/> translates the <c>iva-comm</c> source into a bridge MIC_ON / MIC_OFF.</item>
    /// </list>
    /// A single re-entrancy flag prevents an audio side effect inside a handler from cascading
    /// back into another publish on the same frame.
    /// </remarks>
    public static class TowerPttBus
    {
        /// <summary>
        /// Fired with <c>open == true</c> on PTT key-down (MIC opening) and <c>open == false</c>
        /// on PTT release (MIC closing). Always invoked on the Unity main thread by the publishers
        /// in this codebase; subscribers may freely touch Unity state.
        /// </summary>
        public static event Action<bool> PttStateChanged;

        /// <summary>
        /// Same edge as <see cref="PttStateChanged"/> but also carries the publisher source tag,
        /// for subscribers that need to filter (e.g. the IVA COMM radio bridge translator only
        /// reacts to <c>"iva-comm"</c> so it doesn't double-send for UI / TWR-button events).
        /// </summary>
        public static event Action<bool, string> PttStateChangedWithSource;

        /// <summary>
        /// True when the bus has been informed by *any* source that PTT is currently open.
        /// Mostly diagnostic; subscribers should track their own per-source state.
        /// </summary>
        public static bool IsAnySourceOpen { get; private set; }

        private static bool _publishing;

        /// <summary>
        /// Publish a state transition. <paramref name="source"/> is a short tag (e.g. <c>"ui"</c>,
        /// <c>"twr-pushbutton"</c>, <c>"iva-comm"</c>) that subscribers can filter on if they only
        /// care about a subset.
        /// </summary>
        public static void Publish(bool open, string source)
        {
            if (_publishing)
            {
                // A subscriber's audio-mute side effect must not loop back into another publish on the
                // same frame; KSP's IMGUI / OnUpdate ordering can otherwise re-enter via TowerRadioGui.
                return;
            }

            _publishing = true;
            try
            {
                IsAnySourceOpen = open;
                var handlers = PttStateChanged;
                if (handlers != null)
                {
                    try
                    {
                        handlers(open);
                    }
                    catch (Exception ex)
                    {
                        // One bad subscriber must not block the others; log and continue. Iterating the
                        // invocation list manually would be safer but PttStateChanged is fired from OnGUI /
                        // OnUpdate hot paths and the alloc isn't worth it.
                        Debug.LogWarning(
                            "[KSCTowerNetwork] PTT subscriber threw (source=" + (source ?? "?") + " open=" + open + "): " + ex);
                    }
                }

                var sourceHandlers = PttStateChangedWithSource;
                if (sourceHandlers != null)
                {
                    try
                    {
                        sourceHandlers(open, source ?? string.Empty);
                    }
                    catch (Exception ex)
                    {
                        Debug.LogWarning(
                            "[KSCTowerNetwork] PTT source-subscriber threw (source=" + (source ?? "?") + " open=" + open + "): " + ex);
                    }
                }
            }
            finally
            {
                _publishing = false;
            }
        }
    }
}
