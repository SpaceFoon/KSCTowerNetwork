/**
 * Tower VoiceDesk transmit gate.
 * - KSP bridge `ksp_ptt` always keys the mic when on (even if tower PTT mode is off).
 * - With tower PTT on: T key / pointer OR bridge.
 * - With tower PTT off (open-mic): follow the mute toggle unless bridge is holding MIC_ON.
 */
export function pttGateMicOpen(opts: {
  pttMode: boolean;
  towerPhysicalHeld: boolean;
  bridgePttFromKsp: boolean;
  /** When `pttMode` is false: true = user has not muted via the mic toggle (live when bridge is off). */
  manualUnmuted: boolean;
}): boolean {
  if (opts.bridgePttFromKsp) return true;
  if (!opts.pttMode) return opts.manualUnmuted;
  return opts.towerPhysicalHeld;
}
