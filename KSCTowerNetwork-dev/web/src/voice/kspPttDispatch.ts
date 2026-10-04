import { parseKspPttPayload } from "./kspPttWire";

/**
 * Shared handler for `RoomEvent.DataReceived` — keeps `connectVoiceRoom` and
 * unit tests on one code path for KSP bridge → tower mic PTT.
 */
export function dispatchKspPttData(
  payload: Uint8Array,
  participant: { identity?: string } | undefined,
  callback: (on: boolean, fromIdentity: string) => void
): void {
  const ptt = parseKspPttPayload(payload);
  if (!ptt) return;
  const fromIdentity = ptt.from || participant?.identity || "";
  callback(ptt.on, fromIdentity);
}
