using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Hands-free, opt-out kOS screen mirror. Walks every active <c>kOS.Module.kOSProcessor</c>
    /// part on the active vessel each tick and forwards any newly-changed terminal lines to the
    /// web Tower desk's kOS screen panel.
    /// </summary>
    /// <remarks>
    /// Why reflection: we don't take a compile-time dependency on kOS.dll / kOS.Safe.dll, so the
    /// rest of the plugin still loads cleanly when the player has no kOS install. All type / member
    /// lookups are done lazily on first tick after kOS shows up; if any lookup fails, the loop
    /// quietly disables itself (one log line) and never touches reflection again that session.
    ///
    /// Diff strategy: kOS's own <c>IScreenBufferLine</c> exposes <c>LastChangeTick</c> (a ulong
    /// that bumps when anything in the row mutates). For each processor we cache the last seen tick
    /// per row index; when it changes we ship the row's current text. Because kOS scrolls the
    /// buffer by physically rewriting all rows when a new line is printed at the bottom, *every*
    /// row's tick advances on every PRINT. To keep the web feed signal-rich we additionally dedupe
    /// against a short-TTL ring of recently-shipped lines per processor (3 s window) so scroll
    /// repeats collapse into the single new line at the bottom while genuine "PRINT same string
    /// again 4 seconds later" still goes through.
    ///
    /// Replaced the file-mailbox <c>kos_screen_lib.ks</c> + <c>TowerKosScreenBridge</c> opt-in path
    /// — players asked for "just read all kOS automatically", so this is now the only path. The
    /// player-facing toggle lives on the cockpit radio panel (KOS switch) and is persisted as
    /// <see cref="TowerModSettings.KosScreenStreamActive"/>.
    /// </remarks>
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TowerKosScreenAutoCapture : MonoBehaviour
    {
        // The kOS terminal is 50x36 by default and lines are short; this only kicks in for
        // pathological wrapped output. We never want one runaway PRINT to flood the backend.
        private const int MaxLineLength = 1000;

        // Per-tick safety valve. If a wide reflow / clear-screen flips every row's tick at once
        // we don't want to fire 36 POSTs back-to-back. The dedupe ring usually swallows them
        // before this matters; this is the belt to the suspenders.
        private const int MaxLinesPerProcessorPerTick = 8;

        // Dedupe TTL. Long enough to swallow the scroll-rewrite case (every row's tick bumps
        // on a single PRINT, and we only want the *new* bottom line to reach the web), short
        // enough that a script honestly printing the same status string every few seconds is
        // not silently dropped.
        private const float DedupeTtlSeconds = 3f;

        // Default poll interval. Two ticks per second is plenty to feel "live" on the web side
        // while costing a single reflection-walk per CPU per half-second. No knob exposed —
        // the whole point of this rewrite is "no settings to read, it just works".
        private const float TickIntervalSeconds = 0.5f;

        private static TowerKosScreenAutoCapture _instance;
        public static TowerKosScreenAutoCapture Instance { get { return _instance; } }

        // Reflection handles, all resolved lazily once kOS appears in the appdomain.
        private bool _reflectionResolved;
        private bool _reflectionDisabled;
        private Type _processorType;
        private FieldInfo _sharedField;
        private PropertyInfo _screenProp;
        private MethodInfo _getBufferMethod;
        private PropertyInfo _lineLastChangeTickProp;
        private PropertyInfo _lineLengthProp;
        private MethodInfo _lineToArrayMethod;

        // Optional: the visible cursor row, used to suppress emission of the row the user is
        // actively typing on. If kOS ever drops/renames this property the capture still works,
        // it just regresses to "echoes every keystroke" — exactly the bug this fixes.
        private PropertyInfo _screenCursorRowShowProp;
        private bool _kosMissingLogged;

        // Per-processor capture state. Keyed on the kOSProcessor MonoBehaviour instance so that
        // when the player switches vessels we naturally drop stale state (the old MonoBehaviours
        // get garbage-collected; we prune dead refs on each tick).
        private readonly Dictionary<UnityEngine.Object, ProcState> _state =
            new Dictionary<UnityEngine.Object, ProcState>();

        private bool _started;

        private sealed class ProcState
        {
            // index → LastChangeTick at the time we either shipped this row or decided it was
            // empty/duplicate and need not be shipped. Sparse; only populated for rows we've
            // observed at least once. Crucially we do NOT update this when we skip a row
            // because it's the active cursor row — that's what lets us emit the typed command
            // exactly once when the cursor moves away (the row's tick will then be > shipped
            // tick on a subsequent tick where it's no longer the cursor row).
            public readonly Dictionary<int, ulong> ShippedTicks = new Dictionary<int, ulong>();

            // text → unscaled-time-of-last-ship. Bounded growth: trimmed to most recent ~64 entries.
            public readonly Dictionary<string, float> RecentlyShipped =
                new Dictionary<string, float>(StringComparer.Ordinal);

            public string Tag = string.Empty;
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

        private void OnDestroy()
        {
            if (_instance == this)
            {
                _instance = null;
            }
        }

        private void Start()
        {
            if (_started)
            {
                return;
            }

            _started = true;
            TowerModSettings.EnsureLoaded();
            StartCoroutine(CaptureLoop());
        }

        private IEnumerator CaptureLoop()
        {
            // Stagger so we don't fight scene-load telemetry/login bursts on entry to flight.
            yield return new WaitForSeconds(2.0f);

            while (true)
            {
                if (_reflectionDisabled || !TowerModSettings.KosScreenStreamActive)
                {
                    yield return new WaitForSeconds(1f);
                    continue;
                }

                if (!ResolveReflection())
                {
                    // kOS not loaded yet (or not installed at all). Slow-poll so we pick it up
                    // if the player installs / loads it mid-session, without burning CPU.
                    yield return new WaitForSeconds(5f);
                    continue;
                }

                string sessionId;
                if (CanTalkToBackend(out sessionId))
                {
                    yield return StartCoroutine(WalkProcessors(sessionId));
                }

                yield return new WaitForSeconds(TickIntervalSeconds);
            }
        }

        /// <summary>True when the player is signed in (or skipTowerLogin) and a session id is set.</summary>
        private static bool CanTalkToBackend(out string sessionId)
        {
            TowerModSettings.EnsureLoaded();
            sessionId = TowerModSettings.SessionId ?? string.Empty;
            if (string.IsNullOrEmpty(sessionId))
            {
                return false;
            }

            if (TowerModSettings.SkipTowerLogin)
            {
                return true;
            }

            return !string.IsNullOrEmpty(TowerModSettings.TowerAuthToken);
        }

        /// <summary>
        /// Find <c>kOS.Module.kOSProcessor</c> + the screen-buffer member chain. Returns false
        /// if kOS isn't loaded; permanently disables itself if kOS is loaded but its API has
        /// drifted (so we don't NRE-spam the log on every tick).
        /// </summary>
        private bool ResolveReflection()
        {
            if (_reflectionResolved)
            {
                return true;
            }

            try
            {
                _processorType = FindLoadedType("kOS.Module.kOSProcessor");
                if (_processorType == null)
                {
                    if (!_kosMissingLogged)
                    {
                        _kosMissingLogged = true;
                        Debug.Log(
                            "[KSCTowerNetwork] kOS screen capture: kOS not loaded yet (no kOS.Module.kOSProcessor). " +
                            "Will retry every 5 s.");
                    }

                    return false;
                }

                // Found it. Clear the missing-log flag so a later un-install/re-install logs again.
                _kosMissingLogged = false;

                // kOSProcessor.shared is a field (not a property) on the public instance.
                _sharedField = _processorType.GetField(
                    "shared", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (_sharedField == null)
                {
                    DisableReflection("kOS.Module.kOSProcessor.shared field not found");
                    return false;
                }

                var sharedType = _sharedField.FieldType;

                // SafeSharedObjects.Screen is a virtual property typed as kOS.Safe.Screen.IScreenBuffer.
                _screenProp = WalkForProperty(sharedType, "Screen");
                if (_screenProp == null)
                {
                    DisableReflection("kOS.SharedObjects.Screen property not found");
                    return false;
                }

                var screenType = _screenProp.PropertyType;
                _getBufferMethod = screenType.GetMethod("GetBuffer", Type.EmptyTypes);
                if (_getBufferMethod == null)
                {
                    DisableReflection("IScreenBuffer.GetBuffer() not found");
                    return false;
                }

                // Optional — used to suppress emission of the row the user is typing on. We
                // don't disable the whole capture if this is missing; we just regress to the
                // pre-fix behavior (every keystroke echoes) on that one kOS build.
                _screenCursorRowShowProp = screenType.GetProperty("CursorRowShow");
                if (_screenCursorRowShowProp == null)
                {
                    Debug.LogWarning(
                        "[KSCTowerNetwork] kOS screen capture: IScreenBuffer.CursorRowShow not found; " +
                        "typed input rows will echo to the web until kOS exposes it again.");
                }

                // IScreenBufferLine — pull the line type from the List<T> the buffer returns so we
                // resolve the *exact* interface kOS hands us, not whatever lookup we'd do by name.
                Type lineType = null;
                if (_getBufferMethod.ReturnType.IsGenericType)
                {
                    var args = _getBufferMethod.ReturnType.GetGenericArguments();
                    if (args.Length == 1)
                    {
                        lineType = args[0];
                    }
                }

                if (lineType == null)
                {
                    DisableReflection("IScreenBuffer.GetBuffer() return type unexpected");
                    return false;
                }

                _lineLastChangeTickProp = lineType.GetProperty("LastChangeTick");
                _lineLengthProp = lineType.GetProperty("Length");
                _lineToArrayMethod = lineType.GetMethod("ToArray", Type.EmptyTypes);
                if (_lineLastChangeTickProp == null || _lineLengthProp == null || _lineToArrayMethod == null)
                {
                    DisableReflection("IScreenBufferLine API surface incomplete");
                    return false;
                }

                _reflectionResolved = true;
                Debug.Log("[KSCTowerNetwork] kOS screen capture: bound to kOS reflectively, streaming live.");
                return true;
            }
            catch (Exception ex)
            {
                DisableReflection("reflection bootstrap threw: " + ex.Message);
                return false;
            }
        }

        private void DisableReflection(string reason)
        {
            _reflectionDisabled = true;
            Debug.LogWarning(
                "[KSCTowerNetwork] kOS screen capture: disabled — " + reason +
                ". (kOS plugin version mismatch? Update KSCTowerNetwork or report this.)");
        }

        /// <summary>Look up a Type by full name across all loaded assemblies (kOS sits in its own DLL).</summary>
        private static Type FindLoadedType(string fullName)
        {
            var asms = AppDomain.CurrentDomain.GetAssemblies();
            for (var i = 0; i < asms.Length; i++)
            {
                Type t;
                try
                {
                    t = asms[i].GetType(fullName, false);
                }
                catch
                {
                    continue;
                }

                if (t != null)
                {
                    return t;
                }
            }

            return null;
        }

        /// <summary>Walk up the inheritance chain looking for an instance property by name.</summary>
        private static PropertyInfo WalkForProperty(Type t, string name)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            while (t != null && t != typeof(object))
            {
                var p = t.GetProperty(name, flags);
                if (p != null)
                {
                    return p;
                }

                t = t.BaseType;
            }

            return null;
        }

        private IEnumerator WalkProcessors(string sessionId)
        {
            UnityEngine.Object[] processors;
            try
            {
                processors = UnityEngine.Object.FindObjectsOfType(_processorType);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] kOS screen capture: FindObjectsOfType failed: " + ex.Message);
                yield break;
            }

            if (processors == null || processors.Length == 0)
            {
                // No CPUs in scene right now. Drop stale state so the next CPU we see starts clean.
                if (_state.Count > 0)
                {
                    _state.Clear();
                }

                yield break;
            }

            // Prune dead entries the cheap way: anything not seen this pass is dead.
            HashSet<UnityEngine.Object> alive = null;
            if (_state.Count > 0)
            {
                alive = new HashSet<UnityEngine.Object>();
            }

            for (var i = 0; i < processors.Length; i++)
            {
                var proc = processors[i];
                if (proc == null)
                {
                    continue;
                }

                if (alive != null)
                {
                    alive.Add(proc);
                }

                List<string> newLines;
                try
                {
                    newLines = HarvestNewLines(proc);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning(
                        "[KSCTowerNetwork] kOS screen capture: harvest failed for " + proc.name + ": " + ex.Message);
                    continue;
                }

                if (newLines == null || newLines.Count == 0)
                {
                    continue;
                }

                ProcState state;
                _state.TryGetValue(proc, out state);
                var tag = state != null ? state.Tag : string.Empty;

                for (var j = 0; j < newLines.Count; j++)
                {
                    var body = newLines[j];
                    if (string.IsNullOrEmpty(body))
                    {
                        continue;
                    }

                    var withTag = string.IsNullOrEmpty(tag) ? body : (tag + " | " + body);
                    if (withTag.Length > MaxLineLength)
                    {
                        withTag = withTag.Substring(0, MaxLineLength);
                    }

                    yield return StartCoroutine(PostLine(sessionId, withTag));
                }
            }

            if (alive != null)
            {
                List<UnityEngine.Object> dead = null;
                foreach (var key in _state.Keys)
                {
                    if (!alive.Contains(key))
                    {
                        if (dead == null) { dead = new List<UnityEngine.Object>(); }
                        dead.Add(key);
                    }
                }

                if (dead != null)
                {
                    for (var i = 0; i < dead.Count; i++)
                    {
                        _state.Remove(dead[i]);
                    }
                }
            }
        }

        /// <summary>
        /// Read one processor's screen buffer, diff against last-shipped tick per row, return
        /// the trimmed text of any rows that mutated since we last shipped them. Updates
        /// per-processor state (ShippedTicks + RecentlyShipped) as a side effect.
        /// </summary>
        /// <remarks>
        /// The active cursor row is intentionally skipped without bumping its ShippedTicks
        /// entry. That's the whole trick that suppresses the "line echoes on every keystroke
        /// while typing" bug: while the user types into row R, R's tick bumps each character,
        /// but R == cursorRow so we skip and leave ShippedTicks[R] alone. When the user hits
        /// enter and the cursor moves to R+1, on the next tick R is no longer the cursor row,
        /// its tick is still &gt; ShippedTicks[R], so it ships exactly once with the final text.
        /// </remarks>
        private List<string> HarvestNewLines(UnityEngine.Object proc)
        {
            var shared = _sharedField.GetValue(proc);
            if (shared == null)
            {
                return null;
            }

            var screen = _screenProp.GetValue(shared, null);
            if (screen == null)
            {
                return null;
            }

            var bufferRaw = _getBufferMethod.Invoke(screen, null);
            var buffer = bufferRaw as System.Collections.IList;
            if (buffer == null || buffer.Count == 0)
            {
                return null;
            }

            // -1 means "no cursor info available" → don't skip any row. Defensive parsing in
            // case a third-party kOS fork returns a value out of range for the buffer.
            int cursorRow = -1;
            if (_screenCursorRowShowProp != null)
            {
                try
                {
                    var raw = _screenCursorRowShowProp.GetValue(screen, null);
                    if (raw is int)
                    {
                        var r = (int)raw;
                        if (r >= 0 && r < buffer.Count)
                        {
                            cursorRow = r;
                        }
                    }
                }
                catch
                {
                    // Treat one-off read failure as "no cursor info this tick"; do not disable
                    // the whole feature for a transient hiccup.
                }
            }

            ProcState state;
            if (!_state.TryGetValue(proc, out state))
            {
                state = new ProcState { Tag = ResolveCpuTag(proc) };
                _state[proc] = state;

                // First time seeing this CPU: seed ShippedTicks with current state so we don't
                // immediately ship the entire welcome banner / pre-existing buffer as if it
                // were fresh output. The web panel only cares about *new* output.
                for (var i = 0; i < buffer.Count; i++)
                {
                    var line = buffer[i];
                    if (line == null) { continue; }
                    var tick0 = (ulong)_lineLastChangeTickProp.GetValue(line, null);
                    state.ShippedTicks[i] = tick0;
                }

                return null;
            }

            var now = Time.unscaledTime;
            PruneDedupe(state, now);

            List<string> newLines = null;
            int emittedThisTick = 0;

            for (var i = 0; i < buffer.Count && emittedThisTick < MaxLinesPerProcessorPerTick; i++)
            {
                var line = buffer[i];
                if (line == null)
                {
                    continue;
                }

                var tick = (ulong)_lineLastChangeTickProp.GetValue(line, null);
                ulong shipped;
                state.ShippedTicks.TryGetValue(i, out shipped);
                if (tick == shipped)
                {
                    continue;
                }

                // Active typing row: skip emission AND skip the ShippedTicks bump. We want the
                // line to ship exactly once when the cursor finally moves away (typically on
                // ENTER). Without this branch, every keystroke would either ship a partial
                // line (if we emitted) or silently mark the eventual full line as already
                // shipped (if we just bumped the tick), which is the bug we're fixing.
                if (i == cursorRow)
                {
                    continue;
                }

                var len = (int)_lineLengthProp.GetValue(line, null);
                if (len <= 0)
                {
                    state.ShippedTicks[i] = tick;
                    continue;
                }

                var chars = (char[])_lineToArrayMethod.Invoke(line, null);
                if (chars == null)
                {
                    state.ShippedTicks[i] = tick;
                    continue;
                }

                var text = TrimLineChars(chars, len);
                if (text.Length == 0)
                {
                    state.ShippedTicks[i] = tick;
                    continue;
                }

                // Scroll-suppression: when a single PRINT scrolls the buffer, every row's tick
                // bumps and we'd ship every visible row again. The dedupe ring catches that —
                // any line we shipped in the last DedupeTtlSeconds is silently swallowed.
                float lastShipAt;
                if (state.RecentlyShipped.TryGetValue(text, out lastShipAt) &&
                    (now - lastShipAt) <= DedupeTtlSeconds)
                {
                    state.ShippedTicks[i] = tick;
                    continue;
                }

                state.RecentlyShipped[text] = now;
                state.ShippedTicks[i] = tick;
                emittedThisTick++;

                if (newLines == null) { newLines = new List<string>(); }
                newLines.Add(text);
            }

            return newLines;
        }

        private static void PruneDedupe(ProcState state, float now)
        {
            // Trim absolute size first — Dictionary enumeration cost matters at scale, and any
            // entry past the TTL window is unreachable anyway.
            if (state.RecentlyShipped.Count <= 64)
            {
                return;
            }

            List<string> stale = null;
            foreach (var kv in state.RecentlyShipped)
            {
                if ((now - kv.Value) > DedupeTtlSeconds)
                {
                    if (stale == null) { stale = new List<string>(); }
                    stale.Add(kv.Key);
                }
            }

            if (stale != null)
            {
                for (var i = 0; i < stale.Count; i++)
                {
                    state.RecentlyShipped.Remove(stale[i]);
                }
            }
        }

        /// <summary>
        /// Right-trim trailing spaces and stray NULs out of a fixed-width screen buffer row,
        /// returning the visible text. kOS pads rows to ColumnCount with spaces, so without
        /// this trim every PRINT would be 50 chars wide on the wire.
        /// </summary>
        private static string TrimLineChars(char[] chars, int len)
        {
            var end = Math.Min(len, chars.Length);
            while (end > 0)
            {
                var c = chars[end - 1];
                if (c == '\0' || c == ' ' || c == '\t' || c == '\r' || c == '\n')
                {
                    end--;
                    continue;
                }

                break;
            }

            if (end <= 0)
            {
                return string.Empty;
            }

            // Strip embedded control chars in the middle of the line; kOS sometimes parks NULs
            // in unfilled cells of a partially-overwritten row and the JSON encoder hates them.
            var sb = new StringBuilder(end);
            for (var i = 0; i < end; i++)
            {
                var c = chars[i];
                if (c < 0x20 && c != '\t')
                {
                    sb.Append(' ');
                }
                else
                {
                    sb.Append(c);
                }
            }

            return sb.ToString();
        }

        /// <summary>
        /// Best-effort short label for a kOSProcessor instance, used as the line tag on the web
        /// side ("kOS-1 | hello"). Falls back to the GameObject name. Doesn't reflect into kOS
        /// part labels — the GameObject name on a kOSProcessor is already the part's part name.
        /// </summary>
        private static string ResolveCpuTag(UnityEngine.Object proc)
        {
            if (proc == null)
            {
                return string.Empty;
            }

            var n = proc.name ?? string.Empty;
            // KSP appends "(Clone)" to part instances. Trim it; it adds noise on the web feed.
            const string cloneSuffix = "(Clone)";
            if (n.EndsWith(cloneSuffix, StringComparison.Ordinal))
            {
                n = n.Substring(0, n.Length - cloneSuffix.Length).TrimEnd();
            }

            // Most kOS part GameObjects are named like "kOSMachine0m" / "KAL.kOSMachine1m" —
            // trim long internal IDs to a leading "kOS" tag so the web feed stays tidy.
            if (n.IndexOf("kOS", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "kOS";
            }

            return n.Length > 16 ? n.Substring(0, 16) : n;
        }

        private IEnumerator PostLine(string sessionId, string text)
        {
            var url = TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sessionId) + "/kos-screen";
            var json = "{\"line\":\"" + JsonEscape(text) + "\"}";
            var body = Encoding.UTF8.GetBytes(json);

            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 10;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    var respText = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                    Debug.LogWarning(
                        "[KSCTowerNetwork] kOS screen capture: send failed (" + req.responseCode + "): " +
                        (req.error ?? "?") + " body=" + respText);
                }
            }
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }

            var sb = new StringBuilder(s.Length + 8);
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }

                        break;
                }
            }

            return sb.ToString();
        }
    }
}
