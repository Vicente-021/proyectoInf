import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';

test('la migración conserva usuarios, consolidaciones y líneas existentes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'svdm-migration-'));
  const path = join(dir, 'old.db');

  const old = new DatabaseSync(path);
  old.exec('PRAGMA foreign_keys = ON;');
  old.exec(`
    CREATE TABLE clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('analista', 'aprobador')),
      password_hash TEXT NOT NULL
    );
    CREATE TABLE consolidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL REFERENCES clients(id),
      period TEXT NOT NULL,
      total_kwh REAL NOT NULL,
      total_liters REAL NOT NULL,
      total_clp REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'borrador',
      reject_reason TEXT,
      approved_at TEXT,
      approved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (client_id, period)
    );
    CREATE TABLE consolidation_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consolidation_id INTEGER NOT NULL REFERENCES consolidations(id) ON DELETE CASCADE,
      reading_id INTEGER,
      kwh REAL NOT NULL,
      price_usd_per_kwh REAL NOT NULL,
      exchange_rate REAL NOT NULL,
      factor_l_per_kwh REAL NOT NULL,
      amount_clp REAL NOT NULL,
      liters REAL NOT NULL
    );
  `);
  old.prepare("INSERT INTO clients (id, name) VALUES ('CLI-A', 'Cliente A')").run();
  old
    .prepare("INSERT INTO users (id, name, role, password_hash) VALUES ('u-old', 'Usuario antiguo', 'analista', 'hash')")
    .run();
  old
    .prepare(
      `INSERT INTO consolidations
         (id, client_id, period, total_kwh, total_liters, total_clp, status, approved_by)
       VALUES (7, 'CLI-A', '2026-05', 100, 110, 1000, 'aprobada', 'Jefe')`
    )
    .run();
  old
    .prepare(
      `INSERT INTO consolidation_lines
         (consolidation_id, kwh, price_usd_per_kwh, exchange_rate, factor_l_per_kwh, amount_clp, liters)
       VALUES (7, 100, 0.5, 900, 1.1, 45000, 110)`
    )
    .run();
  old.close();

  const db = openDb(path);
  const user = db.prepare("SELECT id, name, role, is_admin FROM users WHERE id = 'u-old'").get();
  assert.deepEqual({ ...user }, { id: 'u-old', name: 'Usuario antiguo', role: 'analista', is_admin: 0 });

  const consolidation = db.prepare('SELECT * FROM consolidations WHERE id = 7').get();
  assert.equal(consolidation.version, 1);
  assert.equal(consolidation.is_current, 1);
  assert.equal(consolidation.status, 'aprobada');
  assert.equal(consolidation.total_clp, 1000);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM consolidation_lines WHERE consolidation_id = 7').get().n,
    1
  );

  // La restricción antigua UNIQUE(client_id, period) ya no impide una segunda versión.
  db.prepare(
    `INSERT INTO consolidations
       (client_id, period, version, supersedes_id, is_current, total_kwh, total_liters, total_clp, status)
     VALUES ('CLI-A', '2026-05', 2, 7, 0, 120, 130, 1200, 'borrador')`
  ).run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM consolidations WHERE client_id = 'CLI-A'").get().n,
    2
  );

  db.close();

  // Ejecutar la migración de nuevo debe ser seguro.
  const again = openDb(path);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM consolidations').get().n, 2);
  assert.equal(again.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'u-old'").get().n, 1);
  again.close();

  rmSync(dir, { recursive: true, force: true });
});
