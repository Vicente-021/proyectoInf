import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { seedDatabase } from '../src/seed.js';
import { consolidate, round } from '../src/calc.js';

const seed = JSON.parse(
  readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8')
);

function freshDb() {
  const db = openDb(':memory:');
  seedDatabase(db, seed);
  return db;
}

test('el seed carga la cartera, contratos, precios y lecturas', () => {
  const db = freshDb();

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meters').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prices').get().n, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'daily'").get().n,
    seed.daily_readings.length
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'hourly'").get().n,
    seed.hourly_readings.length
  );

  const synthetic = db
    .prepare('SELECT id, synthetic FROM clients ORDER BY id')
    .all()
    .map((row) => [row.id, row.synthetic]);
  assert.deepEqual(synthetic, [
    ['CLI-A', 0],
    ['CLI-B', 1],
    ['CLI-C', 1],
    ['CLI-D', 1]
  ]);

  db.close();
});

test('el seed marca la lectura faltante de B y la inconsistencia horaria de A', () => {
  const db = freshDb();
  const alerts = db.prepare('SELECT * FROM alerts ORDER BY id').all();

  assert.equal(alerts.length, 7);
  const missing = alerts.find((alert) => alert.type === 'missing_reading');
  const consistency = alerts.find((alert) => alert.type === 'hourly_consistency');

  assert.equal(missing.client_id, 'CLI-B');
  assert.equal(missing.meter_id, 'M-01');
  assert.equal(missing.ref_ts, '2026-05-15');
  assert.equal(missing.severity, 'critical');
  assert.equal(consistency.client_id, 'CLI-A');
  assert.equal(consistency.severity, 'warning');

  const items = db.prepare('SELECT * FROM alert_items ORDER BY id').all();
  assert.equal(items.length, 32);
  assert.equal(items.filter((item) => item.kind === 'missing').length, 2);
  assert.equal(items.filter((item) => item.kind === 'negative_drop').length, 12);
  assert.equal(items.filter((item) => item.kind === 'high_jump').length, 13);
  assert.equal(items.filter((item) => item.kind === 'outlier').length, 5);

  db.close();
});

test('el seed es idempotente', () => {
  const db = freshDb();
  seedDatabase(db, seed);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'daily'").get().n,
    118
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'hourly'").get().n,
    751
  );

  db.close();
});

test('la consolidación del Cliente A reproduce el total de la planilla', () => {
  const db = freshDb();

  const readings = db
    .prepare(
      "SELECT id, ts, kwh FROM readings WHERE kind = 'daily' AND meter_id = 'M-04' ORDER BY ts"
    )
    .all();
  const contract = db.prepare("SELECT * FROM contracts WHERE client_id = 'CLI-A'").get();
  const price = db.prepare('SELECT * FROM prices ORDER BY date DESC LIMIT 1').get();

  const result = consolidate({ readings, contract, price });

  assert.equal(result.lines.length, 30);
  assert.ok(
    Math.abs(result.totalKwh - seed.reference.total_kwh) < 1e-6,
    `kWh: ${result.totalKwh} vs ${seed.reference.total_kwh}`
  );
  assert.ok(
    Math.abs(result.totalLiters - seed.reference.total_liters) < 0.01,
    `litros: ${result.totalLiters} vs ${seed.reference.total_liters}`
  );
  assert.ok(
    Math.abs(result.totalClp - seed.reference.total_clp) <= 1,
    `CLP: ${result.totalClp} vs ${seed.reference.total_clp}`
  );
  assert.equal(result.totalClp, round(seed.reference.total_clp, 2));

  db.close();
});

test('la base rechaza lecturas duplicadas y kWh negativos', () => {
  const db = freshDb();
  const insert = db.prepare(
    'INSERT INTO readings (meter_id, ts, kwh, source, kind) VALUES (?, ?, ?, ?, ?)'
  );

  assert.throws(
    () => insert.run('M-04', '2026-05-01', 1, 'eGauge', 'daily'),
    /UNIQUE/
  );
  assert.throws(
    () => insert.run('M-04', '2099-01-01', -1, 'eGauge', 'daily'),
    /CHECK/
  );

  db.close();
});

test('el seed crea los dos roles de la demostración', () => {
  const db = freshDb();
  const users = db.prepare('SELECT id, role FROM users ORDER BY id').all();

  assert.deepEqual(
    users.map((user) => user.role),
    ['analista', 'aprobador']
  );

  db.close();
});
