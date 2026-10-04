import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApiBase } from "../api/client";
import type { AuthUser } from "../auth/session";
import { queryKeys } from "../query/client";
import { ApiError, apiCall, useApiQuery, useQueryClient } from "../query/hooks";
import {
  CHECKLIST_PHASES,
  diffChecklistPhases,
  isEmptyDiff,
  type ChecklistAutoRule,
  type ChecklistDiff,
  type ChecklistPhase,
  type ChecklistSide
} from "./checklists";

export type ChecklistDoneEntry = { doneAt: string; byUserId: string };

export type ChecklistState = {
  pilot: Record<string, ChecklistDoneEntry>;
  controller: Record<string, ChecklistDoneEntry>;
};

export type ChecklistTemplateScope = "user" | "craft" | "global";

export type ChecklistTemplate = {
  id: string;
  ownerUserId: string;
  scope: ChecklistTemplateScope;
  craftName?: string;
  name: string;
  isDefault: boolean;
  phases: ChecklistPhase[];
  createdAt: string;
  updatedAt: string;
};

export type ChecklistSendRecord = {
  id: string;
  sessionId: string;
  messageId: string;
  templateId?: string;
  templateName: string;
  sentByUserId: string;
  createdAt: string;
  ackUserId?: string;
  ackAt?: string;
};

type ChecklistResponse = {
  ok: boolean;
  phases: ChecklistPhase[];
  source: "session" | "default";
  state: ChecklistState;
  defaults: ChecklistPhase[];
  pilotUserId?: string;
  assignedTowerUserId?: string;
  craftName?: string;
  latestSend?: ChecklistSendRecord | null;
};

type MutationResponse = {
  ok: boolean;
  phases: ChecklistPhase[];
  source: "session" | "default";
  state: ChecklistState;
  latestSend?: ChecklistSendRecord | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  user: AuthUser;
  /** Pilot user id of the session — used to decide which side this user can tick. */
  pilotUserId?: string;
  /** Controller user id assigned to the session — used to decide which side this user can tick. */
  assignedTowerUserId?: string;
  /** Optional craft name from telemetry; surfaces in template scope selector. */
  craftName?: string;
  /** Initial state from the parent's session payload — used to render before the first fetch settles. */
  initialState?: ChecklistState;
  /** Initial phases override from the parent's session payload (null/undefined falls back to hardcoded). */
  initialPhases?: ChecklistPhase[];
  /** Called whenever the underlying state or phases changed so the parent can refresh its session. */
  onChanged?: () => void;
};

type Mode = "view" | "edit" | "templates";

/**
 * Modal-style overlay for the bidirectional pilot/controller checklist.
 *
 * Three modes:
 *   - view (default): phases grouped, each side ticks its own column (mods can tick both).
 *   - edit: same grid but each row gains a rename input + delete button, with an "Add item"
 *     row at the bottom of each phase column. Edits write through to the session via
 *     POST/PATCH/DELETE /v1/session/:id/checklist/items so both web AND in-game see them.
 *   - templates: list user's saved templates (per-user + per-craft), load/delete/send-to-tower,
 *     plus a "Save current as…" form. "Send to tower" applies the template to the live session
 *     AND posts an ACARS announcement so the controller sees the swap in chat.
 */
export function ChecklistModal({
  open,
  onClose,
  sessionId,
  user,
  pilotUserId,
  assignedTowerUserId,
  craftName,
  initialState,
  initialPhases,
  onChanged
}: Props): JSX.Element | null {
  const [mode, setMode] = useState<Mode>("view");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // 2-step send-to-tower confirm: holds the template the user clicked Send on so we can
  // render a diff preview before actually firing the POST.
  const [pendingSend, setPendingSend] = useState<ChecklistTemplate | null>(null);

  const isPilot = pilotUserId === user.id;
  const isController = assignedTowerUserId === user.id;
  const isMod = user.isMod || user.isOwner;
  const canEditSession = isPilot || isController || isMod;
  const canToggle = useCallback(
    (side: ChecklistSide): boolean =>
      isMod || (side === "pilot" && isPilot) || (side === "controller" && isController),
    [isMod, isPilot, isController]
  );

  const qc = useQueryClient();

  // Authoritative checklist payload — TanStack-driven. SSE events below
  // simply invalidate this key, so the same code path handles "we just
  // mutated", "the server pushed an SSE event", and "we fell back to a
  // 6s poll because SSE is broken".
  const checklistQuery = useApiQuery<ChecklistResponse>({
    queryKey: queryKeys.session.checklist(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}/checklist`,
    enabled: open,
    placeholderData: (prev) => prev,
    staleTime: 1_000
  });
  const phases =
    checklistQuery.data?.phases ?? (initialPhases && initialPhases.length > 0 ? initialPhases : CHECKLIST_PHASES);
  const state = checklistQuery.data?.state ?? initialState ?? { pilot: {}, controller: {} };
  const source: "session" | "default" =
    checklistQuery.data?.source ?? (initialPhases && initialPhases.length > 0 ? "session" : "default");
  const latestSend = checklistQuery.data?.latestSend ?? null;

  const loadFromServer = useCallback(async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: queryKeys.session.checklist(sessionId) });
  }, [qc, sessionId]);

  // Templates list — keyed by craftName so swapping craft refetches the
  // craft-specific bucket. Only fired when the templates tab is open.
  const templatesQuery = useApiQuery<{ ok: boolean; templates: ChecklistTemplate[] }>({
    queryKey: [...queryKeys.session.all, "checklist-templates", craftName ?? null] as const,
    path: craftName
      ? `/v1/checklist/templates?craft=${encodeURIComponent(craftName)}`
      : `/v1/checklist/templates`,
    enabled: open && mode === "templates",
    placeholderData: (prev) => prev,
    staleTime: 5_000
  });
  const templates = templatesQuery.data?.templates ?? [];
  const refreshTemplates = useCallback(async (): Promise<void> => {
    await qc.invalidateQueries({
      queryKey: [...queryKeys.session.all, "checklist-templates"] as const
    });
  }, [qc]);

  // Surface the most recent query/mutation error in the same banner the
  // mutation handlers write to, so a 401 from the GET shows up like
  // anything else.
  useEffect(() => {
    if (checklistQuery.error) {
      setError(checklistQuery.error.unreachable ? "API unreachable" : checklistQuery.error.message);
    }
  }, [checklistQuery.error]);
  useEffect(() => {
    if (templatesQuery.error) {
      setError(templatesQuery.error.unreachable ? "API unreachable" : templatesQuery.error.message);
    }
  }, [templatesQuery.error]);

  // Local mutation runner. We don't lean on useApiMutation per-action
  // because each handler has subtly different busyId keying / optimistic
  // state / per-call success messages. Routing all of them through one
  // helper keeps the error pipeline (ApiError) and cache-invalidation
  // shape consistent without 12 near-identical hook declarations.
  const runMutation = useCallback(
    async <T,>(busyKey: string, fn: () => Promise<T>, applyResult?: (data: T) => void): Promise<T | null> => {
      setBusyId(busyKey);
      setError(null);
      try {
        const data = await fn();
        applyResult?.(data);
        return data;
      } catch (e) {
        const msg = e instanceof ApiError ? (e.unreachable ? "API unreachable" : e.message) : (e as Error).message;
        setError(msg);
        return null;
      } finally {
        setBusyId(null);
      }
    },
    []
  );

  // Live updates via SSE — pushed by the backend on every checklist mutation, including
  // toggles from the in-game plugin and telemetry-driven auto-ticks. Falls back to a 6s
  // poll if EventSource refuses to open (token missing, proxy blocking, etc.) so a stale
  // browser still self-heals. The 6s cadence is conservatively slower than the previous
  // 4s poll because SSE is the primary path now.
  const sseFallbackTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let es: EventSource | null = null;
    function startFallbackPoll(): void {
      if (sseFallbackTimer.current != null) return;
      sseFallbackTimer.current = window.setInterval(() => {
        if (!cancelled) void loadFromServer();
      }, 6000);
    }
    function stopFallbackPoll(): void {
      if (sseFallbackTimer.current != null) {
        window.clearInterval(sseFallbackTimer.current);
        sseFallbackTimer.current = null;
      }
    }
    try {
      // EventSource cannot send Authorization headers. Use the HttpOnly web session
      // cookie via withCredentials; do not put bearer credentials in the URL.
      const base = getApiBase();
      const path = `/v1/session/${encodeURIComponent(sessionId)}/checklist/stream`;
      const url = base ? `${base}${path}` : path;
      es = new EventSource(url, { withCredentials: true });
      es.onopen = () => {
        stopFallbackPoll();
      };
      es.addEventListener("state", () => {
        if (!cancelled) void loadFromServer();
      });
      es.addEventListener("send", () => {
        if (!cancelled) void loadFromServer();
      });
      es.addEventListener("ack", () => {
        if (!cancelled) void loadFromServer();
      });
      es.addEventListener("auto", () => {
        if (!cancelled) void loadFromServer();
      });
      es.onerror = () => {
        // Don't tear down the EventSource here — it will auto-reconnect. Just spin up a
        // poll so the UI keeps refreshing even if SSE is down.
        startFallbackPoll();
      };
    } catch {
      startFallbackPoll();
    }
    return () => {
      cancelled = true;
      try {
        es?.close();
      } catch {
        /* already closed */
      }
      stopFallbackPoll();
    };
  }, [open, sessionId, loadFromServer]);

  // Push the latest mutation response into the TanStack cache so the UI
  // shows the new state immediately without waiting for a refetch. We
  // synthesize the full ChecklistResponse shape because the server only
  // returns the mutated subset.
  const applyServerResponse = useCallback(
    (data: MutationResponse): void => {
      qc.setQueryData<ChecklistResponse>(queryKeys.session.checklist(sessionId), (prev) => ({
        ok: true,
        phases: data.phases,
        state: data.state,
        source: data.source,
        defaults: prev?.defaults ?? CHECKLIST_PHASES,
        pilotUserId: prev?.pilotUserId,
        assignedTowerUserId: prev?.assignedTowerUserId,
        craftName: prev?.craftName,
        latestSend: data.latestSend !== undefined ? data.latestSend : prev?.latestSend ?? null
      }));
      onChanged?.();
    },
    [qc, sessionId, onChanged]
  );

  async function toggle(side: ChecklistSide, itemId: string): Promise<void> {
    if (!canToggle(side)) return;
    const key = `${side}:${itemId}`;
    // Optimistic flip via the TanStack cache: mirror what the server will
    // do, render instantly. On 4xx/network failure we roll back by writing
    // the snapshot back into the cache so a 403 never leaves a phantom
    // checkmark on screen.
    const snapshot = qc.getQueryData<ChecklistResponse>(queryKeys.session.checklist(sessionId));
    const baseState = snapshot?.state ?? state;
    const optimistic: ChecklistState = {
      pilot: { ...baseState.pilot },
      controller: { ...baseState.controller }
    };
    const sideMap = { ...optimistic[side] };
    if (sideMap[itemId]) delete sideMap[itemId];
    else sideMap[itemId] = { doneAt: new Date().toISOString(), byUserId: user.id };
    optimistic[side] = sideMap;
    if (snapshot) {
      qc.setQueryData<ChecklistResponse>(queryKeys.session.checklist(sessionId), {
        ...snapshot,
        state: optimistic
      });
    }
    const ok = await runMutation(
      key,
      () =>
        apiCall<{ ok: boolean; checklistState: ChecklistState }>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/toggle`,
          { method: "POST", body: JSON.stringify({ side, itemId }) }
        ),
      (data) => {
        if (snapshot) {
          qc.setQueryData<ChecklistResponse>(queryKeys.session.checklist(sessionId), {
            ...snapshot,
            state: data.checklistState
          });
        }
        onChanged?.();
      }
    );
    if (ok == null && snapshot) {
      qc.setQueryData<ChecklistResponse>(queryKeys.session.checklist(sessionId), snapshot);
    }
  }

  async function addItem(phaseId: string, side: ChecklistSide, label: string): Promise<void> {
    if (!canEditSession) return;
    const cleaned = label.trim();
    if (!cleaned) return;
    await runMutation(
      `add:${phaseId}:${side}`,
      () =>
        apiCall<MutationResponse & { itemId: string }>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/items`,
          { method: "POST", body: JSON.stringify({ phaseId, side, label: cleaned }) }
        ),
      applyServerResponse
    );
  }

  async function renameItem(itemId: string, label: string, autoRule?: ChecklistAutoRule | null): Promise<void> {
    if (!canEditSession) return;
    const cleaned = label.trim();
    if (!cleaned) return;
    const body: Record<string, unknown> = { label: cleaned };
    if (autoRule !== undefined) body.autoRule = autoRule;
    await runMutation(
      `rename:${itemId}`,
      () =>
        apiCall<MutationResponse>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/items/${encodeURIComponent(itemId)}`,
          { method: "PATCH", body: JSON.stringify(body) }
        ),
      applyServerResponse
    );
  }

  async function removeItem(itemId: string): Promise<void> {
    if (!canEditSession) return;
    if (!window.confirm("Remove this checklist item from the session?")) return;
    await runMutation(
      `remove:${itemId}`,
      () =>
        apiCall<MutationResponse>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/items/${encodeURIComponent(itemId)}`,
          { method: "DELETE" }
        ),
      applyServerResponse
    );
  }

  async function addPhase(): Promise<void> {
    if (!canEditSession) return;
    const title = window.prompt("New phase title?", "");
    if (!title || !title.trim()) return;
    await runMutation(
      "phase-add",
      () =>
        apiCall<MutationResponse & { phaseId: string }>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/phases`,
          { method: "POST", body: JSON.stringify({ title: title.trim() }) }
        ),
      applyServerResponse
    );
  }

  async function renamePhase(phaseId: string, currentTitle: string): Promise<void> {
    if (!canEditSession) return;
    const title = window.prompt("Rename phase to:", currentTitle);
    if (title == null) return;
    const cleaned = title.trim();
    if (!cleaned || cleaned === currentTitle) return;
    await runMutation(
      `phase-rn:${phaseId}`,
      () =>
        apiCall<MutationResponse>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/phases/${encodeURIComponent(phaseId)}`,
          { method: "PATCH", body: JSON.stringify({ title: cleaned }) }
        ),
      applyServerResponse
    );
  }

  async function removePhase(phaseId: string, title: string): Promise<void> {
    if (!canEditSession) return;
    if (!window.confirm(`Remove phase "${title}" and all its items? This drops their tick state too.`)) return;
    await runMutation(
      `phase-rm:${phaseId}`,
      () =>
        apiCall<MutationResponse>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/phases/${encodeURIComponent(phaseId)}`,
          { method: "DELETE" }
        ),
      applyServerResponse
    );
  }

  async function movePhase(phaseId: string, direction: -1 | 1): Promise<void> {
    if (!canEditSession) return;
    const idx = phases.findIndex((p) => p.id === phaseId);
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= phases.length) return;
    const order = phases.map((p) => p.id);
    [order[idx], order[target]] = [order[target]!, order[idx]!];
    await runMutation(
      `phase-mv:${phaseId}`,
      () =>
        apiCall<MutationResponse>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/phases/order`,
          { method: "PUT", body: JSON.stringify({ order }) }
        ),
      applyServerResponse
    );
  }

  async function resetToDefaults(): Promise<void> {
    if (!canEditSession) return;
    if (!window.confirm("Reset this session's checklist to the built-in default? Tick state is kept.")) return;
    await runMutation(
      "reset",
      () =>
        apiCall<MutationResponse>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/phases`,
          { method: "DELETE" }
        ),
      applyServerResponse
    );
  }

  async function loadTemplate(tpl: ChecklistTemplate): Promise<void> {
    if (!canEditSession) return;
    const ok = await runMutation(
      `load:${tpl.id}`,
      () =>
        apiCall<MutationResponse>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/phases`,
          { method: "PUT", body: JSON.stringify({ phases: tpl.phases }) }
        ),
      applyServerResponse
    );
    if (ok) {
      setInfo(`Loaded template "${tpl.name}" into this session`);
      setMode("view");
    }
  }

  // Send-to-tower is a 2-step flow:
  //   1) the user clicks Send -> pendingSend is set, a confirm panel renders the diff vs the
  //      session's current effective phases.
  //   2) the user confirms the diff -> we POST /checklist/send.
  function requestSendToTower(tpl: ChecklistTemplate): void {
    if (!canEditSession) return;
    setPendingSend(tpl);
  }

  async function confirmSendToTower(): Promise<void> {
    const tpl = pendingSend;
    if (!tpl) return;
    const ok = await runMutation(
      `send:${tpl.id}`,
      () =>
        apiCall<MutationResponse & { sendId?: string }>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/send`,
          { method: "POST", body: JSON.stringify({ templateId: tpl.id }) }
        ),
      applyServerResponse
    );
    setPendingSend(null);
    if (ok) {
      setInfo(`Sent "${tpl.name}" to tower (announced in ACARS)`);
      setMode("view");
    }
  }

  async function ackLatestSend(): Promise<void> {
    if (!latestSend || latestSend.ackUserId) return;
    await runMutation(
      `ack:${latestSend.id}`,
      () =>
        apiCall<MutationResponse & { send: ChecklistSendRecord }>(
          `/v1/session/${encodeURIComponent(sessionId)}/checklist/ack`,
          { method: "POST", body: JSON.stringify({ sendId: latestSend.id }) }
        ),
      (data) => {
        applyServerResponse(data);
        // Server returns the freshly-acked record; merge it into the cached
        // checklist so the banner flips to "acknowledged" instantly.
        qc.setQueryData<ChecklistResponse>(queryKeys.session.checklist(sessionId), (prev) =>
          prev ? { ...prev, latestSend: data.send } : prev
        );
      }
    );
  }

  async function deleteTemplate(tpl: ChecklistTemplate): Promise<void> {
    if (!window.confirm(`Delete template "${tpl.name}"? This cannot be undone.`)) return;
    const ok = await runMutation(
      `del:${tpl.id}`,
      () =>
        apiCall<{ ok: boolean }>(`/v1/checklist/templates/${encodeURIComponent(tpl.id)}`, {
          method: "DELETE"
        })
    );
    if (ok) await refreshTemplates();
  }

  // "Save current as…" form state lives here so it survives template list refreshes.
  const [saveName, setSaveName] = useState("");
  const [saveScope, setSaveScope] = useState<ChecklistTemplateScope>("user");
  const [saveCraft, setSaveCraft] = useState(craftName ?? "");
  const [saveDefault, setSaveDefault] = useState(false);
  useEffect(() => {
    // Whenever craftName changes (telemetry started flowing), pre-fill the craft input
    // so a one-click "save for THIS craft" is just a name + Save.
    if (craftName) setSaveCraft(craftName);
  }, [craftName]);

  async function saveCurrentAsTemplate(): Promise<void> {
    const name = saveName.trim();
    if (!name) {
      setError("Template name is required");
      return;
    }
    if (saveScope === "craft" && !saveCraft.trim()) {
      setError("Craft name is required for a craft-scoped template");
      return;
    }
    const result = await runMutation(
      "save",
      () =>
        apiCall<{ ok: boolean; template: ChecklistTemplate }>(`/v1/checklist/templates`, {
          method: "POST",
          body: JSON.stringify({
            name,
            scope: saveScope,
            craftName: saveScope === "craft" ? saveCraft.trim() : undefined,
            isDefault: saveDefault,
            phases
          })
        })
    );
    if (result) {
      setInfo(`Saved template "${result.template.name}"`);
      setSaveName("");
      setSaveDefault(false);
      await refreshTemplates();
    }
  }

  // ChecklistColumn calls these via callbacks. Hoisted so the JSX below is shorter.
  const handlePhaseUp = useCallback((phaseId: string) => void movePhase(phaseId, -1), [phases, sessionId]);
  const handlePhaseDown = useCallback((phaseId: string) => void movePhase(phaseId, 1), [phases, sessionId]);

  const counts = useMemo(() => computeCounts(phases, state), [phases, state]);

  if (!open) return null;

  return (
    <div className="atc-checklist-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="atc-checklist-card" onClick={(e) => e.stopPropagation()}>
        <header className="atc-checklist-card-head">
          <div>
            <h2>Checklists</h2>
            <p className="room-meta">
              Pilot {counts.pilotDone}/{counts.pilotTotal} - Controller {counts.ctrlDone}/{counts.ctrlTotal}
              {source === "session" ? " - Custom for this session" : " - Default template"}
            </p>
          </div>
          <div className="row" style={{ gap: "0.4rem" }}>
            <button
              type="button"
              className={mode === "view" ? "is-active" : ""}
              onClick={() => setMode("view")}
            >
              View
            </button>
            <button
              type="button"
              className={mode === "edit" ? "is-active" : ""}
              onClick={() => setMode("edit")}
              disabled={!canEditSession}
              title={canEditSession ? "Add / rename / remove items in this session" : "Pilot or controller only"}
            >
              Edit
            </button>
            <button
              type="button"
              className={mode === "templates" ? "is-active" : ""}
              onClick={() => setMode("templates")}
            >
              Templates
            </button>
            <button type="button" onClick={onClose} aria-label="Close checklist">
              ✕
            </button>
          </div>
        </header>

        {error ? <pre className="msg error">{error}</pre> : null}
        {info ? <pre className="msg ok">{info}</pre> : null}

        {latestSend ? (
          <div className={"atc-checklist-send-banner" + (latestSend.ackUserId ? " acked" : " pending")}>
            <span>
              Last send: <strong>{latestSend.templateName}</strong>{" "}
              {latestSend.ackUserId
                ? `— acknowledged ${formatAckAt(latestSend.ackAt)}`
                : "— awaiting tower acknowledgement"}
            </span>
            {!latestSend.ackUserId && (isController || isMod) ? (
              <button
                type="button"
                onClick={() => void ackLatestSend()}
                disabled={busyId === `ack:${latestSend.id}`}
              >
                {busyId === `ack:${latestSend.id}` ? "Acking…" : "Ack"}
              </button>
            ) : null}
          </div>
        ) : null}

        {pendingSend ? (
          <SendToTowerConfirm
            template={pendingSend}
            currentPhases={phases}
            onCancel={() => setPendingSend(null)}
            onConfirm={() => void confirmSendToTower()}
            busy={busyId === `send:${pendingSend.id}`}
          />
        ) : null}

        {mode === "edit" && canEditSession ? (
          <PhaseManager
            phases={phases}
            busyId={busyId}
            onAdd={() => void addPhase()}
            onRename={(id, t) => void renamePhase(id, t)}
            onRemove={(id, t) => void removePhase(id, t)}
            onUp={handlePhaseUp}
            onDown={handlePhaseDown}
          />
        ) : null}

        {mode === "templates" ? (
          <section className="atc-checklist-templates">
            <div className="atc-checklist-template-save">
              <h4>Save current checklist as a template</h4>
              <div className="row" style={{ flexWrap: "wrap", gap: "0.4rem" }}>
                <input
                  type="text"
                  placeholder="Template name (e.g. KSC -> Mun)"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  style={{ flex: "1 1 200px" }}
                />
                <select
                  value={saveScope}
                  onChange={(e) => setSaveScope(e.target.value as ChecklistTemplateScope)}
                >
                  <option value="user">For me (any craft)</option>
                  <option value="craft">For a specific craft</option>
                  {isMod ? <option value="global">Global (mod-curated, all users)</option> : null}
                </select>
                {saveScope === "craft" ? (
                  <input
                    type="text"
                    placeholder="Craft name"
                    value={saveCraft}
                    onChange={(e) => setSaveCraft(e.target.value)}
                    style={{ flex: "1 1 160px" }}
                  />
                ) : null}
                <label className="room-meta" style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                  <input
                    type="checkbox"
                    checked={saveDefault}
                    onChange={(e) => setSaveDefault(e.target.checked)}
                  />
                  Default
                </label>
                <button
                  type="button"
                  onClick={() => void saveCurrentAsTemplate()}
                  disabled={busyId === "save"}
                >
                  {busyId === "save" ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            <h4>My templates {craftName ? `(+ for "${craftName}")` : ""}</h4>
            {templates.length === 0 ? (
              <p className="room-meta">No saved templates yet.</p>
            ) : (
              <ul className="atc-checklist-template-list">
                {templates.map((tpl) => {
                  const totalItems =
                    tpl.phases.reduce((acc, p) => acc + p.pilot.length + p.controller.length, 0);
                  return (
                    <li key={tpl.id} className="atc-checklist-template-row">
                      <div>
                        <strong>{tpl.name}</strong>
                        {tpl.isDefault ? <span className="atc-tag">default</span> : null}
                        <span className={`atc-tag atc-tag-scope atc-tag-${tpl.scope}`}>
                          {tpl.scope === "craft"
                            ? `craft: ${tpl.craftName}`
                            : tpl.scope === "global"
                            ? "global"
                            : "personal"}
                        </span>
                        <span className="room-meta">
                          {" "}{tpl.phases.length} phases - {totalItems} items
                        </span>
                      </div>
                      <div className="row" style={{ gap: "0.3rem" }}>
                        <button
                          type="button"
                          onClick={() => void loadTemplate(tpl)}
                          disabled={!canEditSession || busyId === `load:${tpl.id}`}
                        >
                          Load
                        </button>
                        <button
                          type="button"
                          onClick={() => requestSendToTower(tpl)}
                          disabled={!canEditSession || busyId === `send:${tpl.id}`}
                          title="Preview the diff vs the current session checklist, then send to tower"
                        >
                          Send to tower…
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteTemplate(tpl)}
                          disabled={
                            busyId === `del:${tpl.id}` ||
                            (tpl.scope === "global" && !isMod) ||
                            (tpl.scope !== "global" && tpl.ownerUserId !== user.id)
                          }
                          title={
                            tpl.scope === "global"
                              ? isMod
                                ? "Delete this global template"
                                : "Only mods can delete global templates"
                              : tpl.ownerUserId === user.id
                              ? "Delete your template"
                              : "Only the template owner can delete"
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {source === "session" ? (
              <div className="row" style={{ marginTop: "0.6rem" }}>
                <button
                  type="button"
                  onClick={() => void resetToDefaults()}
                  disabled={!canEditSession || busyId === "reset"}
                >
                  Reset session to default checklist
                </button>
              </div>
            ) : null}
          </section>
        ) : (
          <div className="atc-checklist-grid">
            {(["pilot", "controller"] as const).map((side) => (
              <ChecklistColumn
                key={side}
                side={side}
                phases={phases}
                state={state}
                canToggle={canToggle(side)}
                editing={mode === "edit"}
                canEdit={canEditSession}
                busyId={busyId}
                onToggle={(itemId) => void toggle(side, itemId)}
                onRename={(itemId, label) => void renameItem(itemId, label)}
                onRemove={(itemId) => void removeItem(itemId)}
                onAdd={(phaseId, label) => void addItem(phaseId, side, label)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChecklistColumn({
  side,
  phases,
  state,
  canToggle,
  editing,
  canEdit,
  busyId,
  onToggle,
  onRename,
  onRemove,
  onAdd
}: {
  side: ChecklistSide;
  phases: ChecklistPhase[];
  state: ChecklistState;
  canToggle: boolean;
  editing: boolean;
  canEdit: boolean;
  busyId: string | null;
  onToggle: (itemId: string) => void;
  onRename: (itemId: string, label: string) => void;
  onRemove: (itemId: string) => void;
  onAdd: (phaseId: string, label: string) => void;
}): JSX.Element {
  const sideState = state[side] ?? {};
  return (
    <div className="atc-checklist-col">
      <h4>{side === "pilot" ? "Pilot" : "Controller"}</h4>
      {phases.map((phase) => (
        <div key={`${side}-${phase.id}`} className="atc-checklist-phase">
          <div className="atc-checklist-phase-title">{phase.title}</div>
          {phase[side].map((item) => {
            const done = !!sideState[item.id];
            const toggleKey = `${side}:${item.id}`;
            return (
              <ChecklistRow
                key={item.id}
                item={item}
                done={done}
                canToggle={canToggle}
                editing={editing && canEdit}
                busy={busyId === toggleKey || busyId === `rename:${item.id}` || busyId === `remove:${item.id}`}
                onToggle={() => onToggle(item.id)}
                onRename={(label) => onRename(item.id, label)}
                onRemove={() => onRemove(item.id)}
              />
            );
          })}
          {editing && canEdit ? (
            <AddItemRow
              phaseId={phase.id}
              busy={busyId === `add:${phase.id}:${side}`}
              onAdd={(label) => onAdd(phase.id, label)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ChecklistRow({
  item,
  done,
  canToggle,
  editing,
  busy,
  onToggle,
  onRename,
  onRemove
}: {
  item: { id: string; label: string };
  done: boolean;
  canToggle: boolean;
  editing: boolean;
  busy: boolean;
  onToggle: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(item.label);
  // Keep the draft in sync if a remote rename lands while we're not focused.
  useEffect(() => {
    setDraft(item.label);
  }, [item.label]);

  if (editing) {
    return (
      <div className="atc-checklist-row atc-checklist-row-edit">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() && draft.trim() !== item.label) onRename(draft);
          }}
          disabled={busy}
        />
        <button
          type="button"
          aria-label="Remove item"
          title="Remove this item"
          onClick={onRemove}
          disabled={busy}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <label className={"atc-checklist-row " + (done ? "done" : "") + (canToggle ? "" : " readonly")}>
      <input
        type="checkbox"
        checked={done}
        disabled={!canToggle || busy}
        onChange={onToggle}
      />
      <span>{item.label}</span>
    </label>
  );
}

function AddItemRow({
  phaseId,
  busy,
  onAdd
}: {
  phaseId: string;
  busy: boolean;
  onAdd: (label: string) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  function commit(): void {
    const cleaned = text.trim();
    if (!cleaned) return;
    onAdd(cleaned);
    setText("");
  }
  return (
    <div className="atc-checklist-row atc-checklist-row-add">
      <input
        type="text"
        placeholder="Add item..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        disabled={busy}
        aria-label={`Add item to ${phaseId}`}
      />
      <button type="button" onClick={commit} disabled={busy || !text.trim()}>
        Add
      </button>
    </div>
  );
}

function PhaseManager({
  phases,
  busyId,
  onAdd,
  onRename,
  onRemove,
  onUp,
  onDown
}: {
  phases: ChecklistPhase[];
  busyId: string | null;
  onAdd: () => void;
  onRename: (phaseId: string, currentTitle: string) => void;
  onRemove: (phaseId: string, title: string) => void;
  onUp: (phaseId: string) => void;
  onDown: (phaseId: string) => void;
}): JSX.Element {
  return (
    <div className="atc-checklist-phase-manager">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <strong>Phases</strong>
        <button type="button" onClick={onAdd} disabled={busyId === "phase-add"}>
          {busyId === "phase-add" ? "Adding…" : "+ Add phase"}
        </button>
      </div>
      <ul className="atc-checklist-phase-list">
        {phases.map((p, i) => (
          <li key={p.id}>
            <span>{p.title}</span>
            <span className="room-meta">
              {p.pilot.length}P / {p.controller.length}C
            </span>
            <div className="row" style={{ gap: "0.2rem" }}>
              <button
                type="button"
                aria-label="Move phase up"
                onClick={() => onUp(p.id)}
                disabled={i === 0 || busyId === `phase-mv:${p.id}`}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Move phase down"
                onClick={() => onDown(p.id)}
                disabled={i === phases.length - 1 || busyId === `phase-mv:${p.id}`}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => onRename(p.id, p.title)}
                disabled={busyId === `phase-rn:${p.id}`}
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => onRemove(p.id, p.title)}
                disabled={busyId === `phase-rm:${p.id}`}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SendToTowerConfirm({
  template,
  currentPhases,
  onCancel,
  onConfirm,
  busy
}: {
  template: ChecklistTemplate;
  currentPhases: ChecklistPhase[];
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}): JSX.Element {
  const diff = useMemo<ChecklistDiff>(
    () => diffChecklistPhases(currentPhases, template.phases),
    [currentPhases, template.phases]
  );
  const empty = isEmptyDiff(diff);
  return (
    <div className="atc-checklist-send-confirm">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>Send "{template.name}" to tower?</strong>
          <p className="room-meta">Review the changes that will apply to this session before announcing.</p>
        </div>
        <div className="row" style={{ gap: "0.3rem" }}>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "Sending…" : empty ? "Send (no changes)" : "Confirm send"}
          </button>
        </div>
      </div>
      {empty ? (
        <p className="room-meta">This template matches the current session checklist exactly.</p>
      ) : (
        <ul className="atc-checklist-diff">
          {diff.addedPhases.map((t) => (
            <li key={`+p-${t}`} className="diff add">+ Phase: {t}</li>
          ))}
          {diff.removedPhases.map((t) => (
            <li key={`-p-${t}`} className="diff remove">- Phase: {t}</li>
          ))}
          {diff.renamedPhases.map((r) => (
            <li key={`rn-p-${r.id}`} className="diff change">
              ~ Phase: "{r.from}" → "{r.to}"
            </li>
          ))}
          {diff.addedItems.map((it, i) => (
            <li key={`+i-${i}`} className="diff add">
              + {it.phaseTitle} / {it.side}: {it.label}
            </li>
          ))}
          {diff.removedItems.map((it, i) => (
            <li key={`-i-${i}`} className="diff remove">
              - {it.phaseTitle} / {it.side}: {it.label}
            </li>
          ))}
          {diff.renamedItems.map((it, i) => (
            <li key={`rn-i-${i}`} className="diff change">
              ~ {it.phaseTitle} / {it.side}: "{it.from}" → "{it.to}"
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatAckAt(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const ageSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  return new Date(t).toLocaleTimeString();
}

export function computeCounts(
  phases: ChecklistPhase[],
  state: ChecklistState | undefined
): { pilotDone: number; pilotTotal: number; ctrlDone: number; ctrlTotal: number } {
  let pilotTotal = 0;
  let pilotDone = 0;
  let ctrlTotal = 0;
  let ctrlDone = 0;
  const pilotState = state?.pilot ?? {};
  const ctrlState = state?.controller ?? {};
  for (const p of phases) {
    pilotTotal += p.pilot.length;
    ctrlTotal += p.controller.length;
    for (const it of p.pilot) if (pilotState[it.id]) pilotDone++;
    for (const it of p.controller) if (ctrlState[it.id]) ctrlDone++;
  }
  return { pilotDone, pilotTotal, ctrlDone, ctrlTotal };
}
