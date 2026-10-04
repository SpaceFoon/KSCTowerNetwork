/**
 * Tiny global store that tracks the most recent message timestamp the local
 * user has *seen* per DM peer. Backed by localStorage so the unread badge
 * survives reloads, and exposed via `subscribe`/`getSnapshot` so any component
 * can plug in via `useSyncExternalStore` and re-render the moment a peer is
 * marked read.
 *
 * Why not React Query / context: the read state is a pure client concern
 * (there's no server-side "read receipt" yet) and we want both the topbar
 * badge in `AppShell` and the conversation pane in `DmDesk` to share the same
 * map without prop-drilling or a new provider.
 *
 * Storage shape: `{ [peerUserId]: ISO8601 timestamp of latest message read }`.
 * A peer is "unread" when their thread's `lastMessage.createdAt` is strictly
 * newer than the stored timestamp (or no entry exists yet).
 */

const STORAGE_KEY = "ksc_tower_dm_read_v1";

export type DmReadMap = Readonly<Record<string, string>>;

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let snapshot: DmReadMap = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

export function getDmReadSnapshot(): DmReadMap {
  return snapshot;
}

export function subscribeDmRead(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Mark `peerUserId` as read up to `asOf` (defaults to "now"). No-op when the
 * stored timestamp is already at or past `asOf` — keeps the snapshot reference
 * stable so subscribers don't re-render needlessly.
 */
export function markDmPeerRead(peerUserId: string, asOf?: string): void {
  if (!peerUserId) return;
  const ts = asOf ?? new Date().toISOString();
  const prev = snapshot[peerUserId];
  if (prev && prev >= ts) return;
  snapshot = { ...snapshot, [peerUserId]: ts };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // private mode / quota — read state is best-effort, swallow.
  }
  emit();
}

/** Cross-tab sync: when another tab updates the read map, refresh ours. */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    snapshot = load();
    emit();
  });
}
