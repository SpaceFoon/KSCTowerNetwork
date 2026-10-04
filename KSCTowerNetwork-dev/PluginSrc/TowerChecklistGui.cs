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
    /// In-game checklist panel. Mirrors the web <c>ChecklistModal</c> + the backend's
    /// <c>/v1/session/{id}/checklist</c> endpoint family so a pilot can:
    ///   - View the bidirectional pilot/controller checklist (defaults or a custom override).
    ///   - Tick off the pilot column (controller side is read-only here; mods can flip either).
    ///   - In Edit mode: add / rename / remove items in this session (same backend endpoints
    ///     the web modal uses, so both surfaces stay in lockstep).
    ///   - In Templates mode: load a saved per-user / per-craft template, send it to tower
    ///     (which posts an ACARS announce in the room), or save the current items as a new
    ///     template.
    /// </summary>
    /// <remarks>
    /// Created on demand by <see cref="TowerChecklistToolbar"/>. Polls every 4s while the
    /// panel is open and 12s while hidden so a tower edit shows up promptly without
    /// hammering the API. JsonUtility can't deserialize Dictionary&lt;string,T&gt;, so the
    /// backend GET also includes a <c>doneIds</c> arrays projection that this code consumes.
    /// </remarks>
    public class TowerChecklistGui : MonoBehaviour
    {
        // Bumped 640 → 760 so two-column rows in the Edit tab (and long checklist item
        // labels in View) don't truncate / wrap awkwardly. The two-up "BeginVertical(width = (PanelWidth-48)/2)"
        // panes around line ~990 split this width evenly.
        private const float PanelWidth = 760f;
        private const float PanelHeight = 600f;
        private const float PollIntervalSecondsVisible = 4f;
        private const float PollIntervalSecondsHidden = 12f;
        private const int RequestTimeoutSeconds = 10;

        public enum Tab { View, Edit, Templates }

        private static TowerChecklistGui _instance;
        public static TowerChecklistGui Instance { get { return _instance; } }

        public Action OnRequestMinimize;

#pragma warning disable 0649
        [Serializable]
        public class AutoRuleDto
        {
            public string kind;
            public string expr;
        }

        [Serializable]
        public class ItemDto
        {
            public string id;
            public string label;
            // JsonUtility handles null nested classes fine; the backend only emits this when set.
            public AutoRuleDto autoRule;
        }

        [Serializable]
        public class PhaseDto
        {
            public string id;
            public string title;
            public ItemDto[] pilot;
            public ItemDto[] controller;
        }

        [Serializable]
        private class DoneIdsDto
        {
            public string[] pilot;
            public string[] controller;
        }

        [Serializable]
        public class SendRecordDto
        {
            public string id;
            public string sessionId;
            public string messageId;
            public string templateId;
            public string templateName;
            public string sentByUserId;
            public string createdAt;
            public string ackUserId;
            public string ackAt;
        }

        [Serializable]
        private class ChecklistResponse
        {
            public bool ok;
            public PhaseDto[] phases;
            public string source;
            public DoneIdsDto doneIds;
            public string pilotUserId;
            public string assignedTowerUserId;
            public string craftName;
            // Optional - present on the unified payload returned by every checklist endpoint.
            public SendRecordDto latestSend;
        }

        [Serializable]
        private class SendResponse
        {
            public bool ok;
            public string sendId;
        }

        [Serializable]
        public class TemplateDto
        {
            public string id;
            public string ownerUserId;
            public string scope;
            public string craftName;
            public string name;
            public bool isDefault;
            public PhaseDto[] phases;
            public string createdAt;
            public string updatedAt;
        }

        [Serializable]
        private class TemplatesResponse
        {
            public bool ok;
            public TemplateDto[] templates;
        }

        [Serializable]
        private class TemplateCreateResponse
        {
            public bool ok;
            public TemplateDto template;
        }

        [Serializable]
        private class PhasesEnvelope
        {
            public PhaseDto[] phases;
        }
#pragma warning restore 0649

        private bool _visible;
        private bool _started;
        private Tab _tab = Tab.View;
        private string _statusLine = "Standby.";
        private bool _statusIsError;
        private bool _fetchBusy;
        private bool _mutateBusy;
        // Set by SendMutate / SendMutateTracked at the end of each request so the optimistic
        // toggle path can decide whether to revert its local _doneP/_doneC flip.
        private bool _lastMutateFailed;

        // Seeded from the local defaults so the panel renders the same checklist the web
        // modal does even before (or without) a successful backend round-trip. Replaced by
        // the canonical server payload as soon as FetchChecklist succeeds, OR replaced with
        // a mode-specific fallback (rocket/plane/rover) when TowerCraftMode flips and the
        // backend hasn't sent a session-custom override yet.
        private PhaseDto[] _phases = TowerChecklistDefaults.BuildForMode(TowerCraftMode.Current);
        private string _source = "default";
        private CraftMode _modeForFallback = TowerCraftMode.Current;
        private string _craftName = string.Empty;
        private string _pilotUserId = string.Empty;
        private string _assignedTowerUserId = string.Empty;
        private readonly HashSet<string> _doneP = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> _doneC = new HashSet<string>(StringComparer.Ordinal);

        private TemplateDto[] _templates = new TemplateDto[0];
        private bool _templatesFetched;
        private SendRecordDto _latestSend;

        // Per-row edit state for the Edit tab.
        private readonly Dictionary<string, string> _renameDrafts = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly Dictionary<string, string> _addDrafts = new Dictionary<string, string>(StringComparer.Ordinal);

        // Per-phase rename + new-phase drafts for the Edit tab phase manager.
        private readonly Dictionary<string, string> _phaseRenameDrafts = new Dictionary<string, string>(StringComparer.Ordinal);
        private string _newPhaseTitle = string.Empty;

        // 2-step "send to tower": when the user clicks Send we stash the candidate template
        // and a precomputed diff against the *current* session phases; the user then either
        // hits Confirm to actually POST /send or Cancel to drop the pending intent.
        private TemplateDto _pendingSendTpl;
        private DiffSummary _pendingDiff;

        // "Save current as..." form state.
        private string _saveName = string.Empty;
        private int _saveScopeIdx; // 0 = user, 1 = craft, 2 = global (mod-only on backend)
        private string _saveCraft = string.Empty;
        private bool _saveDefault;

        private Vector2 _scroll = Vector2.zero;
        private Rect _windowRect = new Rect(160f, 90f, PanelWidth, PanelHeight);
        private int _windowId;

        public bool Visible
        {
            get { return _visible; }
            set
            {
                if (_visible == value) return;
                _visible = value;
                if (_visible)
                {
                    // Force a fresh fetch on next tick so reopening always reflects current state.
                    _scroll = Vector2.zero;
                }
            }
        }

        public static void EnsureExists()
        {
            if (_instance != null) return;
            var go = new GameObject("KSCTowerChecklistGui");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<TowerChecklistGui>();
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;
            _windowId = GetInstanceID() ^ 0x434B4C53; // "CKLS"
        }

        private void OnDestroy()
        {
            TowerCraftMode.OnModeChanged -= HandleCraftModeChanged;
            if (_instance == this) _instance = null;
        }

        private void Start()
        {
            if (_started) return;
            _started = true;
            TowerModSettings.EnsureLoaded();
            TowerCraftMode.OnModeChanged += HandleCraftModeChanged;
            StartCoroutine(PollLoop());
        }

        /// <summary>
        /// Swap the local fallback to the mode-specific card stack whenever the player's
        /// active vessel changes category (KSC plane -> rocket on the pad, rocket recovery ->
        /// rover, ...). When the backend has already supplied a session-custom override the
        /// swap is suppressed because the controller's edits should always win.
        /// </summary>
        private void HandleCraftModeChanged(CraftMode mode)
        {
            _modeForFallback = mode;
            if (string.Equals(_source, "session", StringComparison.Ordinal))
            {
                return;
            }

            _phases = TowerChecklistDefaults.BuildForMode(mode);
            // Done state was indexed by the previous mode's item ids — none of those exist in
            // the new card stack, so clearing avoids a confusing "ghost ticked" state where
            // a tick rendered against an item that no longer renders.
            _doneP.Clear();
            _doneC.Clear();
        }

        private IEnumerator PollLoop()
        {
            yield return new WaitForSeconds(0.9f);
            while (true)
            {
                // Force a craft-mode poll on every checklist tick so HandleCraftModeChanged
                // fires even when no other code has touched TowerCraftMode.Current recently
                // (e.g. KSC scene with the radio panel closed). Cheap — at most one part-list
                // walk every PollIntervalSecondsHidden seconds.
                TowerCraftMode.Refresh(true);
                var wait = _visible ? PollIntervalSecondsVisible : PollIntervalSecondsHidden;
                string _ignored;
                if (CanReachApi() && CanTalkToBackend(out _ignored))
                {
                    if (!_fetchBusy)
                    {
                        yield return StartCoroutine(FetchChecklist(false));
                    }
                }
                yield return new WaitForSeconds(wait);
            }
        }

        private static bool CanReachApi()
        {
            TowerModSettings.EnsureLoaded();
            if (TowerModSettings.SkipTowerLogin) return true;
            return !string.IsNullOrEmpty(TowerModSettings.TowerAuthToken);
        }

        private static bool CanTalkToBackend(out string sessionId)
        {
            TowerModSettings.EnsureLoaded();
            sessionId = TowerModSettings.SessionId ?? string.Empty;
            if (string.IsNullOrEmpty(sessionId)) return false;
            if (TowerModSettings.SkipTowerLogin) return true;
            return !string.IsNullOrEmpty(TowerModSettings.TowerAuthToken);
        }

        private static string SessionUrl(string suffix)
        {
            string sessionId;
            if (!CanTalkToBackend(out sessionId)) return null;
            return TowerModSettings.ApiBaseUrl + "/session/" + UnityWebRequest.EscapeURL(sessionId) + suffix;
        }

        private IEnumerator FetchChecklist(bool announce)
        {
            _fetchBusy = true;
            if (announce) SetStatus("Refreshing checklist...", false);
            var url = SessionUrl("/checklist");
            if (string.IsNullOrEmpty(url))
            {
                _fetchBusy = false;
                if (announce) SetStatus("No session id — open the radio settings.", true);
                yield break;
            }
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                _fetchBusy = false;
                if (req.isNetworkError || req.isHttpError)
                {
                    SetStatus("Checklist fetch failed (" + req.responseCode + ").", true);
                    yield break;
                }
                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (string.IsNullOrEmpty(text)) yield break;
                ChecklistResponse parsed = null;
                try { parsed = JsonUtility.FromJson<ChecklistResponse>(text); }
                catch (Exception ex) { Debug.LogWarning("[KSCTowerNetwork] Checklist parse failed: " + ex.Message); }
                if (parsed == null) yield break;
                ApplyChecklistResponse(parsed);
                if (announce) SetStatus("Live - " + DateTime.Now.ToString("HH:mm:ss"), false);
            }
        }

        private void ApplyChecklistResponse(ChecklistResponse r)
        {
            _source = string.IsNullOrEmpty(r.source) ? "default" : r.source;
            // The backend only knows the plane card stack today, so any "default" payload
            // would clobber a rocket / rover fallback the plugin has already swapped in.
            // Honour server "session" (custom) payloads verbatim — those represent explicit
            // controller / pilot edits and must always win — but for "default" we keep our
            // mode-specific local cards instead.
            if (string.Equals(_source, "session", StringComparison.Ordinal))
            {
                _phases = r.phases ?? new PhaseDto[0];
            }
            else
            {
                _phases = TowerChecklistDefaults.BuildForMode(_modeForFallback);
            }
            _craftName = r.craftName ?? string.Empty;
            _pilotUserId = r.pilotUserId ?? string.Empty;
            _assignedTowerUserId = r.assignedTowerUserId ?? string.Empty;
            _doneP.Clear();
            _doneC.Clear();
            if (r.doneIds != null)
            {
                if (r.doneIds.pilot != null)
                {
                    for (var i = 0; i < r.doneIds.pilot.Length; i++) _doneP.Add(r.doneIds.pilot[i]);
                }
                if (r.doneIds.controller != null)
                {
                    for (var i = 0; i < r.doneIds.controller.Length; i++) _doneC.Add(r.doneIds.controller[i]);
                }
            }
            // latestSend is wiped to null when the backend has no record (JsonUtility leaves it
            // as a default-constructed object with empty strings, so check id explicitly).
            if (r.latestSend != null && !string.IsNullOrEmpty(r.latestSend.id))
            {
                _latestSend = r.latestSend;
            }
            else
            {
                _latestSend = null;
            }
        }

        // -------- Mutations (toggle / add / rename / remove / reset / send / save) --------

        /// <summary>
        /// Optimistic toggle: flip the local _doneP/_doneC set immediately so the GUI
        /// responds without the ~30-300ms HTTP roundtrip, then revert if the server
        /// returns a 4xx (e.g. permission denied for cross-side ticks). Successful
        /// responses include the canonical doneIds so the local set is reseated by
        /// ApplyChecklistResponse below.
        /// </summary>
        private IEnumerator ToggleItem(string side, string itemId)
        {
            var url = SessionUrl("/checklist/toggle");
            if (string.IsNullOrEmpty(url))
            {
                SetStatus("No session id.", true);
                yield break;
            }
            var set = string.Equals(side, "controller", StringComparison.Ordinal) ? _doneC : _doneP;
            bool wasDone = set.Contains(itemId);
            if (wasDone) set.Remove(itemId); else set.Add(itemId);
            var json = "{\"side\":\"" + side + "\",\"itemId\":\"" + JsonEscape(itemId) + "\"}";
            yield return SendMutate("POST", url, json, "Toggling...", "Toggled.");
            if (_lastMutateFailed)
            {
                if (wasDone) set.Add(itemId); else set.Remove(itemId);
            }
        }

        // -------- Phase CRUD (Edit-tab phase manager) --------

        private IEnumerator AddPhase(string title)
        {
            // POST /checklist/phases adds a single phase; PUT replaces all phases (apply tpl)
            // and DELETE clears the session override. Same path, different verbs.
            var url = SessionUrl("/checklist/phases");
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            var json = "{\"title\":\"" + JsonEscape(title) + "\"}";
            yield return SendMutate("POST", url, json, "Adding phase...", "Phase added.");
        }

        private IEnumerator RenamePhase(string phaseId, string title)
        {
            var url = SessionUrl("/checklist/phases/" + UnityWebRequest.EscapeURL(phaseId));
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            var json = "{\"title\":\"" + JsonEscape(title) + "\"}";
            yield return SendMutate("PATCH", url, json, "Renaming phase...", "Phase renamed.");
        }

        private IEnumerator RemovePhase(string phaseId)
        {
            var url = SessionUrl("/checklist/phases/" + UnityWebRequest.EscapeURL(phaseId));
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            yield return SendMutate("DELETE", url, null, "Removing phase...", "Phase removed.");
        }

        private IEnumerator MovePhase(string phaseId, int delta)
        {
            // PUT /checklist/phases/order with the new ordering computed locally.
            var url = SessionUrl("/checklist/phases/order");
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            int idx = -1;
            for (var i = 0; i < _phases.Length; i++) { if (_phases[i] != null && _phases[i].id == phaseId) { idx = i; break; } }
            if (idx < 0) { SetStatus("Phase not found locally.", true); yield break; }
            var newIdx = Mathf.Clamp(idx + delta, 0, _phases.Length - 1);
            if (newIdx == idx) yield break;
            var ids = new List<string>(_phases.Length);
            for (var i = 0; i < _phases.Length; i++) if (_phases[i] != null && !string.IsNullOrEmpty(_phases[i].id)) ids.Add(_phases[i].id);
            ids.RemoveAt(idx);
            ids.Insert(newIdx, phaseId);
            var sb = new StringBuilder();
            sb.Append("{\"phaseIds\":[");
            for (var i = 0; i < ids.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(JsonEscape(ids[i])).Append('"');
            }
            sb.Append("]}");
            yield return SendMutate("PUT", url, sb.ToString(), "Reordering...", "Phases reordered.");
        }

        // -------- Acknowledge a "send to tower" --------

        private IEnumerator AckLatestSend()
        {
            if (_latestSend == null || string.IsNullOrEmpty(_latestSend.id)) yield break;
            var url = SessionUrl("/checklist/ack");
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            var json = "{\"sendId\":\"" + JsonEscape(_latestSend.id) + "\"}";
            yield return SendMutate("POST", url, json, "Acking...", "Acknowledged.");
        }

        private IEnumerator AddItem(string phaseId, string side, string label)
        {
            var url = SessionUrl("/checklist/items");
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            var json = "{\"phaseId\":\"" + JsonEscape(phaseId) + "\",\"side\":\"" + side + "\",\"label\":\"" + JsonEscape(label) + "\"}";
            yield return SendMutate("POST", url, json, "Adding...", "Item added.");
        }

        private IEnumerator RenameItem(string itemId, string label)
        {
            var url = SessionUrl("/checklist/items/" + UnityWebRequest.EscapeURL(itemId));
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            var json = "{\"label\":\"" + JsonEscape(label) + "\"}";
            yield return SendMutate("PATCH", url, json, "Renaming...", "Item renamed.");
        }

        private IEnumerator RemoveItem(string itemId)
        {
            var url = SessionUrl("/checklist/items/" + UnityWebRequest.EscapeURL(itemId));
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            yield return SendMutate("DELETE", url, null, "Removing...", "Item removed.");
        }

        private IEnumerator ResetToDefaults()
        {
            var url = SessionUrl("/checklist/phases");
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            yield return SendMutate("DELETE", url, null, "Resetting...", "Reset to default.");
        }

        private IEnumerator SendTemplateToTower(string templateId)
        {
            var url = SessionUrl("/checklist/send");
            if (string.IsNullOrEmpty(url)) { SetStatus("No session id.", true); yield break; }
            var json = "{\"templateId\":\"" + JsonEscape(templateId) + "\"}";
            yield return SendMutate("POST", url, json, "Sending to tower...", "Sent to tower.");
        }

        private IEnumerator LoadTemplateInline(TemplateDto tpl)
        {
            var url = SessionUrl("/checklist/phases");
            if (string.IsNullOrEmpty(url) || tpl == null || tpl.phases == null) { SetStatus("No session id.", true); yield break; }
            // Wrap in {"phases": [...]} via JsonUtility's envelope serialization.
            var envelope = new PhasesEnvelope { phases = tpl.phases };
            var json = "{\"phases\":" + ExtractPhasesArray(JsonUtility.ToJson(envelope)) + "}";
            yield return SendMutate("PUT", url, json, "Loading template...", "Loaded \"" + (tpl.name ?? "?") + "\".");
        }

        /// <summary>
        /// JsonUtility wraps a class as <c>{"phases":[...]}</c>, which is exactly what we want;
        /// this helper just trims the outer braces if anything else needs the bare array. Today
        /// the body is sent intact so we extract only the array portion when re-wrapping.
        /// </summary>
        private static string ExtractPhasesArray(string envelopeJson)
        {
            if (string.IsNullOrEmpty(envelopeJson)) return "[]";
            var idx = envelopeJson.IndexOf("\"phases\":", StringComparison.Ordinal);
            if (idx < 0) return "[]";
            var arrStart = envelopeJson.IndexOf('[', idx);
            if (arrStart < 0) return "[]";
            // Find matching close bracket.
            int depth = 0;
            for (var i = arrStart; i < envelopeJson.Length; i++)
            {
                var ch = envelopeJson[i];
                if (ch == '[') depth++;
                else if (ch == ']')
                {
                    depth--;
                    if (depth == 0) return envelopeJson.Substring(arrStart, i - arrStart + 1);
                }
            }
            return "[]";
        }

        /// <summary>
        /// Sends a JSON-bodied request, surfaces success/error in the status line, and
        /// reapplies the unified <see cref="ChecklistResponse"/> payload returned by every
        /// checklist endpoint. Sets <see cref="_lastMutateFailed"/> so callers (e.g. the
        /// optimistic toggle path) can revert preflight local edits on 4xx/5xx.
        /// </summary>
        private IEnumerator SendMutate(string method, string url, string bodyJson, string busyText, string okText)
        {
            _mutateBusy = true;
            _lastMutateFailed = false;
            SetStatus(busyText, false);
            using (var req = new UnityWebRequest(url, method))
            {
                if (bodyJson != null)
                {
                    var body = Encoding.UTF8.GetBytes(bodyJson);
                    req.uploadHandler = new UploadHandlerRaw(body);
                    req.SetRequestHeader("Content-Type", "application/json");
                }
                req.downloadHandler = new DownloadHandlerBuffer();
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                _mutateBusy = false;
                if (req.isNetworkError || req.isHttpError)
                {
                    _lastMutateFailed = true;
                    var bodyText = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                    var serverMsg = ExtractError(bodyText);
                    SetStatus("Failed (" + req.responseCode + "): " + (string.IsNullOrEmpty(serverMsg) ? (req.error ?? "?") : serverMsg), true);
                    yield break;
                }
                SetStatus(okText, false);
                var resp = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                if (!string.IsNullOrEmpty(resp))
                {
                    ChecklistResponse parsed = null;
                    try { parsed = JsonUtility.FromJson<ChecklistResponse>(resp); }
                    catch (Exception) { parsed = null; }
                    if (parsed != null && parsed.phases != null) ApplyChecklistResponse(parsed);
                }
                else
                {
                    StartCoroutine(FetchChecklist(false));
                }
            }
        }

        // -------- Diff helper for the 2-step send-to-tower preview --------

        /// <summary>
        /// Plain summary of what would change if we replaced the session's current phases
        /// with those of a candidate template. Mirrors <c>diffChecklistPhases</c> in
        /// <c>web/src/session/checklists.ts</c> but only carries counts + a few labels —
        /// enough to render an IMGUI confirm screen without ballooning the binary.
        /// </summary>
        public struct DiffSummary
        {
            public int PhasesAdded;
            public int PhasesRemoved;
            public int PhasesRenamed;
            public int ItemsAdded;
            public int ItemsRemoved;
            public int ItemsRenamed;
            public bool IsEmpty
            {
                get
                {
                    return PhasesAdded == 0 && PhasesRemoved == 0 && PhasesRenamed == 0 &&
                           ItemsAdded == 0 && ItemsRemoved == 0 && ItemsRenamed == 0;
                }
            }
            public string OneLine
            {
                get
                {
                    return string.Format(CultureInfo.InvariantCulture,
                        "phases +{0}/-{1}/~{2}  items +{3}/-{4}/~{5}",
                        PhasesAdded, PhasesRemoved, PhasesRenamed,
                        ItemsAdded, ItemsRemoved, ItemsRenamed);
                }
            }
        }

        private static DiffSummary DiffPhases(PhaseDto[] cur, PhaseDto[] next)
        {
            var d = new DiffSummary();
            cur = cur ?? new PhaseDto[0];
            next = next ?? new PhaseDto[0];
            // Index by phase id so reorders don't show up as add/remove churn.
            var curById = new Dictionary<string, PhaseDto>(StringComparer.Ordinal);
            for (var i = 0; i < cur.Length; i++) if (cur[i] != null && !string.IsNullOrEmpty(cur[i].id)) curById[cur[i].id] = cur[i];
            var nextById = new Dictionary<string, PhaseDto>(StringComparer.Ordinal);
            for (var i = 0; i < next.Length; i++) if (next[i] != null && !string.IsNullOrEmpty(next[i].id)) nextById[next[i].id] = next[i];
            foreach (var kv in nextById)
            {
                PhaseDto curPhase;
                if (!curById.TryGetValue(kv.Key, out curPhase))
                {
                    d.PhasesAdded++;
                    var ph = kv.Value;
                    if (ph.pilot != null) d.ItemsAdded += ph.pilot.Length;
                    if (ph.controller != null) d.ItemsAdded += ph.controller.Length;
                    continue;
                }
                if (!string.Equals(curPhase.title ?? string.Empty, kv.Value.title ?? string.Empty, StringComparison.Ordinal))
                {
                    d.PhasesRenamed++;
                }
                DiffItems(curPhase.pilot, kv.Value.pilot, ref d);
                DiffItems(curPhase.controller, kv.Value.controller, ref d);
            }
            foreach (var kv in curById)
            {
                if (!nextById.ContainsKey(kv.Key))
                {
                    d.PhasesRemoved++;
                    if (kv.Value.pilot != null) d.ItemsRemoved += kv.Value.pilot.Length;
                    if (kv.Value.controller != null) d.ItemsRemoved += kv.Value.controller.Length;
                }
            }
            return d;
        }

        private static void DiffItems(ItemDto[] cur, ItemDto[] next, ref DiffSummary d)
        {
            cur = cur ?? new ItemDto[0];
            next = next ?? new ItemDto[0];
            var curById = new Dictionary<string, ItemDto>(StringComparer.Ordinal);
            for (var i = 0; i < cur.Length; i++) if (cur[i] != null && !string.IsNullOrEmpty(cur[i].id)) curById[cur[i].id] = cur[i];
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < next.Length; i++)
            {
                var n = next[i];
                if (n == null || string.IsNullOrEmpty(n.id)) continue;
                seen.Add(n.id);
                ItemDto c;
                if (!curById.TryGetValue(n.id, out c)) { d.ItemsAdded++; continue; }
                if (!string.Equals(c.label ?? string.Empty, n.label ?? string.Empty, StringComparison.Ordinal))
                {
                    d.ItemsRenamed++;
                }
            }
            foreach (var kv in curById) if (!seen.Contains(kv.Key)) d.ItemsRemoved++;
        }

        private void RequestSendPreview(TemplateDto tpl)
        {
            if (tpl == null || tpl.phases == null) return;
            _pendingSendTpl = tpl;
            _pendingDiff = DiffPhases(_phases, tpl.phases);
        }

        private IEnumerator ConfirmSendPending()
        {
            if (_pendingSendTpl == null) yield break;
            var tplId = _pendingSendTpl.id;
            _pendingSendTpl = null;
            yield return StartCoroutine(SendTemplateToTower(tplId));
        }

        // -------- Templates --------

        private IEnumerator FetchTemplates()
        {
            if (!CanReachApi()) yield break;
            var url = TowerModSettings.ApiBaseUrl + "/checklist/templates";
            if (!string.IsNullOrEmpty(_craftName))
            {
                url += "?craft=" + UnityWebRequest.EscapeURL(_craftName);
            }
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                if (req.isNetworkError || req.isHttpError)
                {
                    SetStatus("Templates fetch failed (" + req.responseCode + ").", true);
                    yield break;
                }
                var text = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                TemplatesResponse parsed = null;
                try { parsed = JsonUtility.FromJson<TemplatesResponse>(text); }
                catch (Exception ex) { Debug.LogWarning("[KSCTowerNetwork] Templates parse failed: " + ex.Message); }
                if (parsed != null && parsed.templates != null) _templates = parsed.templates;
                else _templates = new TemplateDto[0];
                _templatesFetched = true;
            }
        }

        private IEnumerator SaveCurrentAsTemplate(string name, string scope, string craft, bool isDefault)
        {
            var url = TowerModSettings.ApiBaseUrl + "/checklist/templates";
            var envelope = new PhasesEnvelope { phases = _phases ?? new PhaseDto[0] };
            var phasesJson = ExtractPhasesArray(JsonUtility.ToJson(envelope));
            var body = "{\"name\":\"" + JsonEscape(name) + "\"," +
                       "\"scope\":\"" + scope + "\"," +
                       (scope == "craft" ? "\"craftName\":\"" + JsonEscape(craft) + "\"," : string.Empty) +
                       "\"isDefault\":" + (isDefault ? "true" : "false") + "," +
                       "\"phases\":" + phasesJson + "}";
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                if (req.isNetworkError || req.isHttpError)
                {
                    var bodyText = req.downloadHandler != null ? req.downloadHandler.text : string.Empty;
                    SetStatus("Save failed (" + req.responseCode + "): " + (ExtractError(bodyText) ?? req.error), true);
                    yield break;
                }
                SetStatus("Template saved.", false);
                yield return StartCoroutine(FetchTemplates());
            }
        }

        private IEnumerator DeleteTemplate(string templateId)
        {
            var url = TowerModSettings.ApiBaseUrl + "/checklist/templates/" + UnityWebRequest.EscapeURL(templateId);
            using (var req = new UnityWebRequest(url, "DELETE"))
            {
                req.downloadHandler = new DownloadHandlerBuffer();
                req.timeout = RequestTimeoutSeconds;
                TowerApiAuth.ApplyBearer(req);
                yield return req.SendWebRequest();
                if (req.isNetworkError || req.isHttpError)
                {
                    SetStatus("Delete failed (" + req.responseCode + ").", true);
                    yield break;
                }
                SetStatus("Template deleted.", false);
                yield return StartCoroutine(FetchTemplates());
            }
        }

        // -------- IMGUI --------

        private void OnGUI()
        {
            if (!_visible) return;
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

            if (TowerSkin.DrawTitleBar("CHECKLISTS  \u00B7  TOWER", true))
            {
                Visible = false;
                if (OnRequestMinimize != null) OnRequestMinimize();
            }

            DrawHeader();
            DrawSendBanner();
            DrawTabs();

            // 2-step send confirm takes over the body when armed; the rest of the panel
            // stays visible underneath but inert so the operator's eye is on the diff.
            if (_pendingSendTpl != null)
            {
                DrawSendConfirm();
            }
            else
            {
                switch (_tab)
                {
                    case Tab.View:
                        DrawChecklistGrid(false);
                        break;
                    case Tab.Edit:
                        DrawPhaseManager();
                        DrawChecklistGrid(true);
                        break;
                    case Tab.Templates:
                        DrawTemplatesTab();
                        break;
                }
            }

            DrawStatus();

            GUILayout.EndVertical();

            GUI.DragWindow(new Rect(0f, 0f, PanelWidth - 32f, 28f));
            TowerImguiClickSink.UseUnhandledMouseInLocalWindow(new Rect(0f, 0f, PanelWidth, PanelHeight));
        }

        private void DrawHeader()
        {
            GUILayout.BeginHorizontal();
            string sessionId;
            CanTalkToBackend(out sessionId);
            var srcLabel = string.Equals(_source, "session", StringComparison.Ordinal) ? "Custom" : "Default";
            var craftSuffix = string.IsNullOrEmpty(_craftName) ? string.Empty : " · " + _craftName;
            // Mode pill ("plane" / "rocket" / "rover") so the player can see at a glance which
            // card stack they're looking at — useful when the local fallback was swapped after
            // a vessel switch but no controller-side custom is in play yet.
            var modeLabel = TowerCraftMode.Current.ToString().ToUpperInvariant();
            GUILayout.Label(
                "Session: " + (string.IsNullOrEmpty(sessionId) ? "—" : sessionId) +
                "  ·  " + srcLabel + craftSuffix + "  ·  MODE " + modeLabel,
                TowerSkin.Subtitle);
            GUILayout.FlexibleSpace();
            GUI.enabled = !_fetchBusy;
            if (GUILayout.Button("Refresh", TowerSkin.Button, GUILayout.Width(80f), GUILayout.Height(22f)))
            {
                StartCoroutine(FetchChecklist(true));
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();
        }

        private void DrawSendBanner()
        {
            if (_latestSend == null || string.IsNullOrEmpty(_latestSend.id)) return;
            var pending = string.IsNullOrEmpty(_latestSend.ackUserId);
            GUILayout.BeginHorizontal(TowerSkin.Inset);
            var label = pending
                ? "Sent to tower: \"" + (_latestSend.templateName ?? "?") + "\" - awaiting ack"
                : "Sent to tower: \"" + (_latestSend.templateName ?? "?") + "\" - acked";
            GUILayout.Label(label, pending ? TowerSkin.StatusError : TowerSkin.Status);
            GUILayout.FlexibleSpace();
            if (pending)
            {
                GUI.enabled = !_mutateBusy;
                if (GUILayout.Button("Ack", TowerSkin.Button, GUILayout.Width(70f), GUILayout.Height(22f)))
                {
                    StartCoroutine(AckLatestSend());
                }
                GUI.enabled = true;
            }
            GUILayout.EndHorizontal();
        }

        private void DrawSendConfirm()
        {
            GUILayout.BeginVertical(TowerSkin.Inset);
            GUILayout.Label("CONFIRM SEND TO TOWER", TowerSkin.Title);
            GUILayout.Label("Template: " + (_pendingSendTpl.name ?? "?"), TowerSkin.Body);
            if (_pendingDiff.IsEmpty)
            {
                GUILayout.Label("No changes vs current session checklist.", TowerSkin.BodyMuted);
            }
            else
            {
                GUILayout.Label("Changes: " + _pendingDiff.OneLine, TowerSkin.Body);
                GUILayout.Label(
                    "Phases: +" + _pendingDiff.PhasesAdded + " added, -" + _pendingDiff.PhasesRemoved + " removed, ~" + _pendingDiff.PhasesRenamed + " renamed",
                    TowerSkin.BodyMuted);
                GUILayout.Label(
                    "Items: +" + _pendingDiff.ItemsAdded + " added, -" + _pendingDiff.ItemsRemoved + " removed, ~" + _pendingDiff.ItemsRenamed + " renamed",
                    TowerSkin.BodyMuted);
            }
            GUILayout.Space(6f);
            GUILayout.BeginHorizontal();
            GUI.enabled = !_mutateBusy;
            if (GUILayout.Button("Confirm send", TowerSkin.ButtonActive, GUILayout.Width(140f), GUILayout.Height(26f)))
            {
                StartCoroutine(ConfirmSendPending());
            }
            if (GUILayout.Button("Cancel", TowerSkin.Button, GUILayout.Width(90f), GUILayout.Height(26f)))
            {
                _pendingSendTpl = null;
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();
            GUILayout.EndVertical();
        }

        private void DrawPhaseManager()
        {
            GUILayout.BeginVertical(TowerSkin.Inset);
            GUILayout.Label("PHASES", TowerSkin.Subtitle);
            for (var i = 0; i < _phases.Length; i++)
            {
                var ph = _phases[i];
                if (ph == null || string.IsNullOrEmpty(ph.id)) continue;
                GUILayout.BeginHorizontal();
                string draft;
                if (!_phaseRenameDrafts.TryGetValue(ph.id, out draft)) draft = ph.title ?? string.Empty;
                var next = GUILayout.TextField(draft, TowerSkin.TextField, GUILayout.MinWidth(180f));
                if (next != draft) _phaseRenameDrafts[ph.id] = next;
                GUI.enabled = !_mutateBusy && !string.Equals(next, ph.title ?? string.Empty, StringComparison.Ordinal) && !string.IsNullOrEmpty(next.Trim());
                if (GUILayout.Button("Save", TowerSkin.Button, GUILayout.Width(54f)))
                {
                    StartCoroutine(RenamePhase(ph.id, next.Trim()));
                    _phaseRenameDrafts.Remove(ph.id);
                }
                GUI.enabled = !_mutateBusy && i > 0;
                if (GUILayout.Button("\u2191", TowerSkin.IconButton, GUILayout.Width(28f)))
                {
                    StartCoroutine(MovePhase(ph.id, -1));
                }
                GUI.enabled = !_mutateBusy && i < _phases.Length - 1;
                if (GUILayout.Button("\u2193", TowerSkin.IconButton, GUILayout.Width(28f)))
                {
                    StartCoroutine(MovePhase(ph.id, +1));
                }
                GUI.enabled = !_mutateBusy;
                if (GUILayout.Button("\u00D7", TowerSkin.IconButton, GUILayout.Width(28f)))
                {
                    StartCoroutine(RemovePhase(ph.id));
                }
                GUI.enabled = true;
                GUILayout.EndHorizontal();
            }
            GUILayout.BeginHorizontal();
            GUILayout.Label("+", TowerSkin.Subtitle, GUILayout.Width(14f));
            _newPhaseTitle = GUILayout.TextField(_newPhaseTitle ?? string.Empty, TowerSkin.TextField, GUILayout.MinWidth(180f));
            GUI.enabled = !_mutateBusy && !string.IsNullOrEmpty((_newPhaseTitle ?? string.Empty).Trim());
            if (GUILayout.Button("Add phase", TowerSkin.Button, GUILayout.Width(110f)))
            {
                StartCoroutine(AddPhase(_newPhaseTitle.Trim()));
                _newPhaseTitle = string.Empty;
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();
            GUILayout.EndVertical();
            GUILayout.Space(4f);
        }

        private void DrawTabs()
        {
            GUILayout.BeginHorizontal();
            DrawTabButton("View", Tab.View);
            DrawTabButton("Edit", Tab.Edit);
            DrawTabButton("Templates", Tab.Templates);
            GUILayout.FlexibleSpace();
            GUILayout.EndHorizontal();
            GUILayout.Space(4f);
        }

        private void DrawTabButton(string label, Tab tab)
        {
            var active = _tab == tab;
            if (GUILayout.Button(label, active ? TowerSkin.ButtonActive : TowerSkin.Button, GUILayout.Width(90f), GUILayout.Height(24f)))
            {
                _tab = tab;
                if (tab == Tab.Templates && !_templatesFetched && !_fetchBusy)
                {
                    StartCoroutine(FetchTemplates());
                }
            }
        }

        private void DrawChecklistGrid(bool editing)
        {
            GUILayout.BeginVertical(TowerSkin.Inset);
            _scroll = GUILayout.BeginScrollView(_scroll, GUILayout.Height(PanelHeight - 200f));
            GUILayout.BeginHorizontal();
            DrawSideColumn("PILOT", "pilot", _doneP, editing);
            GUILayout.Space(8f);
            DrawSideColumn("CONTROLLER", "controller", _doneC, editing);
            GUILayout.EndHorizontal();
            GUILayout.EndScrollView();
            GUILayout.EndVertical();

            if (editing)
            {
                GUILayout.Space(4f);
                GUILayout.BeginHorizontal();
                GUI.enabled = !_mutateBusy && string.Equals(_source, "session", StringComparison.Ordinal);
                if (GUILayout.Button("Reset session to defaults", TowerSkin.Button, GUILayout.Width(220f), GUILayout.Height(24f)))
                {
                    StartCoroutine(ResetToDefaults());
                }
                GUI.enabled = true;
                GUILayout.EndHorizontal();
            }
        }

        private void DrawSideColumn(string title, string side, HashSet<string> done, bool editing)
        {
            GUILayout.BeginVertical(GUILayout.Width((PanelWidth - 48f) / 2f));
            GUILayout.Label(title, TowerSkin.Title);
            for (var pi = 0; pi < _phases.Length; pi++)
            {
                var phase = _phases[pi];
                if (phase == null) continue;
                GUILayout.Label("  " + (phase.title ?? "Phase " + (pi + 1)), TowerSkin.Subtitle);
                var items = side == "pilot" ? phase.pilot : phase.controller;
                if (items != null)
                {
                    for (var ii = 0; ii < items.Length; ii++)
                    {
                        var it = items[ii];
                        if (it == null || string.IsNullOrEmpty(it.id)) continue;
                        DrawItemRow(side, phase.id, it, done.Contains(it.id), editing);
                    }
                }
                if (editing)
                {
                    DrawAddItemRow(phase.id, side);
                }
                GUILayout.Space(6f);
            }
            GUILayout.EndVertical();
        }

        private void DrawItemRow(string side, string phaseId, ItemDto it, bool isDone, bool editing)
        {
            GUILayout.BeginHorizontal();
            if (editing)
            {
                var key = side + ":" + it.id;
                string draft;
                if (!_renameDrafts.TryGetValue(key, out draft)) draft = it.label ?? string.Empty;
                var next = GUILayout.TextField(draft, TowerSkin.TextField, GUILayout.MinWidth(120f));
                if (next != draft) _renameDrafts[key] = next;
                GUI.enabled = !_mutateBusy && !string.Equals(next, it.label ?? string.Empty, StringComparison.Ordinal) && !string.IsNullOrEmpty(next.Trim());
                if (GUILayout.Button("Save", TowerSkin.Button, GUILayout.Width(54f)))
                {
                    StartCoroutine(RenameItem(it.id, next.Trim()));
                    _renameDrafts.Remove(key);
                }
                GUI.enabled = !_mutateBusy;
                if (GUILayout.Button("\u00D7", TowerSkin.IconButton, GUILayout.Width(28f)))
                {
                    StartCoroutine(RemoveItem(it.id));
                }
                GUI.enabled = true;
            }
            else
            {
                // Toggle button looks like [v] or [ ] then label. The backend's permission
                // gate refuses cross-side toggles for non-mods, so a tap might no-op silently
                // — that's fine; the status line surfaces any 403s.
                var canTick = CanLocallyToggle(side);
                GUI.enabled = !_mutateBusy && canTick;
                var box = isDone ? "\u2713" : "\u00B7";
                if (GUILayout.Button(box, isDone ? TowerSkin.ButtonActive : TowerSkin.IconButton, GUILayout.Width(28f), GUILayout.Height(22f)))
                {
                    StartCoroutine(ToggleItem(side, it.id));
                }
                GUI.enabled = true;
                var label = (isDone ? "<i>" : string.Empty) + (it.label ?? string.Empty) + (isDone ? "</i>" : string.Empty);
                GUILayout.Label(label, TowerSkin.Body);
                if (it.autoRule != null && !string.IsNullOrEmpty(it.autoRule.kind))
                {
                    GUILayout.Label("[auto]", TowerSkin.BodyMuted, GUILayout.Width(48f));
                }
            }
            GUILayout.EndHorizontal();
        }

        private void DrawAddItemRow(string phaseId, string side)
        {
            var key = "add:" + phaseId + ":" + side;
            string draft;
            if (!_addDrafts.TryGetValue(key, out draft)) draft = string.Empty;
            GUILayout.BeginHorizontal();
            GUILayout.Label("+", TowerSkin.Subtitle, GUILayout.Width(14f));
            var next = GUILayout.TextField(draft, TowerSkin.TextField, GUILayout.MinWidth(120f));
            if (next != draft) _addDrafts[key] = next;
            GUI.enabled = !_mutateBusy && !string.IsNullOrEmpty(next.Trim());
            if (GUILayout.Button("Add", TowerSkin.Button, GUILayout.Width(50f)))
            {
                StartCoroutine(AddItem(phaseId, side, next.Trim()));
                _addDrafts.Remove(key);
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();
        }

        /// <summary>
        /// Local hint for the toggle button enable-state. Mirrors the backend rule:
        /// pilot side ticks if local user identity matches pilotUserId; controller side
        /// ticks if matches assignedTowerUserId; mods can tick either. We don't know the
        /// local userId from the plugin, so we always allow the click and let the
        /// backend's 403 surface in the status line if the user isn't authorized.
        /// </summary>
        private static bool CanLocallyToggle(string side)
        {
            return true;
        }

        private void DrawTemplatesTab()
        {
            // Save current as form
            GUILayout.BeginVertical(TowerSkin.Inset);
            GUILayout.Label("SAVE CURRENT CHECKLIST AS A TEMPLATE", TowerSkin.Subtitle);
            GUILayout.BeginHorizontal();
            GUILayout.Label("Name", TowerSkin.Body, GUILayout.Width(50f));
            _saveName = GUILayout.TextField(_saveName ?? string.Empty, TowerSkin.TextField, GUILayout.MinWidth(160f));
            GUILayout.Label("Scope", TowerSkin.Body, GUILayout.Width(50f));
            // 'global' templates are mod-only on the backend - non-mods get a 403 surfaced
            // in the status line. We expose the option here regardless so a mod player can
            // curate fleet-wide templates from inside the cockpit.
            var scopes = new[] { "user", "craft", "global" };
            _saveScopeIdx = GUILayout.SelectionGrid(_saveScopeIdx, new[] { "User", "Craft", "Global" }, 3, TowerSkin.Button, GUILayout.Width(240f));
            GUILayout.EndHorizontal();
            if (_saveScopeIdx == 1)
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label("Craft", TowerSkin.Body, GUILayout.Width(50f));
                if (string.IsNullOrEmpty(_saveCraft) && !string.IsNullOrEmpty(_craftName)) _saveCraft = _craftName;
                _saveCraft = GUILayout.TextField(_saveCraft ?? string.Empty, TowerSkin.TextField, GUILayout.MinWidth(160f));
                GUILayout.EndHorizontal();
            }
            GUILayout.BeginHorizontal();
            _saveDefault = GUILayout.Toggle(_saveDefault, " Default for this scope", TowerSkin.Toggle);
            GUILayout.FlexibleSpace();
            GUI.enabled = !_mutateBusy && !string.IsNullOrEmpty((_saveName ?? string.Empty).Trim()) && (_saveScopeIdx != 1 || !string.IsNullOrEmpty((_saveCraft ?? string.Empty).Trim()));
            if (GUILayout.Button("Save", TowerSkin.Button, GUILayout.Width(80f), GUILayout.Height(24f)))
            {
                StartCoroutine(SaveCurrentAsTemplate(_saveName.Trim(), scopes[_saveScopeIdx], (_saveCraft ?? string.Empty).Trim(), _saveDefault));
                _saveName = string.Empty;
                _saveDefault = false;
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();
            GUILayout.EndVertical();

            GUILayout.Space(4f);
            GUILayout.BeginHorizontal();
            GUILayout.Label("MY TEMPLATES" + (string.IsNullOrEmpty(_craftName) ? string.Empty : "  ·  for \"" + _craftName + "\""), TowerSkin.Subtitle);
            GUILayout.FlexibleSpace();
            if (GUILayout.Button("Reload", TowerSkin.Button, GUILayout.Width(80f), GUILayout.Height(22f))) StartCoroutine(FetchTemplates());
            GUILayout.EndHorizontal();

            GUILayout.BeginVertical(TowerSkin.Inset);
            _scroll = GUILayout.BeginScrollView(_scroll, GUILayout.Height(PanelHeight - 320f));
            if (_templates == null || _templates.Length == 0)
            {
                GUILayout.Label(_templatesFetched ? "No templates saved yet." : "Loading templates…", TowerSkin.BodyMuted);
            }
            else
            {
                for (var i = 0; i < _templates.Length; i++)
                {
                    var tpl = _templates[i];
                    if (tpl == null) continue;
                    DrawTemplateRow(tpl);
                }
            }
            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        private void DrawTemplateRow(TemplateDto tpl)
        {
            GUILayout.BeginVertical(TowerSkin.Inset);
            string scopeTag;
            if (string.Equals(tpl.scope, "craft", StringComparison.Ordinal))
                scopeTag = "[craft: " + (tpl.craftName ?? "?") + "]";
            else if (string.Equals(tpl.scope, "global", StringComparison.Ordinal))
                scopeTag = "[global]";
            else
                scopeTag = "[personal]";
            var defTag = tpl.isDefault ? " [default]" : string.Empty;
            var phaseCount = tpl.phases != null ? tpl.phases.Length : 0;
            GUILayout.Label(tpl.name + "  " + scopeTag + defTag + "  \u00B7  " + phaseCount + " phases", TowerSkin.Body);
            GUILayout.BeginHorizontal();
            GUI.enabled = !_mutateBusy;
            if (GUILayout.Button("Load", TowerSkin.Button, GUILayout.Width(70f))) StartCoroutine(LoadTemplateInline(tpl));
            // 2-step send: opens the diff confirm panel rather than firing immediately.
            if (GUILayout.Button("Send to tower", TowerSkin.Button, GUILayout.Width(130f))) RequestSendPreview(tpl);
            if (GUILayout.Button("Delete", TowerSkin.Button, GUILayout.Width(70f))) StartCoroutine(DeleteTemplate(tpl.id));
            GUI.enabled = true;
            GUILayout.EndHorizontal();
            GUILayout.EndVertical();
        }

        private void DrawStatus()
        {
            GUILayout.Space(4f);
            GUILayout.Label(_statusLine ?? string.Empty, _statusIsError ? TowerSkin.StatusError : TowerSkin.Status);
        }

        private void SetStatus(string text, bool isError)
        {
            _statusLine = text ?? string.Empty;
            _statusIsError = isError;
        }

        private static string ExtractError(string json)
        {
            if (string.IsNullOrEmpty(json)) return string.Empty;
            var m = Regex.Match(json, "\"error\"\\s*:\\s*\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : string.Empty;
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
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
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
