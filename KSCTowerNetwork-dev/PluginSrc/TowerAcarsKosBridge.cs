using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// File-based bridge between the Tower ACARS HTTP API and the kOS Archive volume so a
    /// KerboScript program can read/send ACARS text from any kOS terminal — including the
    /// in-game terminal popup that floats over IVA, or a RasterPropMonitor cockpit page
    /// when <c>kOSPropMonitor</c> is installed.
    /// </summary>
    /// <remarks>
    /// kOS scripts cannot make raw HTTP calls (the language is sandboxed), so the bridge
    /// uses the kOS Archive (defaults to <c>Ships/Script/</c>) as a mailbox:
    /// <list type="bullet">
    ///   <item><description><c>acars.txt</c> — bridge writes a human-readable snapshot of
    ///     the last N messages every poll tick (atomic replace).</description></item>
    ///   <item><description><c>acars-out.txt</c> — KerboScript appends lines to send;
    ///     bridge tails the file and POSTs each new non-comment line as one ACARS message.
    ///     Lines starting with <c>#</c> or blank are skipped.</description></item>
    ///   <item><description><c>acars.ks</c> — the script itself, auto-deployed from
    ///     <c>GameData/KSCTowerNetwork/Scripts/acars.ks</c> on first run when
    ///     <see cref="TowerModSettings.KosBridgeAutoInstallScript"/> is true.</description></item>
    /// </list>
    /// The bridge no-ops cleanly when kOS is not installed (Archive folder missing) and
    /// when the player is logged out.
    /// </remarks>
    [KSPAddon(KSPAddon.Startup.Instantly, true)]
    public class TowerAcarsKosBridge : MonoBehaviour
    {
        private const string SnapshotFileName = "acars.txt";
        private const string OutgoingFileName = "acars-out.txt";
        private const string ScriptFileName = "acars.ks";
        private const string LibraryFileName = "acars_lib.ks";
        private const string CursorFileName = "PluginData/acars-state.cfg";
        private const string ScriptsSubfolder = "GameData/KSCTowerNetwork/Scripts";

        private const int RequestTimeoutSeconds = 10;
        private const int MaxSnapshotMessages = 80;
        private const int MaxOutgoingLineLength = 4000;
        private const int OutgoingFileGuardBytes = 1000000;

        // Suppressed: JsonUtility populates these via reflection.
#pragma warning disable 0649
        [Serializable]
        private class AcarsMessageDto
        {
            public string id;
            public string sessionId;
            public string fromUserId;
            public string body;
            public string createdAt;
        }

        [Serializable]
        private class MessagesResponse
        {
            public bool ok;
            public AcarsMessageDto[] messages;
        }
#pragma warning restore 0649

        private static TowerAcarsKosBridge _instance;
        public static TowerAcarsKosBridge Instance { get { return _instance; } }

        private string _archiveDir;
        private string _snapshotPath;
        private string _outgoingPath;
        private string _scriptPath;
        private string _libraryPath;
        private string _cursorPath;
        private string _kspRoot;

        private string _lastSinceIso = string.Empty;
        private string _activeChannelKey = string.Empty;
        private long _outgoingCursorBytes;
        private string _lastSnapshotHash = string.Empty;
        private bool _archiveMissingLogged;
        private bool _scriptDeployed;
        private bool _started;

        private readonly LinkedList<AcarsMessageDto> _recent = new LinkedList<AcarsMessageDto>();
        private readonly HashSet<string> _knownIds = new HashSet<string>(StringComparer.Ordinal);

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
            _kspRoot = KSPUtil.ApplicationRootPath;
            _cursorPath = ResolveUnderRoot(_kspRoot, CursorFileName);
            LoadCursorState();
            StartCoroutine(BridgeLoop());
        }

        private IEnumerator BridgeLoop()
        {
            // Stagger so we don't fight telemetry/login bursts at scene boot.
            yield return new WaitForSeconds(1.5f);

            while (true)
            {
                if (!TowerModSettings.KosBridgeEnabled)
                {
                    yield return new WaitForSeconds(5f);
                    continue;
                }

                if (!ResolveArchivePaths())
                {
                    yield return new WaitForSeconds(5f);
                    continue;
                }

                MaybeDeployScript();

                string sessionId;
                if (CanTalkToBackend(out sessionId))
                {
                    if (!string.Equals(sessionId, _activeChannelKey, StringComparison.Ordinal))
                    {
                        // Channel switched — drop history, refetch from scratch so two rooms don't mix.
                        _activeChannelKey = sessionId;
                        _lastSinceIso = string.Empty;
                        _recent.Clear();
                        _knownIds.Clear();
                        _lastSnapshotHash = string.Empty;
                    }

                    yield return StartCoroutine(FetchAndSnapshot(sessionId));
                    yield return StartCoroutine(DrainOutgoing(sessionId));
                }
                else
                {
                    WriteSnapshotPlaceholder("Tower not logged in. Open the radio panel and sign in to start ACARS.");
                }

                var poll = Mathf.Clamp(TowerModSettings.KosBridgePollSeconds, 1f, 60f);
                yield return new WaitForSeconds(poll);
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

        private bool ResolveArchivePaths()
        {
            var configured = TowerModSettings.KosBridgeArchivePath;
            if (string.IsNullOrEmpty(configured))
            {
                configured = "Ships/Script";
            }

            _archiveDir = ResolveUnderRoot(_kspRoot, configured);
            if (!Directory.Exists(_archiveDir))
            {
                if (!_archiveMissingLogged)
                {
                    _archiveMissingLogged = true;
                    Debug.Log(
                        "[KSCTowerNetwork] kOS bridge: archive folder not found (" + _archiveDir +
                        "). Install kOS or set kosBridgeArchivePath to your Archive volume to use ACARS from KerboScript.");
                }

                return false;
            }

            if (_archiveMissingLogged)
            {
                _archiveMissingLogged = false;
                Debug.Log("[KSCTowerNetwork] kOS bridge: archive folder is back at " + _archiveDir + ".");
            }

            _snapshotPath = Path.Combine(_archiveDir, SnapshotFileName);
            _outgoingPath = Path.Combine(_archiveDir, OutgoingFileName);
            _scriptPath = Path.Combine(_archiveDir, ScriptFileName);
            _libraryPath = Path.Combine(_archiveDir, LibraryFileName);
            return true;
        }

        private void MaybeDeployScript()
        {
            if (!TowerModSettings.KosBridgeAutoInstallScript || _scriptDeployed)
            {
                return;
            }

            try
            {
                var sourceDir = ResolveUnderRoot(_kspRoot, ScriptsSubfolder);
                CopyScriptIfMissing(Path.Combine(sourceDir, ScriptFileName), _scriptPath);
                CopyScriptIfMissing(Path.Combine(sourceDir, LibraryFileName), _libraryPath);
                _scriptDeployed = true;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] kOS bridge: script auto-deploy failed: " + ex.Message);
                // Swallow — the bridge still works as a mailbox without the script template;
                // the user can hand-write their own KerboScript against acars.txt / acars-out.txt.
                _scriptDeployed = true;
            }
        }

        private static void CopyScriptIfMissing(string source, string dest)
        {
            if (string.IsNullOrEmpty(source) || !File.Exists(source))
            {
                return;
            }

            if (File.Exists(dest))
            {
                return;
            }

            File.Copy(source, dest, false);
            Debug.Log("[KSCTowerNetwork] kOS bridge: deployed " + Path.GetFileName(dest) + " to " + dest);
        }

        private IEnumerator FetchAndSnapshot(string sessionId)
        {
            var url = TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sessionId) + "/messages";
            if (!string.IsNullOrEmpty(_lastSinceIso))
            {
                url += "?since=" + UnityWebRequest.EscapeURL(_lastSinceIso);
            }

            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    WriteSnapshotPlaceholder(
                        "ACARS fetch failed (" + req.responseCode + "): " + (req.error ?? "?"));
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (!IngestMessages(text))
                {
                    var preview = string.IsNullOrEmpty(text)
                        ? "<empty>"
                        : (text.Length > 240 ? text.Substring(0, 240) + "…" : text);
                    Debug.LogWarning(
                        "[KSCTowerNetwork] kOS bridge: bad response shape from " + url +
                        " (status=" + req.responseCode + ", len=" + (text == null ? 0 : text.Length) +
                        "): " + preview);
                    WriteSnapshotPlaceholder("ACARS: bad response shape from backend.");
                    yield break;
                }

                WriteSnapshot(sessionId);
            }
        }

        private bool IngestMessages(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return false;
            }

            MessagesResponse parsed = null;
            try
            {
                parsed = JsonUtility.FromJson<MessagesResponse>(text);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] kOS bridge: parse failed: " + ex.Message);
                return false;
            }

            if (parsed == null)
            {
                return false;
            }

            // Empty arrays sometimes deserialize to null under Unity's JsonUtility — treat
            // that as "no new messages" rather than failing the whole tick.
            if (parsed.messages == null)
            {
                if (!parsed.ok && text.IndexOf("\"messages\"", StringComparison.Ordinal) < 0)
                {
                    return false;
                }

                return true;
            }

            for (var i = 0; i < parsed.messages.Length; i++)
            {
                var m = parsed.messages[i];
                if (m == null || string.IsNullOrEmpty(m.id))
                {
                    continue;
                }

                if (_knownIds.Add(m.id))
                {
                    _recent.AddLast(m);
                }

                if (!string.IsNullOrEmpty(m.createdAt) && string.CompareOrdinal(m.createdAt, _lastSinceIso) > 0)
                {
                    _lastSinceIso = m.createdAt;
                }
            }

            // Bound the in-memory ring so a long uptime doesn't grow unbounded.
            while (_recent.Count > MaxSnapshotMessages)
            {
                var stale = _recent.First.Value;
                _recent.RemoveFirst();
                if (stale != null && !string.IsNullOrEmpty(stale.id))
                {
                    _knownIds.Remove(stale.id);
                }
            }

            PersistCursor();
            return true;
        }

        private void WriteSnapshot(string sessionId)
        {
            var sb = new StringBuilder(2048);
            sb.Append("# ACARS  channel=").Append(sessionId)
              .Append("  refreshed=").Append(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"))
              .Append("  count=").Append(_recent.Count)
              .Append('\n');
            sb.Append("# Each message line: [HH:MM:SS] sender | body\n");
            sb.Append("# Append messages to ").Append(OutgoingFileName)
              .Append(" (one per non-comment line) to send.\n");

            foreach (var m in _recent)
            {
                sb.Append(FormatMessageLine(m)).Append('\n');
            }

            var content = sb.ToString();
            var hash = ComputeHash(content);
            if (string.Equals(hash, _lastSnapshotHash, StringComparison.Ordinal))
            {
                return;
            }

            if (TryWriteAtomic(_snapshotPath, content))
            {
                _lastSnapshotHash = hash;
            }
        }

        private void WriteSnapshotPlaceholder(string note)
        {
            if (string.IsNullOrEmpty(_snapshotPath))
            {
                return;
            }

            var sb = new StringBuilder(256);
            sb.Append("# ACARS  status=").Append(note).Append('\n');
            var content = sb.ToString();
            var hash = ComputeHash(content);
            if (string.Equals(hash, _lastSnapshotHash, StringComparison.Ordinal))
            {
                return;
            }

            if (TryWriteAtomic(_snapshotPath, content))
            {
                _lastSnapshotHash = hash;
            }
        }

        private static string FormatMessageLine(AcarsMessageDto m)
        {
            var when = string.Empty;
            DateTime parsed;
            if (!string.IsNullOrEmpty(m.createdAt) &&
                DateTime.TryParse(
                    m.createdAt,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out parsed))
            {
                when = parsed.ToLocalTime().ToString("HH:mm:ss");
            }

            var who = string.IsNullOrEmpty(m.fromUserId) ? "?" : m.fromUserId;
            // Newlines and pipes break the simple per-line snapshot format; flatten them so a
            // KerboScript reader can split on '\n' and parse with `STRING:SPLIT("|")`.
            var body = (m.body ?? string.Empty).Replace("\r", string.Empty).Replace("\n", " \\n ").Replace("|", "/");
            return "[" + when + "] " + who + " | " + body;
        }

        private IEnumerator DrainOutgoing(string sessionId)
        {
            if (!File.Exists(_outgoingPath))
            {
                _outgoingCursorBytes = 0;
                yield break;
            }

            FileInfo info;
            try
            {
                info = new FileInfo(_outgoingPath);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] kOS bridge: stat outgoing failed: " + ex.Message);
                yield break;
            }

            if (info.Length > OutgoingFileGuardBytes)
            {
                Debug.LogWarning(
                    "[KSCTowerNetwork] kOS bridge: " + OutgoingFileName + " exceeded " +
                    OutgoingFileGuardBytes + " bytes; skipping (clear or truncate it).");
                yield break;
            }

            if (info.Length < _outgoingCursorBytes)
            {
                // File was truncated or replaced; rewind so we read the new contents.
                _outgoingCursorBytes = 0;
            }

            if (info.Length == _outgoingCursorBytes)
            {
                yield break;
            }

            string newChunk;
            try
            {
                using (var fs = new FileStream(_outgoingPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    fs.Seek(_outgoingCursorBytes, SeekOrigin.Begin);
                    using (var reader = new StreamReader(fs, Encoding.UTF8))
                    {
                        newChunk = reader.ReadToEnd();
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] kOS bridge: read outgoing failed: " + ex.Message);
                yield break;
            }

            _outgoingCursorBytes = info.Length;
            PersistCursor();

            var lines = newChunk.Split('\n');
            for (var i = 0; i < lines.Length; i++)
            {
                var raw = (lines[i] ?? string.Empty).TrimEnd('\r').Trim();
                if (raw.Length == 0)
                {
                    continue;
                }

                if (raw[0] == '#')
                {
                    continue;
                }

                if (raw.Length > MaxOutgoingLineLength)
                {
                    raw = raw.Substring(0, MaxOutgoingLineLength);
                }

                yield return StartCoroutine(PostMessage(sessionId, raw));
            }
        }

        private IEnumerator PostMessage(string sessionId, string text)
        {
            var url = TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sessionId) + "/messages";
            var json = "{\"text\":\"" + JsonEscape(text) + "\"}";
            var body = Encoding.UTF8.GetBytes(json);

            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                if (req.isNetworkError || req.isHttpError)
                {
                    var respText = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                    Debug.LogWarning(
                        "[KSCTowerNetwork] kOS bridge: send failed (" + req.responseCode + "): " +
                        (req.error ?? "?") + " body=" + respText);
                }
            }
        }

        private bool TryWriteAtomic(string path, string content)
        {
            try
            {
                var tmp = path + ".tmp";
                File.WriteAllText(tmp, content, new UTF8Encoding(false));
                if (File.Exists(path))
                {
                    File.Replace(tmp, path, null);
                }
                else
                {
                    File.Move(tmp, path);
                }

                return true;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] kOS bridge: write " + path + " failed: " + ex.Message);
                return false;
            }
        }

        private void LoadCursorState()
        {
            try
            {
                if (string.IsNullOrEmpty(_cursorPath) || !File.Exists(_cursorPath))
                {
                    return;
                }

                var node = ConfigNode.Load(_cursorPath);
                if (node == null)
                {
                    return;
                }

                var inner = node.GetNode("KSCTOWERNETWORK_ACARS_KOS") ?? node;
                long bytes;
                if (long.TryParse(inner.GetValue("outgoingCursorBytes"), out bytes) && bytes >= 0)
                {
                    _outgoingCursorBytes = bytes;
                }

                var since = inner.GetValue("lastSinceIso");
                if (!string.IsNullOrEmpty(since))
                {
                    _lastSinceIso = since.Trim();
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] kOS bridge: cursor load failed: " + ex.Message);
            }
        }

        private void PersistCursor()
        {
            try
            {
                if (string.IsNullOrEmpty(_cursorPath))
                {
                    return;
                }

                var dir = Path.GetDirectoryName(_cursorPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                var file = new ConfigNode();
                var inner = file.AddNode("KSCTOWERNETWORK_ACARS_KOS");
                inner.AddValue("outgoingCursorBytes", _outgoingCursorBytes.ToString(CultureInfo.InvariantCulture));
                inner.AddValue("lastSinceIso", _lastSinceIso ?? string.Empty);
                file.Save(_cursorPath);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] kOS bridge: cursor save failed: " + ex.Message);
            }
        }

        private static string ResolveUnderRoot(string root, string pathOrRelative)
        {
            if (string.IsNullOrEmpty(pathOrRelative))
            {
                return root;
            }

            if (Path.IsPathRooted(pathOrRelative))
            {
                return pathOrRelative;
            }

            return Path.GetFullPath(Path.Combine(root, pathOrRelative.Replace('/', Path.DirectorySeparatorChar)));
        }

        private static string ComputeHash(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }

            // Cheap non-cryptographic FNV-1a so we only rewrite the snapshot when it actually changed.
            unchecked
            {
                const uint offset = 2166136261;
                const uint prime = 16777619;
                uint h = offset;
                for (var i = 0; i < s.Length; i++)
                {
                    h ^= s[i];
                    h *= prime;
                }

                return h.ToString("x8", CultureInfo.InvariantCulture);
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
