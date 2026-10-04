import { z } from "zod";
import { logger } from "../lib/logger";

/** Same numeric fields as `atis.weather.json` (validated upstream by weatherFileSchema). */
export type AtisOpenMeteoWeather = {
  windDirDeg: number;
  windKt: number;
  visibilitySm: number;
  skyConditions: string;
  tempC: number;
  dewpointC: number;
  altimeterInHg: number;
};

const openMeteoCurrentSchema = z.object({
  current: z.object({
    time: z.string(),
    interval: z.number().optional(),
    temperature_2m: z.number(),
    dew_point_2m: z.number().optional(),
    relative_humidity_2m: z.number().optional(),
    wind_speed_10m: z.number(),
    wind_direction_10m: z.number(),
    surface_pressure: z.number().optional(),
    cloud_cover: z.number().optional(),
    weather_code: z.number().optional(),
    visibility: z.number().optional()
  })
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function visibilitySmFromMeters(m: number | undefined, weatherCode: number | undefined): number {
  if (m !== undefined && Number.isFinite(m) && m > 0) {
    return clamp(m / 1609.344, 0, 100);
  }
  if (weatherCode === 45 || weatherCode === 48) {
    return 0.25;
  }
  if (weatherCode !== undefined && weatherCode >= 51 && weatherCode <= 67) {
    return clamp(3, 0, 100);
  }
  return 10;
}

function skyPhrase(cloudCover: number | undefined, weatherCode: number | undefined): string {
  const cc = cloudCover ?? 0;
  const code = weatherCode ?? 0;
  if (code === 45 || code === 48) {
    return "fog reducing visibility along the field";
  }
  if (code >= 95) {
    return "thunderstorms in the vicinity";
  }
  if (cc >= 88 || code === 3) {
    return "overcast ceiling three thousand";
  }
  if (cc >= 63 || code === 2) {
    return "broken clouds at three thousand";
  }
  if (cc >= 38) {
    return "scattered clouds at four thousand";
  }
  if (cc >= 12 || code === 1) {
    return "few clouds at three five hundred";
  }
  return "clear below one two thousand";
}

function dewpointEstimate(tempC: number, rh: number | undefined, reported: number | undefined): number {
  if (reported !== undefined && Number.isFinite(reported)) {
    return Math.round(reported * 10) / 10;
  }
  if (rh !== undefined && rh >= 0 && rh <= 100) {
    const a = 17.625;
    const b = 243.04;
    const alpha = Math.log(Math.max(0.0001, rh / 100)) + (a * tempC) / (b + tempC);
    const dp = (b * alpha) / (a - alpha);
    if (Number.isFinite(dp)) {
      return Math.round(dp * 10) / 10;
    }
  }
  return Math.round((tempC - 2) * 10) / 10;
}

/**
 * Map Open-Meteo `current` object (already validated) into ATIS weather fields.
 * Exported for unit tests.
 */
export function mapOpenMeteoCurrentToWeather(current: z.infer<typeof openMeteoCurrentSchema>["current"]): AtisOpenMeteoWeather {
  const windDirDeg = Math.round(current.wind_direction_10m) % 360;
  const windKt = clamp(Math.round(current.wind_speed_10m), 0, 200);
  const tempC = Math.round(current.temperature_2m * 10) / 10;
  const dewpointC = dewpointEstimate(
    current.temperature_2m,
    current.relative_humidity_2m,
    current.dew_point_2m
  );
  const altInHg =
    current.surface_pressure !== undefined && Number.isFinite(current.surface_pressure)
      ? Math.round((current.surface_pressure / 33.8638866667) * 100) / 100
      : 29.92;
  const altimeterInHg = clamp(altInHg, 28, 31);
  const visibilitySm = Math.round(visibilitySmFromMeters(current.visibility, current.weather_code) * 10) / 10;
  const skyConditions = skyPhrase(current.cloud_cover, current.weather_code);

  return {
    windDirDeg,
    windKt,
    visibilitySm,
    skyConditions,
    tempC,
    dewpointC,
    altimeterInHg
  };
}

export function observationIsoFromOpenMeteoTime(t: string): string {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
  }
  const d = new Date(`${t.replace(" ", "T")}Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

export type AtisOpenMeteoBundle = {
  weather: AtisOpenMeteoWeather;
  /** Open-Meteo `current.time` (UTC). */
  observationIso: string;
};

/**
 * Fetch current conditions from Open-Meteo (no API key). Uses wind in knots.
 */
export async function fetchOpenMeteoCurrent(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<AtisOpenMeteoBundle | null> {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    wind_speed_unit: "kn",
    current: [
      "temperature_2m",
      "dew_point_2m",
      "relative_humidity_2m",
      "wind_speed_10m",
      "wind_direction_10m",
      "surface_pressure",
      "cloud_cover",
      "weather_code",
      "visibility"
    ].join(",")
  });
  const url = `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
  try {
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) {
      logger.warn({ lat, lon, status: res.status }, "ATIS Open-Meteo: HTTP error");
      return null;
    }
    const json: unknown = await res.json();
    const parsed = openMeteoCurrentSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn({ lat, lon, err: parsed.error }, "ATIS Open-Meteo: unexpected JSON shape");
      return null;
    }
    const cur = parsed.data.current;
    return {
      weather: mapOpenMeteoCurrentToWeather(cur),
      observationIso: observationIsoFromOpenMeteoTime(cur.time)
    };
  } catch (e) {
    logger.warn({ err: e, lat, lon }, "ATIS Open-Meteo: request failed");
    return null;
  }
}
