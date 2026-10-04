/**
 * Tiny in-process pub/sub for per-session checklist activity. Web modal subscribes via
 * SSE (`GET /v1/session/:id/checklist/stream`); every backend mutation calls
 * {@link emitChecklistEvent} so subscribers get a push instead of polling every 4s.
 *
 * Single-process only — when we eventually scale horizontally this becomes a Redis
 * pub/sub topic with the same shape.
 */
export interface ChecklistEvent {
  /**
   * - `state`: `state` and/or `phases` changed (toggle, add/rename/remove item, send).
   * - `send`: a "send to tower" was just recorded (clients should refresh the latestSend block).
   * - `ack`: the controller acknowledged a send.
   * - `auto`: telemetry-driven auto-tick fired (`itemIds` lists what flipped).
   */
  kind: "state" | "send" | "ack" | "auto";
  sessionId: string;
  at: string;
  itemIds?: string[];
  byUserId?: string;
}

type Listener = (ev: ChecklistEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeChecklistEvents(sessionId: string, fn: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const s = listeners.get(sessionId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(sessionId);
  };
}

export function emitChecklistEvent(ev: ChecklistEvent): void {
  const set = listeners.get(ev.sessionId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try {
      fn(ev);
    } catch {
      // listener errors must not propagate to mutation paths.
    }
  }
}
