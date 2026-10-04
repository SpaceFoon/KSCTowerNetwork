import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Integer; bump when espeak/SAPI render params change so ATIS `contentHash` moves and clients re-fetch WAV. */
export const ATIS_TTS_RENDER_REVISION = 2;

const MAX_CHARS = 12_000;

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
}

function psSingleQuoted(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

/** espeak-ng `-p`: 0–99, default 50; higher = brighter / more “ATC headset” for ATIS. */
const ESPEAK_PITCH = 72;

function escapeXmlForSsml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function espeakToWav(text: string, outWav: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("espeak-ng", ["-s", "150", "-p", String(ESPEAK_PITCH), "-w", outWav], {
      stdio: ["pipe", "ignore", "ignore"]
    });
    child.on("error", () => resolve(false));
    child.stdin.write(text, "utf8");
    child.stdin.end();
    child.on("close", (code) => resolve(code === 0));
  });
}

async function windowsSapiToWav(
  text: string,
  plainPath: string,
  ssmlPath: string,
  ps1Path: string,
  wavPath: string
): Promise<boolean> {
  const inner = escapeXmlForSsml(text);
  const ssml = [
    `<?xml version="1.0"?>`,
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">`,
    `  <prosody pitch="+22%">${inner}</prosody>`,
    `</speak>`,
    ""
  ].join("\n");
  await writeFile(plainPath, text, "utf8");
  await writeFile(ssmlPath, ssml, "utf8");
  const ps1 = [
    `$ErrorActionPreference = "Stop"`,
    `$plain = Get-Content -LiteralPath ${psSingleQuoted(plainPath)} -Raw -Encoding UTF8`,
    `$ssml = Get-Content -LiteralPath ${psSingleQuoted(ssmlPath)} -Raw -Encoding UTF8`,
    `Add-Type -AssemblyName System.Speech`,
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
    `$s.SetOutputToWaveFile(${psSingleQuoted(wavPath)})`,
    `try { $s.SpeakSsml($ssml) } catch { $s.Speak($plain) }`
  ].join("\n");
  await writeFile(ps1Path, ps1, "utf8");
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", ps1Path], {
      stdio: "ignore"
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Renders broadcast text to a mono WAV using host TTS (espeak-ng if available,
 * else Windows SAPI via PowerShell). Used for Kerbalizer preview in the web UI.
 * Returns null when no renderer succeeds on this machine.
 */
export async function renderAtisPreviewAudio(text: string): Promise<Buffer | null> {
  const t = normalizeText(text);
  if (!t) return null;

  const id = randomUUID();
  const base = path.join(os.tmpdir(), `ksc-atis-prev-${id}`);
  const wavPath = `${base}.wav`;
  const plainPath = `${base}.plain.txt`;
  const ssmlPath = `${base}.ssml.xml`;
  const ps1Path = `${base}.ps1`;

  const cleanup = async () => {
    await Promise.all([
      unlink(wavPath).catch(() => {}),
      unlink(plainPath).catch(() => {}),
      unlink(ssmlPath).catch(() => {}),
      unlink(ps1Path).catch(() => {})
    ]);
  };

  try {
    await unlink(wavPath).catch(() => {});
    if (await espeakToWav(t, wavPath)) {
      const buf = await readFile(wavPath);
      await cleanup();
      return buf;
    }

    if (process.platform === "win32") {
      if (await windowsSapiToWav(t, plainPath, ssmlPath, ps1Path, wavPath)) {
        const buf = await readFile(wavPath);
        await cleanup();
        return buf;
      }
    }

    await cleanup();
    return null;
  } catch {
    await cleanup();
    return null;
  }
}
