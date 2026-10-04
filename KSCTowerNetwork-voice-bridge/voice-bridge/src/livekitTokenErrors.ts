/** True when POST /session/.../livekit-token returned 404 (session missing). Used to throttle bridge logs. */
export function isLivekitTokenSessionNotFoundError(message: string): boolean {
  return /\b404\b/.test(message) && /session not found|not found/i.test(message);
}

/** True when LiveKit `room.connect` failed because `ksp_bridge` is still pinned server-side. */
export function isParticipantAlreadyExistsJoinError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /participant already exists|already exists/i.test(msg);
}
