/**
 * App-wide DM unread tracker. Polls `/v1/dm/threads` (same key as `DmDesk`,
 * so TanStack dedupes — there's only one HTTP call regardless of how many
 * components mount the hook) and combines the result with the local "last
 * read" map from `dmReadStore` to produce a per-peer + total unread count.
 *
 * Mounted by `AppShell` so the topbar badge keeps ticking even when the user
 * isn't on `/dm`. We intentionally count *threads with unread*, not raw
 * message counts — the threads endpoint only returns the latest message per
 * peer, so a precise "+3 since you last looked" would require pulling each
 * thread's full history. Showing 1 per peer is honest about what we know
 * and matches how most chat clients render their tab badges.
 */
import { useSyncExternalStore } from "react";
import { queryKeys } from "../query/client";
import { useApiQuery } from "../query/hooks";
import { getDmReadSnapshot, subscribeDmRead } from "./dmReadStore";

const THREAD_POLL_MS = 6_000;

type SessionMessage = {
  id: string;
  sessionId: string;
  fromUserId: string;
  body: string;
  createdAt: string;
};

type Thread = {
  peerUserId: string;
  lastMessage?: SessionMessage;
};

type ThreadsRes = { ok?: boolean; threads?: Thread[] };

export type DmUnread = {
  /** Total number of peers with at least one unread incoming message. */
  totalUnread: number;
  /** Map of peerUserId -> 1 when that peer's latest message is unread. */
  unreadByPeer: Record<string, 1>;
};

export function useDmUnread(currentUserId: string, enabled: boolean): DmUnread {
  const threadsQuery = useApiQuery<ThreadsRes>({
    queryKey: queryKeys.dm.threads,
    path: "/v1/dm/threads",
    enabled,
    refetchInterval: THREAD_POLL_MS,
    placeholderData: (prev) => prev
  });

  const readMap = useSyncExternalStore(
    subscribeDmRead,
    getDmReadSnapshot,
    getDmReadSnapshot
  );

  const threads = threadsQuery.data?.threads ?? [];
  const unreadByPeer: Record<string, 1> = {};
  let totalUnread = 0;
  for (const t of threads) {
    const m = t.lastMessage;
    if (!m) continue;
    // A message you sent yourself is never "unread" for you.
    if (m.fromUserId === currentUserId) continue;
    const lastSeen = readMap[t.peerUserId];
    if (!lastSeen || m.createdAt > lastSeen) {
      unreadByPeer[t.peerUserId] = 1;
      totalUnread += 1;
    }
  }

  return { totalUnread, unreadByPeer };
}
