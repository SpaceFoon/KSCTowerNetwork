#!/usr/bin/env node
/**
 * Static checks so KSP ACARS, web ChatDesk/Lobby/DM, and backend routes stay aligned
 * (URLs, full-snapshot polling, POST body shape, active-room sync for session chat).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function readFromRepo(rel) {
  const p = path.join(repoRoot, ...rel.split("/"));
  if (!fs.existsSync(p)) {
    return { ok: false, path: p, content: null };
  }
  return { ok: true, path: p, content: fs.readFileSync(p, "utf8") };
}

const errors = [];

const chatDesk = readFromRepo("KSCTowerNetwork-dev/web/src/pages/ChatDesk.tsx");
if (!chatDesk.ok) {
  errors.push(`missing ${chatDesk.path}`);
} else {
  const c = chatDesk.content;
  if (!c.includes("path: `/v1/session/${encodeURIComponent(sessionId)}/messages`")) {
    errors.push("ChatDesk.tsx: expected GET path /v1/session/:id/messages");
  }
  if (!c.includes("apiCall(`/v1/session/${encodeURIComponent(sessionId)}/messages`")) {
    errors.push("ChatDesk.tsx: expected POST apiCall /v1/session/:id/messages");
  }
  if (!c.includes("JSON.stringify({ text: vars.text })")) {
    errors.push("ChatDesk.tsx: POST body must use { text } (backend messageBodySchema)");
  }
  if (c.includes("since=") || c.includes("?since")) {
    errors.push("ChatDesk.tsx: must not use incremental ?since= (KSP/plugin use full snapshot only)");
  }
}

const lobby = readFromRepo("KSCTowerNetwork-dev/web/src/pages/LobbyPage.tsx");
if (!lobby.ok) {
  errors.push(`missing ${lobby.path}`);
} else {
  const l = lobby.content;
  if (!l.includes('path: "/v1/lobby/messages"')) {
    errors.push("LobbyPage.tsx: expected GET /v1/lobby/messages");
  }
  if (!l.includes('apiCall("/v1/lobby/messages"')) {
    errors.push("LobbyPage.tsx: expected POST /v1/lobby/messages");
  }
  if (l.includes("since=") || l.includes("?since")) {
    errors.push("LobbyPage.tsx: must not use ?since= on lobby messages");
  }
}

const dm = readFromRepo("KSCTowerNetwork-dev/web/src/pages/DmDesk.tsx");
if (!dm.ok) {
  errors.push(`missing ${dm.path}`);
} else {
  const d = dm.content;
  if (!d.includes("path: `/v1/dm/${encodeURIComponent(selectedPeerId)}/messages`")) {
    errors.push("DmDesk.tsx: expected GET /v1/dm/:peer/messages");
  }
  if (!d.includes("apiCall(`/v1/dm/${encodeURIComponent(selectedPeerId)}/messages`")) {
    errors.push("DmDesk.tsx: expected POST /v1/dm/:peer/messages");
  }
  if (!d.includes("JSON.stringify({ text: vars.text })")) {
    errors.push("DmDesk.tsx: POST body must use { text }");
  }
  if (d.includes("since=") || d.includes("?since")) {
    errors.push("DmDesk.tsx: must not use ?since= on DM messages");
  }
}

const acars = readFromRepo("KSCTowerNetwork-dev/PluginSrc/TowerAcarsGui.cs");
if (!acars.ok) {
  errors.push(`missing ${acars.path}`);
} else {
  const a = acars.content;
  if (!a.includes('TowerModSettings.ApiBaseUrl + "/session/"') || !a.includes('"/messages"')) {
    errors.push("TowerAcarsGui.cs: expected ApiBaseUrl + /session/.../messages for room ACARS");
  }
  if (!a.includes('TowerModSettings.ApiBaseUrl + "/lobby/messages"')) {
    errors.push("TowerAcarsGui.cs: expected /lobby/messages");
  }
  if (!a.includes('TowerModSettings.ApiBaseUrl + "/dm/"')) {
    errors.push("TowerAcarsGui.cs: expected /dm/{peer}/messages");
  }
  if (!a.includes("JsonEscape(text)")) {
    errors.push("TowerAcarsGui.cs: expected POST body built with JsonEscape(text) (JSON text field)");
  }
}

const api = readFromRepo("KSCTowerNetwork-dev/backend/src/routes/api.ts");
if (!api.ok) {
  errors.push(`missing ${api.path}`);
} else {
  const x = api.content;
  if (!x.includes('apiRouter.get("/session/:sessionId/messages"')) {
    errors.push("api.ts: expected GET /session/:sessionId/messages");
  }
  if (!x.includes('"/session/:sessionId/messages"')) {
    errors.push("api.ts: expected /session/:sessionId/messages routes");
  }
  if (!x.includes('apiRouter.get("/lobby/messages"')) {
    errors.push("api.ts: expected GET /lobby/messages");
  }
  if (!x.includes('apiRouter.get("/me/active-room"')) {
    errors.push("api.ts: expected GET /me/active-room (plugin + web session truth)");
  }
  if (!x.includes('"/dm/:peerUserId/messages"')) {
    errors.push("api.ts: expected /dm/:peerUserId/messages routes");
  }
}

const integ = readFromRepo("KSCTowerNetwork-dev/backend/src/integration/messages.http.integration.test.ts");
if (!integ.ok) {
  errors.push(`missing ${integ.path}`);
} else if (!integ.content.includes("buildHttpApp")) {
  errors.push("messages.http.integration.test.ts: expected Supertest + buildHttpApp HTTP proofs");
}

const repoDm = readFromRepo("KSCTowerNetwork-dev/backend/src/services/repository.ts");
if (!repoDm.ok) {
  errors.push(`missing ${repoDm.path}`);
} else {
  const r = repoDm.content;
  if (!r.includes("coParticipantUserIdsFromSessions")) {
    errors.push("repository.ts: DM peers must include session co-participants (coParticipantUserIdsFromSessions)");
  }
  if (!r.includes("coParticipantUserIdsFromSessions(forUserId, sessions)")) {
    errors.push("repository.ts: listDirectMessagePeers must merge co-participants from listSessionsMerged");
  }
}

const sync = readFromRepo("KSCTowerNetwork-dev/PluginSrc/TowerAcarsActiveRoomSync.cs");
if (!sync.ok) {
  errors.push(`missing ${sync.path}`);
} else {
  const s = sync.content;
  if (!s.includes("/me/active-room")) {
    errors.push("TowerAcarsActiveRoomSync.cs: must call /me/active-room");
  }
  if (!s.includes("SetActiveChannel")) {
    errors.push("TowerAcarsActiveRoomSync.cs: must call TowerModSettings.SetActiveChannel");
  }
}

const httpApp = readFromRepo("KSCTowerNetwork-dev/backend/src/httpApp.ts");
if (!httpApp.ok) {
  errors.push(`missing ${httpApp.path}`);
} else if (!httpApp.content.includes("export async function buildHttpApp")) {
  errors.push("httpApp.ts: expected buildHttpApp for Supertest integration");
}

const buildPs1 = readFromRepo("KSCTowerNetwork-dev/build-plugin.ps1");
if (!buildPs1.ok) {
  errors.push(`missing ${buildPs1.path}`);
} else if (!buildPs1.content.includes("TowerAcarsActiveRoomSync.cs")) {
  errors.push("build-plugin.ps1: must compile TowerAcarsActiveRoomSync.cs");
} else if (!buildPs1.content.includes("TowerAcarsContracts.cs")) {
  errors.push("build-plugin.ps1: must compile TowerAcarsContracts.cs (JsonUtility DTOs)");
}

if (errors.length) {
  console.error("ACARS invariant checks FAILED:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("ACARS invariant checks OK");
