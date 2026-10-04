// Quick SFS inspector: print every Body { ... } subnode under the SCANcontroller's Progress node.
// Reads the newest Dev_*/persistent.sfs unless --save <name> is passed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const KSP = path.resolve(SCRIPT_DIR, "..", "..", "..", "..");
function newestSave() {
  const root = path.join(KSP, "saves");
  const subs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = path.join(root, d.name, "persistent.sfs");
      try { return { name: d.name, p, mt: fs.statSync(p).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mt - a.mt);
  return subs[0];
}

const argSave = process.argv.includes("--save")
  ? process.argv[process.argv.indexOf("--save") + 1]
  : null;
const save = argSave
  ? { name: argSave, p: path.join(KSP, "saves", argSave, "persistent.sfs") }
  : newestSave();
console.log("save:", save.name, "->", save.p);

const txt = fs.readFileSync(save.p, "utf8");
const lines = txt.split(/\r?\n/);

const nameIdx = lines.findIndex((l) => l.trim() === "name = SCANcontroller");
if (nameIdx < 0) { console.log("No SCANcontroller scenario in this save."); process.exit(0); }
let scanIdx = nameIdx;
for (let i = nameIdx; i >= 0; i--) { if (lines[i].trim() === "SCENARIO") { scanIdx = i; break; } }
console.log("SCENARIO SCANcontroller starts at line", scanIdx);

let depth = 0;
let inProgress = false;
let progDepth = -1;
let curBody = null;
let bodyDepth = -1;
let fields = {};

for (let i = scanIdx; i < lines.length; i++) {
  const t = lines[i].trim();
  if (t === "{") { depth++; continue; }
  if (t === "}") {
    if (curBody && depth === bodyDepth) {
      console.log(`\n--- Body: ${curBody.Name || "?"} ---`);
      for (const k of Object.keys(curBody)) {
        const v = curBody[k];
        if (typeof v === "string" && v.length > 200) {
          console.log(`${k} = (${v.length} chars) ${v.slice(0, 80)}...${v.slice(-40)}`);
        } else {
          console.log(`${k} = ${v}`);
        }
      }
      curBody = null; bodyDepth = -1;
    }
    depth--;
    if (depth === 0) break;
    if (depth <= progDepth) inProgress = false;
    continue;
  }
  if (!inProgress && t === "Progress") { inProgress = true; progDepth = depth; continue; }
  if (inProgress && !curBody && t === "Body") { curBody = {}; bodyDepth = depth + 1; continue; }
  if (curBody && depth === bodyDepth) {
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) curBody[m[1]] = m[2];
  }
}
