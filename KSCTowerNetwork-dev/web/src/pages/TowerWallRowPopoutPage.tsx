import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  TowerWallRowPane,
  MAX_ROW_HEIGHT_FR,
  type TowerWallLayoutRow,
  type TowerWallRowPopoutPayloadV1
} from "../components/TowerWall";

/**
 * Dev StrictMode mounts effects twice; cache per-window parsed payload so the
 * second mount doesn't trip the "expired" path after we remove sessionStorage.
 */
const POPROW_PAYLOAD_CACHE = new Map<string, TowerWallRowPopoutPayloadV1>();

const PAYLOAD_KEYS = ["v", "sessionId", "basePersistKey", "sourceRowIndex", "showBoothSlot", "row"] as const;
const LAYOUT_ROW_KEYS = ["cells", "widths", "heightWeight"] as const;
const MONITOR_SOURCE_KINDS = new Set([
  "empty",
  "hullcam-grid",
  "hullcam-recent",
  "hullcam-id",
  "countdown",
  "status",
  "telemetry",
  "schematic",
  "vessel-schematic",
  "body-map",
  "tower-radar",
  "dragon-radar-map",
  "kos-screen",
  "acars-chat",
  "voice",
  "booth",
  "tower-view",
  "off-world-traffic",
  "active-roster",
  "scorecard",
  "staging-move"
]);

function isFiniteInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object";
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function hasExactKeys(x: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(x);
  return keys.length === expected.length && expected.every((k) => Object.prototype.hasOwnProperty.call(x, k));
}

function hasAllowedKeys(x: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(x).every((k) => allowed.includes(k));
}

function isMonitorSource(x: unknown): boolean {
  if (!isRecord(x)) return false;
  if (!isNonEmptyString(x.kind) || !MONITOR_SOURCE_KINDS.has(x.kind)) return false;
  if ("bindSessionId" in x && x.bindSessionId !== undefined && !isNonEmptyString(x.bindSessionId)) return false;
  if ("radarPpiOriginId" in x && x.radarPpiOriginId !== undefined) {
    if (x.kind !== "tower-radar") return false;
    if (!isNonEmptyString(x.radarPpiOriginId)) return false;
  }
  if (x.kind === "hullcam-id") {
    if (!hasAllowedKeys(x, ["kind", "cameraId", "bindSessionId"])) return false;
    return isFiniteInt(x.cameraId) && x.cameraId >= 0;
  }
  if (x.kind === "tower-radar") {
    return hasAllowedKeys(x, ["kind", "bindSessionId", "radarPpiOriginId"]);
  }
  return hasAllowedKeys(x, ["kind", "bindSessionId"]);
}

function isLayoutRow(x: unknown): x is TowerWallLayoutRow {
  if (!isRecord(x)) return false;
  if (!hasExactKeys(x, LAYOUT_ROW_KEYS)) return false;
  if (!Array.isArray(x.cells) || !Array.isArray(x.widths)) return false;
  if (x.cells.length === 0 || x.cells.length !== x.widths.length) return false;
  if (!x.cells.every(isMonitorSource)) return false;
  if (!x.widths.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 1)) return false;
  if (typeof x.heightWeight !== "number" || !Number.isFinite(x.heightWeight)) return false;
  if (x.heightWeight <= 0 || x.heightWeight > MAX_ROW_HEIGHT_FR) return false;
  return true;
}

function isPopoutPayloadV1(x: unknown): x is TowerWallRowPopoutPayloadV1 {
  if (!isRecord(x)) return false;
  if (!hasExactKeys(x, PAYLOAD_KEYS)) return false;
  const { v, sessionId, basePersistKey, sourceRowIndex, showBoothSlot, row } = x;
  return (
    v === 1 &&
    isNonEmptyString(sessionId) &&
    isNonEmptyString(basePersistKey) &&
    isFiniteInt(sourceRowIndex) &&
    sourceRowIndex >= 0 &&
    typeof showBoothSlot === "boolean" &&
    isLayoutRow(row)
  );
}

function parsePopoutPayload(json: string): TowerWallRowPopoutPayloadV1 | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return isPopoutPayloadV1(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `/tower/wall/row?k=…` — one row popped from the monitor wall. Payload is written to
 * `sessionStorage` by the parent wall immediately before `window.open`; we read once
 * and remove the key so refresh does not resurrect stale layouts.
 */
export function TowerWallRowPopoutPage(): JSX.Element {
  const [params] = useSearchParams();
  const storageKey = params.get("k")?.trim() ?? "";

  const [payload, setPayload] = useState<TowerWallRowPopoutPayloadV1 | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!storageKey) {
      setErr("Missing row key. Use “Pop row ↗” on the wall.");
      return;
    }
    const cached = POPROW_PAYLOAD_CACHE.get(storageKey);
    if (cached) {
      setPayload(cached);
      return;
    }
    let raw: string | null;
    try {
      raw = sessionStorage.getItem(storageKey);
    } catch {
      setErr("Could not read session storage.");
      return;
    }
    if (!raw) {
      setErr("Row data expired or already opened — close this window and pop the row out again from the wall.");
      return;
    }
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    const parsed = parsePopoutPayload(raw);
    if (!parsed) {
      setErr("Invalid row payload.");
      return;
    }
    POPROW_PAYLOAD_CACHE.set(storageKey, parsed);
    setPayload(parsed);
  }, [storageKey]);

  useEffect(() => {
    if (!payload) return;
    const notifyParent = (): void => {
      if (!window.opener || window.opener.closed) return;
      window.opener.postMessage(
        {
          type: "tower-wall-row-popout-closed",
          persistKey: payload.basePersistKey,
          rowIndex: payload.sourceRowIndex
        },
        window.location.origin
      );
    };
    window.addEventListener("beforeunload", notifyParent);
    return () => window.removeEventListener("beforeunload", notifyParent);
  }, [payload]);

  const slotPrefix = useMemo(() => {
    if (!payload) return "";
    return `${payload.basePersistKey}-poprow-${payload.sourceRowIndex}`;
  }, [payload]);

  if (err) {
    return (
      <div className="card">
        <h2>Wall row</h2>
        <p className="msg error" style={{ marginTop: "0.5rem" }}>
          {err}
        </p>
        <p style={{ marginTop: "1rem" }}>
          <Link to="/tower">Back to Tower</Link>
        </p>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="card">
        <p>Loading row…</p>
      </div>
    );
  }

  return (
    <TowerWallRowPane
      sessionId={payload.sessionId}
      slotPersistKeyPrefix={slotPrefix}
      showBoothSlot={payload.showBoothSlot}
      initialRow={payload.row}
      sourceRowIndex={payload.sourceRowIndex}
    />
  );
}
