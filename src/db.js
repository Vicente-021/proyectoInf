import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = resolve(here, '../data/svdm.db');

/**
 * Abre (o crea) la base SQLite y aplica el esquema.
 * @param {string} path Ruta del archivo o ':memory:' para pruebas.
 */
export function openDb(path = DEFAULT_DB_PATH) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  migrate(db);
  return db;
}

/** Crea las tablas si no existen. */
export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      contact    TEXT,
      synthetic  INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1)),
      status     TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meters (
      id        TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      barge     TEXT,
      source    TEXT NOT NULL CHECK (source IN ('eGauge', 'WiseData', 'manual')),
      active    INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id                TEXT PRIMARY KEY,
      client_id         TEXT NOT NULL REFERENCES clients(id),
      factor_l_per_kwh  REAL NOT NULL CHECK (factor_l_per_kwh > 0),
      price_usd_per_kwh REAL NOT NULL CHECK (price_usd_per_kwh > 0),
      exchange_rate     REAL NOT NULL CHECK (exchange_rate > 0),
      valid_from        TEXT NOT NULL,
      valid_to          TEXT,
      status            TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive'))
    );

    CREATE TABLE IF NOT EXISTS prices (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT NOT NULL UNIQUE,
      usd_per_kwh   REAL NOT NULL CHECK (usd_per_kwh > 0),
      exchange_rate REAL NOT NULL CHECK (exchange_rate > 0),
      source        TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS readings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id   TEXT NOT NULL REFERENCES meters(id),
      ts         TEXT NOT NULL,
      kwh        REAL NOT NULL CHECK (kwh >= 0),
      source     TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('daily', 'hourly')),
      status     TEXT NOT NULL DEFAULT 'ok'
                 CHECK (status IN ('ok', 'manual', 'pending')),
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (meter_id, ts, kind)
    );

    CREATE TABLE IF NOT EXISTS consolidations (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id          TEXT NOT NULL REFERENCES clients(id),
      period             TEXT NOT NULL,
      version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      supersedes_id      INTEGER REFERENCES consolidations(id),
      is_current         INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
      rectification_reason TEXT,
      oc_reference       TEXT,
      calculation_hash   TEXT,
      calculated_at      TEXT,
      total_kwh          REAL NOT NULL,
      total_liters       REAL NOT NULL,
      total_clp          REAL NOT NULL,
      status             TEXT NOT NULL DEFAULT 'borrador'
                         CHECK (status IN ('borrador', 'revision', 'aprobada')),
      reject_reason      TEXT,
      approved_at        TEXT,
      approved_by        TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (client_id, period, version)
    );

    CREATE TABLE IF NOT EXISTS consolidation_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      consolidation_id INTEGER NOT NULL REFERENCES consolidations(id) ON DELETE CASCADE,
      reading_id       INTEGER REFERENCES readings(id),
      kwh              REAL NOT NULL,
      price_usd_per_kwh REAL NOT NULL,
      exchange_rate    REAL NOT NULL,
      factor_l_per_kwh REAL NOT NULL,
      amount_clp       REAL NOT NULL,
      liters           REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   TEXT NOT NULL REFERENCES clients(id),
      meter_id    TEXT REFERENCES meters(id),
      type        TEXT NOT NULL,
      severity    TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
      message     TEXT NOT NULL,
      ref_ts      TEXT,
      status      TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'resolved')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id        INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      meter_id        TEXT NOT NULL REFERENCES meters(id),
      ts              TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('missing', 'negative_drop', 'high_jump', 'outlier')),
      previous_value  REAL,
      value           REAL,
      delta           REAL,
      next_ts         TEXT,
      next_value      REAL,
      next_delta      REAL,
      status          TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'corrected', 'reviewed')),
      corrected_value REAL,
      corrected_at    TEXT,
      corrected_by    TEXT,
      note            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_alert_items_alert ON alert_items (alert_id);
    CREATE INDEX IF NOT EXISTS idx_alert_items_meter_ts ON alert_items (meter_id, ts);

    CREATE TABLE IF NOT EXISTS audit_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      actor        TEXT NOT NULL,
      role         TEXT NOT NULL,
      action       TEXT NOT NULL,
      entity       TEXT NOT NULL,
      entity_id    TEXT,
      detail       TEXT,
      before_value TEXT,
      after_value  TEXT,
      reason       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      role          TEXT CHECK (role IN ('analista', 'aprobador') OR role IS NULL),
      is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_readings_meter_ts ON readings (meter_id, ts);
    CREATE INDEX IF NOT EXISTS idx_readings_kind     ON readings (kind);
    CREATE INDEX IF NOT EXISTS idx_alerts_status     ON alerts (status);
    CREATE INDEX IF NOT EXISTS idx_audit_created     ON audit_events (created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions (expires_at);
  `);

  // Migraciones para bases creadas con el esquema del paso 1.
  ensureColumn(db, 'clients', 'synthetic', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'alerts', 'ref_ts', 'TEXT');
  ensureAlertItemsSchema(db);
  ensureAuditSchema(db);
  ensureUsersSchema(db);
  ensureConsolidationsSchema(db);
}

function ensureAuditSchema(db) {
  ensureColumn(db, 'audit_events', 'before_value', 'TEXT');
  ensureColumn(db, 'audit_events', 'after_value', 'TEXT');
  ensureColumn(db, 'audit_events', 'reason', 'TEXT');
}

function ensureUsersSchema(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  const hasAdmin = columns.some((column) => column.name === 'is_admin');
  const role = columns.find((column) => column.name === 'role');
  if (hasAdmin && role && role.notnull === 0) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec('DROP TABLE IF EXISTS users_new;');
    db.exec(`
      CREATE TABLE users_new (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        role          TEXT CHECK (role IN ('analista', 'aprobador') OR role IS NULL),
        is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      INSERT INTO users_new (id, name, role, password_hash, is_admin)
      SELECT id, name, role, password_hash, 0 FROM users;
    `);
    db.exec('DROP TABLE users;');
    db.exec('ALTER TABLE users_new RENAME TO users;');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function ensureConsolidationsSchema(db) {
  const columns = db.prepare('PRAGMA table_info(consolidations)').all();
  const hasVersion = columns.some((column) => column.name === 'version');

  if (!hasVersion) {
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec('BEGIN IMMEDIATE;');
      db.exec('DROP TABLE IF EXISTS consolidations_new;');
      db.exec(`
        CREATE TABLE consolidations_new (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id            TEXT NOT NULL REFERENCES clients(id),
          period               TEXT NOT NULL,
          version              INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          supersedes_id        INTEGER REFERENCES consolidations(id),
          is_current           INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
          rectification_reason TEXT,
          oc_reference         TEXT,
          calculation_hash     TEXT,
          calculated_at        TEXT,
          total_kwh            REAL NOT NULL,
          total_liters         REAL NOT NULL,
          total_clp            REAL NOT NULL,
          status               TEXT NOT NULL DEFAULT 'borrador'
                               CHECK (status IN ('borrador', 'revision', 'aprobada')),
          reject_reason        TEXT,
          approved_at          TEXT,
          approved_by          TEXT,
          created_at           TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (client_id, period, version)
        );
      `);
      db.exec(`
        INSERT INTO consolidations_new
          (id, client_id, period, version, supersedes_id, is_current,
           total_kwh, total_liters, total_clp, status, reject_reason,
           approved_at, approved_by, created_at)
        SELECT id, client_id, period, 1, NULL, 1,
               total_kwh, total_liters, total_clp, status, reject_reason,
               approved_at, approved_by, created_at
        FROM consolidations;
      `);
      db.exec('DROP TABLE consolidations;');
      db.exec('ALTER TABLE consolidations_new RENAME TO consolidations;');
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_consolidations_version
      ON consolidations (client_id, period, version);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_consolidations_current_approved
      ON consolidations (client_id, period)
      WHERE is_current = 1 AND status = 'aprobada';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_consolidations_open_rectification
      ON consolidations (client_id, period)
      WHERE supersedes_id IS NOT NULL AND status IN ('borrador', 'revision');
  `);
}

function ensureAlertItemsSchema(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'alert_items'")
    .get();
  if (row?.sql && !row.sql.includes("'outlier'")) {
    db.exec(`
      DROP TABLE alert_items;
      CREATE TABLE alert_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id        INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
        meter_id        TEXT NOT NULL REFERENCES meters(id),
        ts              TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('missing', 'negative_drop', 'high_jump', 'outlier')),
        previous_value  REAL,
        value           REAL,
        delta           REAL,
        next_ts         TEXT,
        next_value      REAL,
        next_delta      REAL,
        status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'corrected', 'reviewed')),
        corrected_value REAL,
        corrected_at    TEXT,
        corrected_by    TEXT,
        note            TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alert_items_alert ON alert_items (alert_id);
      CREATE INDEX IF NOT EXISTS idx_alert_items_meter_ts ON alert_items (meter_id, ts);
    `);
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
