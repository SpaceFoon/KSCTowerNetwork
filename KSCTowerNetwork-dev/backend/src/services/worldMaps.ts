import createDOMPurify, { type WindowLike } from "dompurify";
import { JSDOM } from "jsdom";
import { z } from "zod";
import { logger } from "../lib/logger";

// Single shared DOMPurify bound to a JSDOM window. Cheap to keep around;
// re-creating it per request is what blew the original PR's CPU profile.
// The cast is necessary because JSDOM's Window typing doesn't perfectly
// satisfy DOMPurify's structural WindowLike, but at runtime it ships every
// constructor (Element, Node, DOMParser, …) DOMPurify reaches for.
const purify = createDOMPurify(new JSDOM("").window as unknown as WindowLike);

/**
 * DOMPurify always reports removal of JSDOM's implicit document `body` wrapper when sanitizing a
 * bare SVG string. That is not a security signal — only real subtree/attribute removals are.
 */
function meaningfulDomPurifyRemovals(removed: typeof purify.removed): typeof purify.removed {
  return removed.filter((r) => {
    if (!r || typeof r !== "object") return true;
    if ("attribute" in r) return true;
    const el = (r as { element?: Element }).element;
    if (el && typeof el.tagName === "string") {
      const tag = el.tagName.toUpperCase();
      if (tag === "BODY" || tag === "HTML") return false;
    }
    return true;
  });
}

export class UnsafeSvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSvgError";
  }
}

/**
 * Strip script tags, event handlers (`onclick`, `onload`, …), `<foreignObject>`,
 * external references (`href`, `xlink:href`), and any other non-SVG content.
 *
 * Returns the sanitized SVG bytes and a flag set to true when DOMPurify removed
 * anything — we promote that to a 400 in the route so a hostile or malformed
 * plugin gets a loud rejection instead of silently serving a stripped basemap.
 */
export function sanitizeSvgBytes(raw: Buffer): Buffer {
  const text = raw.toString("utf8");
  const clean = purify.sanitize(text, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Belt-and-suspenders on top of the SVG profile: the basemap never needs to
    // reach out to a third-party origin, so block every URL-bearing attribute
    // and the foreignObject escape hatch outright.
    FORBID_TAGS: ["script", "foreignObject", "use", "iframe", "object", "embed", "a"],
    FORBID_ATTR: [
      "href",
      "xlink:href",
      "xmlns:xlink",
      "onload",
      "onerror",
      "onclick",
      "onmouseover",
      "onmouseout",
      "onmousedown",
      "onmouseup",
      "onfocus",
      "onblur",
      "onbegin",
      "onend",
      "onrepeat",
      "formaction",
      "action"
    ],
    KEEP_CONTENT: false,
    RETURN_TRUSTED_TYPE: false
  });
  const meaningful = meaningfulDomPurifyRemovals(purify.removed);
  if (meaningful.length > 0) {
    logger.warn(
      { removed: meaningful.length, sample: meaningful.slice(0, 3) },
      "world-maps SVG: DOMPurify stripped unsafe nodes"
    );
    throw new UnsafeSvgError(
      `SVG contains unsafe nodes (${meaningful.length} stripped). Re-bake from a clean PQS scan.`
    );
  }
  // Final paranoia: textual scan for `javascript:` URIs, which DOMPurify
  // strips by default but we want to be explicit about so a future config
  // tweak can't silently re-enable them.
  if (/javascript\s*:/i.test(clean)) {
    throw new UnsafeSvgError("SVG contains a javascript: URI");
  }
  return Buffer.from(clean, "utf8");
}

/**
 * Schema for the JSON envelope the KSP plugin (`TowerBasemapBaker.cs`) POSTs once per game session
 * with the baked basemap. Schemaversion is sent as a string so we can refuse old plugin builds
 * with a clean 400 instead of trying to render a half-decoded payload.
 *
 * v3: Bytes are PNG (extracted from `body.scaledBody` color texture and `body.BiomeMap`) instead
 * of SVG sampled from PQS. Field name is `bytesBase64`; `contentType` discriminates "image/png"
 * vs "image/svg+xml" so future SVG-based layers (e.g. quantitative slope) can coexist.
 *
 * Bytes are base64-encoded so the JSON is safe to log + free of escape headaches. Decoded bytes
 * are stored as a `Buffer` and served as the declared `contentType` from the GET route —
 * SVGs go through DOMPurify, PNGs pass through (raster, nothing to sanitize).
 */
// 16 MB base64 ≈ 12 MB raw per layer. Stock Kerbin at native 2048x1024 is 1-2 MB total;
// RSS Earth at 8192x4096 PNG-compressed terrain typically lands at 5-15 MB per layer. The
// per-layer cap interacts with `RECORD_BYTES_MAX` (sum across layers) and with
// `WORLD_MAPS_JSON_PARSER` in routes/api.ts — keep them all in sync if you raise this.
const BYTES_BASE64_MAX = 16 * 1024 * 1024;
/**
 * Sum-of-decoded-layer-bytes cap per session record. Bounds memory pressure even when
 * the schema would let an attacker post 4 max-size layers. RSS Earth full-quality is
 * ~20-30 MB across alt + biome + slope; 32 MB leaves headroom for that without letting
 * a single session balloon the heap. Worst case at MAX_SESSIONS records: ~1 GB.
 */
const RECORD_BYTES_MAX = 32 * 1024 * 1024;

export class WorldMapsTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldMapsTooLargeError";
  }
}

export const worldMapsSchema = z.object({
  schemaVersion: z.string().min(1).max(8),
  scannedAt: z.number().int().nonnegative(),
  body: z.object({
    name: z.string().min(1).max(64),
    displayName: z.string().min(1).max(64),
    radiusM: z.number().positive().finite()
  }),
  layers: z
    .array(
      z.object({
        id: z.enum(["alt", "biome", "slope"]),
        label: z.string().min(1).max(32),
        contentType: z.enum(["image/svg+xml", "image/png"]),
        viewBoxW: z.number().int().positive().max(8192),
        viewBoxH: z.number().int().positive().max(8192),
        minH: z.number().finite().optional(),
        maxH: z.number().finite().optional(),
        // Free-form palette key the web chart-key reads to label the swatches; legacy "jebbesen" or "generic".
        // Constrained to a short identifier so a malformed plugin can't sneak HTML into the legend.
        hypsometryKey: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
        bytesBase64: z
          .string()
          .min(64)
          .max(BYTES_BASE64_MAX)
          // Raw base64; reject anything that isn't standard alphabet + padding so we never
          // hand the browser bytes whose decoded payload mismatches the declared content-type.
          .regex(/^[A-Za-z0-9+/]+=?=?$/)
      })
    )
    .min(1)
    .max(4)
    .refine(
      (layers) => new Set(layers.map((l) => l.id)).size === layers.length,
      { message: "Duplicate world-maps layer id" }
    ),
  /**
   * Named surface features extracted from the body's PQSCity/PQSCity2 MonoBehaviours: stock
   * anomalies (Mun arches, KSC2, monoliths, the Duna face), modded anomalies (Anomaly Surveyor,
   * Sentinel Mission), and any KSC building the plugin couldn't classify as "facility" and
   * filter out. Optional — bodies with no PQSCity (gas giants, some custom packs) omit it.
   * Capped well above any sane planet pack: stock has ~30 anomalies on Kerbin's surface,
   * Anomaly-Surveyor-style packs add at most a few dozen more.
   */
  features: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        lat: z.number().finite().min(-90).max(90),
        lon: z.number().finite().min(-360).max(360),
        kind: z.enum(["anomaly", "facility", "unknown"])
      })
    )
    .max(256)
    .optional()
});

export type WorldMapsPayload = z.infer<typeof worldMapsSchema>;

export type WorldMapsLayerRecord = {
  id: "alt" | "biome" | "slope";
  label: string;
  contentType: "image/svg+xml" | "image/png";
  viewBoxW: number;
  viewBoxH: number;
  minH?: number;
  maxH?: number;
  hypsometryKey?: string;
  /** Decoded raw bytes (PNG or sanitized SVG) — served as-is with the recorded `contentType`. */
  bytes: Buffer;
  /** SHA1 of the decoded bytes (used as the ETag so the browser can revalidate cheaply). */
  etag: string;
};

export type WorldMapsFeature = {
  name: string;
  lat: number;
  lon: number;
  kind: "anomaly" | "facility" | "unknown";
};

export type WorldMapsRecord = {
  schemaVersion: string;
  scannedAt: number;
  /** Server-side wallclock UNIX seconds; UI shows "baked 14s ago" off this. */
  receivedAt: number;
  /** ID of the user that POSTed (so a controller can't quietly clobber the pilot's bake). */
  publisherUserId: string;
  body: {
    name: string;
    displayName: string;
    radiusM: number;
  };
  layers: WorldMapsLayerRecord[];
  /** Named surface features (anomalies, facility buildings) — empty array when none extracted. */
  features: WorldMapsFeature[];
};

const TTL_SECONDS = 6 * 60 * 60;
// Kept conservative: a single session's record can already pin RECORD_BYTES_MAX of heap,
// so worst-case in-memory residency is MAX_SESSIONS * RECORD_BYTES_MAX (~1 GB at the cap).
const MAX_SESSIONS = 32;

/**
 * In-memory store. Mirrors `worldInventory.ts`. Losing this on restart is fine because the plugin
 * re-bakes (or re-POSTs from its on-disk PluginData/maps cache) on the next Space Center entry.
 */
const records = new Map<string, WorldMapsRecord>();

function gc(now: number): void {
  if (records.size <= MAX_SESSIONS) {
    let expired: string[] | null = null;
    for (const [k, v] of records) {
      if (now - v.receivedAt > TTL_SECONDS) {
        (expired ??= []).push(k);
      }
    }
    if (expired) {
      for (const k of expired) records.delete(k);
    }
    return;
  }

  const entries = [...records.entries()].sort((a, b) => a[1].receivedAt - b[1].receivedAt);
  const drop = entries.length - MAX_SESSIONS;
  for (let i = 0; i < drop; i++) {
    const e = entries[i];
    if (e) records.delete(e[0]);
  }
}

function sha1Hex(buf: Buffer): string {
  // Lazy-load crypto so this module stays tree-shakeable for non-Node test runners.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha1").update(buf).digest("hex");
}

export function setWorldMaps(
  sessionId: string,
  publisherUserId: string,
  payload: WorldMapsPayload
): WorldMapsRecord {
  const now = Math.floor(Date.now() / 1000);
  const layers: WorldMapsLayerRecord[] = payload.layers.map((l) => {
    // SVG layers go through DOMPurify (sanitizeSvgBytes throws UnsafeSvgError on unsafe nodes,
    // which the route handler converts to a 400 — we deliberately do not silently strip).
    // PNG layers pass through untouched: raster bytes can't carry script content, and re-encoding
    // would mean a CPU-heavy round-trip through Sharp/jimp for no security benefit.
    const raw = Buffer.from(l.bytesBase64, "base64");
    const bytes = l.contentType === "image/svg+xml" ? sanitizeSvgBytes(raw) : raw;
    return {
      id: l.id,
      label: l.label,
      contentType: l.contentType,
      viewBoxW: l.viewBoxW,
      viewBoxH: l.viewBoxH,
      minH: l.minH,
      maxH: l.maxH,
      hypsometryKey: l.hypsometryKey,
      bytes,
      etag: `W/"${sha1Hex(bytes)}"`
    };
  });

  // Aggregate cap defends against the schema permitting 4 * BYTES_BASE64_MAX worth of layers.
  // Route handler maps WorldMapsTooLargeError -> 413 so the client sees a clear failure.
  const totalBytes = layers.reduce((sum, l) => sum + l.bytes.length, 0);
  if (totalBytes > RECORD_BYTES_MAX) {
    throw new WorldMapsTooLargeError(
      `world-maps payload too large: ${totalBytes} bytes across ${layers.length} layers (max ${RECORD_BYTES_MAX})`
    );
  }

  const rec: WorldMapsRecord = {
    schemaVersion: payload.schemaVersion,
    scannedAt: payload.scannedAt,
    receivedAt: now,
    publisherUserId,
    body: payload.body,
    layers,
    features: payload.features ?? []
  };
  records.set(sessionId, rec);
  gc(now);
  return rec;
}

export function getWorldMaps(sessionId: string): WorldMapsRecord | undefined {
  const rec = records.get(sessionId);
  if (!rec) return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (now - rec.receivedAt > TTL_SECONDS) {
    records.delete(sessionId);
    return undefined;
  }
  return rec;
}

export function getWorldMapsLayer(
  sessionId: string,
  layerId: "alt" | "biome" | "slope"
): { rec: WorldMapsRecord; layer: WorldMapsLayerRecord } | undefined {
  const rec = getWorldMaps(sessionId);
  if (!rec) return undefined;
  const layer = rec.layers.find((l) => l.id === layerId);
  if (!layer) return undefined;
  return { rec, layer };
}
