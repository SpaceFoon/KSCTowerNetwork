using System;
using System.IO;
using System.Text;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Local pilot scratch-pad. Persists a single multi-line note buffer to
    /// <c>GameData/KSCTowerNetwork/PluginData/notes.txt</c> so anything the player jots down
    /// (clearance, taxi route, frequency assignments, mission profile, ...) survives scene
    /// changes and game restarts. Strictly client-side — the backend never sees this file.
    /// </summary>
    /// <remarks>
    /// Created on demand by the radio panel's NTS title-bar button (mirrors the ACR / CHK
    /// pattern in <see cref="TowerAcarsGui"/> / <see cref="TowerChecklistGui"/> so the panel
    /// lives across scene loads). Auto-saves with a short debounce after edits, plus an
    /// explicit Save button for the impatient. Copy/Paste/Append-from-clipboard buttons
    /// match the ones in the ACARS composer and tuner so the three surfaces feel like one
    /// console.
    /// </remarks>
    public class TowerNotesGui : MonoBehaviour
    {
        private const float PanelWidth = 520f;
        private const float PanelHeight = 580f;
        private const int MaxNotesChars = 64000;
        private const float AutoSaveDebounceSeconds = 1.25f;
        private const string RelPath = "GameData/KSCTowerNetwork/PluginData/notes.txt";
        private const string DefaultKosFilename = "notes.ks";
        private const int MaxKosFilenameLen = 64;

        private static TowerNotesGui _instance;

        public static TowerNotesGui Instance
        {
            get { return _instance; }
        }

        public Action OnRequestMinimize;

        private bool _visible;
        private bool _started;
        private string _text = string.Empty;
        private string _lastSavedText = string.Empty;
        private bool _dirty;
        private float _autoSaveAt = -1f;
        private string _statusLine = "Standby.";
        private bool _statusIsError;
        private Vector2 _scroll = Vector2.zero;
        private Rect _windowRect = new Rect(200f, 140f, PanelWidth, PanelHeight);
        private int _windowId;
        private string _kosFilename = DefaultKosFilename;

        public bool Visible
        {
            get { return _visible; }
            set
            {
                if (_visible == value)
                {
                    return;
                }

                _visible = value;
                if (!_visible && _dirty)
                {
                    // Don't lose pending edits when the player minimizes the panel — flush
                    // immediately rather than waiting for the debounce to fire (which can't,
                    // because Update() short-circuits while hidden).
                    SaveNow(silent: true);
                }
            }
        }

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerNotesGui");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerNotesGui>();
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            _windowId = GetInstanceID() ^ 0x4E4F5453; // "NOTS"
        }

        private void OnDestroy()
        {
            if (_dirty)
            {
                // Player closed KSP / scene tore down with unsaved edits; flush so they don't
                // lose the last paragraph they typed.
                SaveNow(silent: true);
            }

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
            LoadFromDisk();
        }

        private void Update()
        {
            // Debounced auto-save: every keystroke pushes the deadline back; we only hit the
            // disk once the player stops typing for AutoSaveDebounceSeconds. Cheap — at most
            // one File.WriteAllText per ~second of pause.
            if (!_dirty || _autoSaveAt < 0f)
            {
                return;
            }

            if (Time.unscaledTime < _autoSaveAt)
            {
                return;
            }

            SaveNow(silent: true);
        }

        private void OnApplicationQuit()
        {
            if (_dirty)
            {
                SaveNow(silent: true);
            }
        }

        private void LoadFromDisk()
        {
            try
            {
                var path = ResolvePath();
                if (!File.Exists(path))
                {
                    _text = string.Empty;
                    _lastSavedText = string.Empty;
                    return;
                }

                _text = File.ReadAllText(path) ?? string.Empty;
                if (_text.Length > MaxNotesChars)
                {
                    _text = _text.Substring(0, MaxNotesChars);
                }
                _lastSavedText = _text;
                _dirty = false;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] Notes load failed: " + ex.Message);
                _text = string.Empty;
                _lastSavedText = string.Empty;
            }
        }

        private void SaveNow(bool silent)
        {
            try
            {
                var path = ResolvePath();
                var dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }
                File.WriteAllText(path, _text ?? string.Empty);
                _lastSavedText = _text ?? string.Empty;
                _dirty = false;
                _autoSaveAt = -1f;
                if (!silent)
                {
                    SetStatus("Notes saved.", false);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] Notes save failed: " + ex.Message);
                SetStatus("Save failed: " + ex.Message, true);
            }
        }

        private static string ResolvePath()
        {
            var root = KSPUtil.ApplicationRootPath;
            return Path.Combine(root, RelPath.Replace('/', Path.DirectorySeparatorChar));
        }

        private void MarkDirty()
        {
            _dirty = !string.Equals(_text ?? string.Empty, _lastSavedText ?? string.Empty, StringComparison.Ordinal);
            _autoSaveAt = _dirty ? Time.unscaledTime + AutoSaveDebounceSeconds : -1f;
        }

        private void OnGUI()
        {
            if (!_visible)
            {
                return;
            }

            TowerSkin.EnsureBuilt();

            var maxX = Mathf.Max(0f, Screen.width - PanelWidth);
            var maxY = Mathf.Max(0f, Screen.height - PanelHeight);
            _windowRect.x = Mathf.Clamp(_windowRect.x, 0f, maxX);
            _windowRect.y = Mathf.Clamp(_windowRect.y, 0f, maxY);

            _windowRect = TowerClickBlock.GUILayoutWindow(_windowId, _windowRect, DrawWindow, GUIContent.none, TowerSkin.Panel);
        }

        private void DrawWindow(int id)
        {
            GUILayout.BeginVertical();

            if (TowerSkin.DrawTitleBar("NOTES  \u00B7  PILOT  SCRATCHPAD", true))
            {
                Visible = false;
                if (OnRequestMinimize != null)
                {
                    OnRequestMinimize();
                }
            }

            DrawHeader();
            DrawEditor();
            DrawClipboardRow();
            DrawKosExportRow();
            DrawStatus();

            GUILayout.EndVertical();

            GUI.DragWindow(new Rect(0f, 0f, PanelWidth - 32f, 28f));
            TowerImguiClickSink.UseUnhandledMouseInLocalWindow(new Rect(0f, 0f, PanelWidth, PanelHeight));
        }

        private void DrawHeader()
        {
            GUILayout.BeginHorizontal();
            var info = "Local only \u00B7 " +
                       (_text == null ? 0 : _text.Length) + " / " + MaxNotesChars + " chars" +
                       (_dirty ? "  \u00B7  unsaved" : string.Empty);
            GUILayout.Label(info, _dirty ? TowerSkin.StatusError : TowerSkin.Subtitle);
            GUILayout.FlexibleSpace();

            GUI.enabled = _dirty;
            if (GUILayout.Button("Save", TowerSkin.Button, GUILayout.Width(70f), GUILayout.Height(22f)))
            {
                SaveNow(silent: false);
            }
            GUI.enabled = true;

            if (GUILayout.Button("Reload", TowerSkin.Button, GUILayout.Width(80f), GUILayout.Height(22f)))
            {
                LoadFromDisk();
                ReleaseTextAreaFocus();
                SetStatus("Reloaded from disk.", false);
            }

            GUILayout.EndHorizontal();
        }

        private void DrawEditor()
        {
            GUILayout.BeginVertical(TowerSkin.Inset);
            _scroll = GUILayout.BeginScrollView(_scroll, GUILayout.Height(PanelHeight - 220f));
            // Single big text area; Unity caps it at MaxNotesChars so a runaway paste can't
            // blow the file budget. ExpandHeight keeps the area filling the scroll viewport
            // even when the buffer is short, so the click target is the whole pane.
            var next = GUILayout.TextArea(
                _text ?? string.Empty,
                MaxNotesChars,
                TowerSkin.TextArea,
                GUILayout.ExpandHeight(true),
                GUILayout.MinHeight(PanelHeight - 240f));
            if (!string.Equals(next, _text ?? string.Empty, StringComparison.Ordinal))
            {
                _text = next;
                MarkDirty();
            }
            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        /// <summary>
        /// Copy / Paste / Append / Clear buttons. Mirrors the row added to the ACARS composer
        /// and the radio tuner so all three surfaces share one clipboard vocabulary — the
        /// player can copy a clearance out of ACARS, paste it into Notes, copy a frequency
        /// out of Notes back into the tuner without leaving the cockpit.
        /// </summary>
        private void DrawClipboardRow()
        {
            GUILayout.Space(4f);
            GUILayout.BeginHorizontal();

            GUI.enabled = !string.IsNullOrEmpty(_text);
            if (GUILayout.Button("Copy all", TowerSkin.Button, GUILayout.Height(26f)))
            {
                GUIUtility.systemCopyBuffer = _text ?? string.Empty;
                SetStatus("Copied " + (_text == null ? 0 : _text.Length) + " chars to clipboard.", false);
            }
            GUI.enabled = true;

            var clip = GUIUtility.systemCopyBuffer ?? string.Empty;
            GUI.enabled = !string.IsNullOrEmpty(clip);
            if (GUILayout.Button("Paste (replace)", TowerSkin.Button, GUILayout.Height(26f)))
            {
                ReplaceFromClipboard(clip);
            }
            if (GUILayout.Button("Append", TowerSkin.Button, GUILayout.Height(26f)))
            {
                AppendFromClipboard(clip);
            }
            GUI.enabled = true;

            GUI.enabled = !string.IsNullOrEmpty(_text);
            if (GUILayout.Button("Clear", TowerSkin.Button, GUILayout.Width(70f), GUILayout.Height(26f)))
            {
                _text = string.Empty;
                ReleaseTextAreaFocus();
                MarkDirty();
                SetStatus("Cleared (unsaved — Save to commit).", false);
            }
            GUI.enabled = true;

            GUILayout.EndHorizontal();
        }

        private void ReplaceFromClipboard(string clip)
        {
            if (clip == null)
            {
                clip = string.Empty;
            }
            if (clip.Length > MaxNotesChars)
            {
                clip = clip.Substring(0, MaxNotesChars);
            }
            _text = clip;
            ReleaseTextAreaFocus();
            MarkDirty();
            SetStatus("Pasted " + clip.Length + " chars (replace).", false);
        }

        private void AppendFromClipboard(string clip)
        {
            if (string.IsNullOrEmpty(clip))
            {
                return;
            }
            var existing = _text ?? string.Empty;
            // Insert a separator line between blocks so successive appends don't smear
            // together. Skip when the buffer is empty or already ends with whitespace.
            var sep = string.Empty;
            if (existing.Length > 0 && !char.IsWhiteSpace(existing[existing.Length - 1]))
            {
                sep = "\n";
            }
            var combined = existing + sep + clip;
            if (combined.Length > MaxNotesChars)
            {
                combined = combined.Substring(0, MaxNotesChars);
                SetStatus("Appended (truncated to " + MaxNotesChars + " chars).", true);
            }
            else
            {
                SetStatus("Appended " + clip.Length + " chars.", false);
            }
            _text = combined;
            ReleaseTextAreaFocus();
            MarkDirty();
        }

        /// <summary>
        /// Export-as-KerboScript row. Drops the current scratchpad text into the kOS
        /// Archive volume (same folder <see cref="TowerAcarsKosBridge"/> uses, configured
        /// via <c>kosBridgeArchivePath</c> — defaults to <c>Ships/Script/</c>) so the
        /// player can scribble a quick kOS snippet up here and run it from any kOS
        /// terminal without leaving the panel. Filename is sanitized and forced to end
        /// in <c>.ks</c>; we never auto-create the Archive folder because its absence
        /// almost always means kOS isn't installed and silently making it would just
        /// scatter orphan files under the KSP root.
        /// </summary>
        private void DrawKosExportRow()
        {
            GUILayout.Space(4f);
            GUILayout.BeginHorizontal();

            GUILayout.Label("kOS:", TowerSkin.Subtitle, GUILayout.Width(36f));

            var nextName = GUILayout.TextField(
                _kosFilename ?? string.Empty,
                MaxKosFilenameLen,
                TowerSkin.TextField,
                GUILayout.Height(26f),
                GUILayout.ExpandWidth(true));
            if (!string.Equals(nextName, _kosFilename, StringComparison.Ordinal))
            {
                _kosFilename = nextName;
            }

            GUI.enabled = !string.IsNullOrEmpty(SanitizeKosFilename(_kosFilename, force: false));
            if (GUILayout.Button("Save as .ks", TowerSkin.Button, GUILayout.Width(110f), GUILayout.Height(26f)))
            {
                SaveToKosArchive();
            }
            GUI.enabled = true;

            GUILayout.EndHorizontal();
        }

        /// <summary>
        /// Resolve the kOS Archive folder via the same rule the ACARS bridge uses
        /// (<see cref="TowerModSettings.KosBridgeArchivePath"/>, default
        /// <c>Ships/Script</c>; absolute paths honored as-is) and write the scratchpad
        /// buffer there as a <c>.ks</c> file. Returns silently with a status message
        /// on every failure mode — this is a player-driven action, never throw out.
        /// </summary>
        private void SaveToKosArchive()
        {
            var name = SanitizeKosFilename(_kosFilename, force: true);
            if (string.IsNullOrEmpty(name))
            {
                SetStatus("kOS save: filename is empty after sanitizing.", true);
                return;
            }
            // Reflect the cleaned-up name back into the field so the player sees what we
            // actually wrote (e.g. they typed "my notes" → field updates to "my_notes.ks").
            _kosFilename = name;

            try
            {
                var archiveDir = ResolveKosArchiveDir();
                if (!Directory.Exists(archiveDir))
                {
                    // Don't auto-create — see method docstring rationale.
                    SetStatus("kOS Archive folder not found: " + archiveDir, true);
                    return;
                }

                var path = Path.Combine(archiveDir, name);
                var existed = File.Exists(path);
                File.WriteAllText(path, _text ?? string.Empty);
                SetStatus(
                    (existed ? "Overwrote " : "Saved ") + name + " (" +
                    (_text == null ? 0 : _text.Length) + " chars) → " + archiveDir,
                    false);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] Notes kOS export failed: " + ex.Message);
                SetStatus("kOS save failed: " + ex.Message, true);
            }
        }

        /// <summary>
        /// Mirror of <c>TowerAcarsKosBridge.ResolveUnderRoot</c> + its archive defaulting
        /// rule, inlined so the notes panel doesn't take a hard dependency on the bridge
        /// component (the bridge can be disabled in mod settings; the export should still
        /// work as long as the Archive folder physically exists).
        /// </summary>
        private static string ResolveKosArchiveDir()
        {
            var configured = TowerModSettings.KosBridgeArchivePath;
            if (string.IsNullOrEmpty(configured))
            {
                configured = "Ships/Script";
            }

            var root = KSPUtil.ApplicationRootPath;
            if (Path.IsPathRooted(configured))
            {
                return configured;
            }

            return Path.GetFullPath(Path.Combine(root, configured.Replace('/', Path.DirectorySeparatorChar)));
        }

        /// <summary>
        /// Strip path separators / invalid filename chars and force a <c>.ks</c>
        /// extension. <paramref name="force"/> distinguishes the validation pass (used
        /// to gate the Save button — returns empty when there's nothing usable) from
        /// the commit pass (which always appends <c>.ks</c> if missing).
        /// </summary>
        private static string SanitizeKosFilename(string raw, bool force)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return string.Empty;
            }

            var trimmed = raw.Trim();
            if (trimmed.Length == 0)
            {
                return string.Empty;
            }

            // Replace path separators and any platform-invalid filename chars with '_'
            // so a careless paste like "Ships/Script/foo.ks" can't escape the Archive
            // folder. Spaces become underscores too — kOS filename references in
            // KerboScript are friendlier without whitespace.
            var invalid = Path.GetInvalidFileNameChars();
            var sb = new StringBuilder(trimmed.Length);
            for (var i = 0; i < trimmed.Length; i++)
            {
                var c = trimmed[i];
                if (c == '/' || c == '\\' || c == ' ' || Array.IndexOf(invalid, c) >= 0)
                {
                    sb.Append('_');
                }
                else
                {
                    sb.Append(c);
                }
            }

            var cleaned = sb.ToString().Trim('.', '_');
            if (cleaned.Length == 0)
            {
                return string.Empty;
            }

            if (cleaned.EndsWith(".ks", StringComparison.OrdinalIgnoreCase))
            {
                return cleaned;
            }

            return force ? cleaned + ".ks" : string.Empty;
        }

        /// <summary>
        /// Drop keyboard focus when we mutate <see cref="_text"/> from a button click.
        /// Unity's IMGUI keeps a per-control editing-state cache for the focused TextArea
        /// and will repaint the *cached* value (not the new <c>_text</c>) until focus
        /// changes — which leaves a paste/clear looking like a no-op until the user clicks
        /// the area. Forcing keyboardControl back to 0 invalidates that cache so the next
        /// OnGUI pass picks up the new buffer.
        /// </summary>
        private static void ReleaseTextAreaFocus()
        {
            GUIUtility.keyboardControl = 0;
            GUI.FocusControl(null);
        }

        private void DrawStatus()
        {
            if (string.IsNullOrEmpty(_statusLine))
            {
                return;
            }
            GUILayout.Label(_statusLine, _statusIsError ? TowerSkin.StatusError : TowerSkin.Status);
        }

        private void SetStatus(string text, bool isError)
        {
            _statusLine = text ?? string.Empty;
            _statusIsError = isError;
        }
    }
}
