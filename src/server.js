import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
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

function audit(db, user, action, entity, entityId = null, detail = null, extra = {}) {
  const role = user.is_admin ? 'administrador' : (user.role ?? 'sin_rol');
  db.prepare(
    `INSERT INTO audit_events
       (actor, role, action, entity, entity_id, detail, before_value, after_value, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.name,
    role,
    action,
    entity,
    entityId == null ? null : String(entityId),
    detail,
    extra.before ?? null,
    extra.after ?? null,
    extra.reason ?? null
  );
}

function currentUser(db, req) {
  const sid = parseCookies(req.headers.cookie).sid;
  return getSessionUser(db, sid);
}

function requireUser(db, req, res) {
  const user = currentUser(db, req);
  if (!user) {
    sendError(res, 401, 'no autenticado');
    return null;
  }
  return user;
}

function requireOperational(db, req, res, role) {
  const user = requireUser(db, req, res);
  if (!user) return null;
  if (!user.role) {
    sendError(res, 403, 'la cuenta no tiene rol operativo');
    return null;
  }
  if (role && user.role !== role) {
    sendError(res, 403, 'permiso denegado para el rol ' + user.role);
    return null;
  }
  return user;
}

function requireAdmin(db, req, res) {
  const user = requireUser(db, req, res);
  if (!user) return null;
  if (!user.is_admin) {
    sendError(res, 403, 'se requiere el rol administrador');
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
    .prepare('SELECT id, barge, source FROM meters WHERE client_id = ? AND active = 1 ORDER BY id LIMIT 1')
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

function periodBounds(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${period}-01`,
    end: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
  };
}

function getReadings(db, meterId, period) {
  const bounds = periodBounds(period);
  if (!bounds) return [];
  return db
    .prepare(
      `SELECT id, ts, kwh, source, kind, status, note
       FROM readings
       WHERE meter_id = ? AND kind = 'daily' AND ts >= ? AND ts < ?
       ORDER BY ts`
    )
    .all(meterId, bounds.start, bounds.end);
}

function readingsHash(readings) {
  return createHash('sha256')
    .update(
      readings
        .map((reading) => `${reading.ts}|${reading.kwh}|${reading.status}|${reading.source}`)
        .join('\n')
    )
    .digest('hex');
}

function getCurrentConsolidation(db, clientId, period) {
  return db
    .prepare(
      `SELECT * FROM consolidations
       WHERE client_id = ? AND period = ? AND is_current = 1
       ORDER BY version DESC LIMIT 1`
    )
    .get(clientId, period);
}

function prepareConsolidationData(db, clientId, period) {
  const client = getClient(db, clientId);
  if (!client) return { error: { status: 404, message: 'cliente no encontrado' } };
  const meter = getMeter(db, clientId);
  const contract = getContract(db, clientId);
  const price = getLatestPrice(db);
  if (!meter || !contract || !price) {
    return { error: { status: 409, message: 'faltan medidor, contrato o precio' } };
  }
  const readings = getReadings(db, meter.id, period);
  if (!readings.length) {
    return { error: { status: 400, message: 'no hay lecturas para el período' } };
  }
  const result = consolidate({ readings, contract, price });
  return {
    client,
    meter,
    contract,
    price,
    readings,
    result,
    hash: readingsHash(readings)
  };
}

function consolidationIsStale(db, row) {
  if (!row || row.status === 'aprobada') return false;
  const meter = getMeter(db, row.client_id);
  if (!meter) return true;
  const readings = getReadings(db, meter.id, row.period);
  return row.calculation_hash !== readingsHash(readings);
}

function canEditReadings(db, clientId, period) {
  const current = getCurrentConsolidation(db, clientId, period);
  if (!current) return true;
  if (current.status === 'borrador') return true;
  if (current.status === 'revision') return false;
  const openRectification = db
    .prepare(
      `SELECT id FROM consolidations
       WHERE client_id = ? AND period = ? AND supersedes_id IS NOT NULL
         AND status = 'borrador'`
    )
    .get(clientId, period);
  return Boolean(openRectification);
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
      `SELECT l.*, r.ts,
              COALESCE(l.source, r.source) AS source,
              COALESCE(l.reading_status, r.status) AS reading_status,
              r.note AS reading_note
       FROM consolidation_lines l
       LEFT JOIN readings r ON r.id = l.reading_id
       WHERE l.consolidation_id = ?
       ORDER BY r.ts`
    )
    .all(consolidationId);
  const meter = getMeter(db, header.client_id);
  const current = getCurrentConsolidation(db, header.client_id, header.period);
  const readings = meter ? getReadings(db, meter.id, header.period) : [];
  const stale =
    header.status !== 'aprobada' && header.calculation_hash !== readingsHash(readings);
  const previous = header.supersedes_id
    ? getConsolidation(db, header.supersedes_id)
    : null;

  return {
    ...header,
    meter,
    lines,
    is_current: current?.id === header.id ? 1 : header.is_current,
    is_stale: stale,
    previous
  };
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
      `SELECT a.*, c.name AS client_name,
              (SELECT COUNT(*) FROM alert_items i WHERE i.alert_id = a.id) AS items_total,
              (SELECT COUNT(*) FROM alert_items i WHERE i.alert_id = a.id AND i.status = 'open') AS items_open
       FROM alerts a
       JOIN clients c ON c.id = a.client_id
       ${where}
       ORDER BY CASE a.status WHEN 'open' THEN 0 ELSE 1 END,
                CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                a.id DESC`
    )
    .all(...params);
}

function getAlertDetail(db, alertId) {
  const alert = db
    .prepare(
      `SELECT a.*, c.name AS client_name
       FROM alerts a
       JOIN clients c ON c.id = a.client_id
       WHERE a.id = ?`
    )
    .get(alertId);
  if (!alert) return null;

  const items = db
    .prepare('SELECT * FROM alert_items WHERE alert_id = ? ORDER BY ts')
    .all(alertId);
  const meter = alert.meter_id
    ? db.prepare('SELECT * FROM meters WHERE id = ?').get(alert.meter_id)
    : null;
  const period = (alert.ref_ts ?? items[0]?.ts ?? '').slice(0, 7);
  const consolidation = period
    ? db
        .prepare(
          'SELECT * FROM consolidations WHERE client_id = ? AND period = ? AND is_current = 1 ORDER BY id DESC LIMIT 1'
        )
        .get(alert.client_id, period) ?? null
    : null;

  return { ...alert, meter, items, consolidation };
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
    const sessionUser = { id: row.id, name: row.name, role: row.role, is_admin: row.is_admin };
    audit(db, sessionUser, 'auth.login', 'user', row.id, null);
    return sendJson(
      res,
      200,
      { user: sessionUser },
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

  if (method === 'GET' && url.pathname === '/api/admin/users') {
    const admin = requireAdmin(db, req, res);
    if (!admin) return;
    const users = db
      .prepare('SELECT id, name, role, is_admin FROM users ORDER BY id')
      .all();
    return sendJson(res, 200, { users });
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (method === 'PATCH' && adminUserMatch) {
    const admin = requireAdmin(db, req, res);
    if (!admin) return;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message);
    }

    const targetId = decodeURIComponent(adminUserMatch[1]);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return sendError(res, 404, 'cuenta no encontrada');

    const reason = String(body.reason ?? '').trim();
    if (reason.length < 5) {
      return sendError(res, 400, 'el motivo del cambio es obligatorio');
    }

    let role = target.role;
    if (body.role !== undefined) {
      if (body.role === null || body.role === '' || body.role === 'sin_rol') {
        role = null;
      } else if (['analista', 'aprobador'].includes(body.role)) {
        role = body.role;
      } else {
        return sendError(res, 400, 'rol operativo inválido');
      }
    }

    let isAdmin = target.is_admin;
    if (body.is_admin !== undefined) {
      isAdmin = body.is_admin === true || body.is_admin === 1 ? 1 : 0;
    }

    if (targetId === admin.id && role !== target.role) {
      return sendError(res, 400, 'no puede cambiar su propio rol operativo');
    }

    if (role === target.role && isAdmin === target.is_admin) {
      return sendError(res, 400, 'el cambio no modifica la cuenta');
    }

    if (target.is_admin === 1 && isAdmin === 0) {
      const admins = db
        .prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')
        .get().n;
      if (admins <= 1) {
        return sendError(res, 409, 'no se puede dejar el sistema sin administrador');
      }
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').run(
        role,
        isAdmin,
        targetId
      );
      audit(
        db,
        admin,
        'user.roles_updated',
        'user',
        targetId,
        `Rol: ${target.role ?? 'sin rol'} -> ${role ?? 'sin rol'}; admin: ${target.is_admin} -> ${isAdmin}; motivo: ${reason}`,
        {
          before: JSON.stringify({ role: target.role, is_admin: target.is_admin }),
          after: JSON.stringify({ role, is_admin: isAdmin }),
          reason
        }
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return sendJson(res, 200, {
      user: db.prepare('SELECT id, name, role, is_admin FROM users WHERE id = ?').get(targetId)
    });
  }

  if (!user.role && url.pathname !== '/api/audit') {
    return sendError(res, 403, 'la cuenta no tiene rol operativo');
  }

  if (method === 'GET' && url.pathname === '/api/summary') {
    const period = url.searchParams.get('period') ?? defaultPeriod(db);
    if (!period) return sendError(res, 400, 'no hay período configurado');
    const bounds = periodBounds(period);
    if (!bounds) return sendError(res, 400, 'período inválido');

    const price = getLatestPrice(db);
    const totalKwh =
      db
        .prepare(
          `SELECT ROUND(SUM(kwh), 9) AS total
           FROM readings WHERE kind = 'daily' AND ts >= ? AND ts < ?`
        )
        .get(bounds.start, bounds.end).total ?? 0;

    const statuses = db
      .prepare('SELECT status, COUNT(*) AS n FROM consolidations WHERE period = ? AND is_current = 1 GROUP BY status')
      .all(period);

    return sendJson(res, 200, {
      period,
      clients: db.prepare('SELECT COUNT(*) AS n FROM clients').get().n,
      readings: db
        .prepare("SELECT COUNT(*) AS n FROM readings WHERE kind = 'daily' AND ts >= ? AND ts < ?")
        .get(bounds.start, bounds.end).n,
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
    const bounds = periodBounds(period);
    if (!bounds) return sendError(res, 400, 'período inválido');
    const clients = db
      .prepare(
        `SELECT c.id, c.name, c.synthetic, m.id AS meter_id, m.barge,
                (SELECT ROUND(SUM(r.kwh), 9) FROM readings r
                 WHERE r.meter_id = m.id AND r.kind = 'daily'
                   AND r.ts >= ? AND r.ts < ?) AS total_kwh,
                (SELECT COUNT(*) FROM alerts a
                 WHERE a.client_id = c.id AND a.status = 'open') AS open_alerts,
                (SELECT co.status FROM consolidations co
                 WHERE co.client_id = c.id AND co.period = ? AND co.is_current = 1
                 ORDER BY co.version DESC LIMIT 1) AS consolidation_status
         FROM clients c
         JOIN meters m ON m.client_id = c.id
         ORDER BY c.id`
      )
      .all(bounds.start, bounds.end, period);
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
          .prepare('SELECT * FROM consolidations WHERE client_id = ? AND period = ? AND is_current = 1 ORDER BY id DESC LIMIT 1')
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

  const alertMatch = url.pathname.match(/^\/api\/alerts\/(\d+)$/);
  if (method === 'GET' && alertMatch) {
    const detail = getAlertDetail(db, Number(alertMatch[1]));
    if (!detail) return sendError(res, 404, 'alerta no encontrada');
    return sendJson(res, 200, detail);
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
    const authUser = requireOperational(db, req, res, 'analista');
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

    const prepared = prepareConsolidationData(db, clientId, period);
    if (prepared.error) {
      return sendError(res, prepared.error.status, prepared.error.message);
    }
    const { result, hash } = prepared;

    const current = getCurrentConsolidation(db, clientId, period);
    const openRectification = db
      .prepare(
        `SELECT * FROM consolidations
         WHERE client_id = ? AND period = ? AND supersedes_id IS NOT NULL
           AND status IN ('borrador', 'revision')
         ORDER BY version DESC LIMIT 1`
      )
      .get(clientId, period);

    let existing = null;
    if (openRectification) {
      if (openRectification.status === 'revision') {
        return sendError(res, 409, 'la rectificación está en revisión');
      }
      existing = openRectification;
    } else if (current) {
      if (current.status === 'aprobada') {
        return sendError(
          res,
          409,
          'la consolidación está aprobada; use Rectificar para crear una nueva versión'
        );
      }
      if (current.status === 'revision') {
        return sendError(res, 409, 'la consolidación está en revisión');
      }
      existing = current;
    }

    let consolidationId;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) {
        consolidationId = existing.id;
        db.prepare(
          `UPDATE consolidations
           SET total_kwh = ?, total_liters = ?, total_clp = ?,
               reject_reason = NULL, calculation_hash = ?,
               calculated_at = datetime('now')
           WHERE id = ?`
        ).run(
          result.totalKwh,
          result.totalLiters,
          result.totalClp,
          hash,
          consolidationId
        );
        db.prepare('DELETE FROM consolidation_lines WHERE consolidation_id = ?').run(
          consolidationId
        );
      } else {
        const info = db
          .prepare(
            `INSERT INTO consolidations
               (client_id, period, version, is_current,
                total_kwh, total_liters, total_clp, status,
                calculation_hash, calculated_at)
             VALUES (?, ?, 1, 1, ?, ?, ?, 'borrador', ?, datetime('now'))`
          )
          .run(
            clientId,
            period,
            result.totalKwh,
            result.totalLiters,
            result.totalClp,
            hash
          );
        consolidationId = Number(info.lastInsertRowid);
      }

      const insertLine = db.prepare(
        `INSERT INTO consolidation_lines
           (consolidation_id, reading_id, kwh, price_usd_per_kwh, exchange_rate,
            factor_l_per_kwh, amount_clp, liters, source, reading_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          line.liters,
          line.source ?? null,
          line.status ?? null
        );
      }

      audit(
        db,
        authUser,
        existing ? 'consolidation.recalculated' : 'consolidation.created',
        'consolidation',
        consolidationId,
        `${clientId} ${period}: v${existing?.version ?? 1}, ${result.totalKwh} kWh, ${result.totalClp} CLP`
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return sendJson(res, 201, consolidationDetail(db, consolidationId));
  }

  const rectifyMatch = url.pathname.match(/^\/api\/consolidations\/(\d+)\/rectify$/);
  if (method === 'POST' && rectifyMatch) {
    const authUser = requireOperational(db, req, res, 'analista');
    if (!authUser) return;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    const reason = String(body.reason ?? '').trim();
    if (reason.length < 5) {
      return sendError(res, 400, 'el motivo de la rectificación es obligatorio');
    }

    const sourceId = Number(rectifyMatch[1]);
    const source = getConsolidation(db, sourceId);
    if (!source) return sendError(res, 404, 'consolidación no encontrada');
    if (source.status !== 'aprobada' || source.is_current !== 1) {
      return sendError(res, 409, 'solo se puede rectificar la versión aprobada vigente');
    }

    const open = db
      .prepare(
        `SELECT * FROM consolidations
         WHERE client_id = ? AND period = ? AND supersedes_id IS NOT NULL
           AND status IN ('borrador', 'revision')`
      )
      .get(source.client_id, source.period);
    if (open) {
      return sendError(res, 409, 'ya existe una rectificación abierta para este período');
    }

    let newId;
    let version;
    db.exec('BEGIN IMMEDIATE');
    try {
      const prepared = prepareConsolidationData(db, source.client_id, source.period);
      if (prepared.error) {
        db.exec('ROLLBACK');
        return sendError(res, prepared.error.status, prepared.error.message);
      }
      const { result, hash } = prepared;
      version =
        Number(
          db
            .prepare(
              'SELECT COALESCE(MAX(version), 0) AS v FROM consolidations WHERE client_id = ? AND period = ?'
            )
            .get(source.client_id, source.period).v
        ) + 1;

      const info = db
        .prepare(
          `INSERT INTO consolidations
             (client_id, period, version, supersedes_id, is_current,
              rectification_reason, oc_reference, calculation_hash, calculated_at,
              total_kwh, total_liters, total_clp, status)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, datetime('now'), ?, ?, ?, 'borrador')`
        )
        .run(
          source.client_id,
          source.period,
          version,
          source.id,
          reason,
          source.oc_reference ?? null,
          hash,
          result.totalKwh,
          result.totalLiters,
          result.totalClp
        );
      newId = Number(info.lastInsertRowid);

      const insertLine = db.prepare(
        `INSERT INTO consolidation_lines
           (consolidation_id, reading_id, kwh, price_usd_per_kwh, exchange_rate,
            factor_l_per_kwh, amount_clp, liters, source, reading_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const line of result.lines) {
        insertLine.run(
          newId,
          line.reading_id,
          line.kwh,
          line.price_usd_per_kwh,
          line.exchange_rate,
          line.factor_l_per_kwh,
          line.amount_clp,
          line.liters,
          line.source ?? null,
          line.status ?? null
        );
      }

      audit(
        db,
        authUser,
        'consolidation.rectification_requested',
        'consolidation',
        source.id,
        `v${source.version} -> v${version}. Motivo: ${reason}`
      );
      audit(
        db,
        authUser,
        'consolidation.created',
        'consolidation',
        newId,
        `v${version} de ${source.client_id} ${source.period}; reemplaza a v${source.version}`
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) {
        return sendError(res, 409, 'ya existe una rectificación abierta para este período');
      }
      throw error;
    }

    return sendJson(res, 201, consolidationDetail(db, newId));
  }

  const submitMatch = url.pathname.match(/^\/api\/consolidations\/(\d+)\/submit$/);
  if (method === 'POST' && submitMatch) {
    const authUser = requireOperational(db, req, res, 'analista');
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
    if (consolidationIsStale(db, row)) {
      return sendError(
        res,
        409,
        'el cálculo está desactualizado; regenere la consolidación antes de enviarla'
      );
    }
    if (row.supersedes_id) {
      const previous = getConsolidation(db, row.supersedes_id);
      if (!previous || previous.status !== 'aprobada' || previous.is_current !== 1) {
        return sendError(res, 409, 'la versión anterior ya no es la vigente');
      }
    }

    db.prepare(
      `UPDATE consolidations SET status = 'revision', reject_reason = NULL WHERE id = ?`
    ).run(id);
    audit(
      db,
      authUser,
      'consolidation.submitted',
      'consolidation',
      id,
      `v${row.version}`
    );
    return sendJson(res, 200, consolidationDetail(db, id));
  }

  const approveMatch = url.pathname.match(/^\/api\/consolidations\/(\d+)\/approve$/);
  if (method === 'POST' && approveMatch) {
    const authUser = requireOperational(db, req, res, 'aprobador');
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
    if (consolidationIsStale(db, row)) {
      return sendError(
        res,
        409,
        'el cálculo está desactualizado; regenere y vuelva a enviar la consolidación'
      );
    }

    let previous = null;
    if (row.supersedes_id) {
      previous = getConsolidation(db, row.supersedes_id);
      if (!previous || previous.status !== 'aprobada' || previous.is_current !== 1) {
        return sendError(res, 409, 'la versión anterior ya no es la vigente');
      }
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      if (previous) {
        const deactivated = db
          .prepare(
            'UPDATE consolidations SET is_current = 0 WHERE id = ? AND is_current = 1'
          )
          .run(previous.id).changes;
        if (deactivated !== 1) {
          db.exec('ROLLBACK');
          return sendError(res, 409, 'la versión anterior cambió durante la aprobación');
        }
      }

      db.prepare(
        `UPDATE consolidations
         SET status = 'aprobada', is_current = 1,
             approved_at = datetime('now'), approved_by = ?
         WHERE id = ?`
      ).run(authUser.name, id);

      audit(
        db,
        authUser,
        'consolidation.approved',
        'consolidation',
        id,
        `v${row.version}${previous ? `; reemplaza a v${previous.version}` : ''}`
      );
      if (previous) {
        audit(
          db,
          authUser,
          'consolidation.version_activated',
          'consolidation',
          id,
          `v${row.version} vigente; v${previous.version} queda histórica`
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) {
        return sendError(res, 409, 'ya existe otra versión aprobada vigente');
      }
      throw error;
    }

    return sendJson(res, 200, consolidationDetail(db, id));
  }

  const rejectMatch = url.pathname.match(/^\/api\/consolidations\/(\d+)\/reject$/);
  if (method === 'POST' && rejectMatch) {
    const authUser = requireOperational(db, req, res, 'aprobador');
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
    const authUser = requireOperational(db, req, res, 'analista');
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
    if (!canEditReadings(db, meter.client_id, period)) {
      return sendError(
        res,
        409,
        'no se puede modificar una lectura: la consolidación está en revisión o aprobada y no tiene una rectificación en borrador'
      );
    }

    let resolved;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO readings (meter_id, ts, kwh, source, kind, status, note)
         VALUES (?, ?, ?, 'manual', 'daily', 'manual', ?)
         ON CONFLICT (meter_id, ts, kind) DO UPDATE SET
           kwh = excluded.kwh,
           source = 'manual',
           status = 'manual',
           note = excluded.note`
      ).run(meterId, ts, kwh, reason);

      db.prepare(
        `UPDATE alert_items
         SET status = 'corrected', corrected_value = ?, corrected_at = datetime('now'),
             corrected_by = ?, note = ?
         WHERE meter_id = ? AND ts = ? AND kind = 'missing' AND status = 'open'`
      ).run(kwh, authUser.name, reason, meterId, ts);

      resolved = db
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
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return sendJson(res, 201, {
      reading: db
        .prepare('SELECT * FROM readings WHERE meter_id = ? AND ts = ? AND kind = ?')
        .get(meterId, ts, 'daily'),
      resolvedAlerts: resolved.changes
    });
  }

  const correctAlertMatch = url.pathname.match(/^\/api\/alerts\/(\d+)\/correct$/);
  if (method === 'POST' && correctAlertMatch) {
    const authUser = requireOperational(db, req, res, 'analista');
    if (!authUser) return;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message);
    }

    const id = Number(correctAlertMatch[1]);
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
    if (!alert) return sendError(res, 404, 'alerta no encontrada');
    if (alert.status !== 'open') return sendError(res, 409, 'la alerta ya está resuelta');
    if (!['missing_reading', 'hourly_consistency', 'daily_outlier'].includes(alert.type)) {
      return sendError(res, 400, 'esta alerta no admite corrección de una medición');
    }

    const reason = String(body.reason ?? '').trim();
    if (reason.length < 5) {
      return sendError(res, 400, 'el motivo de la corrección es obligatorio');
    }
    const value = toNumber(body.value);
    if (!Number.isFinite(value)) {
      return sendError(res, 400, 'el valor de la medición debe ser numérico');
    }
    if (['missing_reading', 'daily_outlier'].includes(alert.type) && value <= 0) {
      return sendError(res, 400, 'la lectura debe ser mayor que 0');
    }
    if (alert.type === 'hourly_consistency' && value < 0) {
      return sendError(res, 400, 'el acumulado debe ser mayor o igual que 0');
    }

    const ts =
      alert.type === 'missing_reading'
        ? alert.ref_ts
        : String(body.ts ?? '').trim();
    if (alert.type === 'missing_reading' && body.ts && String(body.ts) !== alert.ref_ts) {
      return sendError(res, 400, 'la fecha no corresponde a la alerta');
    }
    if (!ts || !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(ts)) {
      return sendError(res, 400, 'la fecha de la medición no es válida');
    }

    const items = db.prepare('SELECT * FROM alert_items WHERE alert_id = ?').all(id);
    const item =
      alert.type === 'missing_reading'
        ? items.find((candidate) => candidate.kind === 'missing')
        : items.find(
            (candidate) =>
              candidate.ts === ts &&
              candidate.status === 'open' &&
              ['negative_drop', 'high_jump', 'outlier'].includes(candidate.kind)
          );
    if (!item) {
      return sendError(res, 404, 'no se encontró la medición asociada a la alerta');
    }

    const period = ts.slice(0, 7);
    if (!canEditReadings(db, alert.client_id, period)) {
      return sendError(
        res,
        409,
        'no se puede corregir una medición: la consolidación está en revisión o aprobada y no tiene una rectificación en borrador'
      );
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO readings (meter_id, ts, kwh, source, kind, status, note)
         VALUES (?, ?, ?, 'manual', ?, 'manual', ?)
         ON CONFLICT (meter_id, ts, kind) DO UPDATE SET
           kwh = excluded.kwh,
           source = 'manual',
           status = 'manual',
           note = excluded.note`
      ).run(
        alert.meter_id,
        ts,
        value,
        ['missing_reading', 'daily_outlier'].includes(alert.type) ? 'daily' : 'hourly',
        reason
      );

      db.prepare(
        `UPDATE alert_items
         SET status = 'corrected', corrected_value = ?, corrected_at = datetime('now'),
             corrected_by = ?, note = ?
         WHERE id = ?`
      ).run(value, authUser.name, reason, item.id);

      const openItems = db
        .prepare("SELECT COUNT(*) AS n FROM alert_items WHERE alert_id = ? AND status = 'open'")
        .get(id).n;
      if (openItems === 0) {
        db.prepare(
          "UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?"
        ).run(id);
      }

      audit(
        db,
        authUser,
        'alert.corrected',
        'alert',
        id,
        `${ts}: ${value}. Motivo: ${reason}`
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return sendJson(res, 200, getAlertDetail(db, id));
  }

  const resolveAlertMatch = url.pathname.match(/^\/api\/alerts\/(\d+)\/resolve$/);
  if (method === 'POST' && resolveAlertMatch) {
    const authUser = requireOperational(db, req, res, 'analista');
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
      `UPDATE alert_items
       SET status = 'reviewed', note = ?, corrected_by = ?, corrected_at = datetime('now')
       WHERE alert_id = ? AND status = 'open'`
    ).run(note, authUser.name, id);
    db.prepare(
      `UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`
    ).run(id);
    audit(db, authUser, 'alert.resolved', 'alert', id, note);
    return sendJson(res, 200, getAlertDetail(db, id));
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
