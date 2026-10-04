/**
 * One-shot dev bootstrap: subproject npm installs, env templates, bridge node.exe.
 *
 * - `npm install` / `npm run install` → full setup (root uses --ignore-scripts
 *   when re-run from the lifecycle hook to avoid recursion).
 */
import { copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devRoot = join(__dirname, "..");

const MIN_NODE_MAJOR = 22;

function log(msg) {
  console.log(`[setup-dev] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[setup-dev] ERROR: ${msg}`);
  process.exit(code);
}

function npmInstall(cwd, label, extraArgs = []) {
  log(`Installing ${label}…`);
  const r = spawnSync("npm", ["install", ...extraArgs], {
    cwd,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) {
    fail(`${label} npm install failed (exit ${r.status ?? "unknown"})`);
  }
}

function ensureEnvFile(dir, exampleName, targetName) {
  const example = join(dir, exampleName);
  const target = join(dir, targetName);
  if (existsSync(target)) {
    log(`OK: ${targetName} already present in ${dir}`);
    return;
  }
  if (!existsSync(example)) {
    log(`Skip: no ${exampleName} in ${dir}`);
    return;
  }
  copyFileSync(example, target);
  log(`Created ${targetName} from ${exampleName}`);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  fail(
    `Node ${MIN_NODE_MAJOR}+ required (found ${process.version}). Install from https://nodejs.org/`
  );
}

log(`Node ${process.version} — bootstrapping KSCTowerNetwork dev workspace`);

// --ignore-scripts when root is already being installed via npm lifecycle.
npmInstall(devRoot, "root (concurrently)", ["--ignore-scripts"]);

npmInstall(join(devRoot, "backend"), "backend");
npmInstall(join(devRoot, "web"), "web");
npmInstall(
  join(devRoot, "..", "KSCTowerNetwork-voice-bridge", "voice-bridge"),
  "voice bridge"
);

ensureEnvFile(join(devRoot, "backend"), ".env.example", ".env.development");
ensureEnvFile(join(devRoot, "web"), ".env.example", ".env.development");

const bridgeNodeScript = join(__dirname, "ensure-bridge-node-run.mjs");
if (existsSync(bridgeNodeScript)) {
  log("Ensuring bundled bridge node.exe (Windows only)…");
  const r = spawnSync(process.execPath, [bridgeNodeScript], {
    stdio: "inherit",
    shell: false,
  });
  if (r.status !== 0) {
    fail(`ensure-bridge-node failed (exit ${r.status ?? "unknown"})`);
  }
}

log("Done. Run: npm run dev");
