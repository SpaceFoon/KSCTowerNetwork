#!/usr/bin/env node
/**
 * Static checks for voice regressions (bridge default session, PTT gate,
 * active-room hold on API outage, no dev-shared bootstrap).
 * Run from repo root or KSCTowerNetwork-dev via npm run verify:voice.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(devRoot, "..");

function readFromRepo(rel) {
  const p = path.join(repoRoot, ...rel.split("/"));
  if (!fs.existsSync(p)) {
    return { ok: false, path: p, content: null };
  }
  return { ok: true, path: p, content: fs.readFileSync(p, "utf8") };
}

const errors = [];

const bridge = readFromRepo("KSCTowerNetwork-voice-bridge/voice-bridge/src/bridge.ts");
if (!bridge.ok) {
  errors.push(`missing ${bridge.path}`);
} else {
  const b = bridge.content;
  if (/process\.env\.SESSION_ID\s*\?\?\s*["']dev-shared["']/.test(b)) {
    errors.push("bridge.ts: SESSION_ID must not default to dev-shared (orphan room / token 404)");
  }
  if (!/process\.env\.SESSION_ID\s*\?\?\s*["']ksc-radio-twr["']/.test(b)) {
    errors.push("bridge.ts: SESSION_ID unset fallback must be ksc-radio-twr");
  }
  if (/â/.test(b)) {
    errors.push("bridge.ts: mojibake detected (re-encode as UTF-8 or use ASCII punctuation)");
  }
}

const useActive = readFromRepo("KSCTowerNetwork-dev/web/src/session/useActiveRoom.ts");
if (!useActive.ok) {
  errors.push(`missing ${useActive.path}`);
} else {
  const u = useActive.content;
  if (!u.includes("q.error?.unreachable")) {
    errors.push("useActiveRoom.ts: missing unreachable API guard");
  }
  if (!u.includes("lastKnownActiveRoomRef")) {
    errors.push("useActiveRoom.ts: missing lastKnownActiveRoomRef hold during outage");
  }
}

const ptt = readFromRepo("KSCTowerNetwork-dev/web/src/voice/pttGate.ts");
if (!ptt.ok) {
  errors.push(`missing ${ptt.path}`);
} else if (!ptt.content.includes("if (opts.bridgePttFromKsp) return true")) {
  errors.push("pttGate.ts: KSP bridge PTT must force mic open");
}

const livekit = readFromRepo("KSCTowerNetwork-dev/web/src/voice/livekit.ts");
if (!livekit.ok) {
  errors.push(`missing ${livekit.path}`);
} else {
  const lk = livekit.content;
  const implNeedle = "const runIncomingMeterFrame = (): void => {";
  const subIdx = lk.indexOf(implNeedle);
  if (subIdx < 0) {
    errors.push("livekit.ts: expected incoming meter implementation");
  } else {
    const tail = lk.slice(subIdx, subIdx + 2800);
    if (!tail.includes("isSpeaking")) {
      errors.push("livekit.ts: incoming meter tick should use isSpeaking when audioLevel is flat");
    }
  }
}

const voiceDesk = readFromRepo("KSCTowerNetwork-dev/web/src/pages/VoiceDesk.tsx");
if (voiceDesk.ok && /\?\?\s*["']dev-shared["']/.test(voiceDesk.content)) {
  errors.push("VoiceDesk.tsx: must not use dev-shared as session id fallback");
}

if (errors.length) {
  console.error("voice invariant checks FAILED:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("voice invariant checks OK");
