using System;
using System.Collections.Generic;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Marshals work from worker threads (TCP callbacks, voice playback worker) back to
    /// the Unity main thread. Most KSP/Unity APIs (ScreenMessages, Debug.Log under newer
    /// Unity versions, GameObject access) are not thread-safe; calling them from a
    /// worker thread can crash the game or produce silent corruption.
    ///
    /// Usage: <c>TowerMainThreadDispatcher.Run(() =&gt; Debug.Log("hi"));</c> from any
    /// thread. The action runs in the next Update tick on the main thread.
    /// </summary>
    [KSPAddon(KSPAddon.Startup.Instantly, true)]
    public sealed class TowerMainThreadDispatcher : MonoBehaviour
    {
        private static TowerMainThreadDispatcher _instance;
        private static readonly object _lock = new object();
        private static readonly Queue<Action> _pending = new Queue<Action>();

        // Drains held outside the lock to keep the critical section small.
        private readonly List<Action> _drain = new List<Action>(16);

        /// <summary>
        /// Schedule <paramref name="action"/> to run on the Unity main thread on the next
        /// Update tick. Safe to call from any thread. Silently no-ops if the dispatcher
        /// hasn't been created yet (very early startup) — callers that depend on
        /// guaranteed delivery should null-check via <see cref="IsReady"/>.
        /// </summary>
        public static void Run(Action action)
        {
            if (action == null)
            {
                return;
            }

            lock (_lock)
            {
                _pending.Enqueue(action);
            }
        }

        public static bool IsReady
        {
            get { return _instance != null; }
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;
            DontDestroyOnLoad(gameObject);
        }

        private void Update()
        {
            if (_pending.Count == 0)
            {
                return;
            }

            lock (_lock)
            {
                while (_pending.Count > 0)
                {
                    _drain.Add(_pending.Dequeue());
                }
            }

            for (var i = 0; i < _drain.Count; i++)
            {
                try
                {
                    _drain[i]();
                }
                catch (Exception ex)
                {
                    // A bad callback must not stop us draining the rest of the queue or
                    // wedge subsequent ticks.
                    Debug.LogException(ex);
                }
            }
            _drain.Clear();
        }

        private void OnDestroy()
        {
            if (_instance == this)
            {
                _instance = null;
            }
        }
    }
}
