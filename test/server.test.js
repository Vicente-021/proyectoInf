import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { seedDatabase } from '../src/seed.js';
import { createApp } from '../src/server.js';

const seed = JSON.parse(
  readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8')
);

async function withServer(t) {
  const db = openDb(':memory:');
  seedDatabase(db, seed);
  const server = createApp(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  return { base: `http://127.0.0.1:${port}`, db };
}

test('GET /api/health informa el estado de la base', async (t) => {
  const { base } = await withServer(t);
  const response = await fetch(`${base}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.counts.daily, 30);
  assert.equal(body.counts.hourly, 751);
});

test('GET /api/clients devuelve el cliente sembrado', async (t) => {
  const { base } = await withServer(t);
  const response = await fetch(`${base}/api/clients`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.clients.length, 1);
  assert.equal(body.clients[0].id, 'CLI-A');
  assert.equal(body.clients[0].meter_id, 'M-04');
  assert.ok(Math.abs(body.clients[0].total_kwh - 30811.227520008) < 1e-6);
});

test('GET /api/consolidation/preview reproduce el total de la planilla', async (t) => {
  const { base } = await withServer(t);
  const response = await fetch(
    `${base}/api/consolidation/preview?client=CLI-A&period=2026-05`
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.readings, 30);
  assert.ok(Math.abs(body.summary.totalKwh - 30811.227520008) < 1e-6);
  assert.equal(body.summary.totalClp, 21004949.14);
  assert.equal(body.lines.length, 30);
});

test('GET /api/readings filtra por tipo y limita el resultado', async (t) => {
  const { base } = await withServer(t);

  const daily = await fetch(`${base}/api/readings?kind=daily&limit=2`).then((r) => r.json());
  assert.equal(daily.kind, 'daily');
  assert.equal(daily.count, 2);

  const hourly = await fetch(`${base}/api/readings?kind=hourly&limit=3`).then((r) => r.json());
  assert.equal(hourly.kind, 'hourly');
  assert.equal(hourly.count, 3);

  const bad = await fetch(`${base}/api/readings?kind=minute`);
  assert.equal(bad.status, 400);
});

test('la API responde 400 si faltan parámetros y 404 si la ruta no existe', async (t) => {
  const { base } = await withServer(t);

  const bad = await fetch(`${base}/api/consolidation/preview`);
  assert.equal(bad.status, 400);

  const missing = await fetch(`${base}/api/no-existe`);
  assert.equal(missing.status, 404);
});

test('el preview responde 404 si el cliente o el período no existen', async (t) => {
  const { base } = await withServer(t);

  const noClient = await fetch(
    `${base}/api/consolidation/preview?client=NOPE&period=2026-05`
  );
  assert.equal(noClient.status, 404);

  const noPeriod = await fetch(
    `${base}/api/consolidation/preview?client=CLI-A&period=1999-01`
  );
  assert.equal(noPeriod.status, 404);
});

test('el preview responde 409 si falta el contrato', async (t) => {
  const { base, db } = await withServer(t);
  db.exec('DELETE FROM contracts');

  const response = await fetch(
    `${base}/api/consolidation/preview?client=CLI-A&period=2026-05`
  );
  assert.equal(response.status, 409);
});
