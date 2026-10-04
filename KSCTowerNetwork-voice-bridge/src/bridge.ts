/**
 * Legacy outer-package entrypoint.
 *
 * The maintained bridge lives in `KSCTowerNetwork-voice-bridge/voice-bridge`.
 * Import it here so anyone still running the outer package gets the same
 * hardened room-switch/reconnect behavior instead of the retired implementation.
 */
import "../voice-bridge/src/bridge.ts";
