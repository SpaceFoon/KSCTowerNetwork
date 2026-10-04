export type LiveSnapshotEvent =
  | { topic: "active-aircraft" }
  | { topic: "session"; sessionId: string }
  | { topic: "session-messages"; sessionId: string; deltaMessageId?: string }
  | { topic: "hullcam-meta"; sessionId: string };

type Listener = (event: LiveSnapshotEvent) => void;

const listeners = new Set<Listener>();

export function subscribeLiveSnapshotBus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLiveSnapshotEvent(event: LiveSnapshotEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Snapshot notifications must never crash request/ingest code paths.
    }
  }
}
