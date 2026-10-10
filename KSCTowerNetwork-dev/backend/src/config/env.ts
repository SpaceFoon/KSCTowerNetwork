import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const cwd = process.cwd();
// Test settings must not be replaced by the developer's credentials or runtime configuration.
const isTestProcess = process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
if (!isTestProcess) {
  dotenv.config({ path: path.join(cwd, ".env") });
  if (process.env.NODE_ENV !== "production") {
    dotenv.config({ path: path.join(cwd, ".env.development"), override: true });
  }
}

const DEV_DEFAULT_APP_JWT_SECRET = "dev-only-change-me-please";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(48787),
  /**
   * Local dev mode: skip external auth and use DEV_USER_* identity (development/test only).
   * Defaults to `false`. Used to default `true`, which silently turned any non-prod
   * deployment into an open relay — set explicitly to opt in.
   */
  DEV_OPEN_AUTH: z
    .preprocess((v) => {
      if (v === undefined || v === "") return false;
      if (typeof v === "string") {
        const n = v.trim().toLowerCase();
        return n === "1" || n === "true" || n === "yes" || n === "on";
      }
      return Boolean(v);
    }, z.boolean())
    .default(false),
  /**
   * Allow the built-in dev login (tower@ksc.local / tower12345) when WEB_LOGIN_USERS_JSON
   * is not set. Off by default. Refused in production by the guard below.
   */
  DEV_DEFAULT_WEB_USER: z
    .preprocess((v) => {
      if (v === undefined || v === "") return false;
      if (typeof v === "string") {
        const n = v.trim().toLowerCase();
        return n === "1" || n === "true" || n === "yes" || n === "on";
      }
      return Boolean(v);
    }, z.boolean())
    .default(false),
  /**
   * Force the in-memory persistence path even when DB/Redis are reachable. Off by default.
   * Used to be implicit when `NODE_ENV !== production && DEV_OPEN_AUTH`, which made it easy
   * to lose data on a misconfigured staging box.
   */
  DEV_IN_MEMORY: z
    .preprocess((v) => {
      if (v === undefined || v === "") return false;
      if (typeof v === "string") {
        const n = v.trim().toLowerCase();
        return n === "1" || n === "true" || n === "yes" || n === "on";
      }
      return Boolean(v);
    }, z.boolean())
    .default(false),
  /** Optional shared dev bearer; if set and DEV_OPEN_AUTH=false, token must match this. */
  DEV_BEARER_SECRET: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(20).optional()),
  DEV_USER_ID: z.string().min(1).default("dev_local"),
  /**
   * In dev (`DEV_OPEN_AUTH`), the dev principal is forced to this role. Use `owner` to see the
   * full UI. Legacy role names (`tower`/`supervisor`/`admin`) from older `.env.development`
   * files are accepted and translated transparently so existing setups don't crash on boot.
   */
  DEV_USER_ROLE: z
    .preprocess((v) => {
      if (typeof v !== "string") return v;
      const mapped: Record<string, string> = {
        tower: "controller",
        supervisor: "supermod",
        admin: "owner"
      };
      return mapped[v] ?? v;
    }, z.enum(["guest", "pilot", "controller", "mod", "supermod", "owner"]))
    .default("owner"),
  /** Single user id that is hardcoded as `owner`. Survives DB writes; cannot be banned/demoted via API. */
  OWNER_USER_ID: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).optional()),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_JWT_KEY: z.string().optional(),
  MARIADB_HOST: z.string().default("127.0.0.1"),
  MARIADB_PORT: z.coerce.number().int().positive().default(3306),
  MARIADB_USER: z.string().default("root"),
  MARIADB_PASSWORD: z.string().default(""),
  MARIADB_DATABASE: z.string().default("ksc_tower"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  APP_JWT_SECRET: z.string().min(16).default(DEV_DEFAULT_APP_JWT_SECRET),
  APP_JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  /** WebSocket URL for browsers (e.g. wss://your-project.livekit.cloud). */
  LIVEKIT_WS_URL: z.string().optional(),
  /** Same as Cloud dashboard "URL" / some docs — used if LIVEKIT_WS_URL is missing or still a placeholder. */
  LIVEKIT_URL: z.string().optional(),
  /**
   * When DEV_OPEN_AUTH is on, optional HTTP header name (e.g. `x-ksc-voice-identity`).
   * If the request includes that header with a safe id (`^[a-zA-Z0-9_-]{1,64}$`),
   * that value overrides `DEV_USER_ID` for this request so two browsers can simulate pilot vs tower.
   * Never set in production.
   */
  DEV_VOICE_IDENTITY_HEADER: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).max(64).optional()),
  /**
   * When DEV_OPEN_AUTH is on, "bridge" the dev open-auth web request to whatever
   * userId the in-game plugin most recently authenticated as from the same client
   * IP (within DEV_OPEN_AUTH_BRIDGE_TTL_SECONDS). Without this, dev open-auth
   * stamps every web request as `DEV_USER_ID="dev_local"` while the plugin sends
   * a real `plugin_session` JWT with `sub=<real Tower userId>` — so the room a
   * pilot creates in-game appears as someone else's to their own browser, and
   * `/v1/me/active-room` returns null even though their plugin is publishing
   * telemetry to it. Production is unaffected (DEV_OPEN_AUTH is forbidden in
   * production by the guard below). Default on so local dev "just works".
   */
  DEV_OPEN_AUTH_BRIDGE_TO_PLUGIN: z
    .preprocess((v) => {
      if (v === undefined || v === "") return true;
      if (typeof v === "string") {
        const n = v.trim().toLowerCase();
        return n === "1" || n === "true" || n === "yes" || n === "on";
      }
      return Boolean(v);
    }, z.boolean())
    .default(true),
  /** How long a recently-seen plugin_session userId remains the dev-open identity bridge target for its IP. */
  DEV_OPEN_AUTH_BRIDGE_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 60),
  /**
   * Comma-separated LiveKit identities that represent the KSP voice-bridge (not human browsers).
   * Tokens for these ids get a clear Participant.name so the web room shows "game + bridge" presence.
   */
  LIVEKIT_BRIDGE_IDENTITIES: z.string().default("ksp_bridge"),
  LIVEKIT_BRIDGE_DISPLAY_NAME: z.string().default("Kerbal Space Program (voice bridge)"),
  /** Live browser subscription transport path (plain WebSocket for now). */
  LIVE_WS_PATH: z.string().default("/v1/live/ws"),
  LIVE_WS_ENABLED: z.preprocess((v) => {
    if (v === undefined || v === "") return true;
    if (typeof v === "string") {
      const n = v.trim().toLowerCase();
      return n === "1" || n === "true" || n === "yes" || n === "on";
    }
    return Boolean(v);
  }, z.boolean()),
  LIVE_UDP_HOST: z.string().default("0.0.0.0"),
  LIVE_UDP_PORT: z.coerce.number().int().min(1).max(65535).default(48788),
  LIVE_UDP_ENABLED: z.preprocess((v) => {
    if (v === undefined || v === "") return true;
    if (typeof v === "string") {
      const n = v.trim().toLowerCase();
      return n === "1" || n === "true" || n === "yes" || n === "on";
    }
    return Boolean(v);
  }, z.boolean()),
  LIVE_UDP_MAX_PACKET_BYTES: z.coerce.number().int().min(256).max(65535).default(8192),
  TELEMETRY_DEFAULT_SECONDS: z.coerce.number().positive().default(5),
  TELEMETRY_CLOSE_SECONDS: z.coerce.number().positive().default(1),
  TELEMETRY_CLOSE_AGL_M: z.coerce.number().nonnegative().default(15000),
  /**
   * When > 0, periodically soft-close tower sessions whose last telemetry sample is
   * older than this many seconds (same effect as lobby "Close"). `0` disables the sweep.
   * Excludes `dev-shared`, `ksc-radio-*`, and `KSC-TOWER-*` sessions. Sessions that
   * never received telemetry are not closed (pilot may still be briefing on the pad).
   */
  PILOT_IDLE_CLOSE_SECONDS: z.coerce.number().int().nonnegative().default(120),
  /**
   * Wall-clock interval between idle checks. Ignored when `PILOT_IDLE_CLOSE_SECONDS` is 0.
   */
  PILOT_IDLE_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  /**
   * Comma-separated list of allowed CORS origins (e.g. `https://tower.example.com`).
   * `*` is accepted but disables credentialed CORS. If unset:
   *   - dev: defaults to common Vite dev origins on localhost
   *   - prod: defaults to empty (no cross-origin browser requests allowed)
   * Used to be `cors({ origin: true, credentials: true })` which reflected any origin.
   */
  CORS_ORIGINS: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  /**
   * Express `trust proxy` setting. Drives `req.ip` (used for IP bans + rate limit
   * keying) so it MUST match your real deployment topology:
   *   - Direct (no proxy):                "false"          (req.ip = socket peer)
   *   - Single trusted proxy (nginx):     "1"
   *   - Multiple proxies / k8s ingress:   "2", "3", ...
   *   - Specific subnet:                  "10.0.0.0/8"
   *   - Default (loopback only):          "loopback, linklocal, uniquelocal"
   *
   * Trusting too much lets clients spoof X-Forwarded-For and bypass IP bans /
   * rate limits. Trusting too little gives every guest the proxy IP and a
   * single bad actor can ban the whole front-end.
   */
  TRUST_PROXY: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional())
    .default("loopback, linklocal, uniquelocal"),
  /**
   * Self-serve signup gate. The landing page reads this via /v1/site/info and
   * shows or hides the signup form / invite-code field accordingly.
   *   - "closed"      (default): no signup. Operator manages WEB_LOGIN_USERS_JSON.
   *   - "open"        : anyone with email + password can register as REGISTRATION_DEFAULT_ROLE.
   *   - "invite_only" : registration requires a valid invite code from /v1/admin/invite-codes.
   *   - "open_or_invite" : both paths work (open signup AND invite codes accepted).
   * Default is intentionally "closed" so a deployer who pulls a fresh build
   * doesn't accidentally accept random signups before they've thought about it.
   */
  REGISTRATION_MODE: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.enum(["closed", "open", "invite_only", "open_or_invite"]))
    .default("closed"),
  /**
   * Role assigned to accounts created via /v1/auth/register when no invite code
   * is used (or the invite code itself does not pin a role). Invite codes can
   * still mint a higher role if the owner created them that way.
   */
  REGISTRATION_DEFAULT_ROLE: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.enum(["guest", "pilot", "controller", "mod", "supermod"]))
    .default("pilot"),
  /**
   * Where the registered-users JSON store lives on disk. The file holds
   * argon2id hashes — never plaintext. Created on first successful register.
   */
  REGISTERED_USERS_PATH: z.string().default("./data/registered-users.json"),
  /** Where the invite-code JSON store lives on disk. */
  INVITE_CODES_PATH: z.string().default("./data/invite-codes.json"),
  /** Display name shown in the landing-page hero / browser title. */
  PROJECT_DISPLAY_NAME: z.string().default("KSC Tower Network"),
  /** One-paragraph project description for the landing-page hero. */
  PROJECT_TAGLINE: z
    .string()
    .default(
      "Real human ATC for Kerbal Space Program. Pilots talk to controllers over LiveKit voice while live telemetry from the KSP plugin feeds the web tower map, optional ghost-fleet traffic for pilots who enable it, and per-frequency channels."
    ),
  /**
   * Direct download URL for the plugin (e.g. GitHub Releases page or a pinned
   * .zip asset). Surfaced on the landing page so new players can grab the
   * client without hunting through README files.
   */
  PLUGIN_DOWNLOAD_URL: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().url().optional()),
  /** Optional CKAN catalog identifier (e.g. "KSCTowerNetwork"). Landing page renders the standard CKAN install snippet if set. */
  PLUGIN_CKAN_IDENTIFIER: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().min(1).optional()),
  /** Optional GitHub source URL (linked from landing-page footer). */
  PROJECT_REPO_URL: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().url().optional()),
  /** Optional Discord/community invite URL (linked from landing-page footer). */
  PROJECT_DISCORD_URL: z
    .preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().url().optional()),
  /** Relative to backend process cwd (the `backend/` folder when running npm scripts). */
  ATIS_WEATHER_PATH: z.string().default("./data/atis.weather.json"),
  /** Weather-only bulletin vs roleplay-expanded advisory template. */
  ATIS_MODE: z.enum(["weather", "roleplay"]).default("weather"),
  ATIS_TICK_SECONDS: z.coerce.number().int().positive().default(30),
  /** Minimum wall time between NATO letter advances (set to 0 in dev to test quickly). */
  ATIS_MIN_ADVANCE_SECONDS: z.coerce.number().int().nonnegative().default(60),
  /** In roleplay mode, derive 1..N short advisory lines from the NOTAM text block. */
  ATIS_ROLEPLAY_INCLUDE_NOTAM_ADVISORIES: z
    .preprocess((v) => {
      if (v === undefined || v === "") return true;
      if (typeof v === "string") {
        const n = v.trim().toLowerCase();
        return n === "1" || n === "true" || n === "yes" || n === "on";
      }
      return Boolean(v);
    }, z.boolean())
    .default(true),
  /** Maximum number of short NOTAM-derived advisories to include (roleplay mode). */
  ATIS_ROLEPLAY_MAX_NOTAM_ADVISORIES: z.coerce.number().int().min(1).max(3).default(2),
  /** In roleplay mode, append one optional field-status line (pattern/training/etc). */
  ATIS_ROLEPLAY_INCLUDE_FIELD_STATUS: z
    .preprocess((v) => {
      if (v === undefined || v === "") return true;
      if (typeof v === "string") {
        const n = v.trim().toLowerCase();
        return n === "1" || n === "true" || n === "yes" || n === "on";
      }
      return Boolean(v);
    }, z.boolean())
    .default(true),
  /** In roleplay mode, include "advisory only" disclaimer line. */
  ATIS_ROLEPLAY_INCLUDE_DISCLAIMER: z
    .preprocess((v) => {
      if (v === undefined || v === "") return true;
      if (typeof v === "string") {
        const n = v.trim().toLowerCase();
        return n === "1" || n === "true" || n === "yes" || n === "on";
      }
      return Boolean(v);
    }, z.boolean())
    .default(true),
  /** In roleplay mode, include concise information-letter closer. */
  ATIS_ROLEPLAY_INCLUDE_CLOSER: z
    .preprocess((v) => {
      if (v === undefined || v === "") return true;
      if (typeof v === "string") {
        const n = v.trim().toLowerCase();
        return n === "1" || n === "true" || n === "yes" || n === "on";
      }
      return Boolean(v);
    }, z.boolean())
    .default(true),
  /**
   * When true, `/v1/atis/current` composes wind/temp/visibility from Open-Meteo. Pilots and
   * the in-game plugin use the caller's IP (geo via ipwho.is). Controller+ roles use
   * `ATIS_TOWER_WEATHER_*` so the tower desk reads a shared reference (default: Washington, DC).
   * Letter advances still use `ATIS_REFERENCE_*` so everyone stays on the same information letter.
   */
  ATIS_LIVE_WEATHER: z.preprocess((v) => {
    if (v === undefined || v === "") {
      // Avoid flaky outbound HTTP during `node --test` / `npm test` (NODE_ENV may still be
      // "development" from dotenv). Opt in for tests with ATIS_LIVE_WEATHER=true.
      const underNodeTest = process.argv.includes("--test");
      if (underNodeTest || process.env.NODE_ENV === "test") {
        return false;
      }
      return true;
    }
    if (typeof v === "string") {
      const n = v.trim().toLowerCase();
      if (n === "1" || n === "true" || n === "yes" || n === "on") return true;
      if (n === "0" || n === "false" || n === "no" || n === "off") return false;
    }
    return Boolean(v);
  }, z.boolean()),
  /** Open-Meteo observation point for letter-advance hysteresis (default: Cape Canaveral area). */
  ATIS_REFERENCE_LAT: z.coerce.number().finite().min(-90).max(90).default(28.5729),
  ATIS_REFERENCE_LON: z.coerce.number().finite().min(-180).max(180).default(-80.649),
  /** Used when the client IP is private/loopback or geo lookup fails. */
  ATIS_FALLBACK_LAT: z.coerce.number().finite().min(-90).max(90).default(28.5729),
  ATIS_FALLBACK_LON: z.coerce.number().finite().min(-180).max(180).default(-80.649),
  /** Open-Meteo point for controller+ (tower web) when `ATIS_LIVE_WEATHER` is on. */
  ATIS_TOWER_WEATHER_LAT: z.coerce.number().finite().min(-90).max(90).default(38.9072),
  ATIS_TOWER_WEATHER_LON: z.coerce.number().finite().min(-180).max(180).default(-77.0369),
  ATIS_TOWER_WEATHER_LABEL: z.string().max(200).default("Washington, DC (tower reference)"),
  /** Per-IP cached bundle TTL (geo + Open-Meteo) for `/atis/current`. */
  ATIS_LIVE_CACHE_SECONDS: z.coerce.number().int().positive().default(600),
  /** Max distinct client IPs remembered for live ATIS cache (LRU). */
  ATIS_LIVE_CACHE_MAX_IPS: z.coerce.number().int().positive().default(500)
});

export const env = envSchema.parse(process.env);

/** Resolves the wss URL sent to the web client. Ignores obvious .env.example placeholders. */
export function getLiveKitWsUrl(): string | undefined {
  const primary = env.LIVEKIT_WS_URL?.trim();
  const fallback = env.LIVEKIT_URL?.trim();
  const isPlaceholder = (s: string | undefined): boolean => !s || /example\.com/i.test(s);
  if (!isPlaceholder(primary)) return primary;
  if (!isPlaceholder(fallback)) return fallback;
  return undefined;
}

if (env.NODE_ENV === "production" && env.APP_JWT_SECRET === DEV_DEFAULT_APP_JWT_SECRET) {
  throw new Error("APP_JWT_SECRET must be overridden in production");
}

if (env.NODE_ENV === "production" && (env.DEV_BEARER_SECRET || env.DEV_OPEN_AUTH)) {
  throw new Error("DEV_* auth flags must not be set in production");
}

if (env.NODE_ENV === "production" && env.DEV_VOICE_IDENTITY_HEADER) {
  throw new Error("DEV_VOICE_IDENTITY_HEADER must not be set in production");
}

if (env.NODE_ENV === "production" && env.DEV_DEFAULT_WEB_USER) {
  throw new Error("DEV_DEFAULT_WEB_USER must not be set in production");
}

if (env.NODE_ENV === "production" && env.DEV_IN_MEMORY) {
  throw new Error("DEV_IN_MEMORY must not be set in production");
}
