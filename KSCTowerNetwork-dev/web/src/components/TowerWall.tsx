import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  HullCamPanel,
  HullCamTile,
  useHullCamList,
  type CameraSummary
} from "./HullCamPanel";
import { SystemSchematic } from "./SystemSchematic";
import { BodyMap, type BodyMapVessel } from "./BodyMap";
import {
  KerbinTowerMap,
  aircraftPrimaryLabel,
  formatFarFlapSetting,
  formatKerbinDays,
  formatRadiation,
  type Telemetry as MapTelemetry
} from "./KerbinTowerMap";
import { HOME_DAY_SECONDS_FALLBACK, LIFE_SUPPORT_LABEL } from "../tower/kerbalismLifeSupportLabels";
import { commsStatus, commsStatusLabel } from "./mapComms";
import { TowerRadarWallSlot } from "./TowerRadarScope";
import { TowerDragonRadarWallSlot } from "./TowerDragonRadarWallSlot";
import { buildTowerAircraftTracks, type ActiveAircraftWire } from "../tower/towerAircraftTracks";
import { KosScreenPanel } from "./KosScreenPanel";
import { VesselSchematicPanel } from "./VesselSchematicPanel";
import { TowerViewPanel } from "./TowerViewPanel";
import { OffWorldTrafficPanel, type OffWorldVessel } from "./OffWorldTrafficPanel";
import { basemapUrlFor } from "../data/systemCatalog";
import { useSystemCatalog } from "../data/useSystemCatalog";
import { KERBIN_LAUNCH_SITES } from "../data/kerbinLaunchSites";
import { KERBIN_NAVAIDS } from "../data/kerbinNavaids";
import {
  fetchWorldInventory,
  launchSitesForBody,
  navaidsForBody,
  type WorldInventory
} from "../data/worldInventoryClient";
import { queryKeys } from "../query/client";
import { useApiQuery, useQueryClient } from "../query/hooks";
import { getStoredUser } from "../auth/session";
import { useAuthMe } from "../auth/useAuthMe";
import { CountdownPanel } from "../session/CountdownPanel";
import { StagingMovePanel } from "../session/StagingMovePanel";
import { Scorecard } from "../session/Scorecard";
import { ChatDesk } from "../pages/ChatDesk";
import { VoiceDesk } from "../pages/VoiceDesk";
import { BoothDesk } from "../pages/BoothDesk";
import { CALLSIGN_DISPLAY_HELP } from "../tower/callsignTooltips";
import { deriveFlightStatusPill, deriveGameLinkLabel } from "../tower/flightStatus";
import { useTowerLiveSubscriptions } from "../live/useTowerLiveSubscriptions";
import { displayMhzFromCanonical, displayMhzFromNumber } from "../lib/displayMhz";
import { fetchSiteInfo, type SiteInfo } from "../api/site";

/**
 * TowerWall: customizable "monitor wall" arranged as rows-of-cells. Each row picks
 * its own column count, and each cell has a relative width weight (1 = baseline,
 * 2 = double, etc.) so layouts like "countdown | status | kOS" with one column at
 * 2× width are first-class instead of needing CSS overrides.
 *
 * The **status** source renders one wrap row of compact cards per lobby pilot
 * (`GET /v1/lobby/rooms`), each card polling `GET /v1/session/:roomId` for
 * requests, link health, and at-a-glance vessel fields from the game. Persisted
 * layouts may still store `kind: "telemetry"`; that kind maps to the same UI.
 *
 * Mounted both inline at the top of TowerDesk and as the body of the standalone
 * /wall page. The `persistKey` prop namespaces all per-instance `localStorage`
 * keys (KerbinTowerMap zoom/pan/toggles per slot) so those two mount points
 * don't trample each other.
 *
 * The full row/cell layout is persisted under the same `persistKey` (see
 * `wallLayoutStorageKey`) so refreshes and revisits keep the operator's wall.
 */

const MIN_ROWS = 1;
const MAX_ROWS = 8;
const MIN_COLS = 1;
const MAX_COLS = 8;
/** Hard cap on the relative width input so a fat-finger 999 can't blow out the layout. */
const MAX_WEIGHT = 12;

/**
 * Row **H** is an integer step; each step maps to `ROW_HEIGHT_VH_PER_UNIT` viewport
 * height (`vh`). Example: `ROW_HEIGHT_VH_PER_UNIT = 8` → H=1 → 8vh, H=10 → 80vh.
 */
const ROW_HEIGHT_VH_PER_UNIT = 8;
export const MIN_ROW_HEIGHT_VH = 1;
export const MAX_ROW_HEIGHT_VH = 60;
/** Re-export old names so popout/type imports keep compiling. */
export const MIN_ROW_HEIGHT_TIER = MIN_ROW_HEIGHT_VH;
export const MAX_ROW_HEIGHT_TIER = MAX_ROW_HEIGHT_VH;
export const MIN_ROW_HEIGHT_FR = MIN_ROW_HEIGHT_VH;
export const MAX_ROW_HEIGHT_FR = MAX_ROW_HEIGHT_VH;

/**
 * Snap row H (`vh`) for persistence and after the H field blurs.
 */
export function commitRowHeightFr(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 10;
  const rounded = Math.round(n);
  return Math.max(MIN_ROW_HEIGHT_VH, Math.min(MAX_ROW_HEIGHT_VH, rounded));
}

/** Pixel-ish `vh` used in `grid-template-rows` (H × scale). */
function rowHeightToViewportVh(height: number): number {
  return commitRowHeightFr(height) * ROW_HEIGHT_VH_PER_UNIT;
}

function capRowHeightWhileTyping(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < MIN_ROW_HEIGHT_VH) return MIN_ROW_HEIGHT_VH;
  if (r > MAX_ROW_HEIGHT_VH) return MAX_ROW_HEIGHT_VH;
  return r;
}

/**
 * Source kinds a slot can render. New sources only need:
 *   1. a `MonitorSourceKind` entry,
 *   2. a label in `SOURCE_LABELS`,
 *   3. a render branch in `<SlotContent>` (e.g. `tower-radar` PPI, `dragon-radar-map` hunt map).
 *
 * Hullcam-by-id is encoded as `hullcam:<id>` rather than a separate kind so a
 * pilot rebooting (which can renumber cameras) cleanly falls back to "no signal".
 */
type MonitorSourceKind =
  | "empty"
  | "hullcam-grid"
  | "hullcam-recent"
  | "hullcam-id"
  | "countdown"
  | "status"
  | "telemetry"
  | "schematic"
  | "vessel-schematic"
  | "body-map"
  | "tower-radar"
  | "dragon-radar-map"
  | "kos-screen"
  | "acars-chat"
  | "voice"
  | "booth"
  | "tower-view"
  | "off-world-traffic"
  | "active-roster"
  | "scorecard"
  | "staging-move";

type SessionBoundSource = {
  /** Optional per-slot room override; absent = follow the wall's tracked session. */
  bindSessionId?: string;
  /**
   * `tower-radar` only: PPI reference on the home body. `ksc` / absent = published KSC anchor;
   * `site:<launchSiteId>` = that launch site from world-inventory (e.g. desert airfield).
   */
  radarPpiOriginId?: string;
};

type MonitorSource =
  | ({ kind: Exclude<MonitorSourceKind, "hullcam-id"> } & SessionBoundSource)
  | ({ kind: "hullcam-id"; cameraId: number } & SessionBoundSource);

const SOURCE_LABELS: Record<MonitorSourceKind, string> = {
  empty: "-- empty --",
  "hullcam-grid": "Hull cameras (grid)",
  "hullcam-recent": "Hull cameras (most recent)",
  "hullcam-id": "Hull camera (by id)",
  countdown: "Launch countdown",
  status: "Pilot cards (game link + vessel)",
  telemetry: "Pilot cards (game link + vessel)",
  schematic: "System schematic",
  "vessel-schematic": "Vessel schematic (parts)",
  "body-map": "Body map (follows vessel)",
  "tower-radar": "Airfield radar PPI (center = launch pad)",
  "dragon-radar-map": "Dragon Radar (map · balls only)",
  "kos-screen": "kOS screen output",
  "acars-chat": "ACARS (pilot text)",
  voice: "Voice (LiveKit)",
  booth: "Booth (spectators)",
  "tower-view": "Tower view streams",
  "off-world-traffic": "Off-world traffic",
  "active-roster": "Tower station status",
  scorecard: "Scorecard (rep + tickets)",
  "staging-move": "Ramp / taxi positions"
};

const SESSION_BOUND_SOURCE_KINDS = new Set<MonitorSourceKind>([
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
  "off-world-traffic",
  "scorecard",
  "staging-move"
]);

const WORLD_CONTEXT_SOURCE_KINDS = new Set<MonitorSourceKind>([
  "schematic",
  "body-map",
  "tower-radar",
  "dragon-radar-map",
  "off-world-traffic"
]);

const HULLCAM_SOURCE_KINDS = new Set<MonitorSourceKind>([
  "hullcam-grid",
  "hullcam-recent",
  "hullcam-id"
]);

function normalizeBoundSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sourceSupportsSessionBinding(source: Pick<MonitorSource, "kind">): boolean {
  return SESSION_BOUND_SOURCE_KINDS.has(source.kind);
}

function sourceUsesWorldContext(source: Pick<MonitorSource, "kind">): boolean {
  return WORLD_CONTEXT_SOURCE_KINDS.has(source.kind);
}

function sourceUsesHullCams(source: Pick<MonitorSource, "kind">): boolean {
  return HULLCAM_SOURCE_KINDS.has(source.kind);
}

function withBoundSessionId(source: MonitorSource, bindSessionId?: string): MonitorSource {
  const nextBind = normalizeBoundSessionId(bindSessionId);
  if (!sourceSupportsSessionBinding(source) || !nextBind) {
    const { bindSessionId: _ignored, ...rest } = source;
    return rest as MonitorSource;
  }
  return { ...source, bindSessionId: nextBind };
}

/**
 * Wall layout = ordered list of rows. Each row has its own column count via
 * `cells.length` and per-cell relative widths via `widths` (CSS `fr` units, so
 * `[1, 2, 1]` is 25% / 50% / 25%). Heights are uniform across rows; if we ever
 * want per-row heights we can add a `heightWeight` field the same way.
 */
type Row = {
  cells: MonitorSource[];
  /** Per-cell relative widths, mapped to CSS `fr` units. */
  widths: number[];
  /** Row height step H; rendered height = H × `ROW_HEIGHT_VH_PER_UNIT` vh. */
  heightWeight: number;
};

/** Exported for row pop-out payload typing / validation in `TowerWallRowPopoutPage`. */
export type TowerWallLayoutRow = Row;

/** Session-scratch payload for `/tower/wall/row?k=` (one-shot read in the pop-up). */
export type TowerWallRowPopoutPayloadV1 = {
  v: 1;
  sessionId: string;
  basePersistKey: string;
  sourceRowIndex: number;
  showBoothSlot: boolean;
  row: TowerWallLayoutRow;
};

/**
 * Default layout: row 1 is map-only (full width). Row 2 is comms (messages +
 * voice + booth when allowed). Row 3 is tower-view streams + system map.
 */
function defaultLayout(showBooth: boolean): Row[] {
  const commsRow: Row = showBooth
    ? {
        cells: [{ kind: "acars-chat" }, { kind: "voice" }, { kind: "booth" }],
        widths: [1, 1, 1],
        heightWeight: 9
      }
    : {
        cells: [{ kind: "acars-chat" }, { kind: "voice" }],
        widths: [1, 1],
        heightWeight: 9
      };

  const opsOverviewRow: Row = {
    cells: [{ kind: "tower-view" }, { kind: "schematic" }],
    widths: [1, 1],
    heightWeight: 9
  };

  const deskExtrasRow: Row = {
    cells: [
      { kind: "off-world-traffic" },
      { kind: "active-roster" },
      { kind: "scorecard" },
      { kind: "kos-screen" }
    ],
    widths: [1, 1, 1, 1],
    heightWeight: 9
  };

  return [
    {
      cells: [{ kind: "body-map" }],
      widths: [1],
      heightWeight: 22
    },
    commsRow,
    opsOverviewRow,
    {
      cells: [{ kind: "staging-move" }, { kind: "countdown" }, { kind: "status" }],
      widths: [1, 1, 1],
      heightWeight: 9
    },
    {
      cells: [{ kind: "hullcam-grid" }],
      widths: [1],
      heightWeight: 13
    },
    deskExtrasRow
  ];
}

/** Resize a row's cells/widths to `cols`, preserving existing picks. */
function resizeRow(row: Row, cols: number): Row {
  const target = Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
  if (row.cells.length === target) return row;
  if (target > row.cells.length) {
    const extraCells: MonitorSource[] = Array.from(
      { length: target - row.cells.length },
      () => ({ kind: "empty" })
    );
    const extraWidths: number[] = Array.from(
      { length: target - row.widths.length },
      () => 1
    );
    return {
      cells: [...row.cells, ...extraCells],
      widths: [...row.widths, ...extraWidths],
      heightWeight: row.heightWeight
    };
  }
  return {
    cells: row.cells.slice(0, target),
    widths: row.widths.slice(0, target),
    heightWeight: row.heightWeight
  };
}

const WALL_LAYOUT_STORAGE_VERSION = 3 as const;

type WallLayoutStoredV1 = {
  v: typeof WALL_LAYOUT_STORAGE_VERSION;
  showBoothSlot: boolean;
  rows: Row[];
};

function wallLayoutStorageKey(persistKey: string): string {
  return `ksct.towerwall.layoutV1:${persistKey}`;
}

/** Operator-chosen default layout for "Reset to defaults" (separate from the live autosaved layout). */
function wallUserDefaultsStorageKey(persistKey: string): string {
  return `ksct.towerwall.userDefaultsV1:${persistKey}`;
}

function clampLayoutInt(u: unknown, min: number, max: number): number {
  const n = typeof u === "number" ? u : Number(u);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const KNOWN_SOURCE_KINDS = new Set<string>(Object.keys(SOURCE_LABELS));

function parseMonitorSource(raw: unknown, showBoothSlot: boolean): MonitorSource {
  if (!raw || typeof raw !== "object") return { kind: "empty" };
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  const bindSessionId = normalizeBoundSessionId(o.bindSessionId);
  if (typeof kind !== "string" || !KNOWN_SOURCE_KINDS.has(kind)) return { kind: "empty" };
  if (kind === "hullcam-id") {
    const id = o.cameraId;
    const cameraId = typeof id === "number" && Number.isFinite(id) ? Math.round(id) : Number.NaN;
    if (!Number.isFinite(cameraId)) return withBoundSessionId({ kind: "hullcam-recent" }, bindSessionId);
    return withBoundSessionId({ kind: "hullcam-id", cameraId }, bindSessionId);
  }
  if (kind === "booth" && !showBoothSlot) return { kind: "empty" };
  const radarPpiOriginId =
    kind === "tower-radar" && typeof o.radarPpiOriginId === "string" && o.radarPpiOriginId.trim().length > 0
      ? o.radarPpiOriginId.trim()
      : undefined;
  const base: MonitorSource = { kind: kind as Exclude<MonitorSourceKind, "hullcam-id"> };
  const withRadar =
    kind === "tower-radar" && radarPpiOriginId ? ({ ...base, radarPpiOriginId } as MonitorSource) : base;
  return withBoundSessionId(withRadar, bindSessionId);
}

function parseStoredRow(raw: unknown, showBoothSlot: boolean): Row | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.cells) || o.cells.length === 0) return null;
  const colCount = Math.max(MIN_COLS, Math.min(MAX_COLS, o.cells.length));
  const cells = o.cells
    .slice(0, colCount)
    .map((c) => parseMonitorSource(c, showBoothSlot));
  let widths: number[] = Array.isArray(o.widths)
    ? o.widths.map((w) => clampLayoutInt(w, 1, MAX_WEIGHT)).slice(0, colCount)
    : [];
  while (widths.length < colCount) widths.push(1);
  if (widths.length > colCount) widths = widths.slice(0, colCount);
  const heightWeight = commitRowHeightFr(
    typeof o.heightWeight === "number" ? o.heightWeight : Number(o.heightWeight)
  );
  return resizeRow({ cells, widths, heightWeight }, colCount);
}

function parsePersistedWallLayoutJson(json: string, showBoothSlot: boolean): Row[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== WALL_LAYOUT_STORAGE_VERSION) return null;
  if (!Array.isArray(o.rows)) return null;
  const rows = o.rows
    .slice(0, MAX_ROWS)
    .map((r) => parseStoredRow(r, showBoothSlot))
    .filter((r): r is Row => r !== null);
  if (rows.length < MIN_ROWS) return null;
  return rows;
}

function readPersistedWallLayout(persistKey: string, showBoothSlot: boolean): Row[] | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(wallLayoutStorageKey(persistKey));
  } catch {
    return null;
  }
  if (!raw) return null;
  return parsePersistedWallLayoutJson(raw, showBoothSlot);
}

function writePersistedWallLayout(persistKey: string, showBoothSlot: boolean, rows: Row[]): void {
  if (typeof window === "undefined") return;
  const payload: WallLayoutStoredV1 = {
    v: WALL_LAYOUT_STORAGE_VERSION,
    showBoothSlot,
    rows: JSON.parse(JSON.stringify(rows)) as Row[]
  };
  try {
    window.localStorage.setItem(wallLayoutStorageKey(persistKey), JSON.stringify(payload));
  } catch {
    /* private mode / quota */
  }
}

function clearPersistedWallLayout(persistKey: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(wallLayoutStorageKey(persistKey));
  } catch {
    /* ignore */
  }
}

function readPersistedWallUserDefaults(persistKey: string, showBoothSlot: boolean): Row[] | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(wallUserDefaultsStorageKey(persistKey));
  } catch {
    return null;
  }
  if (!raw) return null;
  return parsePersistedWallLayoutJson(raw, showBoothSlot);
}

function writePersistedWallUserDefaults(persistKey: string, showBoothSlot: boolean, rows: Row[]): void {
  if (typeof window === "undefined") return;
  const payload: WallLayoutStoredV1 = {
    v: WALL_LAYOUT_STORAGE_VERSION,
    showBoothSlot,
    rows: JSON.parse(JSON.stringify(rows)) as Row[]
  };
  try {
    window.localStorage.setItem(wallUserDefaultsStorageKey(persistKey), JSON.stringify(payload));
  } catch {
    /* private mode / quota */
  }
}

function sanitizeRowsForBoothSlot(rows: Row[], showBoothSlot: boolean): Row[] {
  if (showBoothSlot) return rows;
  return rows.map((row) => ({
    ...row,
    cells: row.cells.map((c) => (c.kind === "booth" ? ({ kind: "empty" } as MonitorSource) : c))
  }));
}

/** Border / tone for the desk session strip (`TowerPage` → `TowerDesk` → `TowerWall`). */
export type SessionStripEmphasis = "default" | "active-tower" | "spectator" | "no-tower";

export type TowerWallProps = {
  /**
   * Active session id the wall feeds (hullcams, telemetry, world inventory, etc.).
   * Pass the parent's session id directly so we don't duplicate the localStorage /
   * storage-event plumbing in this component  that's the page-level concern.
   */
  sessionId: string;
  /**
   * Stable per-mount key used to namespace child component `localStorage` (e.g.
   * each `KerbinTowerMap` cell persists its own zoom/pan/toggles under
   * `<persistKey>-r<row>c<col>`). Pick distinct values when mounting the wall in
   * multiple places (the desk vs. the standalone /wall page) so their map
   * states don't trample each other.
   */
  persistKey: string;
  /**
   * If provided, the wall layout dialog includes a "Pop out full wall" control
   * that calls this on click. Intended for the desk-inline mount: it
   * `window.open`'s `/tower/wall` so the controller can drag the standalone wall
   * to a second monitor while keeping the desk view live. Omit on the popup
   * itself so it does not offer to pop itself out again.
   */
  onPopOut?: () => void;
  /**
   * When false, the booth monitor source is hidden and the default layout uses
   * two comms columns (pilots never see the booth desk on the old tower page).
   */
  showBoothSlot?: boolean;
  /**
   * When set (e.g. `SessionHeader` on TowerDesk), rendered in the same bar as the
   * Wall layout control so room id / callsign / squawk read as one strip.
   */
  sessionStrip?: ReactNode;
  /** Left cluster: shown before `sessionStrip` (e.g. “You are active tower!”). */
  sessionStripLeading?: ReactNode;
  /** Right cluster: shown before the Wall layout button (e.g. Quit tower). */
  sessionStripTrailing?: ReactNode;
  /** Strip border tone: controller (green), spectator read-only (green), empty seat / claim (accent). */
  sessionStripEmphasis?: SessionStripEmphasis;
};

export function TowerWall({
  sessionId,
  persistKey,
  onPopOut,
  showBoothSlot = true,
  sessionStrip,
  sessionStripLeading,
  sessionStripTrailing,
  sessionStripEmphasis = "default"
}: TowerWallProps): JSX.Element {
  const sessionStripToneClass =
    sessionStripEmphasis === "active-tower" || sessionStripEmphasis === "spectator"
      ? " tower-wall__session-strip--strip-ok"
      : sessionStripEmphasis === "no-tower"
        ? " tower-wall__session-strip--no-tower"
        : "";
  const [rows, setRows] = useState<Row[]>(() => {
    const stored = readPersistedWallLayout(persistKey, showBoothSlot);
    if (stored) return stored;
    return defaultLayout(showBoothSlot);
  });
  const [poppedRows, setPoppedRows] = useState<Set<number>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaultsSaveHint, setDefaultsSaveHint] = useState<string | null>(null);
  const defaultsSaveHintTimerRef = useRef<number | null>(null);
  const settingsDialogId = useId();
  const settingsTitleId = useId();

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setDefaultsSaveHint(null);
    if (defaultsSaveHintTimerRef.current != null) {
      window.clearTimeout(defaultsSaveHintTimerRef.current);
      defaultsSaveHintTimerRef.current = null;
    }
  }, []);

  // Main-wall layout dialog still shows a quick "N hullcams live" summary for the
  // tracked room; per-slot camera pickers fetch their own lists below.
  const { cameras } = useHullCamList(sessionId);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSettingsOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [settingsOpen]);

  // World inventory + catalog drive the schematic / body-map sources. Both are
  // cheap and cached, so it's fine to fetch even if no cell is using them yet.
  // (Yes, when mounted inside TowerDesk this duplicates the desk's own inventory
  // poll. The 60s cadence makes that acceptable; the alternative is prop-drilling
  // optional inventory + catalog through every consumer.)
  const [worldInventory, setWorldInventory] = useState<WorldInventory | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchWorldInventory(sessionId).then((wi) => {
      if (!cancelled) setWorldInventory(wi);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  // Fall back to the bundled stock catalog when the KSP plugin hasn't published
  // `/v1/world-inventory/{sessionId}` yet  keeps the schematic cell useful instead
  // of showing "system catalog isn't loaded" forever on a fresh session.
  const catalogState = useSystemCatalog(worldInventory?.worldId ?? "kerbin-stock");
  const catalog = catalogState.kind === "ready" ? catalogState.catalog : null;

  const setRowCount = useCallback((next: number) => {
    const clamped = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(next)));
    setRows((prev) => {
      if (prev.length === clamped) return prev;
      if (clamped > prev.length) {
        // New rows default to a single empty cell with baseline height; the
        // operator can then bump the col count, pick sources, and tune the row
        // height without inheriting an unrelated layout.
        const extras: Row[] = Array.from(
          { length: clamped - prev.length },
          () => ({ cells: [{ kind: "empty" }], widths: [1], heightWeight: 10 })
        );
        return [...prev, ...extras];
      }
      return prev.slice(0, clamped);
    });
  }, []);

  const setRowCols = useCallback((rowIndex: number, cols: number) => {
    setRows((prev) => {
      const copy = prev.slice();
      const row = copy[rowIndex];
      if (!row) return prev;
      copy[rowIndex] = resizeRow(row, cols);
      return copy;
    });
  }, []);

  const setRowHeightWhileTyping = useCallback((rowIndex: number, weight: number) => {
    const next = capRowHeightWhileTyping(weight);
    if (next == null) return;
    setRows((prev) => {
      const copy = prev.slice();
      const row = copy[rowIndex];
      if (!row) return prev;
      copy[rowIndex] = { ...row, heightWeight: next };
      return copy;
    });
  }, []);

  const finalizeRowHeightAt = useCallback((rowIndex: number) => {
    setRows((prev) => {
      const row = prev[rowIndex];
      if (!row) return prev;
      const h = commitRowHeightFr(row.heightWeight);
      if (h === row.heightWeight) return prev;
      const copy = prev.slice();
      copy[rowIndex] = { ...row, heightWeight: h };
      return copy;
    });
  }, []);

  const setCellWeight = useCallback((rowIndex: number, colIndex: number, weight: number) => {
    const clamped = Math.max(1, Math.min(MAX_WEIGHT, Math.round(weight)));
    setRows((prev) => {
      const copy = prev.slice();
      const row = copy[rowIndex];
      if (!row) return prev;
      const widths = row.widths.slice();
      widths[colIndex] = clamped;
      copy[rowIndex] = { ...row, widths };
      return copy;
    });
  }, []);

  const updateCell = useCallback((rowIndex: number, colIndex: number, next: MonitorSource) => {
    setRows((prev) => {
      const copy = prev.slice();
      const row = copy[rowIndex];
      if (!row) return prev;
      const cells = row.cells.slice();
      cells[colIndex] = next;
      copy[rowIndex] = { ...row, cells };
      return copy;
    });
  }, []);

  useEffect(() => {
    setRows((prev) => sanitizeRowsForBoothSlot(prev, showBoothSlot));
  }, [showBoothSlot]);

  useEffect(() => {
    const key = wallLayoutStorageKey(persistKey);
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key || e.newValue == null) return;
      const next = parsePersistedWallLayoutJson(e.newValue, showBoothSlot);
      if (next) setRows(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [persistKey, showBoothSlot]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      writePersistedWallLayout(persistKey, showBoothSlot, rows);
    }, 350);
    return () => window.clearTimeout(t);
  }, [rows, persistKey, showBoothSlot]);

  const saveLayoutAsUserDefaults = useCallback(() => {
    writePersistedWallUserDefaults(persistKey, showBoothSlot, rows);
    setDefaultsSaveHint("Default layout saved for this wall.");
    if (defaultsSaveHintTimerRef.current != null) window.clearTimeout(defaultsSaveHintTimerRef.current);
    defaultsSaveHintTimerRef.current = window.setTimeout(() => {
      setDefaultsSaveHint(null);
      defaultsSaveHintTimerRef.current = null;
    }, 2500);
  }, [persistKey, showBoothSlot, rows]);

  const resetLayoutToDefaults = useCallback(() => {
    clearPersistedWallLayout(persistKey);
    const fromSaved = readPersistedWallUserDefaults(persistKey, showBoothSlot);
    setRows(fromSaved ?? defaultLayout(showBoothSlot));
  }, [persistKey, showBoothSlot]);

  useEffect(() => {
    return () => {
      if (defaultsSaveHintTimerRef.current != null) window.clearTimeout(defaultsSaveHintTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string; persistKey?: string; rowIndex?: number } | null;
      if (!data || data.type !== "tower-wall-row-popout-closed") return;
      if (data.persistKey !== persistKey || typeof data.rowIndex !== "number") return;
      setPoppedRows((prev) => {
        const next = new Set(prev);
        next.delete(data.rowIndex as number);
        return next;
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [persistKey]);

  const openRowPopout = useCallback(
    (rowIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return;
      const storageKey = `ksc_twr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const payload: TowerWallRowPopoutPayloadV1 = {
        v: 1,
        sessionId,
        basePersistKey: persistKey,
        sourceRowIndex: rowIndex,
        showBoothSlot,
        row: JSON.parse(JSON.stringify(row)) as Row
      };
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        window.alert("Could not stash row layout (storage blocked or full).");
        return;
      }
      const url = `/tower/wall/row?k=${encodeURIComponent(storageKey)}`;
      const popup = window.open(url, `ktn-wall-row-${persistKey}-${rowIndex}`, "popup,width=1280,height=720");
      if (!popup) {
        window.alert("Popup blocked by browser.");
        return;
      }
      setPoppedRows((prev) => {
        const next = new Set(prev);
        next.add(rowIndex);
        return next;
      });
    },
    [rows, sessionId, persistKey, showBoothSlot]
  );

  const visibleRows = rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ rowIndex }) => !poppedRows.has(rowIndex));

  const layoutSettingsButton = (
    <button
      type="button"
      className={
        "tower-wall__settings-open" +
        (sessionStrip ? " tower-wall__settings-open--in-session-strip" : "")
      }
      onClick={() => setSettingsOpen(true)}
      aria-haspopup="dialog"
      aria-expanded={settingsOpen}
      aria-controls={settingsDialogId}
      title="Wall layout: rows, column counts, row heights, pop-outs"
    >
      Wall layout
    </button>
  );

  return (
    <div className="tower-wall">
      {sessionStrip ? (
        <div
          className={"tower-embed-session-strip tower-wall__session-strip" + sessionStripToneClass}
          role="region"
          aria-label="Session identity and wall layout"
        >
          <div className="tower-wall__session-strip-main">
            {sessionStripLeading}
            {sessionStrip}
          </div>
          <div className="tower-wall__session-strip-actions">
            {sessionStripTrailing}
            {layoutSettingsButton}
          </div>
        </div>
      ) : (
        layoutSettingsButton
      )}

      {settingsOpen
        ? createPortal(
            <div
              className="tower-wall-modal-backdrop"
              role="presentation"
              onClick={(e) => {
                if (e.target === e.currentTarget) closeSettings();
              }}
            >
              <div
                id={settingsDialogId}
                className="tower-wall-settings-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={settingsTitleId}
              >
                <div className="tower-wall-settings-dialog__scroll">
                  <div className="tower-wall-settings-dialog__head">
                    <h2 id={settingsTitleId} className="tower-wall-settings-dialog__title">
                      Wall layout
                    </h2>
                    <button type="button" className="tower-wall-settings-dialog__close" onClick={closeSettings}>
                      Close
                    </button>
                  </div>

          <div className="tower-wall-settings-dialog__section">
            <label className="tower-wall__field">
              <span>Rows</span>
              <input
                type="number"
                min={MIN_ROWS}
                max={MAX_ROWS}
                value={rows.length}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setRowCount(n);
                }}
              />
            </label>
            <span className="tower-wall-settings-dialog__meta">
              {cameras.length > 0
                ? `${cameras.length} hullcam${cameras.length === 1 ? "" : "s"} live`
                : "No hullcams streaming"}
            </span>
            {onPopOut ? (
              <button
                type="button"
                className="tower-wall__popout"
                onClick={() => {
                  closeSettings();
                  onPopOut();
                }}
                title="Open the wall in a new window so you can drag it to a second monitor"
              >
                Pop out full wall
              </button>
            ) : null}
            <div className="tower-wall-settings-dialog__layout-actions">
              <button
                type="button"
                className="tower-wall-settings-dialog__save-defaults"
                onClick={saveLayoutAsUserDefaults}
                title="Remember this layout as what “Reset to defaults” returns to (stored in this browser)"
              >
                Save defaults
              </button>
              <button
                type="button"
                className="tower-wall-settings-dialog__reset"
                onClick={resetLayoutToDefaults}
                title="Clear the live saved layout and restore your saved default, or the built-in wall if you have not saved defaults yet"
              >
                Reset to defaults
              </button>
            </div>
            {defaultsSaveHint ? (
              <p className="tower-wall-settings-dialog__defaults-saved" role="status">
                {defaultsSaveHint}
              </p>
            ) : null}
          </div>
          <p className="tower-wall-settings-dialog__persist-hint">
            Layout is saved automatically in this browser (per wall: desk vs. standalone page). Save defaults
            first if you want Reset to defaults to return to your layout instead of the stock wall.
          </p>

          <div className="tower-wall-settings-dialog__rows" role="list">
            {rows.map((row, rowIndex) => (
              <div key={rowIndex} className="tower-wall-settings-dialog__row-block" role="listitem">
                <div className="tower-wall-settings-dialog__row-head">
                  <span className="tower-wall-settings-dialog__row-name">Row {rowIndex + 1}</span>
                  {poppedRows.has(rowIndex) ? (
                    <span className="tower-wall-settings-dialog__row-badge">Popped out</span>
                  ) : null}
                </div>
                <div className="tower-wall-settings-dialog__row-fields">
                  <label className="tower-wall__field">
                    <span>Cols</span>
                    <input
                      type="number"
                      min={MIN_COLS}
                      max={MAX_COLS}
                      value={row.cells.length}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) setRowCols(rowIndex, n);
                      }}
                    />
                  </label>
                  <label
                    className="tower-wall__field tower-wall__field--width"
                    title={`Row height: H × ${ROW_HEIGHT_VH_PER_UNIT}vh (tune ROW_HEIGHT_VH_PER_UNIT in this file)`}
                  >
                    <span>H</span>
                    <input
                      type="number"
                      min={MIN_ROW_HEIGHT_VH}
                      max={MAX_ROW_HEIGHT_VH}
                      step={1}
                      value={row.heightWeight}
                      onChange={(e) => {
                        const n = Number(e.currentTarget.value);
                        setRowHeightWhileTyping(rowIndex, n);
                      }}
                      onBlur={() => finalizeRowHeightAt(rowIndex)}
                    />
                  </label>
                  <button
                    type="button"
                    className="tower-wall__popout tower-wall__popout--row"
                    onClick={() => {
                      closeSettings();
                      openRowPopout(rowIndex);
                    }}
                    disabled={poppedRows.has(rowIndex)}
                    title={
                      poppedRows.has(rowIndex)
                        ? "This row is already open in a pop-out window"
                        : "Open this row alone in a new window (second monitor, MFD-style)"
                    }
                  >
                    Pop row
                  </button>
                </div>
              </div>
            ))}
          </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      <div
        className="tower-wall__rows"
        style={{
          // Absolute row heights: H maps directly to viewport height (`vh`).
          gridTemplateRows: visibleRows
            .map(({ row }) => `minmax(0, ${rowHeightToViewportVh(row.heightWeight)}vh)`)
            .join(" ")
        }}
      >
        {visibleRows.map(({ row, rowIndex }) => (
          <WallRow
            key={rowIndex}
            row={row}
            rowIndex={rowIndex}
            onSetCellWeight={(colIndex, w) => setCellWeight(rowIndex, colIndex, w)}
            onUpdateCell={(colIndex, next) => updateCell(rowIndex, colIndex, next)}
            sessionId={sessionId}
            catalog={catalog}
            worldInventory={worldInventory}
            homeBodyName={worldInventory?.home.name ?? null}
            // Mirror the catalog fallback above: when the KSP plugin hasn't published
            // `/v1/world-inventory/{sessionId}` yet (fresh session, no SC visit), pretend
            // we're on stock Kerbin so the body-map / per-body asset URLs resolve to
            // bundled artwork instead of bailing out with "world inventory isn't loaded".
            worldId={worldInventory?.worldId ?? "kerbin-stock"}
            persistKey={persistKey}
            showBoothSlot={showBoothSlot}
          />
        ))}
        {visibleRows.length === 0 ? (
          <div className="tower-wall__empty">All rows are popped out. Close a popout to restore it here.</div>
        ) : null}
      </div>
    </div>
  );
}

function WallRow({
  row,
  rowIndex,
  onSetCellWeight,
  onUpdateCell,
  sessionId,
  catalog,
  worldInventory,
  homeBodyName,
  worldId,
  persistKey,
  showBoothSlot
}: {
  row: Row;
  rowIndex: number;
  onSetCellWeight: (colIndex: number, weight: number) => void;
  onUpdateCell: (colIndex: number, next: MonitorSource) => void;
  sessionId: string;
  catalog: Parameters<typeof SystemSchematic>[0]["catalog"] | null;
  worldInventory: WorldInventory | null;
  homeBodyName: string | null;
  worldId: string;
  persistKey: string;
  showBoothSlot: boolean;
}): JSX.Element {
  // Per-row CSS grid so widths map directly to `fr` units. This keeps gutters
  // consistent with the rest of the wall and avoids flex-basis/percentage math.
  const gridTemplate = row.widths.map((w) => `${Math.max(1, w)}fr`).join(" ");

  return (
    <div className="tower-wall__row">
      <div className="tower-wall__row-grid" style={{ gridTemplateColumns: gridTemplate }}>
        {row.cells.map((source, colIndex) => (
          <MonitorSlot
            key={colIndex}
            rowIndex={rowIndex}
            colIndex={colIndex}
            source={source}
            weight={row.widths[colIndex] ?? 1}
            onChange={(next) => onUpdateCell(colIndex, next)}
            onWeightChange={(w) => onSetCellWeight(colIndex, w)}
            sessionId={sessionId}
            catalog={catalog}
            worldInventory={worldInventory}
            homeBodyName={homeBodyName}
            worldId={worldId}
            persistKey={persistKey}
            showBoothSlot={showBoothSlot}
          />
        ))}
      </div>
    </div>
  );
}

export type TowerWallRowPaneProps = {
  sessionId: string;
  /** Passed to slot `persistKey`  use `${basePersistKey}-poprow-${sourceRowIndex}`. */
  slotPersistKeyPrefix: string;
  showBoothSlot: boolean;
  initialRow: Row;
  /** 0-based index of this row on the parent wall (for header + storage keys). */
  sourceRowIndex: number;
};

/**
 * Single wall row in its own surface (pop-out window). Owns a copy of layout state
 * so edits here do not change the main wall until the operator mirrors them manually.
 */
export function TowerWallRowPane({
  sessionId,
  slotPersistKeyPrefix,
  showBoothSlot,
  initialRow,
  sourceRowIndex
}: TowerWallRowPaneProps): JSX.Element {
  const [row, setRow] = useState<Row>(() => {
    const r = JSON.parse(JSON.stringify(initialRow)) as Row;
    r.heightWeight = commitRowHeightFr(r.heightWeight);
    return r;
  });
  const [rowLayoutOpen, setRowLayoutOpen] = useState(false);
  const rowLayoutDialogId = useId();
  const rowLayoutTitleId = useId();

  const closeRowLayout = useCallback(() => setRowLayoutOpen(false), []);

  useEffect(() => {
    if (!rowLayoutOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRowLayoutOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [rowLayoutOpen]);

  const [worldInventory, setWorldInventory] = useState<WorldInventory | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchWorldInventory(sessionId).then((wi) => {
      if (!cancelled) setWorldInventory(wi);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const catalogState = useSystemCatalog(worldInventory?.worldId ?? "kerbin-stock");
  const catalog = catalogState.kind === "ready" ? catalogState.catalog : null;

  const onSetCols = useCallback((cols: number) => {
    setRow((r) => resizeRow(r, cols));
  }, []);

  const setRowHeightWhileTypingPopout = useCallback((weight: number) => {
    const next = capRowHeightWhileTyping(weight);
    if (next == null) return;
    setRow((r) => ({ ...r, heightWeight: next }));
  }, []);

  const finalizeRowHeightPopout = useCallback(() => {
    setRow((r) => ({ ...r, heightWeight: commitRowHeightFr(r.heightWeight) }));
  }, []);

  const onSetCellWeight = useCallback((colIndex: number, weight: number) => {
    const clamped = Math.max(1, Math.min(MAX_WEIGHT, Math.round(weight)));
    setRow((r) => {
      const widths = r.widths.slice();
      widths[colIndex] = clamped;
      return { ...r, widths };
    });
  }, []);

  const onUpdateCell = useCallback((colIndex: number, next: MonitorSource) => {
    setRow((r) => {
      const cells = r.cells.slice();
      cells[colIndex] = next;
      return { ...r, cells };
    });
  }, []);

  const homeBodyName = worldInventory?.home.name ?? null;
  const worldId = worldInventory?.worldId ?? "kerbin-stock";

  return (
    <div className="tower-wall tower-wall--row-popout">
      <button
        type="button"
        className="tower-wall__settings-open"
        onClick={() => setRowLayoutOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={rowLayoutOpen}
        aria-controls={rowLayoutDialogId}
        title="Column count and row height for this popped row"
      >
        Row layout
      </button>

      {rowLayoutOpen
        ? createPortal(
            <div
              className="tower-wall-modal-backdrop"
              role="presentation"
              onClick={(e) => {
                if (e.target === e.currentTarget) closeRowLayout();
              }}
            >
              <div
                id={rowLayoutDialogId}
                className="tower-wall-settings-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={rowLayoutTitleId}
              >
                <div className="tower-wall-settings-dialog__scroll">
                  <div className="tower-wall-settings-dialog__head">
                    <h2 id={rowLayoutTitleId} className="tower-wall-settings-dialog__title">
                      Popped row layout
                    </h2>
                    <button type="button" className="tower-wall-settings-dialog__close" onClick={closeRowLayout}>
                      Close
                    </button>
                  </div>
                  <p className="tower-wall-settings-dialog__blurb">
                    Was row {sourceRowIndex + 1} on the main wall. Session <code>{sessionId}</code>
                  </p>
                  <div className="tower-wall-settings-dialog__row-fields">
                    <label className="tower-wall__field">
                      <span>Cols</span>
                      <input
                        type="number"
                        min={MIN_COLS}
                        max={MAX_COLS}
                        value={row.cells.length}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) onSetCols(n);
                        }}
                      />
                    </label>
                    <label
                      className="tower-wall__field tower-wall__field--width"
                      title={`Row height: H × ${ROW_HEIGHT_VH_PER_UNIT}vh (tune ROW_HEIGHT_VH_PER_UNIT in this file)`}
                    >
                      <span>H</span>
                      <input
                        type="number"
                        min={MIN_ROW_HEIGHT_VH}
                        max={MAX_ROW_HEIGHT_VH}
                        step={1}
                        value={row.heightWeight}
                        onChange={(e) => {
                          const n = Number(e.currentTarget.value);
                          setRowHeightWhileTypingPopout(n);
                        }}
                        onBlur={finalizeRowHeightPopout}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      <div className="tower-wall__rows" style={{ gridTemplateRows: "minmax(0, 1fr)" }}>
        <WallRow
          row={row}
          rowIndex={0}
          onSetCellWeight={onSetCellWeight}
          onUpdateCell={onUpdateCell}
          sessionId={sessionId}
          catalog={catalog}
          worldInventory={worldInventory}
          homeBodyName={homeBodyName}
          worldId={worldId}
          persistKey={slotPersistKeyPrefix}
          showBoothSlot={showBoothSlot}
        />
      </div>
    </div>
  );
}

function MonitorSlot({
  rowIndex,
  colIndex,
  source,
  weight,
  onChange,
  onWeightChange,
  sessionId,
  catalog,
  worldInventory,
  homeBodyName,
  worldId,
  persistKey,
  showBoothSlot
}: {
  rowIndex: number;
  colIndex: number;
  source: MonitorSource;
  weight: number;
  onChange: (next: MonitorSource) => void;
  onWeightChange: (weight: number) => void;
  sessionId: string;
  catalog: Parameters<typeof SystemSchematic>[0]["catalog"] | null;
  worldInventory: WorldInventory | null;
  homeBodyName: string | null;
  worldId: string;
  persistKey: string;
  showBoothSlot: boolean;
}): JSX.Element {
  const trackedSessionId = sessionId.trim();
  const supportsSessionBinding = sourceSupportsSessionBinding(source);
  const boundSessionId = supportsSessionBinding ? normalizeBoundSessionId(source.bindSessionId) : undefined;
  const effectiveSessionId = boundSessionId ?? trackedSessionId;

  const roomsQuery = useApiQuery<LobbyRoomsRes>({
    queryKey: queryKeys.lobby.rooms,
    path: "/v1/lobby/rooms",
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const rooms = roomsQuery.data?.rooms ?? [];

  const overrideWorldInventoryQuery = useApiQuery<WorldInventory | null>({
    queryKey: queryKeys.world.inventory(effectiveSessionId),
    queryFn: async () => fetchWorldInventory(effectiveSessionId),
    enabled: sourceUsesWorldContext(source) && !!effectiveSessionId && effectiveSessionId !== trackedSessionId,
    refetchInterval: effectiveSessionId ? 60_000 : false,
    staleTime: 60_000
  });
  const effectiveWorldInventory =
    effectiveSessionId === trackedSessionId ? worldInventory : (overrideWorldInventoryQuery.data ?? null);
  const effectiveHomeBodyName =
    effectiveSessionId === trackedSessionId ? homeBodyName : (effectiveWorldInventory?.home.name ?? null);
  const effectiveWorldId =
    effectiveSessionId === trackedSessionId ? worldId : (effectiveWorldInventory?.worldId ?? "kerbin-stock");
  const overrideCatalogState = useSystemCatalog(sourceUsesWorldContext(source) ? effectiveWorldId : null);
  const effectiveCatalog =
    effectiveSessionId === trackedSessionId
      ? catalog
      : overrideCatalogState.kind === "ready"
        ? overrideCatalogState.catalog
        : null;

  const { cameras } = useHullCamList(sourceUsesHullCams(source) ? effectiveSessionId : "");

  const sessionOptions = useMemo(() => {
    const labels = new Map<string, string>();
    const trackedRoom = rooms.find((r) => r.roomId === trackedSessionId);
    if (trackedSessionId) {
      labels.set(
        trackedSessionId,
        trackedRoom?.callsign?.trim() ||
          trackedRoom?.roomName?.trim() ||
          `Tracked room (${trackedSessionId.slice(0, 8)})`
      );
    }
    for (const room of rooms) {
      labels.set(
        room.roomId,
        room.callsign?.trim() || room.roomName?.trim() || room.roomId
      );
    }
    if (boundSessionId && !labels.has(boundSessionId)) {
      labels.set(boundSessionId, boundSessionId);
    }
    return [...labels.entries()].map(([id, label]) => ({ id, label }));
  }, [rooms, trackedSessionId, boundSessionId]);

  // Encode the picker selection as a single string so the <select> stays simple.
  // hullcam-id values use the form `hullcam-id:<n>` and decode back to the tagged
  // union shape on change.
  const pickerValue = useMemo(() => {
    if (source.kind === "hullcam-id") return `hullcam-id:${source.cameraId}`;
    // Legacy persisted layouts used `telemetry`; that slot now maps to the same
    // per-pilot status+telemetry panel as `status`.
    if (source.kind === "telemetry") return "status";
    return source.kind;
  }, [source]);

  const onPickerChange = (value: string): void => {
    const currentBind = sourceSupportsSessionBinding(source) ? normalizeBoundSessionId(source.bindSessionId) : undefined;
    if (value.startsWith("hullcam-id:")) {
      const id = Number(value.slice("hullcam-id:".length));
      if (Number.isFinite(id)) {
        onChange(withBoundSessionId({ kind: "hullcam-id", cameraId: id }, currentBind));
        return;
      }
    }
    const kind = value as MonitorSourceKind;
    if (kind === "hullcam-id") {
      // Picked the placeholder "specific camera" entry without a cam id  fall back
      // to "most recent" so the cell doesn't render an empty single-tile.
      onChange(withBoundSessionId({ kind: "hullcam-recent" }, currentBind));
      return;
    }
    if (kind === "booth" && !showBoothSlot) {
      onChange({ kind: "empty" });
      return;
    }
    onChange(withBoundSessionId({ kind }, currentBind));
  };

  const onSessionChange = (value: string): void => {
    const nextBind = value && value !== trackedSessionId ? value : undefined;
    onChange(withBoundSessionId(source, nextBind));
  };

  // Stable label / aria for the cell. R<row>C<col> reads better than a flat
  // monitor index now that we have rows.
  const cellLabel = `R${rowIndex + 1}-C${colIndex + 1}`;
  const slotPersistKey = `${persistKey}-r${rowIndex}c${colIndex}`;
  const hasSelectedCamera =
    source.kind !== "hullcam-id" || cameras.some((c) => c.id === source.cameraId);

  return (
    <section className="tower-wall__slot" aria-label={`Monitor ${cellLabel}`}>
      <header className="tower-wall__slot-head">
        <span className="tower-wall__slot-label">{cellLabel}</span>
        <select
          className="tower-wall__slot-picker"
          value={pickerValue}
          onChange={(e) => onPickerChange(e.target.value)}
          aria-label={`Source for monitor ${cellLabel}`}
        >
          <option value="empty">{SOURCE_LABELS.empty}</option>
          <optgroup label="HullCam">
            <option value="hullcam-recent">{SOURCE_LABELS["hullcam-recent"]}</option>
            <option value="hullcam-grid">{SOURCE_LABELS["hullcam-grid"]}</option>
            {source.kind === "hullcam-id" && !hasSelectedCamera ? (
              <option value={`hullcam-id:${source.cameraId}`}>
                Cam {source.cameraId} - offline
              </option>
            ) : null}
            {cameras.length === 0 && !(source.kind === "hullcam-id" && !hasSelectedCamera) ? (
              <option value="hullcam-id" disabled>
                (no specific cameras yet)
              </option>
            ) : (
              cameras.map((c) => (
                <option key={c.id} value={`hullcam-id:${c.id}`}>
                  Cam {c.id} - {c.name}
                </option>
              ))
            )}
          </optgroup>
          <optgroup label="Comms">
            <option value="acars-chat">{SOURCE_LABELS["acars-chat"]}</option>
            <option value="voice">{SOURCE_LABELS.voice}</option>
            {showBoothSlot ? (
              <option value="booth">{SOURCE_LABELS.booth}</option>
            ) : source.kind === "booth" ? (
              <option value="booth" disabled>
                Booth (not for pilots)
              </option>
            ) : null}
          </optgroup>
          <optgroup label="Other">
            <option value="staging-move">{SOURCE_LABELS["staging-move"]}</option>
            <option value="countdown">{SOURCE_LABELS.countdown}</option>
            <option value="status">{SOURCE_LABELS.status}</option>
            <option value="schematic">{SOURCE_LABELS.schematic}</option>
            <option value="vessel-schematic">{SOURCE_LABELS["vessel-schematic"]}</option>
            <option value="body-map">{SOURCE_LABELS["body-map"]}</option>
            <option value="tower-radar">{SOURCE_LABELS["tower-radar"]}</option>
            <option value="dragon-radar-map">{SOURCE_LABELS["dragon-radar-map"]}</option>
            <option value="kos-screen">{SOURCE_LABELS["kos-screen"]}</option>
            <option value="tower-view">{SOURCE_LABELS["tower-view"]}</option>
            <option value="off-world-traffic">{SOURCE_LABELS["off-world-traffic"]}</option>
            <option value="active-roster">{SOURCE_LABELS["active-roster"]}</option>
            <option value="scorecard">{SOURCE_LABELS.scorecard}</option>
          </optgroup>
        </select>
        {supportsSessionBinding ? (
          <label
            className="tower-wall__field tower-wall__field--session"
            title="Which lobby room feeds this cell (telemetry, maps, hull cams). That is not an airfield: for where the PPI is on the globe, use Airfield in the radar strip (KSC vs other pads from your save)."
          >
            <span>Room</span>
            <select
              className="tower-wall__slot-session"
              value={effectiveSessionId}
              onChange={(e) => onSessionChange(e.target.value)}
              aria-label={`Lobby room for monitor ${cellLabel} (telemetry and cameras; not radar map position)`}
            >
              {sessionOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="tower-wall__field tower-wall__field--width" title="Relative width (fr units)">
          <span>W</span>
          <input
            type="number"
            min={1}
            max={MAX_WEIGHT}
            value={weight}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onWeightChange(n);
            }}
          />
        </label>
      </header>
      <div className="tower-wall__slot-body">
        <SlotContent
          source={source}
          slotPersistKey={slotPersistKey}
          sessionId={effectiveSessionId}
          cameras={cameras}
          catalog={effectiveCatalog}
          worldInventory={effectiveWorldInventory}
          homeBodyName={effectiveHomeBodyName}
          worldId={effectiveWorldId}
          showBoothSlot={showBoothSlot}
          onUpdateSource={onChange}
        />
      </div>
    </section>
  );
}

function SlotContent({
  source,
  slotPersistKey,
  sessionId,
  cameras,
  catalog,
  worldInventory,
  homeBodyName,
  worldId,
  showBoothSlot,
  onUpdateSource
}: {
  source: MonitorSource;
  slotPersistKey: string;
  sessionId: string;
  cameras: CameraSummary[];
  catalog: Parameters<typeof SystemSchematic>[0]["catalog"] | null;
  worldInventory: WorldInventory | null;
  homeBodyName: string | null;
  worldId: string;
  showBoothSlot: boolean;
  onUpdateSource: (next: MonitorSource) => void;
}): JSX.Element {
  switch (source.kind) {
    case "empty":
      return <div className="tower-wall__empty">Pick a source above.</div>;

    case "hullcam-grid":
      return <HullCamPanel sessionId={sessionId} />;

    case "hullcam-recent":
      return <HullCamPanel sessionId={sessionId} compact />;

    case "hullcam-id": {
      const cam = cameras.find((c) => c.id === source.cameraId);
      if (!cam) {
        return (
          <div className="tower-wall__empty">
            Cam {source.cameraId} - no signal. The pilot may have switched vessels or the
            camera was removed.
          </div>
        );
      }
      return (
        <div className="tower-wall__hullcam-large">
          <HullCamTile sessionId={sessionId} camera={cam} />
        </div>
      );
    }

    case "staging-move":
      return <StagingMoveWallSlot sessionId={sessionId} />;

    case "countdown":
      return <CountdownWallSlot sessionId={sessionId} />;

    case "status":
    case "telemetry":
      return <TowerStatusSlot sessionId={sessionId} />;

    case "kos-screen":
      return <KosScreenPanel sessionId={sessionId} />;

    case "schematic":
      if (!catalog) {
        return (
          <div className="tower-wall__empty">
            System catalog isn't loaded for this pilot's planet pack  schematic
            unavailable.
          </div>
        );
      }
      return (
        <SystemSchematic
          catalog={catalog}
          // Wall doesn't aggregate vessels-per-body (that lives in TowerDesk's
          // multi-session state); pass an empty map so markers default-size.
          vesselCounts={new Map<string, number>()}
          focusedBodyName={homeBodyName ?? catalog.starName ?? ""}
          onFocusBody={() => {
            /* no-op: schematic on the wall is read-only context, not a navigator */
          }}
        />
      );

    case "vessel-schematic":
      // Same component the desk uses; the panel polls
      // `/v1/tower/vessel-schematic/{sessionId}` itself, so multiple wall
      // cells configured for the same session dedupe to one HTTP call via
      // the TanStack Query cache.
      return <VesselSchematicPanel sessionId={sessionId} />;

    case "body-map":
      // No `!worldId` early-return on purpose  `worldId` now defaults to
      // "kerbin-stock" upstream, and `BodyMapSlot` itself already falls back to
      // Kerbin (bundled schematic / live basemap) when neither telemetry nor
      // world-inventory has named a body yet. Re-adding a guard here would
      // shadow that fallback and the cell would just say "unavailable" again.
      return (
        <BodyMapSlot
          slotPersistKey={slotPersistKey}
          sessionId={sessionId}
          worldId={worldId}
          catalog={catalog}
          worldInventory={worldInventory}
          homeBodyName={homeBodyName}
        />
      );

    case "tower-radar":
      return (
        <TowerRadarWallSlot
          sessionId={sessionId}
          worldInventory={worldInventory}
          homeBodyName={homeBodyName}
          radarPpiOriginId={source.radarPpiOriginId}
          onPpiOriginIdChange={(nextId) => {
            onUpdateSource({
              ...source,
              radarPpiOriginId: nextId === "ksc" ? undefined : nextId
            });
          }}
        />
      );

    case "dragon-radar-map":
      return (
        <TowerDragonRadarWallSlot
          sessionId={sessionId}
          worldInventory={worldInventory}
          homeBodyName={homeBodyName}
          catalog={catalog}
          slotPersistKey={slotPersistKey}
        />
      );

    case "acars-chat":
      return <ChatDesk embedInWall />;

    case "voice":
      return <VoiceDesk embedInWall />;

    case "booth":
      if (!showBoothSlot) {
        return (
          <div className="tower-wall__empty">
            Booth is only for spectators and tower  not shown while you are the pilot.
          </div>
        );
      }
      return (
        <div className="tower-wall-embed-desk">
          <BoothDesk />
        </div>
      );

    case "tower-view":
      return (
        <div className="tower-wall-embed-desk tower-wall-embed-desk--flush">
          <TowerViewPanel />
        </div>
      );

    case "off-world-traffic":
      return (
        <OffWorldTrafficWallSlot
          sessionId={sessionId}
          catalog={catalog}
          homeBodyName={homeBodyName}
        />
      );

    case "active-roster":
      return <TowerStationStatusSlot />;

    case "scorecard":
      return <ScorecardWallSlot sessionId={sessionId} />;
  }
}

type ScorecardSessionRes = {
  ok?: boolean;
  session?: { pilotUserId?: string };
};

function ScorecardWallSlot({ sessionId }: { sessionId: string }): JSX.Element {
  const liveConnected = useTowerLiveSubscriptions(sessionId);
  const sessionQuery = useApiQuery<ScorecardSessionRes>({
    queryKey: queryKeys.session.detail(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? 3_000 : false,
    placeholderData: (prev) => prev
  });
  const pilotUserId = sessionQuery.data?.session?.pilotUserId;
  const user = getStoredUser();

  if (!user) {
    return <div className="tower-wall__empty">Sign in to view the scorecard.</div>;
  }

  return (
    <div className="tower-wall-embed-desk tower-wall-embed-desk--scroll">
      <Scorecard sessionId={sessionId} user={user} pilotUserId={pilotUserId} />
    </div>
  );
}

function StagingMoveWallSlot({ sessionId }: { sessionId: string }): JSX.Element {
  const qc = useQueryClient();
  const { user } = useAuthMe();
  const liveConnected = useTowerLiveSubscriptions(sessionId);

  type SessionStagingRes = {
    ok?: boolean;
    session?: {
      stagingMoveRequest?: {
        preset: string;
        label: string;
        issuedAt: string;
        issuedByUserId: string;
      };
    };
  };

  const sessionQuery = useApiQuery<SessionStagingRes>({
    queryKey: queryKeys.session.detail(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? 1_000 : false,
    placeholderData: (prev) => prev
  });

  if (!user) {
    return <div className="tower-wall__empty">Sign in to set ramp positions.</div>;
  }

  return (
    <div className="tower-wall-embed-desk tower-wall-embed-desk--scroll tower-wall-embed-desk--staging-move">
      <StagingMovePanel
        sessionId={sessionId}
        user={user}
        stagingMoveRequest={sessionQuery.data?.session?.stagingMoveRequest ?? null}
        forceVisible
        onChanged={() => void qc.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) })}
      />
    </div>
  );
}

function CountdownWallSlot({ sessionId }: { sessionId: string }): JSX.Element {
  const qc = useQueryClient();
  const liveConnected = useTowerLiveSubscriptions(sessionId);
  const user = getStoredUser();
  if (!user) {
    return <div className="tower-wall__empty">Sign in to use launch countdown.</div>;
  }

  type SessionRes = {
    ok?: boolean;
    session?: {
      countdownStartsAt?: string;
      countdownLengthSec?: number;
      countdownRequest?: { at: string; byUserId: string; label?: string };
      takeoffRequest?: { at: string; byUserId: string; label?: string };
    };
  };

  const sessionQuery = useApiQuery<SessionRes>({
    queryKey: queryKeys.session.detail(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? 1_000 : false,
    placeholderData: (prev) => prev
  });

  const s = sessionQuery.data?.session;

  return (
    <div className="tower-wall-embed-desk tower-wall-embed-desk--scroll">
      <CountdownPanel
        sessionId={sessionId}
        user={user}
        startsAt={s?.countdownStartsAt}
        lengthSec={s?.countdownLengthSec ?? 10}
        countdownRequest={s?.countdownRequest ?? null}
        takeoffRequest={s?.takeoffRequest ?? null}
        onChanged={() => void qc.invalidateQueries({ queryKey: queryKeys.session.detail(sessionId) })}
      />
    </div>
  );
}

type TelemetryHealthState =
  | "live"
  | "beacon_off"
  | "paused"
  | "scene_left"
  | "warp"
  | "vessel_dead"
  | "vessel_switch"
  | "stale";

type TelemetryHealth = {
  state: TelemetryHealthState;
  ageSeconds: number | null;
  lastTelemetryAt: string | null;
  staleThresholdSeconds: number;
};

function formatAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function formatTelemetryNum(n: number | undefined, decimals = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(decimals);
}

function formatTelemetryCommsLine(t: MapTelemetry): string {
  if (t.commLinkHome === false && t.commLink === true) return "relay only";
  if (t.commLink === false) return "BLACKOUT";
  if (t.commSignal != null) return `${(t.commSignal * 100).toFixed(0)}%`;
  return "—";
}

/** Short annunciator caption for each Kerbalism `lifeSupport` key (2–3 chars). */
const LS_LAMP_TAG: Record<string, string> = {
  food: "FO",
  water: "H2O",
  oxygen: "O2",
  nitrogen: "N2",
  atmosphere: "AT",
  wasteAtmosphere: "WA",
  carbonDioxide: "CO2"
};

type AnnunciatorTone = "dim" | "ok" | "warn" | "alert";

function annunciatorLifeSupportTone(ls: {
  amount: number;
  max: number;
  ratePerSec: number;
  secondsRemaining: number | null;
  daysRemaining: number | null;
}): AnnunciatorTone {
  let sec: number | null =
    ls.secondsRemaining != null && Number.isFinite(ls.secondsRemaining) ? ls.secondsRemaining : null;
  if (sec == null && ls.daysRemaining != null && Number.isFinite(ls.daysRemaining)) {
    sec = ls.daysRemaining * HOME_DAY_SECONDS_FALLBACK;
  }
  if (sec == null) return "dim";
  if (sec < 0) return "alert";
  if (sec < 20 * 60) return "alert";
  if (sec < 48 * 3600) return "warn";
  return "dim";
}

function annunciatorRadiationTone(rad: number | undefined): AnnunciatorTone {
  if (rad == null || !Number.isFinite(rad)) return "dim";
  const a = Math.abs(rad);
  if (a >= 5e-5) return "alert";
  if (a >= 5e-6) return "warn";
  return "dim";
}

function annunciatorGearTone(t: MapTelemetry): AnnunciatorTone {
  if (t.gearDown === true) return "ok";
  const ra = t.radarAlt;
  if (ra != null && Number.isFinite(ra) && ra > 6 && ra < 450) return "alert";
  if (ra != null && Number.isFinite(ra) && ra >= 450 && ra < 3000) return "warn";
  return "dim";
}

function annunciatorBrakesTone(t: MapTelemetry): AnnunciatorTone {
  if (t.brakes !== true) return "dim";
  const sp = t.surfaceSpeed ?? 0;
  if (sp > 18) return "warn";
  return "dim";
}

function annunciatorLightsTone(t: MapTelemetry): AnnunciatorTone {
  if (t.lights === true) return "ok";
  const ra = t.radarAlt;
  if (ra != null && Number.isFinite(ra) && ra > 10 && ra < 4000) return "warn";
  return "dim";
}

function AnnunciatorLamp({
  tag,
  title,
  tone,
  pulse
}: {
  tag: string;
  title: string;
  tone: AnnunciatorTone;
  pulse?: boolean;
}): JSX.Element {
  return (
    <span className="tower-annun-cap" title={title}>
      <span
        className={
          "tower-annun-lamp tower-annun-lamp--" +
          tone +
          (pulse ? " tower-annun-lamp--pulse" : "")
        }
        aria-hidden
      />
      <span className="tower-annun-cap__tag">{tag}</span>
    </span>
  );
}

function TowerPlayerAnnunciatorBar({ telemetry: t }: { telemetry: MapTelemetry }): JSX.Element | null {
  const cs = commsStatus(t);
  const commsTone: AnnunciatorTone =
    cs === "blackout" ? "alert" : cs === "link" ? "warn" : cs === "home" ? "ok" : "dim";
  const commsTitle = commsStatusLabel(cs, t.commSignal);

  const gearTone = annunciatorGearTone(t);
  const gearTitle =
    t.gearDown === true
      ? "Gear DOWN"
      : t.radarAlt != null && t.radarAlt < 500
        ? `Gear UP · radar ${Math.round(t.radarAlt)} m AGL`
        : "Gear UP";

  const brTone = annunciatorBrakesTone(t);
  const brTitle =
    t.brakes === true
      ? `Brakes ON${t.surfaceSpeed != null ? ` · ${t.surfaceSpeed.toFixed(0)} m/s` : ""}`
      : "Brakes off";

  const ltTone = annunciatorLightsTone(t);
  const ltTitle = t.lights === true ? "Lights ON" : "Lights OFF";

  const rcsTone: AnnunciatorTone = t.rcs === true ? "ok" : "dim";
  const sasTone: AnnunciatorTone = t.sas === true ? "ok" : "dim";

  const radTone = t.radiationAvailable ? annunciatorRadiationTone(t.radiation) : "dim";
  const radTitle = t.radiationAvailable ? `Radiation ${formatRadiation(t.radiation)}` : "";

  const stormIncoming = !!t.kerbalism?.storm?.incoming;
  const stormTitle = stormIncoming
    ? `Solar storm INCOMING${
        t.kerbalism?.storm?.durationSec != null
          ? ` · ${formatKerbinDays(
              t.kerbalism.storm.durationSec / HOME_DAY_SECONDS_FALLBACK,
              t.kerbalism.storm.durationSec
            )}`
          : ""
      }`
    : "";

  const lsEntries = t.kerbalism?.lifeSupport ? Object.entries(t.kerbalism.lifeSupport) : [];

  return (
    <div className="tower-status-player-card__annun" role="group" aria-label="Vessel annunciators">
      <AnnunciatorLamp tag="COM" title={commsTitle} tone={commsTone} />
      <AnnunciatorLamp tag="GE" title={gearTitle} tone={gearTone} />
      <AnnunciatorLamp tag="BR" title={brTitle} tone={brTone} />
      <AnnunciatorLamp tag="LT" title={ltTitle} tone={ltTone} />
      <AnnunciatorLamp tag="RC" title={t.rcs === true ? "RCS on" : "RCS off"} tone={rcsTone} />
      <AnnunciatorLamp tag="SA" title={t.sas === true ? "SAS on" : "SAS off"} tone={sasTone} />
      {t.radiationAvailable && radTone !== "dim" ? (
        <AnnunciatorLamp tag="RAD" title={radTitle || "Radiation"} tone={radTone} />
      ) : null}
      {lsEntries.map(([key, ls]) => {
        const tone = annunciatorLifeSupportTone(ls);
        if (tone === "dim") return null;
        const label = LS_LAMP_TAG[key] ?? key.slice(0, 3).toUpperCase();
        const name = LIFE_SUPPORT_LABEL[key] ?? key;
        const remain = formatKerbinDays(ls.daysRemaining, ls.secondsRemaining);
        const title = `${name} · ${remain}${ls.max > 0 ? ` · ${ls.amount.toFixed(1)}/${ls.max.toFixed(0)}` : ""}`;
        return <AnnunciatorLamp key={key} tag={label} title={title} tone={tone} />;
      })}
      {stormIncoming ? <AnnunciatorLamp tag="STR" title={stormTitle} tone="alert" pulse /> : null}
    </div>
  );
}

function formatLobbyMhz(v: string | number | null | undefined): string {
  if (v == null || v === "") return "";
  if (typeof v === "number") return displayMhzFromNumber(v);
  return displayMhzFromCanonical(String(v));
}

type TowerStatusSessionRes = {
  ok?: boolean;
  session?: {
    callsign?: string | null;
    telemetry?: MapTelemetry | null;
    countdownRequest?: { at: string; byUserId: string; label?: string };
    takeoffRequest?: { at: string; byUserId: string; label?: string };
  };
  telemetryHealth?: TelemetryHealth;
};

const SERVER_RADIO_OWNER_USER_ID = "system:radio";
const SERVER_RADIO_SESSION_PREFIX = "ksc-radio-";

function isServerOwnedRadioRoom(room: Pick<ActivePilotRoom, "roomId" | "pilotUserId">): boolean {
  return room.roomId.startsWith(SERVER_RADIO_SESSION_PREFIX) || room.pilotUserId === SERVER_RADIO_OWNER_USER_ID;
}

function TowerStatusPlayerCard({
  roomId,
  roomSessionName,
  lobbyCallsign,
  lobbyFrequencyMhz,
  pilotUserId,
  isServerRadioRoom,
  towerPresent,
  isTracked,
  nowTick,
  pollMsWhenDisconnected
}: {
  roomId: string;
  /** Lobby `roomName` / session display title (not necessarily the pilot line). */
  roomSessionName: string;
  lobbyCallsign?: string | null;
  lobbyFrequencyMhz?: string | number | null;
  pilotUserId?: string;
  isServerRadioRoom: boolean;
  towerPresent?: boolean;
  isTracked: boolean;
  nowTick: number;
  pollMsWhenDisconnected: number;
}): JSX.Element | null {
  const liveConnected = useTowerLiveSubscriptions(roomId);
  const sessionQuery = useApiQuery<TowerStatusSessionRes>({
    queryKey: queryKeys.session.detail(roomId),
    path: `/v1/session/${encodeURIComponent(roomId)}`,
    enabled: !!roomId,
    refetchInterval: liveConnected ? false : roomId ? pollMsWhenDisconnected : false,
    placeholderData: (prev) => prev
  });

  const telemetry = sessionQuery.data?.session?.telemetry ?? null;
  const sessionCallsign = sessionQuery.data?.session?.callsign ?? null;
  const primaryLabel = useMemo(() => {
    if (isServerRadioRoom && telemetry) {
      const craft = telemetry.craftName?.trim();
      if (craft) return craft;
      const kerbal = telemetry.pilotName?.trim();
      if (kerbal) return kerbal;
    }
    const cs = [lobbyCallsign, sessionCallsign].find((s) => s && String(s).trim());
    if (cs) return String(cs).trim();
    const kerbal = telemetry?.pilotName?.trim();
    if (kerbal) return kerbal;
    return roomSessionName.trim() || roomId;
  }, [isServerRadioRoom, telemetry, lobbyCallsign, sessionCallsign, roomSessionName, roomId]);

  const subtitleParts = useMemo(() => {
    const parts: string[] = [];
    const freq = formatLobbyMhz(lobbyFrequencyMhz ?? undefined);
    if (freq) parts.push(`${freq} MHz`);
    if (roomSessionName && roomSessionName !== primaryLabel) {
      parts.push(isServerRadioRoom ? `via ${roomSessionName}` : roomSessionName);
    }
    if (pilotUserId && !isServerRadioRoom) parts.push(pilotUserId);
    return parts;
  }, [lobbyFrequencyMhz, roomSessionName, primaryLabel, pilotUserId, isServerRadioRoom]);

  const subtitleText =
    subtitleParts.length > 0
      ? subtitleParts.join(" · ")
      : roomSessionName !== primaryLabel
        ? roomSessionName
        : "";

  const telemetryFetchFailed = !!(sessionQuery.error && !sessionQuery.error.unreachable);
  const telemetryHealth = sessionQuery.data?.telemetryHealth ?? null;
  const countdownRequest = sessionQuery.data?.session?.countdownRequest;
  const takeoffRequest = sessionQuery.data?.session?.takeoffRequest;
  const countdownRequestAge = countdownRequest ? formatAge(countdownRequest.at, nowTick) : null;
  const takeoffRequestAge = takeoffRequest ? formatAge(takeoffRequest.at, nowTick) : null;
  const flightStatus = deriveFlightStatusPill({
    telemetry,
    telemetryHealth,
    countdownRequest,
    takeoffRequest
  });

  const takeoffLine = takeoffRequest
    ? `${takeoffRequest.label ?? "Pilot"} · ${takeoffRequestAge ?? "now"}`
    : "None";
  const countdownLine = countdownRequest
    ? `${countdownRequest.label ?? "Pilot"} · ${countdownRequestAge ?? "now"}`
    : "None";
  const linkLine = deriveGameLinkLabel(telemetryHealth);

  if (isServerRadioRoom && !telemetry && !takeoffRequest && !countdownRequest) {
    return null;
  }

  return (
    <article
      className={"tower-status-player-card" + (isTracked ? " tower-status-player-card--tracked" : "")}
      aria-label={`Pilot session: ${primaryLabel}`}
    >
      <header className="tower-status-player-card__head">
        <div className="tower-status-player-card__titles">
          <div
            className="tower-status-player-card__room"
            title={`${primaryLabel} · ${roomId}\n${CALLSIGN_DISPLAY_HELP}`}
          >
            {primaryLabel}
          </div>
          {subtitleText || towerPresent ? (
            <div
              className="tower-status-player-card__pilot"
              title={subtitleParts.length ? subtitleParts.join(" · ") : roomId}
            >
              {subtitleText}
              {towerPresent ? (
                <span className="tower-status-player-card__tower-on">
                  {subtitleText ? " · " : ""}controller online
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {isTracked ? <span className="tower-status-player-card__badge">Tracked</span> : null}
      </header>
      <div className={`tower-status-pill tone-${flightStatus.tone} tower-status-pill--compact`}>
        {flightStatus.label}
      </div>
      <dl className="tower-status-player-card__dl">
        <div className="tower-status-player-card__dl-row">
          <dt>Takeoff</dt>
          <dd className={takeoffRequest ? "" : "muted"}>{takeoffLine}</dd>
        </div>
        <div className="tower-status-player-card__dl-row">
          <dt>Countdown</dt>
          <dd className={countdownRequest ? "" : "muted"}>{countdownLine}</dd>
        </div>
        <div className="tower-status-player-card__dl-row">
          <dt>Game link</dt>
          <dd className={telemetryHealth?.state === "stale" ? "is-alert" : ""}>{linkLine}</dd>
        </div>
      </dl>
      <div className="tower-status-player-card__sep" aria-hidden />
      {telemetryFetchFailed ? (
        <p className="tower-status-player-card__no-telem">Could not load vessel data.</p>
      ) : telemetry ? (
        <>
        <dl className="tower-status-player-card__dl tower-status-player-card__dl--telemetry">
          <div className="tower-status-player-card__dl-row">
            <dt>Ship</dt>
            <dd>{telemetry.craftName ?? "—"}</dd>
          </div>
          <div className="tower-status-player-card__dl-row">
            <dt>Pilot</dt>
            <dd>{telemetry.pilotName ?? "—"}</dd>
          </div>
          <div className="tower-status-player-card__dl-row">
            <dt>Body</dt>
            <dd>
              {telemetry.bodyName ?? "—"} · {telemetry.situation ?? "—"}
            </dd>
          </div>
          <div className="tower-status-player-card__dl-row">
            <dt>Lat / lon</dt>
            <dd>
              {formatTelemetryNum(telemetry.lat, 4)}° / {formatTelemetryNum(telemetry.lon, 4)}°
            </dd>
          </div>
          <div className="tower-status-player-card__dl-row">
            <dt>Radar / ASL</dt>
            <dd>
              {formatTelemetryNum(telemetry.radarAlt, 0)} / {formatTelemetryNum(telemetry.aslAlt, 0)} m
            </dd>
          </div>
          <div className="tower-status-player-card__dl-row">
            <dt>V / H spd</dt>
            <dd>
              {formatTelemetryNum(telemetry.verticalSpeed, 1)} / {formatTelemetryNum(telemetry.surfaceSpeed, 1)}{" "}
              m/s
            </dd>
          </div>
          <div className="tower-status-player-card__dl-row">
            <dt>Hdg / thr</dt>
            <dd>
              {formatTelemetryNum(telemetry.heading, 1)}°
              {telemetry.throttle != null ? ` · ${(telemetry.throttle * 100).toFixed(0)}%` : ""}
            </dd>
          </div>
          {telemetry.far?.available ? (
            <div className="tower-status-player-card__dl-row">
              <dt>FAR</dt>
              <dd>
                {formatFarFlapSetting(telemetry.far.flap)}
                {telemetry.far.spoiler ? " · spoiler" : ""}
              </dd>
            </div>
          ) : null}
          <div className="tower-status-player-card__dl-row">
            <dt>Ap / Pe</dt>
            <dd>
              {formatTelemetryNum(telemetry.apoapsis, 0)} / {formatTelemetryNum(telemetry.periapsis, 0)} m
            </dd>
          </div>
          <div className="tower-status-player-card__dl-row">
            <dt>Crew</dt>
            <dd>
              {telemetry.crewCurrent ?? "—"} / {telemetry.crewCapacity ?? "—"}
            </dd>
          </div>
        </dl>
        <TowerPlayerAnnunciatorBar telemetry={telemetry} />
        <dl className="tower-status-player-card__dl tower-status-player-card__dl--telemetry">
          <div className="tower-status-player-card__dl-row">
            <dt>Comms</dt>
            <dd>{formatTelemetryCommsLine(telemetry)}</dd>
          </div>
        </dl>
        </>
      ) : (
        <p className="tower-status-player-card__no-telem muted">No vessel data from game yet</p>
      )}
    </article>
  );
}

function TowerStatusSlot({ sessionId }: { sessionId: string }): JSX.Element {
  const tracked = sessionId.trim();
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const roomsQuery = useApiQuery<LobbyRoomsRes>({
    queryKey: queryKeys.lobby.rooms,
    path: "/v1/lobby/rooms",
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const rooms = roomsQuery.data?.rooms ?? [];
  const rosterErr =
    roomsQuery.error && !roomsQuery.error.unreachable ? roomsQuery.error.message : null;

  const orderedRooms = useMemo(() => {
    const sorted = [...rooms].sort((a, b) => {
      const ta = Date.parse(a.lastMessageAt ?? a.updatedAt ?? "") || 0;
      const tb = Date.parse(b.lastMessageAt ?? b.updatedAt ?? "") || 0;
      if (tb !== ta) return tb - ta;
      const la = (a.callsign ?? a.roomName ?? a.roomId).toLowerCase();
      const lb = (b.callsign ?? b.roomName ?? b.roomId).toLowerCase();
      return la.localeCompare(lb);
    });
    if (!tracked) return sorted;
    const ix = sorted.findIndex((r) => r.roomId === tracked);
    if (ix <= 0) return sorted;
    const next = [...sorted];
    const removed = next.splice(ix, 1);
    const pick = removed[0];
    if (!pick) return sorted;
    return [pick, ...next];
  }, [rooms, tracked]);

  const cards: ActivePilotRoom[] = useMemo(() => {
    if (orderedRooms.length > 0) return orderedRooms;
    if (tracked) {
      return [{ roomId: tracked, roomName: tracked, updatedAt: undefined }];
    }
    return [];
  }, [orderedRooms, tracked]);

  if (!tracked && cards.length === 0) {
    return <div className="tower-wall__empty">Pick a session to show pilot cards.</div>;
  }

  if (rosterErr && cards.length === 0) {
    return <div className="tower-wall__empty">Pilot list unavailable: {rosterErr}</div>;
  }

  return (
    <div className="tower-status-wall" role="list">
      {cards.map((r) => {
        const roomSessionName = (r.roomName ?? r.roomId).trim() || r.roomId;
        const isTracked = r.roomId === tracked;
        return (
          <div key={r.roomId} className="tower-status-wall__item" role="listitem">
            <TowerStatusPlayerCard
              roomId={r.roomId}
              roomSessionName={roomSessionName}
              lobbyCallsign={r.callsign}
              lobbyFrequencyMhz={r.frequencyMhz}
              pilotUserId={r.pilotUserId}
              isServerRadioRoom={isServerOwnedRadioRoom(r)}
              towerPresent={r.towerPresent}
              isTracked={isTracked}
              nowTick={nowTick}
              pollMsWhenDisconnected={isTracked ? 1_000 : 3_000}
            />
          </div>
        );
      })}
    </div>
  );
}

type ActivePilotRoom = {
  roomId: string;
  roomName?: string;
  /** ATC callsign when set (lobby always sends this when the session has one). */
  callsign?: string | null;
  /** Cosmetic MHz string `NNN.NNN` or numeric from API. */
  frequencyMhz?: string | number | null;
  pilotUserId?: string;
  assignedTowerUserId?: string | null;
  towerPresent?: boolean;
  updatedAt?: string;
  lastMessageAt?: string | null;
};

type LobbyRoomsRes = { ok?: boolean; rooms?: ActivePilotRoom[] };

function TowerStationStatusSlot(): JSX.Element {
  const roomsQuery = useApiQuery<LobbyRoomsRes>({
    queryKey: queryKeys.lobby.rooms,
    path: "/v1/lobby/rooms",
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const siteQuery = useApiQuery<SiteInfo>({
    queryKey: queryKeys.site.info,
    path: "/v1/site/info",
    queryFn: fetchSiteInfo,
    staleTime: 5 * 60_000
  });
  const rooms = roomsQuery.data?.rooms ?? [];
  const presets = siteQuery.data?.plugin.radioPresets ?? [];
  const err =
    (roomsQuery.error && !roomsQuery.error.unreachable ? roomsQuery.error.message : null) ??
    (siteQuery.error && !siteQuery.error.unreachable ? siteQuery.error.message : null);

  if (err) {
    return <div className="tower-wall__empty">Tower station status unavailable: {err}</div>;
  }

  if (presets.length === 0) {
    return <div className="tower-wall__empty">No configured tower stations.</div>;
  }

  return (
    <table className="tower-wall__roster">
      <thead>
        <tr>
          <th>Station</th>
          <th>Frequency</th>
          <th>Pilots</th>
          <th>Controller</th>
        </tr>
      </thead>
      <tbody>
        {presets.map((preset) => {
          const stationRooms = rooms.filter(
            (r) => formatLobbyMhz(r.frequencyMhz) === preset.frequencyMhz
          );
          const controllerIds = stationRooms
            .map((r) => r.assignedTowerUserId)
            .filter((id): id is string => !!id);
          const pilotLabels = stationRooms
            .filter((r) => !isServerOwnedRadioRoom(r))
            .map((r) => r.callsign ?? r.roomName ?? r.roomId)
            .filter((label) => !!label);
          return (
            <tr key={preset.id}>
              <td>{preset.label}</td>
              <td>{preset.frequencyMhz} MHz</td>
              <td>{pilotLabels.length ? pilotLabels.join(", ") : "No pilot sessions"}</td>
              <td>{controllerIds.length ? controllerIds.join(", ") : "Vacant"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type ActiveAircraftRow = ActiveAircraftWire;

type ActiveAircraftRes = { ok?: boolean; aircraft?: ActiveAircraftRow[] };

/**
 * Off-world list for a wall cell  mirrors the merge logic from `TowerDesk` (session
 * telemetry + `/v1/tower/active-aircraft`) with "focused body" fixed to the pilot's
 * home body so the list matches what the old sidebar showed at default focus.
 * Body buttons are no-ops here (no shared map focus across cells).
 */
function OffWorldTrafficWallSlot({
  sessionId,
  catalog,
  homeBodyName
}: {
  sessionId: string;
  catalog: Parameters<typeof SystemSchematic>[0]["catalog"] | null;
  homeBodyName: string | null;
}): JSX.Element {
  const liveConnected = useTowerLiveSubscriptions(sessionId);
  type SessionRes = { ok?: boolean; session?: { telemetry?: MapTelemetry | null } };

  const sessionQuery = useApiQuery<SessionRes>({
    queryKey: queryKeys.session.detail(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? 1_000 : false,
    placeholderData: (prev) => prev
  });
  const telemetry = sessionQuery.data?.session?.telemetry ?? null;

  const aircraftQuery = useApiQuery<ActiveAircraftRes>({
    queryKey: queryKeys.tower.activeAircraft(),
    path: "/v1/tower/active-aircraft",
    refetchInterval: liveConnected ? false : 3_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const activeAircraft = aircraftQuery.data?.aircraft ?? [];
  const selfId = sessionId || "self";
  const focusLower = (homeBodyName ?? "Kerbin").toLowerCase();

  const vessels = useMemo<OffWorldVessel[]>(() => {
    const out: OffWorldVessel[] = [];
    if (telemetry?.bodyName && telemetry.bodyName.toLowerCase() !== focusLower) {
      out.push({
        id: selfId,
        callsign: aircraftPrimaryLabel(telemetry),
        bodyName: telemetry.bodyName,
        situation: telemetry.situation,
        radarAltM: telemetry.radarAlt,
        aslAltM: telemetry.aslAlt,
        apoapsisM: telemetry.apoapsis,
        periapsisM: telemetry.periapsis,
        biome: telemetry.biome,
        isSelf: true
      });
    }
    for (const a of activeAircraft) {
      if (a.sessionId === selfId) continue;
      if (!a.bodyName || a.bodyName.toLowerCase() === focusLower) continue;
      out.push({
        id: a.sessionId,
        callsign: a.callsign ?? a.craftName ?? a.pilotName ?? "Unknown craft",
        bodyName: a.bodyName,
        situation: a.situation,
        apoapsisM: a.apoapsis,
        periapsisM: a.periapsis,
        isSelf: false
      });
    }
    return out;
  }, [telemetry, activeAircraft, selfId, focusLower]);

  return (
    <div className="tower-wall-embed-desk tower-wall-embed-desk--scroll">
      <OffWorldTrafficPanel vessels={vessels} catalog={catalog} onFocusBody={() => {}} />
    </div>
  );
}

/** Wall body-map: home body → `KerbinTowerMap` (desk parity); else `BodyMap`. `slotPersistKey` isolates prefs per cell. */
function BodyMapSlot({
  slotPersistKey,
  sessionId,
  worldId,
  catalog,
  worldInventory,
  homeBodyName
}: {
  slotPersistKey: string;
  sessionId: string;
  worldId: string;
  catalog: Parameters<typeof SystemSchematic>[0]["catalog"] | null;
  worldInventory: WorldInventory | null;
  homeBodyName: string | null;
}): JSX.Element {
  const liveConnected = useTowerLiveSubscriptions(sessionId);
  type SessionRes = { ok?: boolean; session?: { callsign?: string; telemetry?: MapTelemetry | null } };

  // Multiple wall cells configured for the same session dedupe to a single
  // HTTP call per second via TanStack Query's request cache.
  const sessionQuery = useApiQuery<SessionRes>({
    queryKey: queryKeys.session.detail(sessionId),
    path: `/v1/session/${encodeURIComponent(sessionId)}`,
    enabled: !!sessionId,
    refetchInterval: liveConnected ? false : sessionId ? 1_000 : false,
    placeholderData: (prev) => prev
  });
  const t = sessionQuery.data?.session?.telemetry ?? null;

  const aircraftQuery = useApiQuery<ActiveAircraftRes>({
    queryKey: queryKeys.tower.activeAircraft(),
    path: "/v1/tower/active-aircraft",
    refetchInterval: liveConnected ? false : 3_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev
  });
  const activeAircraft = aircraftQuery.data?.aircraft ?? [];

  // If neither the live vessel nor the world-inventory scan has named a body yet
  // (typical right after a fresh dev boot — KSP plugin hasn't entered the Space
  // Center, so `world-inventory` 404s and telemetry is empty), default to Kerbin
  // so the schematic basemap still renders instead of an "unavailable" message.
  const effectiveHomeBodyName = homeBodyName ?? "Kerbin";
  const bodyName = t?.bodyName || effectiveHomeBodyName;

  const towerAircraftTracks = useMemo(
    () =>
      buildTowerAircraftTracks({
        homeBodyName: effectiveHomeBodyName,
        sessionId: sessionId.trim(),
        telemetry: t,
        selfCallsign: sessionQuery.data?.session?.callsign,
        active: activeAircraft
      }),
    [effectiveHomeBodyName, sessionId, t, sessionQuery.data?.session?.callsign, activeAircraft]
  );

  const onHomeBody = bodyName.toLowerCase() === effectiveHomeBodyName.toLowerCase();
  if (onHomeBody) {
    return (
      <KerbinTowerMap
        sessionId={sessionId}
        telemetry={t}
        towerAircraft={towerAircraftTracks}
        worldInventory={worldInventory}
        systemCatalog={catalog}
        persistKey={slotPersistKey}
        wallSlot
      />
    );
  }

  const descriptor = catalog?.bodies.find(
    (b) => b.name.toLowerCase() === bodyName.toLowerCase()
  );

  const vessels: BodyMapVessel[] =
    t?.lat != null && t?.lon != null && t?.bodyName
      ? [
          {
            id: sessionId || "self",
            label: t.craftName ?? t.pilotName ?? "Unknown",
            lat: t.lat,
            lon: t.lon,
            situation: t.situation,
            isSelf: true
          }
        ]
      : [];

  const navaids =
    worldInventory != null
      ? navaidsForBody(worldInventory, bodyName)
      : bodyName.toLowerCase() === "kerbin"
        ? KERBIN_NAVAIDS
        : [];
  const launchSites =
    worldInventory != null
      ? launchSitesForBody(worldInventory, bodyName)
      : bodyName.toLowerCase() === "kerbin"
        ? KERBIN_LAUNCH_SITES
        : [];

  return (
    <BodyMap
      bodyName={bodyName}
      bodyDisplayName={descriptor?.displayName}
      parentBodyName={descriptor?.parent ?? null}
      basemapUrl={basemapUrlFor(worldId, bodyName)}
      vessels={vessels}
      navaids={navaids}
      launchSites={launchSites}
    />
  );
}



