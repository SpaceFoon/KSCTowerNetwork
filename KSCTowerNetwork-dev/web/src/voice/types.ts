/** Backend `POST /v1/session/:sessionId/livekit-token` success body. */
export type LiveKitTokenResponse = {
  ok?: boolean;
  roomName?: string;
  /** Human session/channel label for the tuned frequency. */
  sessionName?: string | null;
  /** Server-authoritative tuned frequency for this token/participant. */
  frequencyMhz?: string | null;
  /** "ops", "booth" (spectator commentary), or "lobby_ops" (lobby listen). Defaults to "ops" on legacy backends. */
  flavor?: "ops" | "booth" | "lobby_ops";
  canPublish?: boolean;
  canSubscribe?: boolean;
  /** Booth kill-switch state when `flavor === "booth"`. */
  boothMuted?: boolean;
  token?: string;
  wsUrl?: string;
};

export type VoiceErrorKind =
  | "permission_denied"
  | "no_token"
  | "forbidden"
  | "not_found"
  | "livekit_unavailable"
  | "network"
  | "unknown";

/** Normalized row for UI (local + remote LiveKit participants). */
export type VoiceParticipantRow = {
  identity: string;
  /** LiveKit display name from token (e.g. KSP bridge), when set. */
  displayName?: string;
  /** Participant metadata from the backend token, if present. */
  frequencyMhz?: string;
  roomName?: string;
  isSpeaking: boolean;
  /** True for the browser user’s own row. */
  isLocal?: boolean;
};
