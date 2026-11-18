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

async function login(base, username, password = 'demo') {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200, `login ${username}`);
  return response.headers.get('set-cookie').split(';')[0];
}

async function api(base, path, { method = 'GET', cookie, body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('GET /api/health es público e informa los conteos', async (t) => {
  const { base } = await withServer(t);
  const response = await fetch(`${base}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.counts.clients, 4);
  assert.equal(body.counts.daily, 118);
  assert.equal(body.counts.hourly, 751);
  assert.equal(body.counts.alerts, 7);
});

test('sirve la interfaz y los archivos estáticos', async (t) => {
  const { base } = await withServer(t);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /SVDM/);

  const app = await fetch(`${base}/app.js`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /javascript/);

  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const missing = await fetch(`${base}/no-existe.html`);
  assert.equal(missing.status, 404);
});

test('login, sesión y logout', async (t) => {
  const { base } = await withServer(t);

  const bad = await api(base, '/api/auth/login', {
    method: 'POST',
    body: { username: 'u-analista', password: 'mala' }
  });
  assert.equal(bad.status, 401);

  const cookie = await login(base, 'u-analista');
  const me = await api(base, '/api/auth/me', { cookie }).then((r) => r.json());
  assert.equal(me.user.role, 'analista');

  const logout = await api(base, '/api/auth/logout', { method: 'POST', cookie });
  assert.equal(logout.status, 200);

  const after = await api(base, '/api/auth/me', { cookie });
  assert.equal(after.status, 401);
});

test('las rutas de negocio exigen autenticación', async (t) => {
  const { base } = await withServer(t);

  for (const path of ['/api/clients', '/api/summary', '/api/consolidations', '/api/alerts']) {
    const response = await api(base, path);
    assert.equal(response.status, 401, path);
  }
});

test('GET /api/clients devuelve la cartera con totales', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');
  const response = await api(base, '/api/clients', { cookie });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.clients.length, 4);

  const clientA = body.clients.find((client) => client.id === 'CLI-A');
  assert.equal(clientA.meter_id, 'M-04');
  assert.equal(clientA.synthetic, 0);
  assert.ok(Math.abs(clientA.total_kwh - 30811.227520008) < 1e-6);

  const clientB = body.clients.find((client) => client.id === 'CLI-B');
  assert.equal(clientB.open_alerts, 2);
  assert.equal(clientB.synthetic, 1);
});

test('GET /api/readings filtra por tipo, medidor y límite', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');

  const daily = await api(base, '/api/readings?kind=daily&limit=2', { cookie }).then((r) =>
    r.json()
  );
  assert.equal(daily.count, 2);

  const hourly = await api(base, '/api/readings?kind=hourly&limit=3', { cookie }).then((r) =>
    r.json()
  );
  assert.equal(hourly.count, 3);

  const byMeter = await api(base, '/api/readings?kind=daily&meter=M-01&limit=100', {
    cookie
  }).then((r) => r.json());
  assert.equal(byMeter.count, 29);

  const bad = await api(base, '/api/readings?kind=minute', { cookie });
  assert.equal(bad.status, 400);
});

test('el preview reproduce el total del Cliente A', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');
  const response = await api(
    base,
    '/api/consolidation/preview?client=CLI-A&period=2026-05',
    { cookie }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.readings, 30);
  assert.ok(Math.abs(body.summary.totalKwh - 30811.227520008) < 1e-6);
  assert.equal(body.summary.totalClp, 21004949.14);
});

test('el preview responde 400, 404 y 409 según el caso', async (t) => {
  const { base, db } = await withServer(t);
  const cookie = await login(base, 'u-analista');

  const bad = await api(base, '/api/consolidation/preview', { cookie });
  assert.equal(bad.status, 400);

  const missing = await api(base, '/api/no-existe', { cookie });
  assert.equal(missing.status, 404);

  const noClient = await api(
    base,
    '/api/consolidation/preview?client=NOPE&period=2026-05',
    { cookie }
  );
  assert.equal(noClient.status, 404);

  const noPeriod = await api(
    base,
    '/api/consolidation/preview?client=CLI-A&period=1999-01',
    { cookie }
  );
  assert.equal(noPeriod.status, 404);

  db.prepare("DELETE FROM contracts WHERE client_id = 'CLI-A'").run();
  const noContract = await api(
    base,
    '/api/consolidation/preview?client=CLI-A&period=2026-05',
    { cookie }
  );
  assert.equal(noContract.status, 409);
});

test('el resumen del período informa cartera y alertas', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');
  const body = await api(base, '/api/summary?period=2026-05', { cookie }).then((r) =>
    r.json()
  );

  assert.equal(body.clients, 4);
  assert.equal(body.criticalAlerts, 2);
  assert.ok(body.estimatedClp > 0);
  assert.equal(body.period, '2026-05');
});

test('el resumen y la cartera rechazan períodos inválidos', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');

  const summary = await api(base, '/api/summary?period=2026-13', { cookie });
  assert.equal(summary.status, 400);

  const clients = await api(base, '/api/clients?period=2026-5', { cookie });
  assert.equal(clients.status, 400);
});

test('un analista no puede aprobar y un aprobador no puede generar', async (t) => {
  const { base } = await withServer(t);
  const analyst = await login(base, 'u-analista');
  const approver = await login(base, 'u-aprobador');

  const generated = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-C', period: '2026-05' }
  });
  const consolidation = await generated.json();

  const approveAsAnalyst = await api(
    base,
    `/api/consolidations/${consolidation.id}/approve`,
    { method: 'POST', cookie: analyst }
  );
  assert.equal(approveAsAnalyst.status, 403);

  const generateAsApprover = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: approver,
    body: { client_id: 'CLI-C', period: '2026-05' }
  });
  assert.equal(generateAsApprover.status, 403);
});

test('flujo completo: alerta, ingreso manual, envío y aprobación', async (t) => {
  const { base } = await withServer(t);
  const analyst = await login(base, 'u-analista');

  const alerts = await api(base, '/api/alerts?status=open&client=CLI-B', {
    cookie: analyst
  }).then((r) => r.json());
  assert.equal(alerts.alerts.length, 2);
  const missingAlert = alerts.alerts.find((item) => item.type === 'missing_reading');
  assert.ok(missingAlert);

  // Se puede generar el borrador, pero no enviarlo con una alerta crítica.
  const draft = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-B', period: '2026-05' }
  });
  assert.equal(draft.status, 201);
  const draftBody = await draft.json();
  assert.equal(draftBody.status, 'borrador');
  assert.equal(draftBody.lines.length, 29);

  const blocked = await api(base, `/api/consolidations/${draftBody.id}/submit`, {
    method: 'POST',
    cookie: analyst
  });
  assert.equal(blocked.status, 409);

  // Ingreso manual con motivo: resuelve la alerta.
  const manual = await api(base, '/api/readings/manual', {
    method: 'POST',
    cookie: analyst,
    body: {
      meter_id: 'M-01',
      ts: '2026-05-15',
      kwh: '700,5',
      reason: 'Medidor sin señal; valor tomado del registro en terreno'
    }
  });
  assert.equal(manual.status, 201);
  const manualBody = await manual.json();
  assert.equal(manualBody.resolvedAlerts, 1);
  assert.equal(manualBody.reading.kwh, 700.5);
  assert.equal(manualBody.reading.status, 'manual');

  // Se recalcula el borrador y ahora sí se puede enviar.
  const recalculated = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-B', period: '2026-05' }
  });
  assert.equal(recalculated.status, 201);
  const recalculatedBody = await recalculated.json();
  assert.equal(recalculatedBody.lines.length, 30);

  const submitted = await api(
    base,
    `/api/consolidations/${recalculatedBody.id}/submit`,
    { method: 'POST', cookie: analyst }
  );
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).status, 'revision');

  // El aprobador ve el detalle y aprueba.
  const approver = await login(base, 'u-aprobador');
  const detail = await api(base, `/api/consolidations/${recalculatedBody.id}`, {
    cookie: approver
  }).then((r) => r.json());
  assert.equal(detail.lines.length, 30);
  assert.equal(detail.meter.id, 'M-01');

  const approved = await api(
    base,
    `/api/consolidations/${recalculatedBody.id}/approve`,
    { method: 'POST', cookie: approver }
  );
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json();
  assert.equal(approvedBody.status, 'aprobada');
  assert.equal(approvedBody.approved_by, 'Jefe Comercial Marine');

  // Aprobada: no se puede volver a tocar ni ingresar lecturas.
  const manualAfterApproval = await api(base, '/api/readings/manual', {
    method: 'POST',
    cookie: analyst,
    body: {
      meter_id: 'M-01',
      ts: '2026-05-15',
      kwh: 800,
      reason: 'Intento de cambio posterior a la aprobación'
    }
  });
  assert.equal(manualAfterApproval.status, 409);

  const reapprove = await api(
    base,
    `/api/consolidations/${recalculatedBody.id}/approve`,
    { method: 'POST', cookie: approver }
  );
  assert.equal(reapprove.status, 409);

  const audit = await api(base, '/api/audit', { cookie: analyst }).then((r) => r.json());
  const actions = audit.events.map((event) => event.action);
  assert.ok(actions.includes('reading.manual'));
  assert.ok(actions.includes('consolidation.submitted'));
  assert.ok(actions.includes('consolidation.approved'));
});

test('rechazo con motivo devuelve la consolidación a borrador', async (t) => {
  const { base } = await withServer(t);
  const analyst = await login(base, 'u-analista');
  const approver = await login(base, 'u-aprobador');

  const generated = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-C', period: '2026-05' }
  });
  const consolidation = await generated.json();

  await api(base, `/api/consolidations/${consolidation.id}/submit`, {
    method: 'POST',
    cookie: analyst
  });

  const noReason = await api(base, `/api/consolidations/${consolidation.id}/reject`, {
    method: 'POST',
    cookie: approver,
    body: {}
  });
  assert.equal(noReason.status, 400);

  const rejected = await api(base, `/api/consolidations/${consolidation.id}/reject`, {
    method: 'POST',
    cookie: approver,
    body: { reason: 'El consumo de mayo no coincide con el nivel de GLP informado' }
  });
  assert.equal(rejected.status, 200);
  const body = await rejected.json();
  assert.equal(body.status, 'borrador');
  assert.match(body.reject_reason, /nivel de GLP/);
});

test('una alerta de lectura faltante no se resuelve sin ingreso manual', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');
  const alerts = await api(base, '/api/alerts?status=open&client=CLI-B', {
    cookie
  }).then((r) => r.json());

  const missingAlert = alerts.alerts.find((item) => item.type === 'missing_reading');
  const response = await api(base, `/api/alerts/${missingAlert.id}/resolve`, {
    method: 'POST',
    cookie,
    body: { note: 'Se revisó y no se encontró la lectura' }
  });
  assert.equal(response.status, 409);
});

test('la alerta de B muestra la medición faltante y se corrige con un valor', async (t) => {
  const { base } = await withServer(t);
  const analyst = await login(base, 'u-analista');

  const list = await api(base, '/api/alerts?status=open', { cookie: analyst }).then((r) => r.json());
  const alert = list.alerts.find(
    (item) => item.client_id === 'CLI-B' && item.type === 'missing_reading'
  );
  assert.equal(alert.items_total, 1);
  assert.equal(alert.items_open, 1);

  const detail = await api(base, `/api/alerts/${alert.id}`, { cookie: analyst }).then((r) => r.json());
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].kind, 'missing');
  assert.equal(detail.items[0].value, null);

  const corrected = await api(base, `/api/alerts/${alert.id}/correct`, {
    method: 'POST',
    cookie: analyst,
    body: {
      ts: '2026-05-15',
      value: 700.5,
      reason: 'Medidor sin señal; valor tomado en terreno'
    }
  });
  assert.equal(corrected.status, 200);
  const body = await corrected.json();
  assert.equal(body.status, 'resolved');
  assert.equal(body.items[0].status, 'corrected');
  assert.equal(body.items[0].corrected_value, 700.5);

  const readings = await api(base, '/api/readings?kind=daily&meter=M-01&limit=100', {
    cookie: analyst
  }).then((r) => r.json());
  const manual = readings.readings.find((item) => item.ts === '2026-05-15');
  assert.equal(manual.kwh, 700.5);
  assert.equal(manual.status, 'manual');
});

test('el consumo diario atípico permite corregir el valor', async (t) => {
  const { base } = await withServer(t);
  const analyst = await login(base, 'u-analista');

  const list = await api(base, '/api/alerts?status=open&client=CLI-D', {
    cookie: analyst
  }).then((r) => r.json());
  const alert = list.alerts.find((item) => item.type === 'daily_outlier');
  assert.equal(alert.items_total, 2);
  assert.equal(alert.items_open, 2);

  const detail = await api(base, `/api/alerts/${alert.id}`, { cookie: analyst }).then((r) => r.json());
  const item = detail.items.find((candidate) => candidate.status === 'open');
  const correctedValue = Math.round((Number(item.value) / 2) * 1000) / 1000;

  const corrected = await api(base, `/api/alerts/${alert.id}/correct`, {
    method: 'POST',
    cookie: analyst,
    body: {
      ts: item.ts,
      value: correctedValue,
      reason: 'Consumo corregido con el registro en terreno'
    }
  });
  assert.equal(corrected.status, 200);
  const body = await corrected.json();
  const changed = body.items.find((candidate) => candidate.ts === item.ts);
  assert.equal(changed.status, 'corrected');
  assert.equal(body.items.filter((candidate) => candidate.status === 'open').length, 1);

  const readings = await api(base, '/api/readings?kind=daily&meter=M-06&limit=100', {
    cookie: analyst
  }).then((r) => r.json());
  const updated = readings.readings.find((candidate) => candidate.ts === item.ts);
  assert.equal(updated.kwh, correctedValue);
  assert.equal(updated.status, 'manual');
});

test('la alerta horaria lista sus mediciones y permite corregir una', async (t) => {
  const { base } = await withServer(t);
  const analyst = await login(base, 'u-analista');

  const list = await api(base, '/api/alerts?status=open', { cookie: analyst }).then((r) => r.json());
  const alert = list.alerts.find((item) => item.type === 'hourly_consistency');
  assert.equal(alert.items_total, 25);
  assert.equal(alert.items_open, 25);

  const detail = await api(base, `/api/alerts/${alert.id}`, { cookie: analyst }).then((r) => r.json());
  assert.equal(detail.items.length, 25);

  const item = detail.items.find((candidate) => candidate.status === 'open');
  const corrected = await api(base, `/api/alerts/${alert.id}/correct`, {
    method: 'POST',
    cookie: analyst,
    body: {
      ts: item.ts,
      value: Number(item.value) + 1,
      reason: 'Ajuste de prueba sobre el acumulado'
    }
  });
  assert.equal(corrected.status, 200);
  const body = await corrected.json();
  assert.equal(body.status, 'open');
  const changed = body.items.find((candidate) => candidate.ts === item.ts);
  assert.equal(changed.status, 'corrected');
  assert.equal(body.items.filter((candidate) => candidate.status === 'open').length, 24);
});

test('corregir una alerta exige analista, motivo y una medición válida', async (t) => {
  const { base } = await withServer(t);
  const analyst = await login(base, 'u-analista');
  const approver = await login(base, 'u-aprobador');

  const list = await api(base, '/api/alerts?status=open&client=CLI-B', {
    cookie: analyst
  }).then((r) => r.json());
  const alert = list.alerts[0];

  const forbidden = await api(base, `/api/alerts/${alert.id}/correct`, {
    method: 'POST',
    cookie: approver,
    body: { value: 700, reason: 'Intento de aprobador' }
  });
  assert.equal(forbidden.status, 403);

  const noReason = await api(base, `/api/alerts/${alert.id}/correct`, {
    method: 'POST',
    cookie: analyst,
    body: { value: 700 }
  });
  assert.equal(noReason.status, 400);

  const badDate = await api(base, `/api/alerts/${alert.id}/correct`, {
    method: 'POST',
    cookie: analyst,
    body: { ts: '2026-05-14', value: 700, reason: 'Fecha que no corresponde' }
  });
  assert.equal(badDate.status, 400);
});

test('la ficha del cliente devuelve resumen, alertas y consolidación', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');

  const detail = await api(base, '/api/clients/CLI-A?period=2026-05', { cookie }).then((r) =>
    r.json()
  );
  assert.equal(detail.client.id, 'CLI-A');
  assert.equal(detail.client.synthetic, 0);
  assert.equal(detail.summary.readings, 30);
  assert.equal(detail.summary.totalClp, 21004949.14);
  assert.equal(detail.alerts.length, 2);
  assert.ok(detail.alerts.some((item) => item.type === 'hourly_consistency'));
  assert.equal(detail.consolidation, null);

  const missing = await api(base, '/api/clients/NOPE', { cookie });
  assert.equal(missing.status, 404);
});

test('una alerta de consistencia se resuelve con una nota', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');
  const alerts = await api(base, '/api/alerts?status=open&client=CLI-A', {
    cookie
  }).then((r) => r.json());

  const hourlyAlert = alerts.alerts.find((item) => item.type === 'hourly_consistency');
  const response = await api(base, `/api/alerts/${hourlyAlert.id}/resolve`, {
    method: 'POST',
    cookie,
    body: { note: 'Se revisaron los saltos con el área de operación' }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'resolved');
  assert.ok(body.items.length > 0);
  assert.ok(body.items.every((item) => item.status === 'reviewed'));

  const again = await api(base, `/api/alerts/${hourlyAlert.id}/resolve`, {
    method: 'POST',
    cookie,
    body: { note: 'Segundo intento de resolución' }
  });
  assert.equal(again.status, 409);
});

test('la lista de consolidaciones y su detalle están disponibles', async (t) => {
  const { base } = await withServer(t);
  const cookie = await login(base, 'u-analista');

  const generated = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie,
    body: { client_id: 'CLI-C', period: '2026-05' }
  }).then((r) => r.json());

  const list = await api(base, '/api/consolidations?period=2026-05', { cookie }).then((r) =>
    r.json()
  );
  assert.equal(list.consolidations.length, 1);
  assert.equal(list.consolidations[0].client_name, 'Cliente C');

  const detail = await api(base, `/api/consolidations/${generated.id}`, { cookie }).then((r) =>
    r.json()
  );
  assert.equal(detail.lines.length, 30);

  const missing = await api(base, '/api/consolidations/9999', { cookie });
  assert.equal(missing.status, 404);
});

test('crear consolidación valida cliente, período y estado', async (t) => {
  const { base } = await withServer(t);
  const analyst = await login(base, 'u-analista');
  const approver = await login(base, 'u-aprobador');

  const noClient = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: {}
  });
  assert.equal(noClient.status, 400);

  const unknown = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'NOPE', period: '2026-05' }
  });
  assert.equal(unknown.status, 404);

  const noReadings = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-A', period: '1999-01' }
  });
  assert.equal(noReadings.status, 400);

  const generated = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-C', period: '2026-05' }
  }).then((r) => r.json());

  await api(base, `/api/consolidations/${generated.id}/submit`, {
    method: 'POST',
    cookie: analyst
  });

  const inReview = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-C', period: '2026-05' }
  });
  assert.equal(inReview.status, 409);

  await api(base, `/api/consolidations/${generated.id}/approve`, {
    method: 'POST',
    cookie: approver
  });

  const approved = await api(base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-C', period: '2026-05' }
  });
  assert.equal(approved.status, 409);
});
