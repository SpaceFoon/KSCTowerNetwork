import { z } from "zod";
import { logger } from "../lib/logger";

const ipwhoSchema = z.object({
  success: z.boolean(),
  latitude: z.number().finite().optional(),
  longitude: z.number().finite().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  message: z.string().optional()
});

export type AtisGeoHit = {
  lat: number;
  lon: number;
  /** Human-readable hint for the Tower Desk (no street-level precision). */
  label: string;
};

/**
 * Strip IPv4-mapped IPv6 prefix Express sometimes uses (`::ffff:10.0.0.1`).
 */
export function normalizeClientIp(ip: string): string {
  const t = ip.trim();
  if (t.startsWith("::ffff:")) {
    return t.slice(7);
  }
  return t;
}

/**
 * True for loopback, unspecified, RFC1918, link-local, and ULA IPv6 — not usable for public geo APIs.
 */
export function isNonRoutableClientIp(ip: string): boolean {
  const raw = normalizeClientIp(ip).toLowerCase();
  if (!raw || raw === "0.0.0.0") return true;
  if (raw === "::1" || raw === "localhost") return true;

  // IPv4
  if (!raw.includes(":")) {
    const p = raw.split(".").map((x) => Number(x));
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = p;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    return false;
  }

  // IPv6 (minimal checks)
  if (raw.startsWith("fe80:")) return true;
  if (raw.startsWith("fc") || raw.startsWith("fd")) return true;
  if (raw === "::") return true;
  return false;
}

/**
 * HTTPS ipwho.is — no API key. Rate-limited; callers should cache results.
 */
export async function resolveIpToLatLon(ip: string, signal?: AbortSignal): Promise<AtisGeoHit | null> {
  const norm = normalizeClientIp(ip);
  if (!norm || isNonRoutableClientIp(norm)) {
    return null;
  }

  const url = `https://ipwho.is/${encodeURIComponent(norm)}`;
  try {
    const res = await fetch(url, {
      signal,
      headers: { Accept: "application/json" },
      redirect: "follow"
    });
    if (!res.ok) {
      logger.warn({ ip: norm, status: res.status }, "ATIS geo: ipwho.is HTTP error");
      return null;
    }
    const json: unknown = await res.json();
    const parsed = ipwhoSchema.safeParse(json);
    if (!parsed.success || !parsed.data.success) {
      logger.warn({ ip: norm, msg: parsed.success ? parsed.data.message : parsed.error }, "ATIS geo: lookup failed");
      return null;
    }
    const { latitude, longitude, city, region, country } = parsed.data;
    if (latitude === undefined || longitude === undefined) {
      return null;
    }
    const place = [city, region, country].filter(Boolean).join(", ");
    return {
      lat: latitude,
      lon: longitude,
      label: place.length > 0 ? place : `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`
    };
  } catch (e) {
    logger.warn({ err: e, ip: norm }, "ATIS geo: ipwho.is request failed");
    return null;
  }
}
