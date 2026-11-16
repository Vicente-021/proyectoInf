import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { consolidate, round } from './calc.js';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  getSessionUser,
  parseCookies,
  sessionCookie,
  verifyPassword
} from './auth.js';

const MAX_BODY = 1_000_000;
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

/** Sirve archivos de public/. Devuelve true si respondió. */
function serveStatic(res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return true;
  }

  let relative;
  try {
    relative = pathname === '/'
      ? 'index.html'
      : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return false;
  }

  const filePath = resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + sep) || !existsSync(filePath)) {
    return false;
  }
  if (!statSync(filePath).isFile()) {
    return false;
  }

  const content = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-cache'
  });
  res.end(content);
  return true;
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error('body demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const clean = value.trim().replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(clean)) return Number.NaN;
    return Number(clean);
  }
  return Number.NaN;
}

function audit(db, user, action, entity, entityId = null, detail = null) {
  db.prepare(
    `INSERT INTO audit_events (actor, role, action, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(user.name, user.role, action, entity, entityId == null ? null : String(entityId), detail);
}

function currentUser(db, req) {
  const sid = parseCookies(req.headers.cookie).sid;
  return getSessionUser(db, sid);
}

function requireUser(db, req, res, role) {
  const user = currentUser(db, req);
  if (!user) {
    sendError(res, 401, 'no autenticado');
    return null;
  }
  if (role && user.role !== role) {
    sendError(res, 403, 'permiso denegado para el rol ' + user.role);
    return null;
  }
  return user;
}

function defaultPeriod(db) {
  return db.prepare("SELECT value FROM meta WHERE key = 'period'").get()?.value ?? null;
}

function getClient(db, clientId) {
  return db
    .prepare('SELECT id, name, contact, synthetic FROM clients WHERE id = ?')
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

function getReadings(db, meterId, period) {
  return db
    .prepare(
      `SELECT id, ts, kwh, source, kind, status, note
       FROM readings
       WHERE meter_id = ? AND kind = 'daily' AND ts LIKE ?
       ORDER BY ts`
    )
    .all(meterId, `${period}%`);
}

function getConsolidation(db, consolidationId) {
  return db
    .prepare(
      `SELECT co.*, c.name AS client_name
       FROM consolidations co
       JOIN clients c ON c.id = co.client_id
       WHERE co.id = ?`
    )
    .get(consolidationId);
}

function consolidationDetail(db, consolidationId) {
  const header = getConsolidation(db, consolidationId);
  if (!header) return null;
  const lines = db
    .prepare(
      `SELECT l.*, r.ts
       FROM consolidation_lines l
       LEFT JOIN readings r ON r.id = l.reading_id
       WHERE l.consolidation_id = ?
       ORDER BY r.ts`
    )
    .all(consolidationId);
  const meter = getMeter(db, header.client_id);
  return { ...header, meter, lines };
}

function getAlerts(db, { status = 'open', clientId = null } = {}) {
  const conditions = [];
  const params = [];
  if (status && status !== 'all') {
    conditions.push('a.status = ?');
    params.push(status);
  }
  if (clientId) {
    conditions.push('a.client_id = ?');
    params.push(clientId);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return db
    .prepare(
      `SELECT a.*, c.name AS client_name
       FROM alerts a
       JOIN clients c ON c.id = a.client_id
       ${where}
       ORDER BY CASE a.status WHEN 'open' THEN 0 ELSE 1 END,
                CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                a.id DESC`
    )
    .all(...params);
}

async function handle(db, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method;

  // ---------- Archivos estáticos ----------
  if (method === 'GET' && !url.pathname.startsWith('/api/')) {
    if (serveStatic(res, url.pathname)) return;
    return sendError(res, 404, 'recurso no encontrado');
  }

  // ---------- Público ----------
  if (method === 'GET' && url.pathname === '/api/health') {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return sendJson(res, 200, {
      ok: true,
      service: 'svdm-mvp',
      counts: {
        clients: count('clients'),
        readings: count('readings'),
        daily: db.prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'daily'").get().n,
        hourly: db.prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'hourly'").get().n,
        alerts: count('alerts'),
        consolidations: count('consolidations'),
        audit: count('audit_events')
      }
    });
  }

  if (method === 'POST' && url.pathname === '/api/auth/login') {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    const username = body.username ?? body.id;
    if (!username || !body.password) {
      return sendError(res, 400, 'username y password son obligatorios');
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(username);
    if (!row || !verifyPassword(body.password, row.password_hash)) {
      return sendError(res, 401, 'credenciales inválidas');
    }
    const sid = createSession(db, row.id);
    audit(
      db,
      { id: row.id, name: row.name, role: row.role },
      'auth.login',
      'user',
      row.id,
      null
    );
    return sendJson(
      res,
      200,
      { user: { id: row.id, name: row.name, role: row.role } },
      { 'Set-Cookie': sessionCookie(sid) }
    );
  }

  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    const sid = parseCookies(req.headers.cookie).sid;
    deleteSession(db, sid);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  // ---------- Autenticado ----------
  const user = requireUser(db, req, res);
  if (!user) return;

  if (method === 'GET' && url.pathname === '/api/auth/me') {
    return sendJson(res, 200, { user });
  }

  if (method === 'GET' && url.pathname === '/api/summary') {
    const period = url.searchParams.get('period') ?? defaultPeriod(db);
    if (!period) return sendError(res, 400, 'no hay período configurado');

    const price = getLatestPrice(db);
    const totalKwh =
      db
        .prepare(
          `SELECT ROUND(SUM(kwh), 9) AS total
           FROM readings WHERE kind = 'daily' AND ts LIKE ?`
        )
        .get(`${period}%`).total ?? 0;

    const statuses = db
      .prepare('SELECT status, COUNT(*) AS n FROM consolidations WHERE period = ? GROUP BY status')
      .all(period);

    return sendJson(res, 200, {
      period,
      clients: db.prepare('SELECT COUNT(*) AS n FROM clients').get().n,
      readings: db
        .prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'daily' AND ts LIKE ?")
        .get(`${period}%`).n,
      openAlerts: db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'").get().n,
      criticalAlerts: db
        .prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open' AND severity = 'critical'")
        .get().n,
      totalKwh,
      estimatedClp: price ? round(totalKwh * price.usd_per_kwh * price.exchange_rate, 2) : 0,
      consolidations: statuses,
      latestAudit: db
        .prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 5')
        .all()
    });
  }

  if (method === 'GET' && url.pathname === '/api/clients') {
    const period = url.searchParams.get('period') ?? defaultPeriod(db);
    const clients = db
      .prepare(
        `SELECT c.id, c.name, c.synthetic, m.id AS meter_id, m.barge,
                (SELECT ROUND(SUM(r.kwh), 9) FROM readings r
                 WHERE r.meter_id = m.id AND r.kind = 'daily' AND r.ts LIKE ?) AS total_kwh,
                (SELECT COUNT(*) FROM alerts a
                 WHERE a.client_id = c.id AND a.status = 'open') AS open_alerts,
                (SELECT co.status FROM consolidations co
                 WHERE co.client_id = c.id AND co.period = ? ORDER BY co.id DESC LIMIT 1) AS consolidation_status
         FROM clients c
         JOIN meters m ON m.client_id = c.id
         ORDER BY c.id`
      )
      .all(`${period}%`, period);
    return sendJson(res, 200, { period, clients });
  }

  const clientMatch = url.pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (method === 'GET' && clientMatch) {
    const period = url.searchParams.get('period') ?? defaultPeriod(db);
    const client = getClient(db, decodeURIComponent(clientMatch[1]));
    if (!client) return sendError(res, 404, 'cliente no encontrado');

    const meter = getMeter(db, client.id);
    const contract = getContract(db, client.id);
    const price = getLatestPrice(db);
    const readings = meter ? getReadings(db, meter.id, period) : [];
    const result =
      meter && contract && price && readings.length
        ? consolidate({ readings, contract, price })
        : null;

    return sendJson(res, 200, {
      period,
      client,
      meter,
      contract,
      price,
      readings,
      summary: result
        ? {
            readings: result.lines.length,
            totalKwh: result.totalKwh,
            totalLiters: result.totalLiters,
            totalClp: result.totalClp
          }
        : null,
      alerts: getAlerts(db, { status: 'open', clientId: client.id }),
      consolidation:
        db
          .prepare('SELECT * FROM consolidations WHERE client_id = ? AND period = ? ORDER BY id DESC LIMIT 1')
          .get(client.id, period) ?? null
    });
  }

  if (method === 'GET' && url.pathname === '/api/readings') {
    const kind = url.searchParams.get('kind') ?? 'daily';
    if (kind !== 'daily' && kind !== 'hourly') {
      return sendError(res, 400, "kind debe ser 'daily' o 'hourly'");
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 1000);
    const meterId = url.searchParams.get('meter');
    const readings = meterId
      ? db
          .prepare(
            `SELECT id, meter_id, ts, kwh, source, kind, status, note
             FROM readings WHERE kind = ? AND meter_id = ? ORDER BY ts LIMIT ?`
          )
          .all(kind, meterId, limit)
      : db
          .prepare(
            `SELECT id, meter_id, ts, kwh, source, kind, status, note
             FROM readings WHERE kind = ? ORDER BY ts LIMIT ?`
          )
          .all(kind, limit);
    return sendJson(res, 200, { kind, count: readings.length, readings });
  }

  if (method === 'GET' && url.pathname === '/api/alerts') {
    const status = url.searchParams.get('status') ?? 'open';
    const clientId = url.searchParams.get('client');
    return sendJson(res, 200, { alerts: getAlerts(db, { status, clientId }) });
  }

  if (method === 'GET' && url.pathname === '/api/audit') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 500);
    const events = db
      .prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?')
      .all(limit);
    return sendJson(res, 200, { events });
  }

  if (method === 'GET' && url.pathname === '/api/consolidations') {
    const period = url.searchParams.get('period');
    const rows = period
      ? db
          .prepare(
            `SELECT co.*, c.name AS client_name
             FROM consolidations co JOIN clients c ON c.id = co.client_id
             WHERE co.period = ? ORDER BY co.id DESC`
          )
          .all(period)
      : db
          .prepare(
            `SELECT co.*, c.name AS client_name
             FROM consolidations co JOIN clients c ON c.id = co.client_id
             ORDER BY co.id DESC`
          )
          .all();
    return sendJson(res, 200, { consolidations: rows });
  }

  const consolidationMatch = url.pathname.match(/^\/api\/consolidations\/(\d+)$/);
  if (method === 'GET' && consolidationMatch) {
    const detail = consolidationDetail(db, Number(consolidationMatch[1]));
    if (!detail) return sendError(res, 404, 'consolidación no encontrada');
    return sendJson(res, 200, detail);
  }

  // Compatibilidad con el endpoint de preview del paso 1.
  if (method === 'GET' && url.pathname === '/api/consolidation/preview') {
    const clientId = url.searchParams.get('client');
    const period = url.searchParams.get('period');
    if (!clientId || !period) return sendError(res, 400, 'client y period son obligatorios');

    const client = getClient(db, clientId);
    if (!client) return sendError(res, 404, 'cliente no encontrado');
    const meter = getMeter(db, clientId);
    const contract = getContract(db, clientId);
    const price = getLatestPrice(db);
    if (!meter || !contract || !price) {
      return sendError(res, 409, 'faltan medidor, contrato o precio');
    }
    const readings = getReadings(db, meter.id, period);
    if (!readings.length) return sendError(res, 404, 'no hay lecturas para el período');
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

  // ---------- Escritura ----------
  if (method === 'POST' && url.pathname === '/api/consolidations') {
    const authUser = requireUser(db, req, res, 'analista');
    if (!authUser) return;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    const clientId = body.client_id;
    const period = body.period ?? defaultPeriod(db);
    if (!clientId || !period) {
      return sendError(res, 400, 'client_id y period son obligatorios');
    }

    const client = getClient(db, clientId);
    const meter = getMeter(db, clientId);
    const contract = getContract(db, clientId);
    const price = getLatestPrice(db);
    if (!client) return sendError(res, 404, 'cliente no encontrado');
    if (!meter || !contract || !price) {
      return sendError(res, 409, 'faltan medidor, contrato o precio');
    }
    const readings = getReadings(db, meter.id, period);
    if (!readings.length) return sendError(res, 400, 'no hay lecturas para el período');

    const existing = db
      .prepare('SELECT * FROM consolidations WHERE client_id = ? AND period = ? ORDER BY id DESC LIMIT 1')
      .get(clientId, period);
    if (existing?.status === 'aprobada') {
      return sendError(res, 409, 'la consolidación está aprobada y es inmutable');
    }
    if (existing?.status === 'revision') {
      return sendError(res, 409, 'la consolidación está en revisión');
    }

    const result = consolidate({ readings, contract, price });
    let consolidationId;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) {
        consolidationId = existing.id;
        db.prepare(
          `UPDATE consolidations
           SET total_kwh = ?, total_liters = ?, total_clp = ?, reject_reason = NULL
           WHERE id = ?`
        ).run(result.totalKwh, result.totalLiters, result.totalClp, consolidationId);
        db.prepare('DELETE FROM consolidation_lines WHERE consolidation_id = ?').run(
          consolidationId
        );
      } else {
        const info = db
          .prepare(
            `INSERT INTO consolidations
               (client_id, period, total_kwh, total_liters, total_clp, status)
             VALUES (?, ?, ?, ?, ?, 'borrador')`
          )
          .run(clientId, period, result.totalKwh, result.totalLiters, result.totalClp);
        consolidationId = Number(info.lastInsertRowid);
      }

      const insertLine = db.prepare(
        `INSERT INTO consolidation_lines
           (consolidation_id, reading_id, kwh, price_usd_per_kwh, exchange_rate,
            factor_l_per_kwh, amount_clp, liters)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const line of result.lines) {
        insertLine.run(
          consolidationId,
          line.reading_id,
          line.kwh,
          line.price_usd_per_kwh,
          line.exchange_rate,
          line.factor_l_per_kwh,
          line.amount_clp,
          line.liters
        );
      }

      audit(
        db,
        authUser,
        existing ? 'consolidation.recalculated' : 'consolidation.created',
        'consolidation',
        consolidationId,
        `${clientId} ${period}: ${result.totalKwh} kWh, ${result.totalClp} CLP`
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return sendJson(res, 201, consolidationDetail(db, consolidationId));
  }

  const submitMatch = url.pathname.match(/^\/api\/consolidations\/(\d+)\/submit$/);
  if (method === 'POST' && submitMatch) {
    const authUser = requireUser(db, req, res, 'analista');
    if (!authUser) return;
    const id = Number(submitMatch[1]);
    const row = getConsolidation(db, id);
    if (!row) return sendError(res, 404, 'consolidación no encontrada');
    if (row.status !== 'borrador') {
      return sendError(res, 409, `no se puede enviar una consolidación en estado ${row.status}`);
    }
    const openCritical = db
      .prepare(
        `SELECT * FROM alerts
         WHERE client_id = ? AND status = 'open' AND severity = 'critical'`
      )
      .all(row.client_id);
    if (openCritical.length) {
      return sendError(res, 409, 'hay alertas críticas abiertas', { alerts: openCritical });
    }

    db.prepare(
      `UPDATE consolidations SET status = 'revision', reject_reason = NULL WHERE id = ?`
    ).run(id);
    audit(db, authUser, 'consolidation.submitted', 'consolidation', id, null);
    return sendJson(res, 200, consolidationDetail(db, id));
  }

  const approveMatch = url.pathname.match(/^\/api\/consolidations\/(\d+)\/approve$/);
  if (method === 'POST' && approveMatch) {
    const authUser = requireUser(db, req, res, 'aprobador');
    if (!authUser) return;
    const id = Number(approveMatch[1]);
    const row = getConsolidation(db, id);
    if (!row) return sendError(res, 404, 'consolidación no encontrada');
    if (row.status !== 'revision') {
      return sendError(res, 409, `no se puede aprobar una consolidación en estado ${row.status}`);
    }
    const openCritical = db
      .prepare(
        `SELECT * FROM alerts
         WHERE client_id = ? AND status = 'open' AND severity = 'critical'`
      )
      .all(row.client_id);
    if (openCritical.length) {
      return sendError(res, 409, 'hay alertas críticas abiertas', { alerts: openCritical });
    }

    db.prepare(
      `UPDATE consolidations
       SET status = 'aprobada', approved_at = datetime('now'), approved_by = ?
       WHERE id = ?`
    ).run(authUser.name, id);
    audit(db, authUser, 'consolidation.approved', 'consolidation', id, null);
    return sendJson(res, 200, consolidationDetail(db, id));
  }

  const rejectMatch = url.pathname.match(/^\/api\/consolidations\/(\d+)\/reject$/);
  if (method === 'POST' && rejectMatch) {
    const authUser = requireUser(db, req, res, 'aprobador');
    if (!authUser) return;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    const reason = String(body.reason ?? '').trim();
    if (reason.length < 5) {
      return sendError(res, 400, 'el motivo del rechazo es obligatorio');
    }
    const id = Number(rejectMatch[1]);
    const row = getConsolidation(db, id);
    if (!row) return sendError(res, 404, 'consolidación no encontrada');
    if (row.status !== 'revision') {
      return sendError(res, 409, `no se puede rechazar una consolidación en estado ${row.status}`);
    }

    db.prepare(
      `UPDATE consolidations
       SET status = 'borrador', reject_reason = ?, approved_at = NULL, approved_by = NULL
       WHERE id = ?`
    ).run(reason, id);
    audit(db, authUser, 'consolidation.rejected', 'consolidation', id, reason);
    return sendJson(res, 200, consolidationDetail(db, id));
  }

  if (method === 'POST' && url.pathname === '/api/readings/manual') {
    const authUser = requireUser(db, req, res, 'analista');
    if (!authUser) return;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    const meterId = body.meter_id;
    const ts = String(body.ts ?? '').trim();
    const kwh = toNumber(body.kwh);
    const reason = String(body.reason ?? '').trim();

    if (!meterId || !/^\d{4}-\d{2}-\d{2}$/.test(ts)) {
      return sendError(res, 400, 'meter_id y ts (YYYY-MM-DD) son obligatorios');
    }
    if (!Number.isFinite(kwh) || kwh <= 0) {
      return sendError(res, 400, 'kwh debe ser un número mayor que 0');
    }
    if (reason.length < 5) {
      return sendError(res, 400, 'el motivo del ingreso manual es obligatorio');
    }

    const meter = db.prepare('SELECT * FROM meters WHERE id = ?').get(meterId);
    if (!meter) return sendError(res, 404, 'medidor no encontrado');

    const period = ts.slice(0, 7);
    const consolidation = db
      .prepare('SELECT * FROM consolidations WHERE client_id = ? AND period = ? ORDER BY id DESC LIMIT 1')
      .get(meter.client_id, period);
    if (consolidation && consolidation.status !== 'borrador') {
      return sendError(
        res,
        409,
        `no se puede modificar una lectura con la consolidación en estado ${consolidation.status}`
      );
    }

    db.prepare(
      `INSERT INTO readings (meter_id, ts, kwh, source, kind, status, note)
       VALUES (?, ?, ?, 'manual', 'daily', 'manual', ?)
       ON CONFLICT (meter_id, ts, kind) DO UPDATE SET
         kwh = excluded.kwh,
         source = 'manual',
         status = 'manual',
         note = excluded.note`
    ).run(meterId, ts, kwh, reason);

    const resolved = db
      .prepare(
        `UPDATE alerts
         SET status = 'resolved', resolved_at = datetime('now')
         WHERE meter_id = ? AND type = 'missing_reading' AND status = 'open' AND ref_ts = ?`
      )
      .run(meterId, ts);

    audit(
      db,
      authUser,
      'reading.manual',
      'reading',
      `${meterId}@${ts}`,
      `${kwh} kWh. Motivo: ${reason}`
    );

    return sendJson(res, 201, {
      reading: db
        .prepare('SELECT * FROM readings WHERE meter_id = ? AND ts = ? AND kind = ?')
        .get(meterId, ts, 'daily'),
      resolvedAlerts: resolved.changes
    });
  }

  const resolveAlertMatch = url.pathname.match(/^\/api\/alerts\/(\d+)\/resolve$/);
  if (method === 'POST' && resolveAlertMatch) {
    const authUser = requireUser(db, req, res, 'analista');
    if (!authUser) return;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    const note = String(body.note ?? '').trim();
    if (note.length < 5) {
      return sendError(res, 400, 'la nota de resolución es obligatoria');
    }
    const id = Number(resolveAlertMatch[1]);
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
    if (!alert) return sendError(res, 404, 'alerta no encontrada');
    if (alert.status !== 'open') return sendError(res, 409, 'la alerta ya está resuelta');
    if (alert.type === 'missing_reading') {
      return sendError(res, 409, 'esta alerta se resuelve con el ingreso manual de la lectura');
    }

    db.prepare(
      `UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`
    ).run(id);
    audit(db, authUser, 'alert.resolved', 'alert', id, note);
    return sendJson(res, 200, db.prepare('SELECT * FROM alerts WHERE id = ?').get(id));
  }

  return sendError(res, 404, 'ruta no encontrada');
}

export function createApp(db) {
  return createServer((req, res) => {
    handle(db, req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) {
        sendError(res, 500, 'error interno');
      } else {
        res.end();
      }
    });
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
    console.log('  POST /api/auth/login   { username, password }');
    console.log('  GET  /api/summary?period=2026-05');
    console.log('  GET  /api/clients');
    console.log('  GET  /api/alerts?status=open');
    console.log('  GET  /api/consolidations?period=2026-05');
  });
}
