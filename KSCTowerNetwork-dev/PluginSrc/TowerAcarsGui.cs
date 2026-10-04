using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Networking;

namespace KSCTowerNetwork
{
    /// <summary>
    /// In-game ACARS panel. Channels: Room — per-room ops chat
    /// <c>GET/POST /v1/session/{sessionId}/messages</c> (web ChatDesk); Lobby — general text
    /// <c>/v1/lobby/messages</c> (web LobbyPage); DMs; Radar hail — <c>POST …/dragon-radar/hail</c>
    /// (no message poll on this tab). Polls use full snapshots (no <c>?since=</c>), matching the web clients.
    /// </summary>
    /// <remarks>
    /// Created on demand by <see cref="TowerAcarsToolbar"/> (no <c>[KSPAddon]</c> so the
    /// component lives across scene loads via <c>DontDestroyOnLoad</c>; per-scene addon
    /// instances would never register with <see cref="_instance"/> and produce duplicates).
    /// </remarks>
    public class TowerAcarsGui : MonoBehaviour
    {
        private const float PanelWidth = 460f;
        private const float PanelHeight = 540f;
        private const int MaxKeptMessages = 400;
        private const float PollIntervalSecondsVisible = 2.5f;
        private const float PollIntervalSecondsHidden = 8f;
        private const float PeerRefreshSecondsVisible = 30f;
        private const int RequestTimeoutSeconds = 10;

        /// <summary>
        /// Which conversation the panel is currently showing.
        /// <list type="bullet">
        /// <item><c>SessionChat</c> → <c>/v1/session/{id}/messages</c> (per-room ops chat).</item>
        /// <item><c>DirectMessage</c> → <c>/v1/dm/{peerUserId}/messages</c> (1:1 ACARS).</item>
        /// <item><c>Lobby</c> → <c>/v1/lobby/messages</c> (global lobby text chat — same
        /// channel the web portal's <c>LobbyPage</c> renders. No session id required;
        /// available even before the player joins a tower room and to guests.)</item>
        /// <item><c>RadarHail</c> → posts radar meet-on-frequency to another room (same contract as
        /// the Dragon Radar hail API). Not a text channel — no <c>/messages</c> poll.</item>
        /// </list>
        /// Switching modes resets the in-memory log so two channels never bleed into each other.
        /// </summary>
        public enum ChannelMode
        {
            SessionChat,
            DirectMessage,
            Lobby,
            RadarHail
        }

        private static TowerAcarsGui _instance;

        public static TowerAcarsGui Instance
        {
            get { return _instance; }
        }

        public Action OnRequestMinimize;

        // JsonUtility DTOs for messages live in TowerAcarsContracts.cs (namespace scope) so
        // Unity can deserialize backend JSON reliably; nested private types are brittle.

        private bool _visible;
        private bool _started;
        private string _draft = string.Empty;
        private string _statusLine = "Standby.";
        private bool _statusIsError;
        private bool _sendBusy;
        private bool _fetchBusy;
        private string _lastSinceIso = string.Empty;
        private string _activeChannelKey = string.Empty;
        private string _lastFetchTime = string.Empty;
        private readonly List<AcarsMessage> _messages = new List<AcarsMessage>(64);
        private readonly HashSet<string> _knownIds = new HashSet<string>(StringComparer.Ordinal);

        // Captured from the first successful POST response we make so we can suppress the
        // ACR red/beep alert for our own outbound messages (which round-trip back through the
        // same /messages poll). Stays empty until the player sends at least one message —
        // until then we have no way to tell self from peer, so we conservatively alert on
        // everything in the *incremental* fetch (initial seed never alerts, see _seededOnce).
        private string _selfUserId = string.Empty;
        private bool _seededOnce;
        private Vector2 _logScroll = Vector2.zero;
        private bool _autoScroll = true;

        private ChannelMode _mode = ChannelMode.SessionChat;
        private string _selectedPeerUserId = string.Empty;
        private readonly List<AcarsDmPeer> _peers = new List<AcarsDmPeer>(8);
        private bool _peerFetchBusy;
        private float _peerLastFetchAt = -999f;
        private bool _peerPickerOpen;
        private Vector2 _peerScroll = Vector2.zero;

        private readonly List<AcarsHailActiveAircraftRow> _hailAircraft = new List<AcarsHailActiveAircraftRow>(32);
        private bool _hailFetchBusy;
        private float _hailLastFetchAt = -9999f;
        private string _hailTargetSid = string.Empty;
        private string _hailFreqText = "122.000";
        private string _hailNote = string.Empty;
        private bool _hailSendBusy;
        private Vector2 _hailTargetScroll = Vector2.zero;

        private Rect _windowRect = new Rect(120f, 120f, PanelWidth, PanelHeight);
        private int _windowId;

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
                if (_visible)
                {
                    // Snap scroll to the bottom when the panel reopens so the player sees the latest traffic.
                    _autoScroll = true;
                    // Player has eyes on chat now → clear the radio's ACR-unread annunciator.
                    TowerRadioGui.NotifyAcarsRead();
                }
            }
        }

        public static void EnsureExists()
        {
            if (_instance != null)
            {
                return;
            }

            var go = new GameObject("KSCTowerAcarsGui");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerAcarsGui>();
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            _windowId = GetInstanceID() ^ 0x41434152;
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
            StartCoroutine(PollLoop());
        }

        private IEnumerator PollLoop()
        {
            // Stagger the first fetch so telemetry/login bursts settle, and so
            // TowerAcarsActiveRoomSync (session id from active-room) can run before we
            // bind a channel key — otherwise the first poll uses a stale SessionId and
            // the next sync clears the log right after the player sends.
            yield return new WaitForSeconds(1.5f);

            while (true)
            {
                var wait = _visible ? PollIntervalSecondsVisible : PollIntervalSecondsHidden;

                if (CanReachApi())
                {
                    // Refresh the DM peer list lazily — it's small (configured users + your
                    // existing threads) but we don't want to hammer it every 2.5s alongside the
                    // message poll. The picker also calls this on demand.
                    if (_visible
                        && !_peerFetchBusy
                        && (Time.unscaledTime - _peerLastFetchAt) > PeerRefreshSecondsVisible)
                    {
                        StartCoroutine(FetchPeers());
                    }

                    string channelKey;
                    string url;
                    if (TryBuildPollUrl(out channelKey, out url))
                    {
                        if (!string.Equals(channelKey, _activeChannelKey, StringComparison.Ordinal))
                        {
                            // Channel/mode switched (radio dial / login / DM peer change). Drop the
                            // message log so we don't mix two threads' traffic, and refetch from scratch.
                            _activeChannelKey = channelKey;
                            _lastSinceIso = string.Empty;
                            _messages.Clear();
                            _knownIds.Clear();
                            _autoScroll = true;
                            // The new channel's first fetch is "history seed" — a 30-message
                            // backlog should NOT trigger 30 ACR beeps. Re-arm the seed flag so
                            // we only start alerting from the next incremental fetch onward.
                            _seededOnce = false;
                        }

                        if (!_fetchBusy)
                        {
                            yield return StartCoroutine(FetchMessages(url, channelKey));
                        }
                    }

                    if (_visible
                        && _mode == ChannelMode.RadarHail
                        && !_hailFetchBusy
                        && (Time.unscaledTime - _hailLastFetchAt) > 2.5f)
                    {
                        _hailLastFetchAt = Time.unscaledTime;
                        StartCoroutine(FetchHailAircraft());
                    }
                }

                yield return new WaitForSeconds(wait);
            }
        }

        /// <summary>True when we have an auth token (or skipTowerLogin is set) — a prerequisite for any backend call.</summary>
        private static bool CanReachApi()
        {
            TowerModSettings.EnsureLoaded();
            if (TowerModSettings.SkipTowerLogin)
            {
                return true;
            }

            return !string.IsNullOrEmpty(TowerModSettings.TowerAuthToken);
        }

        /// <summary>
        /// Legacy helper for the session/lobby path: returns true only when the player is
        /// logged in (or skipTowerLogin) AND a session id is configured. Kept for the
        /// composer/draft enable check; the new poll loop uses <see cref="TryBuildPollUrl"/>.
        /// </summary>
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
        /// Build the URL we should poll right now based on <see cref="_mode"/>.
        /// channelKey is a stable identifier that changes whenever the conversation
        /// changes (used by the poll loop to detect a switch and clear the log).
        /// </summary>
        private bool TryBuildPollUrl(out string channelKey, out string url)
        {
            channelKey = string.Empty;
            url = string.Empty;

            if (_mode == ChannelMode.RadarHail)
            {
                return false;
            }

            if (_mode == ChannelMode.DirectMessage)
            {
                var peer = _selectedPeerUserId ?? string.Empty;
                if (string.IsNullOrEmpty(peer))
                {
                    return false;
                }

                channelKey = "dm:" + peer;
                // Full snapshot only — matches DmDesk.tsx (web never sends ?since=).
                url = TowerModSettings.ApiBaseUrl + "/dm/" + UnityWebRequest.EscapeURL(peer) + "/messages";
                return true;
            }

            if (_mode == ChannelMode.Lobby)
            {
                // Lobby chat doesn't require a session id — it's the global text
                // channel shared with the web portal's LobbyPage. Auth alone is
                // enough (CanReachApi already gated us above).
                //
                // Always request the full snapshot (no ?since=), matching LobbyPage.tsx.
                // Incremental ?since= was causing "everyone sees lobby chat except KSP" when
                // the cursor advanced past new rows (encoding / clock / DB compare edge cases)
                // while the web client never sends since and kept working.
                channelKey = "lobby";
                url = TowerModSettings.ApiBaseUrl + "/lobby/messages";
                return true;
            }

            string sessionId;
            if (!CanTalkToBackend(out sessionId))
            {
                return false;
            }

            channelKey = "session:" + sessionId;
            // Per-room ops chat — same thread as web ChatDesk. Full snapshot only; web never
            // sends ?since= on this route either. Incremental poll was a second source of
            // "one-way" or empty logs beside general lobby.
            url = TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sessionId) + "/messages";
            return true;
        }

        /// <summary>Build the POST URL for the current channel; null when we can't send (no peer / no session).</summary>
        private string TryBuildSendUrl()
        {
            if (_mode == ChannelMode.RadarHail)
            {
                return null;
            }

            if (_mode == ChannelMode.DirectMessage)
            {
                var peer = _selectedPeerUserId ?? string.Empty;
                if (string.IsNullOrEmpty(peer))
                {
                    return null;
                }
                return TowerModSettings.ApiBaseUrl + "/dm/" + UnityWebRequest.EscapeURL(peer) + "/messages";
            }

            if (_mode == ChannelMode.Lobby)
            {
                return TowerModSettings.ApiBaseUrl + "/lobby/messages";
            }

            string sessionId;
            if (!CanTalkToBackend(out sessionId))
            {
                return null;
            }
            return TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sessionId) + "/messages";
        }

        /// <summary>True when the composer should be enabled for the current mode/auth state.</summary>
        private bool CanComposeNow()
        {
            if (!CanReachApi())
            {
                return false;
            }
            if (_mode == ChannelMode.RadarHail)
            {
                return false;
            }
            if (_mode == ChannelMode.DirectMessage)
            {
                return !string.IsNullOrEmpty(_selectedPeerUserId);
            }
            if (_mode == ChannelMode.Lobby)
            {
                // Lobby only needs auth (chat:lobby is granted to every role,
                // including guest). No session id required.
                return true;
            }
            string ignored;
            return CanTalkToBackend(out ignored);
        }

        private IEnumerator FetchMessages(string url, string channelKey)
        {
            _fetchBusy = true;
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                _fetchBusy = false;

                // Drop late responses for a channel we already left (user switched DM peer
                // or session id mid-flight). Otherwise the new conversation gets seeded
                // with stale messages from the prior thread before the next poll catches up.
                if (!string.Equals(channelKey, _activeChannelKey, StringComparison.Ordinal))
                {
                    yield break;
                }

                if (req.isNetworkError || req.isHttpError)
                {
                    var detail = req.error ?? "?";
                    if (req.responseCode == 403)
                    {
                        var body = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                        var serverMsg = ExtractError(body);
                        if (!string.IsNullOrEmpty(serverMsg))
                        {
                            detail = serverMsg;
                        }

                        if (channelKey.StartsWith("session:", StringComparison.Ordinal))
                        {
                            detail += " — room chat needs you to be pilot/tower/spectator of this SessionId "
                                + "(dev-shared often mismatches your login).";
                        }
                    }

                    SetStatus("ACARS fetch failed (" + req.responseCode + "): " + detail, true);
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (!ApplyMessagesJson(text))
                {
                    // Truncate so a giant body never floods Player.log.
                    var preview = string.IsNullOrEmpty(text)
                        ? "<empty>"
                        : (text.Length > 240 ? text.Substring(0, 240) + "…" : text);
                    Debug.LogWarning(
                        "[KSCTowerNetwork] ACARS: bad response shape from " + url +
                        " (status=" + req.responseCode + ", len=" + (text == null ? 0 : text.Length) +
                        "): " + preview);
                    SetStatus("ACARS: bad response shape (status " + req.responseCode + ").", true);
                    yield break;
                }

                _lastFetchTime = DateTime.Now.ToString("HH:mm:ss");
                if (_statusIsError)
                {
                    SetStatus("Live · last sync " + _lastFetchTime, false);
                }
            }
        }

        private IEnumerator FetchPeers()
        {
            _peerFetchBusy = true;
            _peerLastFetchAt = Time.unscaledTime;

            var url = TowerModSettings.ApiBaseUrl + "/dm/peers";
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                _peerFetchBusy = false;

                if (req.isNetworkError || req.isHttpError)
                {
                    // 403 just means the account doesn't have chat:dm yet (e.g. guest). Don't
                    // drop the existing peer list on a transient blip either.
                    if (req.responseCode != 403)
                    {
                        Debug.LogWarning(
                            "[KSCTowerNetwork] ACARS: /dm/peers fetch failed (" +
                            req.responseCode + "): " + (req.error ?? "?"));
                    }
                    yield break;
                }

                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(text))
                {
                    yield break;
                }

                AcarsPeersEnvelope parsed = null;
                try
                {
                    parsed = JsonUtility.FromJson<AcarsPeersEnvelope>(text);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[KSCTowerNetwork] ACARS peer list parse failed: " + ex.Message);
                    yield break;
                }

                if (parsed == null)
                {
                    yield break;
                }

                AcarsDmPeer[] rows = parsed.peers;
                if (rows == null || PeersLookUnparsed(rows))
                {
                    var fb = AcarsJsonFallback.ParsePeersArrayObjects(text);
                    if (fb.Count > 0)
                    {
                        rows = fb.ToArray();
                    }
                }

                if (rows == null)
                {
                    if (text.IndexOf("\"peers\"", StringComparison.Ordinal) >= 0)
                    {
                        rows = new AcarsDmPeer[0];
                    }
                    else
                    {
                        yield break;
                    }
                }

                _peers.Clear();
                for (var i = 0; i < rows.Length; i++)
                {
                    var p = rows[i];
                    if (p == null || string.IsNullOrEmpty(p.userId))
                    {
                        continue;
                    }

                    _peers.Add(p);
                }

                // If the picker had a peer selected that's no longer in the list (operator
                // removed them from the user config), keep the selection so the player can
                // still read history — they just can't send a new DM until reconfig.
            }
        }

        /// <summary>
        /// Parse the messages list from a backend response and merge into <see cref="_messages"/>.
        /// Returns false when the JSON is unparseable; true when parsed (including an empty list).
        /// </summary>
        private bool ApplyMessagesJson(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return false;
            }

            AcarsMessagesEnvelope parsed = null;
            try
            {
                parsed = JsonUtility.FromJson<AcarsMessagesEnvelope>(text);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] ACARS parse failed: " + ex.Message);
                return false;
            }

            if (parsed == null)
            {
                return false;
            }

            AcarsMessage[] rows = parsed.messages;
            if (rows == null || RowsLookUnparsed(rows))
            {
                var fb = AcarsJsonFallback.ParseMessagesArrayObjects(text);
                if (fb.Count > 0)
                {
                    rows = fb.ToArray();
                }
            }

            // Unity's JsonUtility can leave an empty JSON array as null instead of T[0]; treat
            // that as "no new messages" rather than failing the whole fetch. Only refuse if the
            // response really looks wrong (no `messages` key at all AND `ok` was not set true).
            if (rows == null)
            {
                if (!parsed.ok && text.IndexOf("\"messages\"", StringComparison.Ordinal) < 0)
                {
                    return false;
                }

                // Empty seed for a fresh channel still counts as "we've now got the baseline" —
                // otherwise the next burst of messages on this channel would be treated as
                // more seed and never beep. Setting the flag here makes the first real
                // message on a previously-empty channel ring the ACR annunciator like it
                // should.
                _seededOnce = true;
                return true;
            }

            var added = 0;
            var fromPeer = 0;
            for (var i = 0; i < rows.Length; i++)
            {
                var m = rows[i];
                if (m == null || string.IsNullOrEmpty(m.id))
                {
                    continue;
                }

                if (_knownIds.Add(m.id))
                {
                    _messages.Add(m);
                    added++;
                    // Count anything that isn't from us as a peer message — drives the ACR
                    // annunciator/beep below. Skip the count entirely on the very first fetch
                    // for this channel (the "seed" pass) so opening the panel doesn't beep
                    // for every message in the historical backlog.
                    if (_seededOnce
                        && !string.IsNullOrEmpty(m.fromUserId)
                        && !string.Equals(m.fromUserId, _selfUserId, StringComparison.Ordinal))
                    {
                        fromPeer++;
                    }
                }

                if (!string.IsNullOrEmpty(m.createdAt) &&
                    StringCompareIso(m.createdAt, _lastSinceIso) > 0)
                {
                    _lastSinceIso = m.createdAt;
                }
            }

            // Only alert when the player isn't already looking at the panel — open ACARS UI
            // already shows the message, an annunciator on top would be noise.
            if (fromPeer > 0 && !_visible)
            {
                TowerRadioGui.NotifyAcarsUnread(fromPeer);
            }

            // After the first parsed batch (history seed) future fetches are deltas — beep on those.
            if (!_seededOnce)
            {
                _seededOnce = true;
            }

            // Keep the list bounded so a long session doesn't eat memory or grind the IMGUI scroll view.
            if (_messages.Count > MaxKeptMessages)
            {
                var drop = _messages.Count - MaxKeptMessages;
                for (var i = 0; i < drop; i++)
                {
                    var stale = _messages[i];
                    if (stale != null && !string.IsNullOrEmpty(stale.id))
                    {
                        _knownIds.Remove(stale.id);
                    }
                }

                _messages.RemoveRange(0, drop);
            }

            if (added > 0)
            {
                _autoScroll = true;
            }

            return true;
        }

        /// <summary>
        /// True when JsonUtility deserialized the messages array but left every row empty
        /// (common when envelope types were nested private classes).
        /// </summary>
        private static bool RowsLookUnparsed(AcarsMessage[] rows)
        {
            if (rows == null || rows.Length == 0)
            {
                return false;
            }

            for (var i = 0; i < rows.Length; i++)
            {
                var m = rows[i];
                if (m != null && !string.IsNullOrEmpty(m.id))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>
        /// ISO-8601 timestamps from the backend are already lexicographically comparable
        /// (UTC, fixed-width) so a plain ordinal string compare gives correct ordering
        /// without going through DateTime parsing for every message on every tick.
        /// </summary>
        private static int StringCompareIso(string a, string b)
        {
            if (string.IsNullOrEmpty(b))
            {
                return 1;
            }

            return string.CompareOrdinal(a, b);
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

            if (TowerSkin.DrawTitleBar("ACARS  \u00B7  TOWER TEXT", true))
            {
                Visible = false;
                if (OnRequestMinimize != null)
                {
                    OnRequestMinimize();
                }
            }

            DrawHeader();
            DrawChannelPicker();
            if (_mode == ChannelMode.RadarHail)
            {
                DrawRadarHailTab();
            }
            else
            {
                DrawLog();
                DrawComposer();
            }
            DrawStatus();

            GUILayout.EndVertical();

            GUI.DragWindow(new Rect(0f, 0f, PanelWidth - 32f, 28f));
            TowerImguiClickSink.UseUnhandledMouseInLocalWindow(new Rect(0f, 0f, PanelWidth, PanelHeight));
        }

        private void DrawHeader()
        {
            GUILayout.BeginHorizontal();

            string label;
            if (_mode == ChannelMode.RadarHail)
            {
                label = "Radar hail · meet on MHz";
            }
            else if (_mode == ChannelMode.DirectMessage)
            {
                var peer = _selectedPeerUserId ?? string.Empty;
                label = "DM: " + (peer.Length == 0 ? "(no peer)" : DescribePeerById(peer));
            }
            else if (_mode == ChannelMode.Lobby)
            {
                // Mirrors the web portal's "Lobby text chat" panel — no session id
                // qualifier because lobby is global.
                label = "Lobby (general)";
            }
            else
            {
                // "Session" mode = tower room ops chat (/v1/session/{id}/messages), not general lobby.
                var channel = TowerModSettings.SessionId ?? string.Empty;
                label = "Room chat · " + (channel.Length == 0 ? "—" : channel);
            }

            GUILayout.Label(label, TowerSkin.Subtitle);
            GUILayout.FlexibleSpace();

            var headerFetchBusy = _mode == ChannelMode.RadarHail ? _hailFetchBusy : _fetchBusy;
            GUI.enabled = !headerFetchBusy;
            if (GUILayout.Button("Refresh", TowerSkin.Button, GUILayout.Width(80f), GUILayout.Height(22f)))
            {
                if (_mode == ChannelMode.RadarHail)
                {
                    if (!CanReachApi())
                    {
                        SetStatus("Log in (radio) before refreshing traffic picks.", true);
                    }
                    else if (!_hailFetchBusy)
                    {
                        StartCoroutine(FetchHailAircraft());
                    }
                }
                else
                {
                    string channelKey;
                    string url;
                    if (TryBuildPollUrl(out channelKey, out url))
                    {
                        StartCoroutine(FetchMessages(url, channelKey));
                    }
                    else
                    {
                        string fetchHint;
                        if (_mode == ChannelMode.DirectMessage)
                        {
                            fetchHint = "Pick a DM peer to fetch.";
                        }
                        else if (_mode == ChannelMode.Lobby)
                        {
                            fetchHint = "Log in to fetch lobby chat.";
                        }
                        else
                        {
                            fetchHint = "Log in to fetch ACARS.";
                        }
                        SetStatus(fetchHint, true);
                    }
                }
            }

            GUI.enabled = true;

            GUILayout.EndHorizontal();
        }

        private void DrawChannelPicker()
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label("MODE", TowerSkin.Subtitle, GUILayout.Width(50f));

            var sessionActive = _mode == ChannelMode.SessionChat;
            if (GUILayout.Button("Room", sessionActive ? TowerSkin.ButtonActive : TowerSkin.Button, GUILayout.Width(80f), GUILayout.Height(22f)))
            {
                SwitchMode(ChannelMode.SessionChat, _selectedPeerUserId);
            }

            // General lobby only — /v1/lobby/messages (web LobbyPage "Lobby text chat").
            // Not the per-room thread; that is "Room" + current SessionId above.
            var lobbyActive = _mode == ChannelMode.Lobby;
            if (GUILayout.Button("Lobby", lobbyActive ? TowerSkin.ButtonActive : TowerSkin.Button, GUILayout.Width(70f), GUILayout.Height(22f)))
            {
                SwitchMode(ChannelMode.Lobby, _selectedPeerUserId);
            }

            var dmActive = _mode == ChannelMode.DirectMessage;
            if (GUILayout.Button("DM", dmActive ? TowerSkin.ButtonActive : TowerSkin.Button, GUILayout.Width(60f), GUILayout.Height(22f)))
            {
                SwitchMode(ChannelMode.DirectMessage, _selectedPeerUserId);
            }

            var hailActive = _mode == ChannelMode.RadarHail;
            if (GUILayout.Button("Hail", hailActive ? TowerSkin.ButtonActive : TowerSkin.Button, GUILayout.Width(50f), GUILayout.Height(22f)))
            {
                SwitchMode(ChannelMode.RadarHail, _selectedPeerUserId);
            }

            GUILayout.FlexibleSpace();

            if (_mode == ChannelMode.DirectMessage)
            {
                if (GUILayout.Button(_peerPickerOpen ? "Close peers" : "Choose peer", TowerSkin.Button, GUILayout.Width(110f), GUILayout.Height(22f)))
                {
                    _peerPickerOpen = !_peerPickerOpen;
                    if (_peerPickerOpen && !_peerFetchBusy)
                    {
                        StartCoroutine(FetchPeers());
                    }
                }
            }

            GUILayout.EndHorizontal();

            if (_mode == ChannelMode.DirectMessage && _peerPickerOpen)
            {
                GUILayout.BeginVertical(TowerSkin.Inset);
                _peerScroll = GUILayout.BeginScrollView(_peerScroll, GUILayout.Height(110f));
                if (_peers.Count == 0)
                {
                    GUILayout.Label(_peerFetchBusy
                        ? "Loading peers…"
                        : "No one available to message.",
                        TowerSkin.BodyMuted);
                }
                else
                {
                    for (var i = 0; i < _peers.Count; i++)
                    {
                        var p = _peers[i];
                        if (p == null || string.IsNullOrEmpty(p.userId))
                        {
                            continue;
                        }

                        var isSelected = string.Equals(p.userId, _selectedPeerUserId, StringComparison.Ordinal);
                        var label2 = (isSelected ? "● " : "○ ") + DescribePeer(p);
                        if (GUILayout.Button(label2, isSelected ? TowerSkin.ButtonActive : TowerSkin.Button, GUILayout.ExpandWidth(true)))
                        {
                            SwitchMode(ChannelMode.DirectMessage, p.userId);
                            _peerPickerOpen = false;
                        }
                    }
                }
                GUILayout.EndScrollView();
                GUILayout.EndVertical();
            }
        }

        private void SwitchMode(ChannelMode mode, string peerUserId)
        {
            var changed = mode != _mode
                          || !string.Equals(peerUserId ?? string.Empty, _selectedPeerUserId ?? string.Empty, StringComparison.Ordinal);
            _mode = mode;
            _selectedPeerUserId = peerUserId ?? string.Empty;

            if (changed)
            {
                // Force the poll loop to recompute and clear the log on next tick by
                // invalidating the cached channel key.
                _activeChannelKey = string.Empty;
                _lastSinceIso = string.Empty;
                _messages.Clear();
                _knownIds.Clear();
                _autoScroll = true;
            }

            if (changed && mode == ChannelMode.RadarHail)
            {
                _peerPickerOpen = false;
                string sidSession;
                if (CanTalkToBackend(out sidSession) && !string.IsNullOrEmpty(sidSession))
                {
                    _hailTargetSid = sidSession;
                }
                else
                {
                    _hailTargetSid = string.Empty;
                }
                _hailLastFetchAt = -9999f;
            }
        }

        private static bool PeersLookUnparsed(AcarsDmPeer[] rows)
        {
            if (rows == null || rows.Length == 0)
            {
                return false;
            }

            for (var i = 0; i < rows.Length; i++)
            {
                var p = rows[i];
                if (p != null && !string.IsNullOrEmpty(p.userId))
                {
                    return false;
                }
            }

            return true;
        }

        private string DescribePeer(AcarsDmPeer p)
        {
            if (p == null)
            {
                return "?";
            }

            var name = !string.IsNullOrEmpty(p.displayName) ? p.displayName : (p.userId ?? "?");
            var roleSuffix = string.IsNullOrEmpty(p.role) ? string.Empty : " [" + p.role + "]";
            return name + roleSuffix;
        }

        private string DescribePeerById(string peerUserId)
        {
            if (string.IsNullOrEmpty(peerUserId))
            {
                return "?";
            }
            for (var i = 0; i < _peers.Count; i++)
            {
                var p = _peers[i];
                if (p != null && string.Equals(p.userId, peerUserId, StringComparison.Ordinal))
                {
                    return DescribePeer(p);
                }
            }
            return peerUserId;
        }

        private void DrawLog()
        {
            GUILayout.BeginVertical(TowerSkin.Inset);
            // Detect a manual scroll so we stop auto-following the bottom while the user is reading old messages.
            var prevScroll = _logScroll;
            _logScroll = GUILayout.BeginScrollView(_logScroll, GUILayout.Height(PanelHeight - 240f));

            if (_messages.Count == 0)
            {
                string emptyText;
                if (_fetchBusy)
                {
                    emptyText = "Fetching ACARS…";
                }
                else if (!CanReachApi())
                {
                    emptyText = "Log in (radio button) to use ACARS.";
                }
                else if (_mode == ChannelMode.DirectMessage && string.IsNullOrEmpty(_selectedPeerUserId))
                {
                    emptyText = "Pick a DM peer to start a conversation.";
                }
                else if (_mode == ChannelMode.Lobby)
                {
                    emptyText = "No lobby messages yet.";
                }
                else
                {
                    string ignoredSessionId;
                    if (_mode == ChannelMode.SessionChat && !CanTalkToBackend(out ignoredSessionId))
                    {
                        emptyText = "No session id set — open the radio settings.";
                    }
                    else
                    {
                        emptyText = "No messages yet.";
                    }
                }
                GUILayout.Label(emptyText, TowerSkin.BodyMuted);
            }
            else
            {
                for (var i = 0; i < _messages.Count; i++)
                {
                    var m = _messages[i];
                    if (m == null)
                    {
                        continue;
                    }

                    GUILayout.Label(FormatMessageHeader(m), TowerSkin.Subtitle);
                    GUILayout.Label(m.body ?? string.Empty, TowerSkin.Body);
                    GUILayout.Space(4f);
                }
            }

            // GUILayout.EndScrollView mutates the scroll position to the layout-clamped value;
            // do auto-follow on the previous (user-driven) value so we only stick when the
            // user is already at the bottom.
            if (Event.current.type == EventType.Repaint)
            {
                if (Mathf.Abs(prevScroll.y - _logScroll.y) > 0.5f)
                {
                    _autoScroll = false;
                }
            }

            GUILayout.EndScrollView();
            GUILayout.EndVertical();

            if (_autoScroll)
            {
                // Force scroll to the bottom on the next paint pass.
                _logScroll = new Vector2(0f, float.MaxValue);
            }
        }

        private static string FormatMessageHeader(AcarsMessage m)
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

            var fromBody = TryExtractAnnounceSender(m.body);
            var who = !string.IsNullOrEmpty(fromBody)
                ? fromBody
                : (string.IsNullOrEmpty(m.fromUserId) ? "?" : m.fromUserId);
            return when + "  —  " + who;
        }

        /// <summary>
        /// Session lines like <c>[REQUEST] callsign ready for countdown</c> used to use
        /// <c>fromUserId=system</c>, so the ACARS header read as &quot;system&quot; even though the
        /// name was in the body. Lift the human label for the header when the template matches.
        /// </summary>
        private static string TryExtractAnnounceSender(string body)
        {
            if (string.IsNullOrEmpty(body))
            {
                return null;
            }

            var b = body.Trim();
            const string req = "[REQUEST] ";
            const string reqTail = " ready for countdown";
            if (b.StartsWith(req, StringComparison.Ordinal) && b.EndsWith(reqTail, StringComparison.Ordinal))
            {
                var mid = b.Substring(req.Length, b.Length - req.Length - reqTail.Length).Trim();
                return mid.Length > 0 ? mid : null;
            }

            const string al = "[ALERT] ";
            const string alTail = " requests takeoff clearance";
            if (b.StartsWith(al, StringComparison.Ordinal) && b.EndsWith(alTail, StringComparison.Ordinal))
            {
                var mid = b.Substring(al.Length, b.Length - al.Length - alTail.Length).Trim();
                return mid.Length > 0 ? mid : null;
            }

            const string abort = "[COUNTDOWN] POST-LIFTOFF ABORT (";
            if (b.StartsWith(abort, StringComparison.Ordinal) && b.EndsWith(")", StringComparison.Ordinal))
            {
                var mid = b.Substring(abort.Length, b.Length - abort.Length - 1).Trim();
                return mid.Length > 0 ? mid : null;
            }

            return null;
        }

        private void DrawComposer()
        {
            GUILayout.Space(4f);
            string composerLabel;
            if (_mode == ChannelMode.DirectMessage)
            {
                composerLabel = string.IsNullOrEmpty(_selectedPeerUserId)
                    ? "Send DM (pick a peer above) — Ctrl+Enter to send"
                    : "Send DM to " + DescribePeerById(_selectedPeerUserId) + " (Ctrl+Enter, max 4000 chars)";
            }
            else if (_mode == ChannelMode.Lobby)
            {
                composerLabel = "Send to lobby — visible to everyone (Ctrl+Enter, max 4000 chars)";
            }
            else
            {
                composerLabel = "Send ACARS (Ctrl+Enter to send, max 4000 chars)";
            }
            GUILayout.Label(composerLabel, TowerSkin.Subtitle);
            _draft = GUILayout.TextArea(_draft ?? string.Empty, 4000, TowerSkin.TextArea, GUILayout.MinHeight(48f), GUILayout.MaxHeight(80f));

            // Ctrl+Enter as a keyboard send shortcut. We swallow the event so the newline doesn't land in the textarea.
            var e = Event.current;
            if (e != null
                && e.type == EventType.KeyDown
                && (e.keyCode == KeyCode.Return || e.keyCode == KeyCode.KeypadEnter)
                && (e.control || e.command))
            {
                e.Use();
                TrySend();
            }

            GUILayout.BeginHorizontal();
            GUI.enabled = !_sendBusy && !string.IsNullOrEmpty((_draft ?? string.Empty).Trim()) && CanComposeNow();
            if (GUILayout.Button(_sendBusy ? "Sending…" : "Send", TowerSkin.Button, GUILayout.Height(28f)))
            {
                TrySend();
            }

            // Copy / Paste / Clear share a row with Send so the player has a one-click path
            // between ACARS, Notes, and external apps without leaving the composer. COPY
            // prefers the draft (most useful while typing); when the draft is empty it falls
            // back to copying the most recent message body so a freshly-arrived clearance
            // can be pasted into Notes or Discord with one click. PASTE replaces the draft
            // (an Append button felt redundant — most pastes are clearances copied wholesale
            // from the web Tower desk or a sim brief).
            GUI.enabled = !_sendBusy && CanCopyAnything();
            if (GUILayout.Button("Copy", TowerSkin.Button, GUILayout.Width(60f), GUILayout.Height(28f)))
            {
                CopyToClipboard();
            }

            var clip = GUIUtility.systemCopyBuffer ?? string.Empty;
            GUI.enabled = !_sendBusy && !string.IsNullOrEmpty(clip);
            if (GUILayout.Button("Paste", TowerSkin.Button, GUILayout.Width(60f), GUILayout.Height(28f)))
            {
                PasteFromClipboard(clip);
            }

            GUI.enabled = !_sendBusy && !string.IsNullOrEmpty((_draft ?? string.Empty).Trim());
            if (GUILayout.Button("Clear", TowerSkin.Button, GUILayout.Width(60f), GUILayout.Height(28f)))
            {
                _draft = string.Empty;
                ReleaseDraftFocus();
            }

            GUI.enabled = true;
            GUILayout.EndHorizontal();
        }

        private bool CanCopyAnything()
        {
            if (!string.IsNullOrEmpty((_draft ?? string.Empty).Trim()))
            {
                return true;
            }
            // Falls back to "copy last incoming/outgoing message" when the draft is empty.
            return _messages.Count > 0;
        }

        private void CopyToClipboard()
        {
            var draft = (_draft ?? string.Empty).Trim();
            if (draft.Length > 0)
            {
                GUIUtility.systemCopyBuffer = draft;
                SetStatus("Copied draft (" + draft.Length + " chars).", false);
                return;
            }

            // Walk back from the tail to the most recent non-empty message body so the player
            // can grab the latest clearance with one click. Skipping empty bodies guards
            // against a degenerate tower message that is just whitespace.
            for (var i = _messages.Count - 1; i >= 0; i--)
            {
                var m = _messages[i];
                if (m == null)
                {
                    continue;
                }
                var body = m.body ?? string.Empty;
                if (body.Length == 0)
                {
                    continue;
                }
                GUIUtility.systemCopyBuffer = body;
                SetStatus("Copied last message (" + body.Length + " chars).", false);
                return;
            }

            SetStatus("Nothing to copy.", true);
        }

        private void PasteFromClipboard(string clip)
        {
            if (string.IsNullOrEmpty(clip))
            {
                return;
            }
            // Cap to the same 4000-char limit the textarea enforces so a runaway paste
            // doesn't quietly exceed the backend's per-message ceiling.
            if (clip.Length > 4000)
            {
                clip = clip.Substring(0, 4000);
                SetStatus("Pasted (truncated to 4000 chars).", false);
            }
            else
            {
                SetStatus("Pasted " + clip.Length + " chars into draft.", false);
            }
            _draft = clip;
            ReleaseDraftFocus();
        }

        /// <summary>
        /// Drop keyboard focus when we mutate <see cref="_draft"/> from a button click.
        /// IMGUI keeps a per-control editing-state cache for the focused TextArea and
        /// repaints the cached value (not the new <c>_draft</c>) until focus changes —
        /// which makes paste/clear look like a no-op until the user clicks the area.
        /// Forcing keyboardControl to 0 invalidates that cache so the next OnGUI pass
        /// renders the new buffer.
        /// </summary>
        private static void ReleaseDraftFocus()
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

        private void TrySend()
        {
            if (_sendBusy)
            {
                return;
            }

            if (_mode == ChannelMode.RadarHail)
            {
                return;
            }

            var text = (_draft ?? string.Empty).Trim();
            if (text.Length == 0)
            {
                return;
            }

            if (!CanReachApi())
            {
                SetStatus("Log in (radio button) before sending ACARS.", true);
                return;
            }

            var url = TryBuildSendUrl();
            if (string.IsNullOrEmpty(url))
            {
                string sendHint;
                if (_mode == ChannelMode.DirectMessage)
                {
                    sendHint = "Pick a DM peer before sending.";
                }
                else if (_mode == ChannelMode.Lobby)
                {
                    // Lobby send URL is unconditional once auth is in place, so
                    // an empty URL here means we lost auth — point at the radio.
                    sendHint = "Log in (radio button) before sending to lobby.";
                }
                else
                {
                    sendHint = "No session id set — open the radio settings before sending.";
                }
                SetStatus(sendHint, true);
                return;
            }

            // Cap length client-side so we get a clean local error instead of a 400.
            if (text.Length > 4000)
            {
                text = text.Substring(0, 4000);
            }

            StartCoroutine(SendRoutine(url, text));
        }

        private IEnumerator SendRoutine(string url, string text)
        {
            _sendBusy = true;
            string sendingLabel;
            if (_mode == ChannelMode.DirectMessage)
            {
                sendingLabel = "Sending DM…";
            }
            else if (_mode == ChannelMode.Lobby)
            {
                sendingLabel = "Sending to lobby…";
            }
            else
            {
                sendingLabel = "Sending ACARS…";
            }
            SetStatus(sendingLabel, false);

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

                _sendBusy = false;

                if (req.isNetworkError || req.isHttpError)
                {
                    var bodyText = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                    var serverMsg = ExtractError(bodyText);
                    SetStatus(
                        "Send failed (" + req.responseCode + "): " +
                        (string.IsNullOrEmpty(serverMsg) ? (req.error ?? "?") : serverMsg),
                        true);
                    yield break;
                }

                _draft = string.Empty;
                SetStatus("Sent.", false);

                // Pick up our own message immediately instead of waiting for the next poll tick.
                var respText = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (!string.IsNullOrEmpty(respText))
                {
                    AcarsMessage echo = null;
                    try
                    {
                        var parsed = JsonUtility.FromJson<AcarsSendEnvelope>(respText);
                        if (parsed != null && parsed.message != null && !string.IsNullOrEmpty(parsed.message.id))
                        {
                            echo = parsed.message;
                        }
                    }
                    catch (Exception)
                    {
                        // Non-fatal: try fallback / poll below.
                    }

                    if (echo == null && !string.IsNullOrEmpty(respText))
                    {
                        AcarsJsonFallback.TryParsePostMessageEcho(respText, out echo);
                    }

                    if (echo != null && !string.IsNullOrEmpty(echo.id))
                    {
                        if (_knownIds.Add(echo.id))
                        {
                            _messages.Add(echo);
                            _autoScroll = true;
                        }

                        // Cache our own user id from the echo so the next poll's delta can
                        // skip our own outbound messages when deciding whether to ring the
                        // ACR annunciator. JsonUtility leaves missing fields as "" not null.
                        if (string.IsNullOrEmpty(_selfUserId)
                            && !string.IsNullOrEmpty(echo.fromUserId))
                        {
                            _selfUserId = echo.fromUserId;
                        }

                        if (!string.IsNullOrEmpty(echo.createdAt) &&
                            StringCompareIso(echo.createdAt, _lastSinceIso) > 0)
                        {
                            _lastSinceIso = echo.createdAt;
                        }
                    }
                }
            }
        }

        private void SetStatus(string text, bool isError)
        {
            _statusLine = text ?? string.Empty;
            _statusIsError = isError;
        }

        private static string ExtractError(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return string.Empty;
            }

            var m = Regex.Match(json, "\"error\"\\s*:\\s*\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : string.Empty;
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }

            // ACARS bodies are free-form text from a textarea; escape the standard JSON specials
            // and convert CRLF to \n so multi-line drafts survive a round trip.
            var sb = new StringBuilder(s.Length + 8);
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                switch (c)
                {
                    case '\\':
                        sb.Append("\\\\");
                        break;
                    case '"':
                        sb.Append("\\\"");
                        break;
                    case '\b':
                        sb.Append("\\b");
                        break;
                    case '\f':
                        sb.Append("\\f");
                        break;
                    case '\n':
                        sb.Append("\\n");
                        break;
                    case '\r':
                        // Drop bare \r so CRLF -> \n.
                        break;
                    case '\t':
                        sb.Append("\\t");
                        break;
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

        private void DrawRadarHailTab()
        {
            GUILayout.BeginVertical(TowerSkin.Inset, GUILayout.MinHeight(PanelHeight - 245f));
            GUILayout.Label(
                "Posts a meet-on-frequency line to the target room's ACARS (and mirrors to their radio annunciator when online).",
                TowerSkin.BodyMuted);
            GUILayout.Space(6f);

            if (!CanReachApi())
            {
                GUILayout.Label("Log in (radio button) before sending a radar hail.", TowerSkin.BodyMuted);
                GUILayout.EndVertical();
                return;
            }

            string ownSid;
            if (!CanTalkToBackend(out ownSid) || string.IsNullOrEmpty(ownSid))
            {
                GUILayout.Label("No session id set — open the radio settings.", TowerSkin.BodyMuted);
                GUILayout.EndVertical();
                return;
            }

            GUILayout.Label("Target room", TowerSkin.Subtitle);
            _hailTargetScroll = GUILayout.BeginScrollView(_hailTargetScroll, GUILayout.Height(108f));
            var selOwn = string.Equals(_hailTargetSid ?? string.Empty, ownSid, StringComparison.Ordinal);
            if (GUILayout.Button((selOwn ? "● " : "○ ") + "This room (ops / ACARS) · " + HailTrimSid(ownSid), selOwn ? TowerSkin.ButtonActive : TowerSkin.Button))
            {
                _hailTargetSid = ownSid;
            }

            for (var i = 0; i < _hailAircraft.Count; i++)
            {
                var a = _hailAircraft[i];
                if (a == null)
                {
                    continue;
                }

                var sid = (a.sessionId ?? string.Empty).Trim();
                if (string.IsNullOrEmpty(sid) || string.Equals(sid, ownSid, StringComparison.Ordinal))
                {
                    continue;
                }

                var label = HailAircraftLabel(a);
                var sel = string.Equals(_hailTargetSid ?? string.Empty, sid, StringComparison.Ordinal);
                if (GUILayout.Button((sel ? "● " : "○ ") + label + " · " + HailTrimSid(sid), sel ? TowerSkin.ButtonActive : TowerSkin.Button))
                {
                    _hailTargetSid = sid;
                }
            }

            GUILayout.EndScrollView();

            GUILayout.Label("Meet MHz (NNN.NNN)", TowerSkin.Subtitle);
            GUILayout.BeginHorizontal();
            GUI.enabled = !_hailSendBusy;
            if (GUILayout.Button("−25 kHz", TowerSkin.Button, GUILayout.Width(72f), GUILayout.Height(22f)))
            {
                StepHailMhz(-1);
            }
            _hailFreqText = GUILayout.TextField(_hailFreqText ?? string.Empty, 12, TowerSkin.TextField, GUILayout.MinWidth(90f));
            if (GUILayout.Button("+25 kHz", TowerSkin.Button, GUILayout.Width(72f), GUILayout.Height(22f)))
            {
                StepHailMhz(1);
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();

            GUILayout.Label("Note (optional, max 120)", TowerSkin.Subtitle);
            _hailNote = GUILayout.TextField(_hailNote ?? string.Empty, 120, TowerSkin.TextField);

            GUILayout.Space(8f);
            GUI.enabled = !_hailSendBusy && CanReachApi() && !string.IsNullOrEmpty((ownSid ?? string.Empty).Trim());
            if (GUILayout.Button(_hailSendBusy ? "Sending…" : "Send radar hail", TowerSkin.ButtonActive, GUILayout.Height(28f)))
            {
                StartCoroutine(PostRadarHailCoroutine());
            }
            GUI.enabled = true;

            GUILayout.EndVertical();
        }

        private static string HailTrimSid(string sid)
        {
            if (string.IsNullOrEmpty(sid))
            {
                return "—";
            }
            return sid.Length <= 10 ? sid : sid.Substring(0, 10) + "…";
        }

        private static string HailAircraftLabel(AcarsHailActiveAircraftRow a)
        {
            var cs = (a.callsign ?? string.Empty).Trim();
            if (cs.Length > 0)
            {
                return cs;
            }
            var craft = (a.craftName ?? string.Empty).Trim();
            if (craft.Length > 0)
            {
                return craft;
            }
            var pilot = (a.pilotName ?? string.Empty).Trim();
            return pilot.Length > 0 ? pilot : "?";
        }

        private IEnumerator FetchHailAircraft()
        {
            if (_hailFetchBusy)
            {
                yield break;
            }

            _hailFetchBusy = true;

            if (TowerModSettings.UseUdpLiveTransport)
            {
                string udpReply;
                string udpError;
                if (TowerUdpClient.TryRequest(
                        TowerUdpMessageType.GhostQuery,
                        TowerModSettings.SessionId,
                        "{}",
                        out udpReply,
                        out udpError))
                {
                    ApplyHailAircraftSnapshot(udpReply);
                    _hailFetchBusy = false;
                    _hailLastFetchAt = Time.unscaledTime;
                    SetStatus("Radar hail picks refreshed (UDP).", false);
                    yield break;
                }

                if (!TowerModSettings.LiveUdpFallbackHttp)
                {
                    SetStatus(
                        "Active traffic (UDP) failed: " + (string.IsNullOrEmpty(udpError) ? "no reply" : udpError),
                        true);
                    _hailFetchBusy = false;
                    yield break;
                }
            }

            var url = TowerModSettings.ApiBaseUrl + "/tower/active-aircraft";
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 8;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                _hailFetchBusy = false;
                _hailLastFetchAt = Time.unscaledTime;

                if (req.isNetworkError || req.isHttpError)
                {
                    var detail = req.error ?? "?";
                    if (req.responseCode != 0)
                    {
                        var bodyText = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                        var serverMsg = ExtractError(bodyText);
                        if (!string.IsNullOrEmpty(serverMsg))
                        {
                            detail = serverMsg;
                        }
                    }
                    SetStatus("Active-aircraft fetch failed (" + req.responseCode + "): " + detail, true);
                    yield break;
                }

                var txt = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(txt))
                {
                    _hailAircraft.Clear();
                    SetStatus("Active-aircraft list empty.", false);
                    yield break;
                }

                ApplyHailAircraftSnapshot(txt);
                SetStatus("Radar hail picks refreshed.", false);
            }
        }

        private void ApplyHailAircraftSnapshot(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                _hailAircraft.Clear();
                return;
            }

            AcarsHailActiveAircraftEnvelope parsed;
            try
            {
                parsed = JsonUtility.FromJson<AcarsHailActiveAircraftEnvelope>(json);
            }
            catch (Exception ex)
            {
                SetStatus("Active-aircraft parse failed: " + ex.Message, true);
                return;
            }

            _hailAircraft.Clear();
            if (parsed == null || parsed.aircraft == null)
            {
                return;
            }

            for (var i = 0; i < parsed.aircraft.Length; i++)
            {
                var a = parsed.aircraft[i];
                if (a == null || string.IsNullOrEmpty(a.sessionId))
                {
                    continue;
                }
                _hailAircraft.Add(a);
            }
        }

        private IEnumerator PostRadarHailCoroutine()
        {
            if (_hailSendBusy)
            {
                yield break;
            }

            string hailFreqNormalized;
            if (!TryNormalizeHailMhz(_hailFreqText, out hailFreqNormalized))
            {
                SetStatus("Invalid MHz — use NNN.NNN between 100 and 199.999.", true);
                yield break;
            }
            _hailFreqText = hailFreqNormalized;

            var target = (_hailTargetSid ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(target))
            {
                SetStatus("Pick a target room.", true);
                yield break;
            }

            string sessionId;
            if (!CanTalkToBackend(out sessionId))
            {
                SetStatus("No session id — open the radio settings.", true);
                yield break;
            }

            if (!CanReachApi())
            {
                SetStatus("Log in (radio) before sending radar hail.", true);
                yield break;
            }

            var url = TowerModSettings.ApiBaseUrl + "/session/"
                      + UnityWebRequest.EscapeURL(sessionId) + "/dragon-radar/hail";

            var note = (_hailNote ?? string.Empty).Trim();
            if (note.Length > 120)
            {
                note = note.Substring(0, 120);
            }

            var payload = "{\"targetSessionId\":\"" + JsonEscape(target)
                          + "\",\"frequencyMhz\":\"" + JsonEscape(_hailFreqText) + "\"";
            if (note.Length > 0)
            {
                payload += ",\"note\":\"" + JsonEscape(note) + "\"";
            }
            payload += "}";

            _hailSendBusy = true;
            SetStatus("Sending radar hail…", false);

            var body = Encoding.UTF8.GetBytes(payload);
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();

                _hailSendBusy = false;

                if (req.isNetworkError || req.isHttpError)
                {
                    var bodyText = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                    var serverMsg = ExtractError(bodyText);
                    SetStatus(
                        "Radar hail failed (" + req.responseCode + "): "
                        + (string.IsNullOrEmpty(serverMsg) ? (req.error ?? "?") : serverMsg),
                        true);
                    yield break;
                }

                SetStatus("Radar hail sent on " + _hailFreqText + " MHz.", false);
            }
        }

        private void StepHailMhz(int steps)
        {
            string normalized;
            if (!TryNormalizeHailMhz(_hailFreqText, out normalized))
            {
                normalized = "122.000";
            }

            double mhz;
            if (!double.TryParse(normalized, NumberStyles.Float, CultureInfo.InvariantCulture, out mhz))
            {
                mhz = 122.000;
            }

            mhz += 0.025 * steps;
            if (mhz < 118.000)
            {
                mhz = 118.000;
            }
            if (mhz > 136.975)
            {
                mhz = 136.975;
            }
            mhz = Math.Round(mhz * 40.0, MidpointRounding.AwayFromZero) / 40.0;
            _hailFreqText = string.Format(CultureInfo.InvariantCulture, "{0:000.000}", mhz);
        }

        private static bool TryNormalizeHailMhz(string raw, out string canonical)
        {
            canonical = string.Empty;
            if (string.IsNullOrEmpty(raw))
            {
                return false;
            }
            double mhz;
            if (!double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out mhz))
            {
                return false;
            }
            mhz = Math.Round(mhz * 40.0, MidpointRounding.AwayFromZero) / 40.0;
            if (mhz < 100.0 || mhz > 199.999)
            {
                return false;
            }
            canonical = string.Format(CultureInfo.InvariantCulture, "{0:000.000}", mhz);
            return true;
        }

        [Serializable]
        private sealed class AcarsHailActiveAircraftEnvelope
        {
            public bool ok;
            public AcarsHailActiveAircraftRow[] aircraft;
        }

        [Serializable]
        private sealed class AcarsHailActiveAircraftRow
        {
            public string sessionId;
            public string pilotName;
            public string callsign;
            public string craftName;
            public string bodyName;
            public double lat;
            public double lon;
            public double aslAlt;
            public bool smoothedPositionValid;
            public double smoothedLat;
            public double smoothedLon;
            public double smoothedAslAlt;
        }
    }
}
