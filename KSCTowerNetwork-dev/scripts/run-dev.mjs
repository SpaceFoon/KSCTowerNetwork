import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import concurrently from "concurrently";
import { readDevPorts } from "./dev-ports.mjs";

const devRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const npmCli = process.env.npm_execpath || require.resolve("npm/bin/npm-cli.js");
const ports = readDevPorts();
const target = process.argv[2];
const services = {
  backend: "backend",
  web: "web",
  bridge: "../KSCTowerNetwork-voice-bridge/voice-bridge"
};
if (target && target !== "--clean" && !Object.hasOwn(services, target)) {
  throw new Error(`Unknown development service: ${target}`);
}

if (!target || target === "--clean") {
  if (process.platform === "win32") {
    const selectedPorts = [48787, ...Object.values(ports)].join(",");
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `$ports = ${selectedPorts}; $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports } | Select-Object -Unique OwningProcess; foreach ($row in $listeners) { Stop-Process -Id $row.OwningProcess -Force -ErrorAction SilentlyContinue }`
    ], { stdio: "inherit" });
    if (cleanup.error || cleanup.status !== 0) throw new Error("Development port cleanup failed.");
  }
}
if (target !== "--clean") {
  console.log(`[dev] web localhost:${ports.webPort}, bridge PCM ${ports.pcmPort}, control ${ports.ctlPort}`);
  const env = {
    ...process.env,
    PCM_PORT: String(ports.pcmPort),
    CTL_PORT: String(ports.ctlPort)
  };
  const commands = Object.entries(services).filter(([name]) => !target || target === name).map(([name, folder]) => ({
    name, env,
    command: `"${process.execPath}" "${npmCli}" run dev --prefix "${folder}"`
  }));
  const { result } = concurrently(commands, {
    cwd: devRoot, prefix: "name", prefixColors: ["blue", "green", "magenta"], killOthersOn: ["failure"]
  });
  try { await result; } catch { process.exitCode = 1; }
}
