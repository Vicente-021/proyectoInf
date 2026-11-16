import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { consolidate } from './calc.js';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function getClient(db, clientId) {
  return db
    .prepare('SELECT id, name, contact FROM clients WHERE id = ?')
    .get(clientId);
}

function getMeter(db, clientId) {
  return db
    .prepare('SELECT id, barge, source FROM meters WHERE client_id = ? AND active = 1 LIMIT 1')
    .get(clientId);
}

function getContract(db, clientId) {
  return db
    .prepare(
      `SELECT * FROM contracts
       WHERE client_id = ? AND status = 'active'
       ORDER BY valid_from DESC LIMIT 1`
    )
    .get(clientId);
}

function getLatestPrice(db) {
  return db.prepare('SELECT * FROM prices ORDER BY date DESC LIMIT 1').get();
}

/**
 * Construye la app HTTP. Se separa del `listen` para poder probarla.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createApp(db) {
  return createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/api/health') {
        const counts = {
          clients: db.prepare('SELECT COUNT(*) AS n FROM clients').get().n,
          readings: db.prepare('SELECT COUNT(*) AS n FROM readings').get().n,
          daily: db.prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'daily'").get().n,
          hourly: db.prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'hourly'").get().n,
          consolidations: db.prepare('SELECT COUNT(*) AS n FROM consolidations').get().n
        };
        return sendJson(res, 200, { ok: true, service: 'svdm-mvp', counts });
      }

      if (req.method === 'GET' && url.pathname === '/api/clients') {
        const clients = db
          .prepare(
            `SELECT c.id, c.name, m.id AS meter_id, m.barge,
                    (SELECT ROUND(SUM(r.kwh), 9) FROM readings r
                     WHERE r.meter_id = m.id AND r.kind = 'daily') AS total_kwh
             FROM clients c
             JOIN meters m ON m.client_id = c.id
             ORDER BY c.id`
          )
          .all();
        return sendJson(res, 200, { clients });
      }

      if (req.method === 'GET' && url.pathname === '/api/readings') {
        const kind = url.searchParams.get('kind') ?? 'daily';
        if (kind !== 'daily' && kind !== 'hourly') {
          return sendJson(res, 400, { error: "kind debe ser 'daily' o 'hourly'" });
        }
        const limit = Math.min(
          Math.max(Number(url.searchParams.get('limit') ?? 50), 1),
          1000
        );
        const readings = db
          .prepare(
            `SELECT id, meter_id, ts, kwh, source, kind, status, note
             FROM readings WHERE kind = ? ORDER BY ts LIMIT ?`
          )
          .all(kind, limit);
        return sendJson(res, 200, { kind, count: readings.length, readings });
      }

      if (req.method === 'GET' && url.pathname === '/api/consolidation/preview') {
        const clientId = url.searchParams.get('client');
        const period = url.searchParams.get('period');
        if (!clientId || !period) {
          return sendJson(res, 400, { error: 'client y period son obligatorios' });
        }

        const client = getClient(db, clientId);
        if (!client) {
          return sendJson(res, 404, { error: 'cliente no encontrado' });
        }
        const meter = getMeter(db, clientId);
        const contract = getContract(db, clientId);
        const price = getLatestPrice(db);
        if (!meter || !contract || !price) {
          return sendJson(res, 409, { error: 'faltan medidor, contrato o precio' });
        }

        const readings = db
          .prepare(
            `SELECT id, ts, kwh FROM readings
             WHERE meter_id = ? AND kind = 'daily' AND ts LIKE ?
             ORDER BY ts`
          )
          .all(meter.id, `${period}%`);

        if (readings.length === 0) {
          return sendJson(res, 404, { error: 'no hay lecturas para el período' });
        }

        const result = consolidate({ readings, contract, price });
        return sendJson(res, 200, {
          client,
          meter,
          period,
          contract,
          price,
          summary: {
            readings: result.lines.length,
            totalKwh: result.totalKwh,
            totalLiters: result.totalLiters,
            totalClp: result.totalClp
          },
          lines: result.lines
        });
      }

      return sendJson(res, 404, { error: 'ruta no encontrada' });
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: 'error interno' });
    }
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const db = openDb();
  const port = Number(process.env.PORT ?? 3000);
  const server = createApp(db);
  server.listen(port, () => {
    console.log(`SVDM MVP en http://localhost:${port}`);
    console.log('  GET /api/health');
    console.log('  GET /api/clients');
    console.log('  GET /api/readings?kind=daily&limit=50');
    console.log('  GET /api/consolidation/preview?client=CLI-A&period=2026-05');
  });
}
