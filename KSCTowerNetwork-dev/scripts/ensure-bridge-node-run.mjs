/**
 * Invoked from npm `predev`. On Windows, runs ensure-bridge-node.ps1 when the
 * bundled bridge node.exe is missing or outdated. No-op on other platforms.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devRoot = join(__dirname, "..");
const kspRoot = join(devRoot, "..");
const targetExe = join(
  kspRoot,
  "GameData",
  "KSCTowerNetwork",
  "PluginData",
  "bridge-runtime",
  "node",
  "node.exe"
);
const bundledNodeVersion = "v24.22.1";

if (process.platform !== "win32") {
  process.exit(0);
}

if (existsSync(targetExe)) {
  try {
    const installed = spawnSync(targetExe, ["--version"], { encoding: "utf8", shell: false });
    if (installed.status === 0 && installed.stdout.trim() === bundledNodeVersion) {
      process.exit(0);
    }
  } catch {
    // fall through to re-fetch
  }
}

const ps1 = join(__dirname, "ensure-bridge-node.ps1");
const r = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
  { stdio: "inherit", shell: false }
);
process.exit(r.status === 0 ? 0 : r.status ?? 1);
