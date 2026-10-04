import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { fetchOpenMeteoCurrent } from "./atisOpenMeteo";
import { isNonRoutableClientIp, normalizeClientIp, resolveIpToLatLon } from "./atisIpGeo";
import { ATIS_TTS_RENDER_REVISION } from "./atisPreviewAudio";

const NATO_LETTERS = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliett",
  "Kilo",
  "Lima",
  "Mike",
  "November",
  "Oscar",
  "Papa",
  "Quebec",
  "Romeo",
  "Sierra",
  "Tango",
  "Uniform",
  "Victor",
  "Whiskey",
  "X-ray",
  "Yankee",
  "Zulu"
] as const;

const DIGIT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine"
];

const weatherFileSchema = z.object({
  windDirDeg: z.number().finite().min(0).max(359),
  windKt: z.number().finite().min(0).max(200),
  visibilitySm: z.number().finite().min(0).max(100),
  skyConditions: z.string().max(200),
  tempC: z.number().finite().min(-100).max(100),
  dewpointC: z.number().finite().min(-100).max(100),
  altimeterInHg: z.number().finite().min(28).max(31)
});

export type AtisMaterialSnapshot = {
  windDirDeg: number;
  windKt: number;
  runwayId: string;
  altInHg: number;
  notamSig: string;
};

export type AtisWeatherSource = "live" | "file" | "default";

export type AtisCurrentPayload = {
  letter: string;
  text: string;
  lines: string[];
  audioUrl: string | null;
  contentHash: string;
  advancedAt: string;
  sourceTimestamp: string;
  degraded: boolean;
  /** Where wind/temp/visibility numbers came from for this response. */
  weatherSource: AtisWeatherSource;
  /**
   * Always null on the wire. Geo / tower reference labels exist only server-side for Open-Meteo
   * bookkeeping and must never reveal another client or the configured tower desk to anyone.
   */
  locationHint: string | null;
};

const DEFAULT_WEATHER = {
  windDirDeg: 270,
  windKt: 8,
  visibilitySm: 10,
  skyConditions: "clear below one two thousand",
  tempC: 15,
  dewpointC: 12,
  altimeterInHg: 29.92
};

const DEFAULT_RUNWAY = "09";

let tickHandle: ReturnType<typeof setInterval> | undefined;

let letterIndex = 0;
let lastAdvanceAt = Date.now();
/** Snapshot the current information letter was issued against (advance resets this). */
let baselineMaterial: AtisMaterialSnapshot | null = null;
let lastWarnedMissingFile = false;

type CoordWeatherEntry = {
  fetchedAt: number;
  weather: z.infer<typeof weatherFileSchema>;
  sourceIso: string;
  degraded: boolean;
  fromLive: boolean;
};

const coordWeatherCache = new Map<string, CoordWeatherEntry>();

type IpAtisBundle = {
  fetchedAt: number;
  weather: z.infer<typeof weatherFileSchema>;
  sourceIso: string;
  degraded: boolean;
  weatherSource: AtisWeatherSource;
  locationHint: string | null;
};

const ipAtisCache = new Map<string, IpAtisBundle>();

/** Cache key for the shared controller+ / tower-desk live bundle (not a real client IP). */
const TOWER_ATIS_CACHE_KEY = "__ksc_tower_weather_ref__";

function touchLruMap<K, V>(m: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (m.has(key)) {
    m.delete(key);
  }
  m.set(key, value);
  while (m.size > maxSize) {
    const first = m.keys().next().value as K | undefined;
    if (first === undefined) break;
    m.delete(first);
  }
}

function coordCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function parseWeatherFileShape(w: unknown): z.infer<typeof weatherFileSchema> | null {
  const r = weatherFileSchema.safeParse(w);
  return r.success ? r.data : null;
}

/**
 * Cached Open-Meteo (or cold miss) for a lat/lon. Used for scheduler reference point and live clients.
 */
async function fetchWeatherAtCoords(lat: number, lon: number): Promise<{
  weather: z.infer<typeof weatherFileSchema>;
  sourceIso: string;
  degraded: boolean;
  fromLive: boolean;
}> {
  const ttlMs = env.ATIS_LIVE_CACHE_SECONDS * 1000;
  const key = coordCacheKey(lat, lon);
  const now = Date.now();
  const hit = coordWeatherCache.get(key);
  if (hit && now - hit.fetchedAt < ttlMs) {
    return {
      weather: hit.weather,
      sourceIso: hit.sourceIso,
      degraded: hit.degraded,
      fromLive: hit.fromLive
    };
  }

  const bundle = await fetchOpenMeteoCurrent(lat, lon, AbortSignal.timeout(12_000));
  if (bundle) {
    const parsed = parseWeatherFileShape(bundle.weather);
    const weather = parsed ?? DEFAULT_WEATHER;
    const entry: CoordWeatherEntry = {
      fetchedAt: now,
      weather,
      sourceIso: bundle.observationIso,
      degraded: !parsed,
      fromLive: true
    };
    touchLruMap(coordWeatherCache, key, entry, 64);
    return { weather, sourceIso: bundle.observationIso, degraded: !parsed, fromLive: true };
  }

  const file = await loadWeather();
  const entry: CoordWeatherEntry = {
    fetchedAt: now,
    weather: file.weather,
    sourceIso: file.sourceIso,
    degraded: file.degraded,
    fromLive: false
  };
  touchLruMap(coordWeatherCache, key, entry, 64);
  return {
    weather: file.weather,
    sourceIso: file.sourceIso,
    degraded: file.degraded,
    fromLive: false
  };
}

async function loadSchedulerObservation(): Promise<{
  weather: z.infer<typeof weatherFileSchema>;
  sourceIso: string;
  degraded: boolean;
  fromLive: boolean;
}> {
  if (!env.ATIS_LIVE_WEATHER) {
    const f = await loadWeather();
    return { ...f, fromLive: false };
  }
  const r = await fetchWeatherAtCoords(env.ATIS_REFERENCE_LAT, env.ATIS_REFERENCE_LON);
  return { weather: r.weather, sourceIso: r.sourceIso, degraded: r.degraded, fromLive: r.fromLive };
}

export function invalidateAtisLiveWeatherCaches(): void {
  coordWeatherCache.clear();
  ipAtisCache.clear();
}

function spellDigits(s: string): string {
  return s
    .split("")
    .map((ch) => {
      const n = Number(ch);
      return Number.isFinite(n) ? DIGIT_WORDS[n]! : ch;
    })
    .join(" ");
}

function windDirSpeech(deg: number): string {
  const d = Math.round(deg) % 360;
  const s = String(d).padStart(3, "0");
  return spellDigits(s);
}

function windKtSpeech(kt: number): string {
  const k = Math.round(kt);
  if (k < 0) return "zero";
  return k
    .toString()
    .split("")
    .map((c) => DIGIT_WORDS[Number(c)]!)
    .join(" ");
}

function runwaySpeech(id: string): string {
  const raw = id.replace(/\s+/g, "");
  return raw
    .split("")
    .map((c) => DIGIT_WORDS[Number(c)]!)
    .join(" ");
}

function altimeterSpeech(inHg: number): string {
  const t = Math.round(inHg * 100) / 100;
  const s = t.toFixed(2).replace(".", "");
  return spellDigits(s);
}

function tempSpeech(c: number): string {
  const n = Math.round(c);
  const sign = n < 0 ? "minus " : "";
  const abs = Math.abs(n)
    .toString()
    .split("")
    .map((d) => DIGIT_WORDS[Number(d)]!)
    .join(" ");
  return sign + abs;
}

function visibilitySpeech(sm: number): string {
  const raw = sm.toString();
  return raw
    .split("")
    .map((ch) => (ch === "." ? "point" : DIGIT_WORDS[Number(ch)]!))
    .join(" ");
}

function zuluTimeSpeech(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${spellDigits(hh + mm)} zulu`;
}

type AtisComposeConfig = {
  mode: "weather" | "roleplay";
  includeNotamAdvisories: boolean;
  maxNotamAdvisories: number;
  includeFieldStatus: boolean;
  includeDisclaimer: boolean;
  includeCloser: boolean;
};

function composeConfigFromEnv(): AtisComposeConfig {
  return {
    mode: env.ATIS_MODE,
    includeNotamAdvisories: env.ATIS_ROLEPLAY_INCLUDE_NOTAM_ADVISORIES,
    maxNotamAdvisories: env.ATIS_ROLEPLAY_MAX_NOTAM_ADVISORIES,
    includeFieldStatus: env.ATIS_ROLEPLAY_INCLUDE_FIELD_STATUS,
    includeDisclaimer: env.ATIS_ROLEPLAY_INCLUDE_DISCLAIMER,
    includeCloser: env.ATIS_ROLEPLAY_INCLUDE_CLOSER
  };
}

function stableIndex(seed: string, modulo: number, salt: string): number {
  if (modulo <= 1) return 0;
  const h = createHash("sha256");
  h.update(seed, "utf8");
  h.update("|", "utf8");
  h.update(salt, "utf8");
  const n = h.digest().readUInt32BE(0);
  return n % modulo;
}

function pickStable<T>(items: readonly T[], seed: string, salt: string): T {
  return items[stableIndex(seed, items.length, salt)]!;
}

function extractNotamAdvisories(notamBlock: string, max: number, seed: string): string[] {
  if (!notamBlock.trim()) return [];
  const chunks = notamBlock
    .split(/[\r\n;.]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6)
    .map((s) => s.replace(/\s+/g, " "));
  if (chunks.length === 0) return [];
  const capped = Math.max(1, Math.min(3, Math.trunc(max)));
  const takeCount = Math.min(chunks.length, capped);
  const start = stableIndex(seed, chunks.length, "notam-start");
  const out: string[] = [];
  for (let i = 0; i < takeCount; i++) {
    out.push(chunks[(start + i) % chunks.length]!);
  }
  return out.map((s) => `Advisory ${s}.`);
}

const ROLEPLAY_FIELD_STATUS_LINES = [
  "Pattern active.",
  "Training operations in progress.",
  "Mixed traffic expected in the terminal area.",
  "Ground operations active near the apron.",
  "Use caution for local training traffic."
] as const;

function contentHashStable(letter: string, mat: AtisMaterialSnapshot, notamSig: string): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ letter, mat, notamSig }), "utf8");
  return h.digest("hex");
}

/** Same material as `contentHashStable` plus TTS revision so WAV caches invalidate when render settings change. */
function atisAudioContentHash(letter: string, mat: AtisMaterialSnapshot, notamSig: string): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ letter, mat, notamSig, ttsRev: ATIS_TTS_RENDER_REVISION }), "utf8");
  return h.digest("hex");
}

function composeLines(
  w: z.infer<typeof weatherFileSchema>,
  _runwayId: string,
  letter: string,
  notamBlock: string,
  now: Date,
  cfg: AtisComposeConfig = composeConfigFromEnv(),
  stableSeed = ""
): string[] {
  const lines: string[] = [];
  lines.push(`KSC information ${letter}. Time ${zuluTimeSpeech(now)}.`);
  lines.push(
    `Wind ${windDirSpeech(w.windDirDeg)} at ${windKtSpeech(w.windKt)}. Visibility ${visibilitySpeech(w.visibilitySm)} statute miles. ${w.skyConditions}.`
  );
  lines.push(
    `Temperature ${tempSpeech(w.tempC)} dewpoint ${tempSpeech(w.dewpointC)}. Altimeter ${altimeterSpeech(w.altimeterInHg)}.`
  );
  const trimmedNotam = notamBlock.trim();
  if (trimmedNotam.length > 0) {
    lines.push(trimmedNotam);
  }
  if (cfg.mode === "roleplay") {
    const seed = stableSeed || `${letter}|${trimmedNotam}|${w.windDirDeg}|${w.windKt}`;
    if (cfg.includeNotamAdvisories) {
      lines.push(...extractNotamAdvisories(trimmedNotam, cfg.maxNotamAdvisories, seed));
    }
    if (cfg.includeFieldStatus) {
      lines.push(pickStable(ROLEPLAY_FIELD_STATUS_LINES, seed, "field-status"));
    }
    if (cfg.includeDisclaimer) {
      lines.push("Advisory only. Tower clearance required.");
    }
    if (cfg.includeCloser) {
      lines.push(`Information ${letter}.`);
    }
  }
  return lines;
}

function broadcastText(lines: string[]): string {
  return lines.join(" ");
}

function buildPayload(
  letter: string,
  lines: string[],
  advancedAtIso: string,
  sourceTimestampIso: string,
  degradedFlag: boolean,
  mat: AtisMaterialSnapshot,
  notamSig: string,
  meta?: { weatherSource: AtisWeatherSource; locationHint: string | null }
): AtisCurrentPayload {
  const text = broadcastText(lines);
  const hash = atisAudioContentHash(letter, mat, notamSig);
  const weatherSource = meta?.weatherSource ?? "file";
  const locationHint = meta?.locationHint ?? null;
  return {
    letter,
    text,
    lines,
    audioUrl: null,
    contentHash: hash,
    advancedAt: advancedAtIso,
    sourceTimestamp: sourceTimestampIso,
    degraded: degradedFlag,
    weatherSource,
    locationHint
  };
}

function circularDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function materiallyChanged(prev: AtisMaterialSnapshot, next: AtisMaterialSnapshot): boolean {
  if (prev.runwayId !== next.runwayId) return true;
  if (prev.notamSig !== next.notamSig) return true;
  if (Math.abs(prev.altInHg - next.altInHg) > 0.005) return true;
  if (circularDiffDeg(prev.windDirDeg, next.windDirDeg) >= 10) return true;
  if (Math.abs(prev.windKt - next.windKt) >= 3) return true;
  return false;
}

function materialFromInputs(
  w: z.infer<typeof weatherFileSchema>,
  runwayId: string,
  notamSig: string
): AtisMaterialSnapshot {
  return {
    windDirDeg: w.windDirDeg,
    windKt: w.windKt,
    runwayId,
    altInHg: Math.round(w.altimeterInHg * 100) / 100,
    notamSig
  };
}

const ATIS_BOOT_NOW = new Date();
const ATIS_BOOT_MAT = materialFromInputs(DEFAULT_WEATHER, DEFAULT_RUNWAY, "");
let cachedPayload: AtisCurrentPayload = buildPayload(
  NATO_LETTERS[0]!,
  composeLines(
    DEFAULT_WEATHER,
    DEFAULT_RUNWAY,
    NATO_LETTERS[0]!,
    "",
    ATIS_BOOT_NOW,
    composeConfigFromEnv(),
    contentHashStable(NATO_LETTERS[0]!, ATIS_BOOT_MAT, "")
  ),
  ATIS_BOOT_NOW.toISOString(),
  ATIS_BOOT_NOW.toISOString(),
  false,
  ATIS_BOOT_MAT,
  "",
  { weatherSource: "default", locationHint: null }
);

async function loadWeather(): Promise<{
  weather: z.infer<typeof weatherFileSchema>;
  sourceIso: string;
  degraded: boolean;
}> {
  const filePath = path.resolve(process.cwd(), env.ATIS_WEATHER_PATH);
  try {
    const st = await stat(filePath);
    const buf = await readFile(filePath);
    const parsed = weatherFileSchema.parse(JSON.parse(buf.toString("utf8")));
    lastWarnedMissingFile = false;
    return { weather: parsed, sourceIso: new Date(st.mtimeMs).toISOString(), degraded: false };
  } catch (e) {
    if (!lastWarnedMissingFile) {
      logger.warn({ err: e, path: filePath }, "ATIS: using default weather (file missing or invalid)");
      lastWarnedMissingFile = true;
    }
    return {
      weather: DEFAULT_WEATHER,
      sourceIso: new Date().toISOString(),
      degraded: true
    };
  }
}

function recomputeCache(
  w: z.infer<typeof weatherFileSchema>,
  runwayId: string,
  letter: string,
  notamBlock: string,
  now: Date,
  advancedAtIso: string,
  sourceIso: string,
  degradedFlag: boolean,
  mat: AtisMaterialSnapshot,
  meta?: { weatherSource: AtisWeatherSource; locationHint: string | null }
): void {
  const notamSig = notamBlock.trim();
  const seed = contentHashStable(letter, mat, notamSig);
  const lines = composeLines(w, runwayId, letter, notamBlock, now, composeConfigFromEnv(), seed);
  const weatherSource =
    meta?.weatherSource ?? (degradedFlag ? "default" : env.ATIS_LIVE_WEATHER ? "live" : "file");
  const locationHint = meta?.locationHint ?? null;
  cachedPayload = buildPayload(letter, lines, advancedAtIso, sourceIso, degradedFlag, mat, notamSig, {
    weatherSource,
    locationHint
  });
}

function composeLiveClientPayload(bundle: IpAtisBundle, now: Date): AtisCurrentPayload {
  const letter = NATO_LETTERS[letterIndex]!;
  const notamBlock = "";
  const runwayId = DEFAULT_RUNWAY;
  const mat = materialFromInputs(bundle.weather, runwayId, "");
  const lines = composeLines(
    bundle.weather,
    runwayId,
    letter,
    notamBlock,
    now,
    composeConfigFromEnv(),
    contentHashStable(letter, mat, "")
  );
  const advancedIso = new Date(lastAdvanceAt).toISOString();
  return buildPayload(
    letter,
    lines,
    advancedIso,
    bundle.sourceIso,
    bundle.degraded,
    mat,
    "",
    { weatherSource: bundle.weatherSource, locationHint: bundle.locationHint }
  );
}

async function buildCoordsAtisBundle(
  lat: number,
  lon: number,
  locationHint: string | null
): Promise<IpAtisBundle> {
  const obs = await fetchWeatherAtCoords(lat, lon);
  const weatherSource: AtisWeatherSource = obs.fromLive ? "live" : obs.degraded ? "default" : "file";
  return {
    fetchedAt: Date.now(),
    weather: obs.weather,
    sourceIso: obs.sourceIso,
    degraded: obs.degraded,
    weatherSource,
    locationHint
  };
}

async function buildIpAtisBundle(ipNorm: string): Promise<IpAtisBundle> {
  let lat = env.ATIS_FALLBACK_LAT;
  let lon = env.ATIS_FALLBACK_LON;
  let locationHint: string | null = null;

  if (isNonRoutableClientIp(ipNorm)) {
    locationHint = "Default location (private or loopback IP)";
  } else {
    const geo = await resolveIpToLatLon(ipNorm, AbortSignal.timeout(8000));
    if (geo) {
      lat = geo.lat;
      lon = geo.lon;
      locationHint = geo.label;
    } else {
      locationHint = "Geo lookup failed — default coordinates";
    }
  }

  return buildCoordsAtisBundle(lat, lon, locationHint);
}

export type AtisLiveWeatherAnchor = "pilot_geo_ip" | "tower_fixed";

export type GetAtisCurrentForClientOptions = {
  /** Default `pilot_geo_ip`: Open-Meteo at caller IP. `tower_fixed`: shared tower desk coords. */
  anchor?: AtisLiveWeatherAnchor;
};

function withoutPublicAtisLocation(p: AtisCurrentPayload): AtisCurrentPayload {
  if (p.locationHint == null) {
    return p;
  }
  return { ...p, locationHint: null };
}

/**
 * ATIS readout for authed clients. When `ATIS_LIVE_WEATHER` is on, wind/temp/visibility come from
 * Open-Meteo — either at the client's geo-located IP (`pilot_geo_ip`, in-game + pilots) or at
 * `ATIS_TOWER_WEATHER_*` for `tower_fixed` (controller+). The information letter still follows
 * reference-station hysteresis so everyone stays in sync.
 */
export async function getAtisCurrentForClient(
  ipRaw: string,
  opts?: GetAtisCurrentForClientOptions
): Promise<AtisCurrentPayload> {
  if (!env.ATIS_LIVE_WEATHER) {
    return withoutPublicAtisLocation(cachedPayload);
  }
  const ttlMs = env.ATIS_LIVE_CACHE_SECONDS * 1000;
  const now = Date.now();
  const anchor: AtisLiveWeatherAnchor = opts?.anchor ?? "pilot_geo_ip";

  if (anchor === "tower_fixed") {
    const hit = ipAtisCache.get(TOWER_ATIS_CACHE_KEY);
    if (hit && now - hit.fetchedAt < ttlMs) {
      return withoutPublicAtisLocation(composeLiveClientPayload(hit, new Date()));
    }
    const bundle = await buildCoordsAtisBundle(
      env.ATIS_TOWER_WEATHER_LAT,
      env.ATIS_TOWER_WEATHER_LON,
      env.ATIS_TOWER_WEATHER_LABEL.trim() || null
    );
    touchLruMap(ipAtisCache, TOWER_ATIS_CACHE_KEY, bundle, env.ATIS_LIVE_CACHE_MAX_IPS);
    return withoutPublicAtisLocation(composeLiveClientPayload(bundle, new Date()));
  }

  const ip = normalizeClientIp(ipRaw) || "127.0.0.1";
  const hit = ipAtisCache.get(ip);
  if (hit && now - hit.fetchedAt < ttlMs) {
    return withoutPublicAtisLocation(composeLiveClientPayload(hit, new Date()));
  }
  const bundle = await buildIpAtisBundle(ip);
  touchLruMap(ipAtisCache, ip, bundle, env.ATIS_LIVE_CACHE_MAX_IPS);
  return withoutPublicAtisLocation(composeLiveClientPayload(bundle, new Date()));
}

/** @deprecated Use {@link getAtisCurrentForClient} with the request IP. */
export function getAtisCurrent(): AtisCurrentPayload {
  return withoutPublicAtisLocation(cachedPayload);
}

function schedulerMeta(fromLive: boolean, loadDeg: boolean): {
  weatherSource: AtisWeatherSource;
  locationHint: string | null;
} {
  const weatherSource: AtisWeatherSource = fromLive ? "live" : loadDeg ? "default" : "file";
  return { weatherSource, locationHint: null };
}

async function tick(): Promise<void> {
  const now = new Date();
  const { weather, sourceIso, degraded: loadDeg, fromLive } = await loadSchedulerObservation();
  const notamBlock = "";
  const runwayId = DEFAULT_RUNWAY;
  const mat = materialFromInputs(weather, runwayId, "");
  const meta = schedulerMeta(fromLive, loadDeg);

  if (!baselineMaterial) {
    baselineMaterial = mat;
    lastAdvanceAt = Date.now();
    recomputeCache(
      weather,
      runwayId,
      NATO_LETTERS[letterIndex]!,
      notamBlock,
      now,
      new Date(lastAdvanceAt).toISOString(),
      sourceIso,
      loadDeg,
      mat,
      meta
    );
    return;
  }

  if (materiallyChanged(baselineMaterial, mat)) {
    const elapsed = Date.now() - lastAdvanceAt;
    if (elapsed >= env.ATIS_MIN_ADVANCE_SECONDS * 1000) {
      letterIndex = (letterIndex + 1) % NATO_LETTERS.length;
      lastAdvanceAt = Date.now();
      baselineMaterial = mat;
      const letter = NATO_LETTERS[letterIndex]!;
      recomputeCache(
        weather,
        runwayId,
        letter,
        notamBlock,
        now,
        new Date(lastAdvanceAt).toISOString(),
        sourceIso,
        loadDeg,
        mat,
        meta
      );
      return;
    }
  }

  const letter = NATO_LETTERS[letterIndex]!;
  const advancedIso = new Date(lastAdvanceAt).toISOString();
  recomputeCache(weather, runwayId, letter, notamBlock, now, advancedIso, sourceIso, loadDeg, mat, meta);
}

export async function forceAdvanceAtis(clientIp?: string): Promise<AtisCurrentPayload> {
  const { weather, sourceIso, degraded: loadDeg, fromLive } = await loadSchedulerObservation();
  const notamBlock = "";
  const mat = materialFromInputs(weather, DEFAULT_RUNWAY, "");
  letterIndex = (letterIndex + 1) % NATO_LETTERS.length;
  lastAdvanceAt = Date.now();
  baselineMaterial = mat;
  const letter = NATO_LETTERS[letterIndex]!;
  const now = new Date();
  recomputeCache(
    weather,
    DEFAULT_RUNWAY,
    letter,
    notamBlock,
    now,
    new Date(lastAdvanceAt).toISOString(),
    sourceIso,
    loadDeg,
    mat,
    schedulerMeta(fromLive, loadDeg)
  );
  if (env.ATIS_LIVE_WEATHER && clientIp) {
    return getAtisCurrentForClient(clientIp);
  }
  return getAtisCurrent();
}

export async function regenAtisCache(clientIp?: string): Promise<AtisCurrentPayload> {
  invalidateAtisLiveWeatherCaches();
  const { weather, sourceIso, degraded: loadDeg, fromLive } = await loadSchedulerObservation();
  const notamBlock = "";
  const mat = materialFromInputs(weather, DEFAULT_RUNWAY, "");
  // Re-baseline so an admin "regen" doesn't immediately trip the next tick into
  // an unintentional letter advance — regen is "use what's on disk *as if* it
  // were the current snapshot," not "make the next tick advance."
  baselineMaterial = mat;
  const letter = NATO_LETTERS[letterIndex]!;
  const now = new Date();
  recomputeCache(
    weather,
    DEFAULT_RUNWAY,
    letter,
    notamBlock,
    now,
    new Date(lastAdvanceAt).toISOString(),
    sourceIso,
    loadDeg,
    mat,
    schedulerMeta(fromLive, loadDeg)
  );
  if (env.ATIS_LIVE_WEATHER && clientIp) {
    return getAtisCurrentForClient(clientIp);
  }
  return getAtisCurrent();
}

/**
 * Pure helpers exposed for unit tests. NOT part of the public service surface —
 * routes and bootstrap should stick to the exported functions above so the
 * shared module-level state (cache, baseline, scheduler handle) stays the
 * single source of truth.
 */
export const __testInternals = {
  NATO_LETTERS,
  composeLines,
  composeConfigFromEnv,
  extractNotamAdvisories,
  ROLEPLAY_FIELD_STATUS_LINES,
  spellDigits,
  windDirSpeech,
  windKtSpeech,
  runwaySpeech,
  altimeterSpeech,
  tempSpeech,
  visibilitySpeech,
  zuluTimeSpeech,
  circularDiffDeg,
  materiallyChanged,
  materialFromInputs,
  contentHashStable,
  DEFAULT_WEATHER,
  DEFAULT_RUNWAY
};

export function startAtisScheduler(): () => void {
  if (tickHandle) {
    return () => {
      clearInterval(tickHandle);
      tickHandle = undefined;
    };
  }
  void tick().catch((err) => logger.error({ err }, "ATIS initial tick failed"));
  tickHandle = setInterval(() => {
    void tick().catch((err) => logger.error({ err }, "ATIS tick failed"));
  }, env.ATIS_TICK_SECONDS * 1000);
  return () => {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = undefined;
  };
}
