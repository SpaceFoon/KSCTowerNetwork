/** Canonical MHz from API/plugin: three whole digits + dot + three fractional digits. */
const CANON_MHZ = /^([0-9]{3})\.([0-9]{3})$/;

/**
 * Pretty-print canonical `NNN.NNN` MHz for UI: trim useless trailing fractional zeros
 * but keep up to three decimals when needed (25 kHz style), e.g. `122.000` → `122.00`,
 * `118.025` → `118.025`.
 */
export function displayMhzFromCanonical(mhz: string | null | undefined): string {
  if (mhz == null) return "";
  const t = mhz.trim();
  const m = CANON_MHZ.exec(t);
  if (!m || m[1] === undefined || m[2] === undefined) return t;
  const whole = parseInt(m[1], 10);
  let frac = m[2];
  while (frac.length > 2 && frac.endsWith("0")) {
    frac = frac.slice(0, -1);
  }
  if (frac.length === 0) return String(whole);
  return `${whole}.${frac}`;
}

/** Format a numeric MHz (any precision) for display after snapping to 1 mHz canonical grid. */
export function displayMhzFromNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  const scaled = Math.round(n * 1000);
  const w = Math.trunc(scaled / 1000);
  const f = ((scaled % 1000) + 1000) % 1000;
  const canon = `${String(w).padStart(3, "0")}.${String(f).padStart(3, "0")}`;
  return displayMhzFromCanonical(canon);
}
