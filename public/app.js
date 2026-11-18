const state = {
  user: null,
  period: '2026-05',
  view: 'resumen',
  summary: null,
  clients: [],
  alerts: [],
  consolidations: [],
  audit: [],
  selectedClientId: null,
  clientDetail: null,
  selectedConsolidationId: null,
  consolidationDetail: null,
  alertFilter: 'open',
  alertDetail: null,
  correctAlertId: null,
  correctTs: null,
  correctKind: null,
  rejectId: null,
  resolveId: null
};

const $ = (id) => document.getElementById(id);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const STATUS_LABELS = { borrador: 'Borrador', revision: 'En revisión', aprobada: 'Aprobada' };
const ACTION_LABELS = {
  'auth.login': 'Inicio de sesión',
  'reading.manual': 'Ingreso manual',
  'consolidation.created': 'Consolidación creada',
  'consolidation.recalculated': 'Consolidación recalculada',
  'consolidation.submitted': 'Enviada a revisión',
  'consolidation.approved': 'Aprobada',
  'consolidation.rejected': 'Rechazada',
  'alert.resolved': 'Alerta resuelta',
  seed: 'Carga inicial'
};
const TYPE_LABELS = {
  missing_reading: 'Lectura faltante',
  hourly_consistency: 'Consistencia horaria',
  daily_outlier: 'Consumo diario atípico'
};
const SEVERITY_LABELS = {
  critical: 'Crítica',
  warning: 'Advertencia',
  info: 'Info'
};

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const nfInt = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const nf4 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const nf5 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 5, maximumFractionDigits: 5 });
const nf6 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 6, maximumFractionDigits: 6 });

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function fmtInt(value) {
  return nfInt.format(Number(value ?? 0));
}
function fmtNum(value, decimals = 0) {
  const number = Number(value ?? 0);
  if (decimals === 1) return nf1.format(number);
  if (decimals === 2) return nf2.format(number);
  if (decimals === 3) return nf3.format(number);
  if (decimals === 4) return nf4.format(number);
  if (decimals === 5) return nf5.format(number);
  if (decimals === 6) return nf6.format(number);
  return fmtInt(number);
}
function fmtClp(value) {
  return '$' + fmtInt(Math.round(Number(value ?? 0)));
}
function fmtDate(value) {
  if (!value) return '—';
  const text = String(value);
  const [datePart, timePart] = text.split(' ');
  const parts = datePart.split('-');
  if (parts.length !== 3) return text;
  const formatted = `${parts[2]}-${parts[1]}-${parts[0]}`;
  return timePart ? `${formatted} ${timePart.slice(0, 5)}` : formatted;
}

function statusBadge(status) {
  const classes = { borrador: 'badge-draft', revision: 'badge-review', aprobada: 'badge-ok' };
  return `<span class="badge ${classes[status] ?? 'badge-info'}">${esc(STATUS_LABELS[status] ?? status)}</span>`;
}
function severityBadge(severity) {
  const map = { critical: ['badge-err', 'Crítica'], warning: ['badge-warn', 'Advertencia'], info: ['badge-info', 'Info'] };
  const [cls, label] = map[severity] ?? ['badge-info', severity];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}
function syntheticBadge(isSynthetic) {
  return isSynthetic ? '<span class="badge badge-synth">Sintético</span>' : '';
}

async function api(path, options = {}) {
  const { headers, ...rest } = options;
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    }
  });

  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    if (response.status === 401 && !path.includes('/auth/login')) {
      showLogin();
    }
    throw new ApiError(data?.error ?? `Error ${response.status}`, response.status, data);
  }
  return data;
}

let toastTimer = null;
function toast(message, type = 'info') {
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', type === 'error');
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 3500);
}

function showLogin() {
  state.user = null;
  $$('dialog').forEach((dialog) => {
    if (dialog.open) dialog.close();
  });
  $('app').classList.add('hidden');
  $('login-screen').classList.remove('hidden');
  $('login-error').classList.add('hidden');
  $('login-password').value = '';
}

async function showApp() {
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('user-name').textContent = state.user?.name ?? '—';
  $('user-role').textContent = state.user?.role ?? '—';
}

function showView(view) {
  state.view = view;
  $$('.view').forEach((element) => {
    element.classList.toggle('hidden', element.id !== `view-${view}`);
  });
  $$('.menu-item').forEach((button) => {
    const active = button.dataset.view === view || (button.dataset.view === 'clientes' && view === 'cliente');
    button.classList.toggle('active', active);
  });

  if (view === 'resumen') renderResumen();
  if (view === 'consolidacion') renderConsolidacion();
  if (view === 'clientes') renderClientes();
  if (view === 'alertas') renderAlertas();
  if (view === 'auditoria') renderAuditoria();
  if (view === 'cliente') renderCliente();
}

async function loadAll() {
  const summary = await api('/api/summary');
  state.period = summary.period;

  const [clients, alerts, consolidations, audit] = await Promise.all([
    api(`/api/clients?period=${encodeURIComponent(state.period)}`),
    api('/api/alerts?status=all'),
    api(`/api/consolidations?period=${encodeURIComponent(state.period)}`),
    api('/api/audit?limit=100')
  ]);

  state.summary = summary;
  state.clients = clients.clients;
  state.alerts = alerts.alerts;
  state.consolidations = consolidations.consolidations;
  state.audit = audit.events;

  if (!state.selectedClientId && state.clients.length) {
    state.selectedClientId = state.clients[0].id;
  }

  if (state.selectedConsolidationId) {
    try {
      state.consolidationDetail = await api(`/api/consolidations/${state.selectedConsolidationId}`);
    } catch {
      state.selectedConsolidationId = null;
      state.consolidationDetail = null;
    }
  }

  if (state.selectedClientId && state.view === 'cliente') {
    try {
      state.clientDetail = await api(
        `/api/clients/${encodeURIComponent(state.selectedClientId)}?period=${encodeURIComponent(state.period)}`
      );
    } catch {
      state.clientDetail = null;
    }
  }

  renderAll();
}

function renderAll() {
  renderResumen();
  renderConsolidacion();
  renderClientes();
  renderAlertas();
  renderAuditoria();
  if (state.view === 'cliente') renderCliente();
}

function openAlerts() {
  return state.alerts.filter((alert) => alert.status === 'open');
}
function criticalAlertsFor(clientId) {
  return state.alerts.filter(
    (alert) => alert.status === 'open' && alert.severity === 'critical' && alert.client_id === clientId
  );
}

function alertAction(alert) {
  if (alert.status !== 'open') return '';
  return `<button class="btn btn-sm" type="button" data-alert="${alert.id}">Ver detalle</button>`;
}

function renderResumen() {
  if (!state.summary) return;
  const summary = state.summary;
  const critical = openAlerts().filter((alert) => alert.severity === 'critical');

  $('resumen-period').textContent = state.period;
  $('kpi-clients').textContent = fmtInt(summary.clients);
  $('kpi-readings').textContent = fmtInt(summary.readings);
  $('kpi-alerts').textContent = fmtInt(summary.openAlerts);
  $('kpi-alerts').style.color = summary.criticalAlerts > 0 ? 'var(--red)' : 'var(--green)';
  $('kpi-alerts-sub').textContent = summary.criticalAlerts > 0
    ? `${summary.criticalAlerts} crítica(s)`
    : 'Sin críticas abiertas';
  $('kpi-clp').textContent = fmtClp(summary.estimatedClp);

  if (critical.length) {
    $('resumen-alert').innerHTML = `
      <div class="alert-banner">
        <span><b>${critical.length} alerta(s) crítica(s):</b> ${esc(critical[0].message)}</span>
        <button class="link-btn" type="button" data-go="alertas">Ver alertas</button>
      </div>`;
  } else if (summary.openAlerts > 0) {
    $('resumen-alert').innerHTML = `
      <div class="warn-banner">
        <span><b>${summary.openAlerts} alerta(s) abierta(s)</b> sin bloqueo de aprobación.</span>
        <button class="link-btn" type="button" data-go="alertas">Ver alertas</button>
      </div>`;
  } else {
    $('resumen-alert').innerHTML = '<div class="ok-banner">Sin alertas abiertas.</div>';
  }

  const max = Math.max(...state.clients.map((client) => Number(client.total_kwh ?? 0)), 1);
  $('resumen-bars').innerHTML = state.clients.length
    ? state.clients.map((client) => {
        const percent = Math.max(4, Math.round((Number(client.total_kwh ?? 0) / max) * 100));
        return `
          <div class="bar-row">
            <span>${esc(client.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${percent}%"></span></span>
            <span class="valor">${fmtInt(client.total_kwh)}</span>
          </div>`;
      }).join('')
    : '<p class="empty">Sin clientes cargados.</p>';

  const counts = { borrador: 0, revision: 0, aprobada: 0 };
  for (const consolidation of state.consolidations) {
    if (counts[consolidation.status] !== undefined) counts[consolidation.status]++;
  }
  $('resumen-status-sub').textContent = `${state.consolidations.length} consolidación(es)`;
  $('resumen-status').innerHTML = Object.entries(counts)
    .map(([status, count]) => `
      <div class="status-item">
        <span>${statusBadge(status)}</span>
        <b>${count}</b>
      </div>`)
    .join('');

  $('resumen-audit').innerHTML = state.audit.slice(0, 5).map((event) => `
    <li>
      <time>${fmtDate(event.created_at)}</time>
      <span><b>${esc(event.actor)}</b> · ${esc(ACTION_LABELS[event.action] ?? event.action)}</span>
    </li>`).join('') || '<li><span class="empty">Sin actividad.</span></li>';
}

function renderConsolidacion() {
  const select = $('consolidacion-client');
  const previous = state.selectedClientId || select.value || state.clients[0]?.id;
  select.innerHTML = state.clients.map((client) => `
    <option value="${esc(client.id)}">${esc(client.name)}${client.synthetic ? ' (sintético)' : ''}</option>
  `).join('');
  if (previous) select.value = previous;

  const isAnalyst = state.user?.role === 'analista';
  $('btn-generate').disabled = !isAnalyst || !state.clients.length;
  $('btn-generate').title = isAnalyst ? '' : 'Solo el analista puede generar consolidaciones';

  const clientId = select.value;
  const client = state.clients.find((item) => item.id === clientId);
  const alerts = state.alerts.filter((alert) => alert.client_id === clientId && alert.status === 'open');
  const critical = alerts.filter((alert) => alert.severity === 'critical');

  if (clientId && critical.length) {
    $('consolidacion-alert').innerHTML = `
      <div class="alert-banner">
        <span><b>Alerta crítica:</b> ${esc(critical[0].message)} No se puede enviar a revisión hasta resolverla.</span>
        ${alertAction(critical[0])}
      </div>`;
  } else if (clientId && alerts.length) {
    $('consolidacion-alert').innerHTML = `
      <div class="warn-banner">
        <span><b>${alerts.length} alerta(s) abierta(s):</b> ${esc(alerts[0].message)}</span>
        ${alertAction(alerts[0])}
      </div>`;
  } else {
    $('consolidacion-alert').innerHTML = '';
  }

  const rows = state.consolidations.map((consolidation) => `
    <tr>
      <td>${esc(consolidation.client_name)}</td>
      <td>${statusBadge(consolidation.status)}</td>
      <td class="num">${fmtNum(consolidation.total_kwh, 0)}</td>
      <td class="num">${fmtNum(consolidation.total_liters, 0)}</td>
      <td class="num">${fmtClp(consolidation.total_clp)}</td>
      <td><button class="btn btn-sm" type="button" data-consolidation="${consolidation.id}">Ver detalle</button></td>
    </tr>`).join('');

  $('consolidacion-list').innerHTML = `
    <div class="panel-head">
      <h3>Consolidaciones del período</h3>
      <span class="panel-sub">${state.consolidations.length} registro(s)</span>
    </div>
    ${rows
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Cliente</th><th>Estado</th><th class="num">kWh</th><th class="num">Litros</th><th class="num">CLP</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : '<p class="empty">Aún no hay consolidaciones. Selecciona un cliente y genera una.</p>'}`;

  const detail = state.consolidationDetail;
  if (!detail) {
    $('consolidacion-detail').innerHTML = client
      ? `<div class="panel"><p class="empty">Sin detalle seleccionado para ${esc(client.name)}. Genera la consolidación o abre una existente.</p></div>`
      : '';
    return;
  }

  const detailCritical = criticalAlertsFor(detail.client_id);
  let actions = '';
  if (state.user?.role === 'analista' && detail.status === 'borrador') {
    actions = `<button class="btn btn-primary" type="button" data-action="submit" data-id="${detail.id}" ${detailCritical.length ? 'disabled' : ''}>Enviar a revisión</button>`;
  }
  if (state.user?.role === 'aprobador' && detail.status === 'revision') {
    actions = `
      <button class="btn btn-primary" type="button" data-action="approve" data-id="${detail.id}">Aprobar y enviar a SAP (simulado)</button>
      <button class="btn btn-danger" type="button" data-action="reject" data-id="${detail.id}">Rechazar</button>`;
  }
  if (detail.status === 'aprobada') {
    actions = `<span class="badge badge-ok">Aprobada por ${esc(detail.approved_by ?? '—')} · inmutable</span>`;
  }

  const lines = detail.lines.map((line) => `
    <tr>
      <td>${fmtDate(line.ts)}</td>
      <td class="num">${fmtNum(line.kwh, 3)}</td>
      <td class="num">${fmtNum(line.price_usd_per_kwh, 5)}</td>
      <td class="num">${fmtNum(line.exchange_rate, 3)}</td>
      <td class="num">${fmtNum(line.factor_l_per_kwh, 6)}</td>
      <td class="num">${fmtClp(line.amount_clp)}</td>
      <td class="num">${fmtNum(line.liters, 3)}</td>
    </tr>`).join('');

  $('consolidacion-detail').innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>${esc(detail.client_name)} · ${esc(detail.period)}</h3>
          <p class="muted">Medidor ${esc(detail.meter?.id ?? '—')} · ${esc(detail.meter?.barge ?? '—')}</p>
        </div>
        <div class="actions-inline">${statusBadge(detail.status)}${actions}</div>
      </div>
      ${detail.reject_reason ? `<div class="warn-banner"><span><b>Devuelta:</b> ${esc(detail.reject_reason)}</span></div>` : ''}
      <div class="cards">
        <div class="card"><div class="card-title">Consumo</div><div class="card-value">${fmtNum(detail.total_kwh, 0)}</div><div class="card-sub">kWh</div></div>
        <div class="card"><div class="card-title">Gas equivalente</div><div class="card-value">${fmtNum(detail.total_liters, 0)}</div><div class="card-sub">litros</div></div>
        <div class="card"><div class="card-title">Monto</div><div class="card-value">${fmtClp(detail.total_clp)}</div><div class="card-sub">CLP</div></div>
        <div class="card"><div class="card-title">Líneas</div><div class="card-value">${detail.lines.length}</div><div class="card-sub">lecturas del período</div></div>
      </div>
      <div class="table-wrap scroll">
        <table>
          <thead><tr><th>Fecha</th><th class="num">kWh</th><th class="num">USD/kWh</th><th class="num">T.C.</th><th class="num">Factor</th><th class="num">CLP</th><th class="num">Litros</th></tr></thead>
          <tbody>${lines}</tbody>
        </table>
      </div>
    </div>`;
}

function renderClientes() {
  const rows = state.clients.map((client) => {
    const alerts = state.alerts.filter((alert) => alert.client_id === client.id && alert.status === 'open');
    return `
      <tr>
        <td><b>${esc(client.name)}</b> ${syntheticBadge(client.synthetic)}</td>
        <td>${esc(client.meter_id)} · ${esc(client.barge ?? '—')}</td>
        <td class="num">${fmtInt(client.total_kwh)}</td>
        <td>${alerts.length ? `<span class="badge badge-err">${alerts.length}</span>` : '<span class="badge badge-ok">0</span>'}</td>
        <td>${client.consolidation_status ? statusBadge(client.consolidation_status) : '<span class="badge badge-info">Sin generar</span>'}</td>
        <td><button class="btn btn-sm" type="button" data-client="${esc(client.id)}">Ver ficha</button></td>
      </tr>`;
  }).join('');

  $('clientes-list').innerHTML = rows
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Cliente</th><th>Medidor</th><th class="num">kWh</th><th>Alertas</th><th>Consolidación</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : '<p class="empty">Sin clientes cargados.</p>';
}

async function openClient(clientId) {
  state.selectedClientId = clientId;
  try {
    state.clientDetail = await api(
      `/api/clients/${encodeURIComponent(clientId)}?period=${encodeURIComponent(state.period)}`
    );
    showView('cliente');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderCliente() {
  const detail = state.clientDetail;
  if (!detail) {
    $('cliente-title').textContent = 'Cliente';
    $('cliente-sub').textContent = 'Sin datos';
    return;
  }

  const alerts = detail.alerts.filter((alert) => alert.status === 'open');
  const critical = alerts.filter((alert) => alert.severity === 'critical');
  $('cliente-title').textContent = detail.client.name;
  $('cliente-sub').textContent = `${detail.meter?.id ?? '—'} · ${detail.meter?.barge ?? '—'} · Contrato ${detail.contract?.id ?? '—'}`;
  $('cliente-badge').className = `badge ${critical.length ? 'badge-err' : 'badge-ok'}`;
  $('cliente-badge').textContent = critical.length ? 'Con alerta crítica' : 'Sin alertas críticas';

  const summary = detail.summary;
  $('cliente-kwh').textContent = summary ? fmtNum(summary.totalKwh, 0) : '—';
  $('cliente-liters').textContent = summary ? fmtNum(summary.totalLiters, 0) : '—';
  $('cliente-clp').textContent = summary ? fmtClp(summary.totalClp) : '—';
  $('cliente-alerts').textContent = alerts.length;
  $('cliente-alerts').style.color = alerts.length ? 'var(--red)' : 'var(--green)';
  $('cliente-alerts-sub').textContent = alerts.length ? 'Requieren revisión' : 'Sin alertas abiertas';

  $('cliente-contract-id').textContent = detail.contract?.id ?? '—';
  $('cliente-contract').innerHTML = `
    <dt>Factor</dt><dd>${fmtNum(detail.contract?.factor_l_per_kwh, 6)} L/kWh</dd>
    <dt>Precio</dt><dd>${fmtNum(detail.contract?.price_usd_per_kwh, 5)} USD/kWh</dd>
    <dt>Tipo de cambio</dt><dd>${fmtNum(detail.contract?.exchange_rate, 3)}</dd>
    <dt>Vigencia</dt><dd>${fmtDate(detail.contract?.valid_from)} — ${fmtDate(detail.contract?.valid_to)}</dd>
    <dt>Medidor</dt><dd>${esc(detail.meter?.id ?? '—')}</dd>
    <dt>Barcaza</dt><dd>${esc(detail.meter?.barge ?? '—')}</dd>
    <dt>Contacto</dt><dd>${esc(detail.client.contact ?? '—')}</dd>`;

  $('cliente-alert-list').innerHTML = alerts.length
    ? alerts.map((alert) => `
        <div class="source" style="align-items:flex-start;">
          <span>${severityBadge(alert.severity)} ${esc(alert.message)}</span>
          ${alertAction(alert)}
        </div>`).join('')
    : '<p class="empty">Sin alertas abiertas.</p>';

  const readings = [...detail.readings].slice(-12).reverse();
  $('cliente-readings').innerHTML = readings.length
    ? readings.map((reading) => `
        <tr>
          <td>${fmtDate(reading.ts)}</td>
          <td>${esc(reading.source)}</td>
          <td class="num">${fmtNum(reading.kwh, 3)}</td>
          <td>${reading.status === 'manual' ? '<span class="badge badge-review">Manual</span>' : '<span class="badge badge-ok">OK</span>'}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="empty">Sin lecturas.</td></tr>';

  if (detail.consolidation) {
    $('cliente-consolidation').innerHTML = `
      <div class="panel-head">
        <h3>Consolidación del período</h3>
        ${statusBadge(detail.consolidation.status)}
      </div>
      <div class="cards">
        <div class="card"><div class="card-title">kWh</div><div class="card-value">${fmtNum(detail.consolidation.total_kwh, 0)}</div></div>
        <div class="card"><div class="card-title">Litros</div><div class="card-value">${fmtNum(detail.consolidation.total_liters, 0)}</div></div>
        <div class="card"><div class="card-title">Monto</div><div class="card-value">${fmtClp(detail.consolidation.total_clp)}</div></div>
        <div class="card"><div class="card-title">Acción</div><div class="card-value"><button class="btn btn-sm" type="button" data-consolidation="${detail.consolidation.id}">Ver detalle</button></div></div>
      </div>`;
  } else {
    $('cliente-consolidation').innerHTML = `
      <div class="panel-head"><h3>Consolidación del período</h3></div>
      <p class="empty">Sin consolidación generada.</p>
      ${state.user?.role === 'analista'
        ? `<button class="btn btn-primary" type="button" data-generate-client="${esc(detail.client.id)}">Generar consolidación</button>`
        : ''}`;
  }
}

function renderAlertas() {
  const filter = $('alert-filter').value || 'open';
  state.alertFilter = filter;
  const alerts = state.alerts.filter((alert) => filter === 'all' || alert.status === filter);

  const rows = alerts.map((alert) => `
    <tr>
      <td>${severityBadge(alert.severity)}</td>
      <td>${esc(alert.client_name)}</td>
      <td><b>${esc(TYPE_LABELS[alert.type] ?? alert.type)}</b><br><span class="muted">${esc(alert.message)}</span></td>
      <td>${alert.ref_ts ? fmtDate(alert.ref_ts) : '—'}</td>
      <td>${alert.items_open ?? '—'}/${alert.items_total ?? '—'}</td>
      <td>${alert.status === 'open' ? '<span class="badge badge-err">Abierta</span>' : '<span class="badge badge-ok">Resuelta</span>'}</td>
      <td>${alertAction(alert) || '—'}</td>
    </tr>`).join('');

  $('alertas-list').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Severidad</th><th>Cliente</th><th>Alerta</th><th>Referencia</th><th>Mediciones</th><th>Estado</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty">Sin alertas para el filtro.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function kindLabel(kind) {
  const labels = {
    missing: 'Lectura faltante',
    negative_drop: 'Caída del acumulado',
    high_jump: 'Salto sobre el umbral',
    outlier: 'Consumo atípico'
  };
  return labels[kind] ?? kind;
}

function itemStatusBadge(item) {
  if (item.status === 'corrected') {
    return `<span class="badge badge-ok">Corregida${item.corrected_value !== null && item.corrected_value !== undefined ? ` → ${fmtNum(item.corrected_value, 3)}` : ''}</span>`;
  }
  if (item.status === 'reviewed') {
    return '<span class="badge badge-info">Revisada</span>';
  }
  return '<span class="badge badge-err">Abierta</span>';
}

async function openAlert(alertId) {
  try {
    state.alertDetail = await api(`/api/alerts/${alertId}`);
    renderAlertModal();
    $('dlg-alert').showModal();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderAlertModal() {
  const detail = state.alertDetail;
  if (!detail) return;

  const canCorrect = state.user?.role === 'analista' && detail.status === 'open';
  const openItems = detail.items.filter((item) => item.status === 'open').length;
  $('alert-title').textContent = `${TYPE_LABELS[detail.type] ?? detail.type} · ${detail.client_name}`;
  const consolidationText = detail.consolidation
    ? ` · Consolidación: ${STATUS_LABELS[detail.consolidation.status] ?? detail.consolidation.status}`
    : '';
  const referenceTs = detail.ref_ts ?? detail.items[0]?.ts;
  $('alert-meta').textContent =
    `${detail.meter?.id ?? '—'} · ${referenceTs ? fmtDate(referenceTs) : 'sin fecha de referencia'}` +
    ` · ${SEVERITY_LABELS[detail.severity] ?? detail.severity}` +
    ` · ${detail.status === 'resolved' ? 'Resuelta' : 'Abierta'}${consolidationText}`;

  const bannerClass = detail.status === 'resolved'
    ? 'ok-banner'
    : detail.severity === 'critical'
      ? 'alert-banner'
      : 'warn-banner';
  $('alert-message').innerHTML = `<div class="${bannerClass}">${esc(detail.message)}</div>`;

  const rows = detail.items.map((item) => {
    const isMissing = item.kind === 'missing';
    const action = canCorrect && item.status === 'open'
      ? `<button class="btn btn-sm ${isMissing ? 'btn-primary' : ''}" type="button"
           data-correct-alert="${detail.id}"
           data-ts="${esc(item.ts)}"
           data-kind="${esc(item.kind)}"
           data-value="${item.value ?? ''}">${isMissing ? 'Registrar lectura' : 'Corregir'}</button>`
      : '—';
    return `
      <tr>
        <td><b>${esc(kindLabel(item.kind))}</b><br>${fmtDate(item.ts)}</td>
        <td class="num">${isMissing || item.previous_value === null ? '—' : fmtNum(item.previous_value, 3)}</td>
        <td class="num">${isMissing || item.value === null ? '—' : fmtNum(item.value, 3)}</td>
        <td class="num">${item.delta === null ? '—' : fmtNum(item.delta, 3)}</td>
        <td>${item.next_ts ? `${fmtDate(item.next_ts)}<br><span class="muted">${fmtNum(item.next_value, 3)} (${fmtNum(item.next_delta, 3)})</span>` : '—'}</td>
        <td>${itemStatusBadge(item)}</td>
        <td>${action}</td>
      </tr>`;
  }).join('');

  $('alert-items').innerHTML = detail.items.length
    ? `<table>
        <thead><tr><th>Medición</th><th class="num">Anterior</th><th class="num">Valor</th><th class="num">Delta</th><th>Siguiente</th><th>Estado</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<p class="empty">Sin mediciones asociadas a la alerta.</p>';

  const showResolve = canCorrect && detail.type !== 'missing_reading' && openItems > 0;
  $('alert-resolve-note').classList.toggle('hidden', !showResolve);
  $('alert-resolve-note').textContent = detail.type === 'hourly_consistency'
    ? 'Revisar serie y resolver con nota'
    : 'Resolver con nota';
}

function openCorrect(alertId, ts, kind, value) {
  state.correctAlertId = Number(alertId);
  state.correctTs = ts;
  state.correctKind = kind;
  const detail = state.alertDetail;
  $('correct-title').textContent = kind === 'missing'
    ? 'Registrar lectura faltante'
    : 'Corregir medición';
  $('correct-meta').textContent =
    `${detail?.meter?.id ?? '—'} · ${fmtDate(ts)} · ${kindLabel(kind)}`;
  $('correct-value').value = kind === 'missing' ? '' : (value ?? '');
  $('correct-reason').value = '';
  $('correct-error').classList.add('hidden');
  $('dlg-correct').showModal();
  $('correct-value').focus();
}

async function saveCorrect() {
  const error = $('correct-error');
  const value = parseNumber($('correct-value').value);
  const reason = $('correct-reason').value.trim();

  if (!Number.isFinite(value)) {
    error.textContent = 'Ingresa un valor numérico.';
    error.classList.remove('hidden');
    return;
  }
  if (state.correctKind === 'missing' && value <= 0) {
    error.textContent = 'La lectura debe ser mayor que 0.';
    error.classList.remove('hidden');
    return;
  }
  if (reason.length < 5) {
    error.textContent = 'Escribe el motivo de la corrección (mínimo 5 caracteres).';
    error.classList.remove('hidden');
    return;
  }

  try {
    const detail = await api(`/api/alerts/${state.correctAlertId}/correct`, {
      method: 'POST',
      body: JSON.stringify({ ts: state.correctTs, value, reason })
    });
    $('dlg-correct').close();
    state.alertDetail = detail;
    const openItems = detail.items.filter((item) => item.status === 'open').length;
    toast(
      detail.status === 'resolved'
        ? 'Alerta resuelta con la corrección'
        : `Corrección guardada; quedan ${openItems} mediciones por revisar`
    );
    await loadAll();
    if (detail.status === 'resolved') {
      $('dlg-alert').close();
    } else {
      renderAlertModal();
    }
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

function renderAuditoria() {
  const rows = state.audit.map((event) => `
    <tr>
      <td>${fmtDate(event.created_at)}</td>
      <td>${esc(event.actor)}</td>
      <td>${esc(event.role)}</td>
      <td>${esc(ACTION_LABELS[event.action] ?? event.action)}</td>
      <td>${esc(event.entity)}${event.entity_id ? ` #${esc(event.entity_id)}` : ''}</td>
      <td>${esc(event.detail ?? '—')}</td>
    </tr>`).join('');

  $('auditoria-list').innerHTML = `
    <div class="table-wrap scroll">
      <table>
        <thead><tr><th>Fecha</th><th>Actor</th><th>Rol</th><th>Acción</th><th>Entidad</th><th>Detalle</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="empty">Sin eventos.</td></tr>'}</tbody>
      </table>
    </div>`;
}

async function openConsolidation(id) {
  try {
    state.selectedConsolidationId = Number(id);
    state.consolidationDetail = await api(`/api/consolidations/${id}`);
    if (state.consolidationDetail?.client_id) {
      state.selectedClientId = state.consolidationDetail.client_id;
      $('consolidacion-client').value = state.consolidationDetail.client_id;
    }
    showView('consolidacion');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function generateConsolidationFor(clientId) {
  if (!clientId) return;
  try {
    const detail = await api('/api/consolidations', {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId, period: state.period })
    });
    state.selectedConsolidationId = detail.id;
    state.consolidationDetail = detail;
    state.selectedClientId = clientId;
    $('consolidacion-client').value = clientId;
    await loadAll();
    showView('consolidacion');
    toast(`Consolidación generada para ${detail.client_name}`);
  } catch (error) {
    const extra = error.data?.alerts?.length ? ` (${error.data.alerts.length} alerta(s))` : '';
    toast(error.message + extra, 'error');
  }
}

async function submitConsolidation(id) {
  try {
    state.consolidationDetail = await api(`/api/consolidations/${id}/submit`, { method: 'POST' });
    toast('Consolidación enviada a revisión');
    await loadAll();
  } catch (error) {
    const extra = error.data?.alerts?.length ? ` (${error.data.alerts.length} alerta(s))` : '';
    toast(error.message + extra, 'error');
  }
}

async function approveConsolidation(id) {
  if (!confirm('Al aprobar, la consolidación queda bloqueada y no se podrá modificar. ¿Continuar?')) return;
  try {
    state.consolidationDetail = await api(`/api/consolidations/${id}/approve`, { method: 'POST' });
    toast('Consolidación aprobada y bloqueada');
    await loadAll();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openReject(id) {
  state.rejectId = id;
  $('reject-reason').value = '';
  $('reject-error').classList.add('hidden');
  $('dlg-reject').showModal();
  $('reject-reason').focus();
}

async function saveReject() {
  const reason = $('reject-reason').value.trim();
  const error = $('reject-error');
  if (reason.length < 5) {
    error.textContent = 'Escribe el motivo del rechazo (mínimo 5 caracteres).';
    error.classList.remove('hidden');
    return;
  }
  try {
    state.consolidationDetail = await api(`/api/consolidations/${state.rejectId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
    $('dlg-reject').close();
    toast('Consolidación devuelta al analista');
    await loadAll();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

function openManual(meterId, ts) {
  const select = $('manual-meter');
  select.innerHTML = state.clients.map((client) => `
    <option value="${esc(client.meter_id)}">${esc(client.name)} · ${esc(client.meter_id)}</option>
  `).join('');
  if (meterId) select.value = meterId;
  $('manual-ts').value = ts || `${state.period}-01`;
  $('manual-kwh').value = '';
  $('manual-reason').value = '';
  $('manual-error').classList.add('hidden');
  $('dlg-manual').showModal();
  $('manual-kwh').focus();
}

function parseNumber(value) {
  const clean = String(value).trim().replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return Number.NaN;
  return Number(clean);
}

async function saveManual() {
  const error = $('manual-error');
  const meterId = $('manual-meter').value;
  const ts = $('manual-ts').value;
  const kwh = parseNumber($('manual-kwh').value);
  const reason = $('manual-reason').value.trim();

  if (!Number.isFinite(kwh) || kwh <= 0) {
    error.textContent = 'Ingresa una lectura numérica mayor que 0.';
    error.classList.remove('hidden');
    return;
  }
  if (reason.length < 5) {
    error.textContent = 'Escribe el motivo del ingreso manual (mínimo 5 caracteres).';
    error.classList.remove('hidden');
    return;
  }

  try {
    const result = await api('/api/readings/manual', {
      method: 'POST',
      body: JSON.stringify({ meter_id: meterId, ts, kwh, reason })
    });
    $('dlg-manual').close();
    toast(`Lectura registrada${result.resolvedAlerts ? ' y alerta resuelta' : ''}`);
    await loadAll();
    if (state.view === 'cliente' && state.selectedClientId) {
      state.clientDetail = await api(
        `/api/clients/${encodeURIComponent(state.selectedClientId)}?period=${encodeURIComponent(state.period)}`
      );
      renderCliente();
    }
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

function openResolve(alertId) {
  state.resolveId = Number(alertId);
  if ($('dlg-alert').open) $('dlg-alert').close();
  $('resolve-note').value = '';
  $('resolve-error').classList.add('hidden');
  $('dlg-resolve').showModal();
  $('resolve-note').focus();
}

async function saveResolve() {
  const note = $('resolve-note').value.trim();
  const error = $('resolve-error');
  if (note.length < 5) {
    error.textContent = 'Escribe una nota de resolución (mínimo 5 caracteres).';
    error.classList.remove('hidden');
    return;
  }
  try {
    await api(`/api/alerts/${state.resolveId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note })
    });
    $('dlg-resolve').close();
    $('dlg-alert').close();
    toast('Alerta resuelta');
    await loadAll();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

async function login(event) {
  event.preventDefault();
  const error = $('login-error');
  const button = $('login-submit');
  error.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Ingresando…';

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('login-username').value.trim(),
        password: $('login-password').value
      })
    });
    state.user = data.user;
    await showApp();
    await loadAll();
    showView('resumen');
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Ingresar';
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // La sesión pudo haber expirado.
  }
  state.user = null;
  state.clientDetail = null;
  state.consolidationDetail = null;
  state.selectedConsolidationId = null;
  showLogin();
}

function bindEvents() {
  $('login-form').addEventListener('submit', login);
  $('logout').addEventListener('click', logout);

  $$('dialog form').forEach((form) => {
    form.addEventListener('submit', (event) => event.preventDefault());
  });

  $$('.menu-item').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });

  $('consolidacion-client').addEventListener('change', () => {
    const clientId = $('consolidacion-client').value;
    state.selectedClientId = clientId;
    const existing = state.consolidations.find((item) => item.client_id === clientId);
    if (existing) {
      openConsolidation(existing.id);
    } else {
      state.selectedConsolidationId = null;
      state.consolidationDetail = null;
      renderConsolidacion();
    }
  });

  $('btn-generate').addEventListener('click', () => {
    generateConsolidationFor($('consolidacion-client').value);
  });

  $('alert-filter').addEventListener('change', renderAlertas);
  $('btn-back-clientes').addEventListener('click', () => showView('clientes'));
  $('btn-cliente-consolidacion').addEventListener('click', () => {
    if (state.clientDetail?.consolidation) {
      openConsolidation(state.clientDetail.consolidation.id);
    } else {
      $('consolidacion-client').value = state.clientDetail?.client.id ?? '';
      state.consolidationDetail = null;
      showView('consolidacion');
    }
  });

  $('manual-save').addEventListener('click', saveManual);
  $('reject-save').addEventListener('click', saveReject);
  $('resolve-save').addEventListener('click', saveResolve);
  $('correct-save').addEventListener('click', saveCorrect);
  $('alert-resolve-note').addEventListener('click', () => {
    if (state.alertDetail) openResolve(state.alertDetail.id);
  });

  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go]');
    if (go) {
      showView(go.dataset.go);
      return;
    }

    const alert = event.target.closest('[data-alert]');
    if (alert) {
      openAlert(alert.dataset.alert);
      return;
    }

    const correct = event.target.closest('[data-correct-alert]');
    if (correct) {
      openCorrect(
        correct.dataset.correctAlert,
        correct.dataset.ts,
        correct.dataset.kind,
        correct.dataset.value
      );
      return;
    }

    const client = event.target.closest('[data-client]');
    if (client) {
      openClient(client.dataset.client);
      return;
    }

    const consolidation = event.target.closest('[data-consolidation]');
    if (consolidation) {
      openConsolidation(consolidation.dataset.consolidation);
      return;
    }

    const generate = event.target.closest('[data-generate-client]');
    if (generate) {
      generateConsolidationFor(generate.dataset.generateClient);
      return;
    }

    const action = event.target.closest('[data-action]');
    if (action) {
      if (action.dataset.action === 'submit') submitConsolidation(action.dataset.id);
      if (action.dataset.action === 'approve') approveConsolidation(action.dataset.id);
      if (action.dataset.action === 'reject') openReject(action.dataset.id);
      return;
    }

    const manual = event.target.closest('[data-manual]');
    if (manual) {
      openManual(manual.dataset.meter, manual.dataset.ts);
      return;
    }

    const resolve = event.target.closest('[data-resolve]');
    if (resolve) {
      openResolve(resolve.dataset.resolve);
      return;
    }

    const close = event.target.closest('[data-close]');
    if (close) {
      $(close.dataset.close).close();
    }
  });
}

async function init() {
  bindEvents();
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    await showApp();
    await loadAll();
    showView('resumen');
  } catch {
    showLogin();
  }
}

init();
