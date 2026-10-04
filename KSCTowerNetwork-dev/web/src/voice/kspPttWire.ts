/**
 * LiveKit data-channel payload used by the Node voice-bridge (`publishData`) and
 * parsed by `connectVoiceRoom` when `onBridgePtt` is set. Keep in sync with
 * `KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts` `sendPttToRoom`.
 */
const PTT_DECODER = new TextDecoder();

export type KspPttParsed = { on: boolean; from: string };

export function parseKspPttPayload(payload: Uint8Array): KspPttParsed | null {
  try {
    const text = PTT_DECODER.decode(payload);
    const obj = JSON.parse(text) as { type?: unknown; on?: unknown; from?: unknown };
    if (obj && obj.type === "ksp_ptt" && typeof obj.on === "boolean") {
      return { on: obj.on, from: typeof obj.from === "string" ? obj.from : "" };
    }
  } catch {
    /* not a JSON PTT packet */
  }
  return null;
}

/** Same encoding as the voice-bridge uses for reliable `publishData`. */
export function encodeKspPttPayload(on: boolean, from: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type: "ksp_ptt", on, from }));
}
