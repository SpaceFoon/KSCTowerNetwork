import * as mariadb from "mariadb";
import type { Pool, PoolConnection } from "mariadb";
import { env } from "../config/env";
import { logger } from "./logger";

async function addColumnIfMissing(
  conn: PoolConnection,
  table: string,
  column: string,
  ddl: string
): Promise<void> {
  const rows = (await conn.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `,
    [table, column]
  )) as Array<Record<string, unknown>>;
  if (rows.length > 0) return;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
}

async function addIndexIfMissing(
  conn: PoolConnection,
  table: string,
  indexName: string,
  cols: string
): Promise<void> {
  const rows = (await conn.query(
    `
    SELECT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
    LIMIT 1
    `,
    [table, indexName]
  )) as Array<Record<string, unknown>>;
  if (rows.length > 0) return;
  await conn.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` ${cols}`);
}

/**
 * Returns the ordered column list of the table's PRIMARY KEY, or [] if none.
 */
async function getPrimaryKeyColumns(
  conn: PoolConnection,
  table: string
): Promise<string[]> {
  const rows = (await conn.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
    ORDER BY SEQ_IN_INDEX
    `,
    [table]
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.COLUMN_NAME));
}

let pool: Pool | null = null;
/**
 * When MariaDB is unhealthy, skip request-path pool acquisition so callers fall
 * back to in-memory state immediately. A background recovery loop can clear this
 * flag once a bounded health check succeeds.
 */
let dbSkipped = false;

export function isDbAvailable(): boolean {
  return !dbSkipped && pool !== null;
}

export function getDbPool(): Pool {
  if (dbSkipped) {
    throw new Error("MariaDB unavailable");
  }
  if (pool) {
    return pool;
  }

  pool = mariadb.createPool({
    host: env.MARIADB_HOST,
    port: env.MARIADB_PORT,
    user: env.MARIADB_USER,
    password: env.MARIADB_PASSWORD,
    database: env.MARIADB_DATABASE,
    connectionLimit: 5,
    // Keep request latency bounded if the DB blips; the in-memory fallback
    // path will just take over once dbSkipped flips.
    acquireTimeout: 5000,
    connectTimeout: 3000
  });

  return pool;
}

async function closeDbPool(): Promise<void> {
  if (!pool) return;
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  pool = null;
}

function dbErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes("ECONNREFUSED") ? "connection refused" : detail;
}

export async function markDbUnavailable(error: unknown, context = "MariaDB not used - in-memory data"): Promise<void> {
  dbSkipped = true;
  await closeDbPool();
  logger.info(
    "%s (%s). Normal for local dev without MariaDB on %s:%s.",
    context,
    dbErrorDetail(error),
    env.MARIADB_HOST,
    String(env.MARIADB_PORT)
  );
}

export async function pingDb(): Promise<boolean> {
  if (dbSkipped) {
    return false;
  }
  let conn: PoolConnection | undefined;
  try {
    const db = getDbPool();
    conn = await db.getConnection();
    await conn.query("SELECT 1");
    return true;
  } catch (error) {
    await markDbUnavailable(error);
    return false;
  } finally {
    conn?.release();
  }
}

export function startDbRecovery(options: {
  intervalMs?: number;
  onRecovered?: () => Promise<void> | void;
} = {}): () => void {
  const intervalMs = Math.max(1000, options.intervalMs ?? 10_000);
  let recovering = false;
  const timer = setInterval(() => {
    if (recovering || !dbSkipped) return;
    recovering = true;
    void (async () => {
      try {
        dbSkipped = false;
        const ok = await pingDb();
        if (!ok) return;
        logger.info("MariaDB recovered; re-enabling DB-backed repository calls");
        try {
          await options.onRecovered?.();
        } catch (error) {
          await markDbUnavailable(error, "MariaDB recovery hook failed");
        }
      } finally {
        recovering = false;
      }
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function initDbSchema(): Promise<void> {
  const db = getDbPool();
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        clerk_user_id VARCHAR(128) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'pilot',
        is_banned TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_clerk_user_id (clerk_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(64) NOT NULL,
        pilot_user_id VARCHAR(128) NOT NULL,
        assigned_tower_user_id VARCHAR(128) NULL,
        status VARCHAR(32) NOT NULL,
        telemetry_json LONGTEXT NULL,
        blocked_users_json LONGTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id VARCHAR(64) NOT NULL,
        reporter_user_id VARCHAR(128) NOT NULL,
        target_user_id VARCHAR(128) NULL,
        session_id VARCHAR(64) NULL,
        reason TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS bans (
        user_id VARCHAR(128) NOT NULL,
        banned_by_user_id VARCHAR(128) NULL,
        reason TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        kind VARCHAR(16) NOT NULL DEFAULT 'ban',
        PRIMARY KEY (user_id, kind)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await addColumnIfMissing(conn, "bans", "ip", "VARCHAR(64) NULL");
    await addColumnIfMissing(conn, "bans", "expires_at", "DATETIME NULL");
    await addColumnIfMissing(conn, "bans", "kind", "VARCHAR(16) NOT NULL DEFAULT 'ban'");
    await addIndexIfMissing(conn, "bans", "idx_bans_ip", "(ip)");
    await addIndexIfMissing(conn, "bans", "idx_bans_user_kind_expires", "(user_id, kind, expires_at)");

    // Migrate existing tables with PK (user_id) to PK (user_id, kind). Mute and ban
    // used to share the same row, so a later mute would silently overwrite a ban
    // and vice versa. With the composite key, both can coexist for the same user.
    const banPk = await getPrimaryKeyColumns(conn, "bans");
    if (banPk.length === 1 && banPk[0] === "user_id") {
      try {
        await conn.query(
          "ALTER TABLE `bans` DROP PRIMARY KEY, ADD PRIMARY KEY (`user_id`, `kind`)"
        );
        logger.info("Migrated bans PRIMARY KEY to (user_id, kind)");
      } catch (error) {
        logger.warn(
          { err: error },
          "Failed to migrate bans PRIMARY KEY to (user_id, kind). " +
            "If this is due to duplicate (user_id) rows from the legacy schema, deduplicate manually."
        );
      }
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS guests (
        id VARCHAR(64) NOT NULL,
        ip VARCHAR(64) NOT NULL,
        display_name VARCHAR(64) NOT NULL,
        first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_guests_ip (ip),
        KEY idx_guests_last_seen (last_seen_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`UPDATE users SET role = 'controller' WHERE role = 'tower'`);
    await conn.query(`UPDATE users SET role = 'supermod' WHERE role = 'supervisor'`);
    await conn.query(`UPDATE users SET role = 'owner' WHERE role = 'admin'`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS action_logs (
        id VARCHAR(64) NOT NULL,
        actor_user_id VARCHAR(128) NOT NULL,
        action_name VARCHAR(128) NOT NULL,
        metadata_json LONGTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_action_logs_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id VARCHAR(64) NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        from_user_id VARCHAR(128) NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_session_messages_session_created (session_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // One-way kOS screen mirror: each row is one terminal line forwarded by the
    // plugin's TowerKosScreenAutoCapture (reflective walk of every kOSProcessor
    // each tick, diffed by IScreenBufferLine.LastChangeTick). Kept in its own
    // table (not session_messages) so the chat/ACARS feed stays clean and so we
    // can apply different retention/limits later.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS session_kos_screen (
        id VARCHAR(64) NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        from_user_id VARCHAR(128) NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_session_kos_screen_session_created (session_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // ATC roleplay: per-session squawk/callsign, controller-driven launch countdown,
    // and bidirectional pilot/controller checklist state stored as a single JSON blob.
    await addColumnIfMissing(conn, "sessions", "squawk", "VARCHAR(4) NULL");
    await addColumnIfMissing(conn, "sessions", "callsign", "VARCHAR(64) NULL");
    // Human-set name for the lobby's "Tower room". When unset at create-time, the backend
    // auto-fills it with a callsign-derived English label (e.g. "DARREN-A49 Tower") so the
    // lobby NEVER shows a raw `tower-<UUID>` heading. May be PATCHed later via
    // PATCH /v1/session/:id. See docs/GLOSSARY.md "Room name".
    await addColumnIfMissing(conn, "sessions", "name", "VARCHAR(80) NULL");
    // Notional VHF aviation-band frequency (118.000 - 136.975 MHz, 25 kHz spacing) auto-
    // assigned to each session at create-time so the lobby card has a "real radio" feel
    // ("Bobcat-7 Tower · 118.300") instead of a UUID. Stored as a string for display
    // fidelity (preserves the trailing zero in 118.300). Cosmetic — no routing logic
    // depends on this; LiveKit room name is still tower-{sessionId}.
    await addColumnIfMissing(conn, "sessions", "frequency_mhz", "VARCHAR(8) NULL");
    await addColumnIfMissing(conn, "sessions", "checklist_state", "LONGTEXT NULL");
    // Optional per-session checklist override. NULL = use the hardcoded CHECKLIST_PHASES
    // template from web/src/session/checklists.ts. Set when a pilot/controller loads a
    // saved template or edits items in this session, so all participants (web + in-game)
    // see the same item set.
    await addColumnIfMissing(conn, "sessions", "checklist_phases", "LONGTEXT NULL");
    await addColumnIfMissing(conn, "sessions", "countdown_starts_at", "DATETIME NULL");
    await addColumnIfMissing(conn, "sessions", "countdown_length_sec", "INT NULL");
    // JSON array of user ids currently spectating this room (read-only listeners — see
    // chat/telemetry/voice subscribe but cannot publish, rename, advance tower, or close
    // the room). Mirrors the design of `blocked_users_json`. Spectators self-add via
    // POST /v1/session/:id/spectate and self-remove via POST /v1/session/:id/leave;
    // they're also dropped automatically when the pilot/mod closes the room.
    await addColumnIfMissing(conn, "sessions", "spectator_user_ids_json", "LONGTEXT NULL");
    await addColumnIfMissing(conn, "sessions", "clearances_json", "LONGTEXT NULL");
    await addColumnIfMissing(conn, "sessions", "expected_landing_runway", "VARCHAR(8) NULL");

    // Saved checklist templates. `scope='user'` is a personal template that auto-loads
    // for every new session the owner pilots; `scope='craft'` is keyed by craft_name and
    // takes precedence over the user default when telemetry shows that craft is active;
    // `scope='global'` is a mod-curated template visible to ALL users (owner_user_id still
    // tracks the mod who created/last-edited it for audit). `phases_json` matches the
    // `ChecklistPhase[]` shape used on the wire.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS checklist_templates (
        id VARCHAR(64) NOT NULL,
        owner_user_id VARCHAR(128) NOT NULL,
        scope VARCHAR(16) NOT NULL DEFAULT 'user',
        craft_name VARCHAR(120) NULL,
        name VARCHAR(120) NOT NULL,
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        phases_json LONGTEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_checklist_tpl_owner (owner_user_id, scope),
        KEY idx_checklist_tpl_craft (owner_user_id, craft_name),
        KEY idx_checklist_tpl_scope (scope)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Send-to-tower receipts. Each row links a checklist "send" action to the
    // session_messages row it announced and (optionally) the controller's ack. NULL
    // ack_user_id = pending. We never delete on session close so the audit survives.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS checklist_sends (
        id VARCHAR(64) NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        message_id VARCHAR(64) NOT NULL,
        template_id VARCHAR(64) NULL,
        template_name VARCHAR(120) NOT NULL,
        sent_by_user_id VARCHAR(128) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ack_user_id VARCHAR(128) NULL,
        ack_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_cs_session_created (session_id, created_at),
        KEY idx_cs_message (message_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Denormalized per-user lifetime tallies. Recomputable from session_events but read-hot
    // enough that we keep them in sync transactionally inside awardEvent().
    await addColumnIfMissing(conn, "users", "rep", "INT NOT NULL DEFAULT 0");
    await addColumnIfMissing(conn, "users", "achievements", "INT NOT NULL DEFAULT 0");
    await addColumnIfMissing(conn, "users", "penalties", "INT NOT NULL DEFAULT 0");

    // session_events: scorecard + chat-feed substrate. dedupe_bucket lets the client preview
    // path (`source='client_preview'`) and the canonical backend detector (`source='auto'`)
    // collapse into a single row when they describe the same physical event. Manual
    // controller-issued events leave dedupe_bucket NULL (MySQL UNIQUE allows multiple NULLs)
    // so they can never accidentally clobber an automatic detection.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS session_events (
        id CHAR(36) NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        target_user_id VARCHAR(128) NOT NULL,
        actor_user_id VARCHAR(128) NULL,
        kind VARCHAR(48) NOT NULL,
        points INT NOT NULL DEFAULT 0,
        label VARCHAR(160) NOT NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'auto',
        dedupe_bucket VARCHAR(96) NULL,
        metadata_json LONGTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_session_events_dedupe (session_id, target_user_id, kind, dedupe_bucket),
        KEY idx_session_events_session_created (session_id, created_at),
        KEY idx_session_events_target_created (target_user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.commit();
  } catch (error) {
    if (conn) {
      await conn.rollback();
    }
    throw error;
  } finally {
    conn?.release();
  }
}
