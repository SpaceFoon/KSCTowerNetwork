import type { PointerEvent } from "react";

export type VoiceTopBarPttHandlers = {
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
};

export type VoiceTopBarSnapshot = {
  present: boolean;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  canPublish: boolean;
  canSubscribe: boolean;
  pttEnabled: boolean;
  micHot: boolean;
};

// Replaced, never mutated: useSyncExternalStore compares snapshots by identity,
// so an in-place update would never re-render the top bar.
let snap: VoiceTopBarSnapshot = {
  present: false,
  connected: false,
  connecting: false,
  reconnecting: false,
  canPublish: false,
  canSubscribe: false,
  pttEnabled: true,
  micHot: false
};

let pttHandlers: VoiceTopBarPttHandlers | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeVoiceTopBar(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getVoiceTopBarSnapshot(): VoiceTopBarSnapshot {
  return snap;
}

export function getVoiceTopBarPtt(): VoiceTopBarPttHandlers | null {
  return pttHandlers;
}

export function registerVoiceTopBar(opts: {
  snapshot: Partial<VoiceTopBarSnapshot>;
  ptt: VoiceTopBarPttHandlers | null;
}): void {
  snap = { ...snap, ...opts.snapshot };
  pttHandlers = opts.ptt;
  emit();
}

export function resetVoiceTopBar(): void {
  snap = {
    ...snap,
    present: false,
    connected: false,
    connecting: false,
    reconnecting: false,
    canPublish: false,
    canSubscribe: false,
    pttEnabled: true,
    micHot: false
  };
  pttHandlers = null;
  emit();
}
