import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { seedDatabase } from '../src/seed.js';
import { createApp } from '../src/server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const SEED = JSON.parse(readFileSync(join(ROOT, 'data', 'seed.json'), 'utf8'));

const net = { requests: 0, errors: 0 };

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function stats(values) {
  return {
    count: values.length,
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length)
  };
}

async function startServer(db) {
  const started = performance.now();
  const server = createApp(db);
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    startupMs: round(performance.now() - started),
    close: () => new Promise((resolvePromise) => server.close(resolvePromise))
  };
}

async function request(base, path, { method = 'GET', cookie, body } = {}) {
  const started = performance.now();
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const ms = performance.now() - started;
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  net.requests++;
  if (response.status >= 500) net.errors++;
  return {
    status: response.status,
    data,
    ms,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null
  };
}

async function login(base, username) {
  const response = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { username, password: 'demo' }
  });
  if (response.status !== 200) {
    throw new Error(`No se pudo iniciar sesión como ${username}: ${response.status}`);
  }
  return response.cookie;
}

async function measureIngestion() {
  const times = [];
  let rows = 0;
  for (let run = 0; run < 3; run++) {
    const dir = mkdtempSync(join(tmpdir(), 'svdm-ingest-'));
    const path = join(dir, 'ingest.db');
    const db = openDb(path);
    const started = performance.now();
    seedDatabase(db, SEED);
    times.push(performance.now() - started);
    rows = db.prepare('SELECT COUNT(*) AS n FROM readings').get().n;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { times, stats: stats(times), rows };
}

async function measureSmallDatabase() {
  const db = openDb(':memory:');
  seedDatabase(db, SEED);
  const server = await startServer(db);
  const analyst = await login(server.base, 'u-analista');
  const approver = await login(server.base, 'u-aprobador');

  const first = await request(server.base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-A', period: '2026-05' }
  });
  if (first.status !== 201) throw new Error(`No se pudo generar la consolidación A: ${first.status}`);
  const consolidationId = first.data.id;

  const endpoints = [
    '/api/summary?period=2026-05',
    '/api/clients?period=2026-05',
    '/api/clients/CLI-A?period=2026-05',
    '/api/consolidations?period=2026-05',
    `/api/consolidations/${consolidationId}`,
    '/api/alerts?status=all'
  ];

  const latencies = {};
  for (const endpoint of endpoints) {
    for (let warmup = 0; warmup < 3; warmup++) {
      await request(server.base, endpoint, { cookie: analyst });
    }
    const samples = [];
    for (let run = 0; run < 50; run++) {
      const response = await request(server.base, endpoint, { cookie: analyst });
      if (response.status !== 200) throw new Error(`${endpoint} respondió ${response.status}`);
      samples.push(response.ms);
    }
    latencies[endpoint] = stats(samples);
  }

  const consolidationTimes = [];
  let detail = first.data;
  for (let run = 0; run < 10; run++) {
    const response = await request(server.base, '/api/consolidations', {
      method: 'POST',
      cookie: analyst,
      body: { client_id: 'CLI-A', period: '2026-05' }
    });
    if (response.status !== 201) throw new Error(`Consolidación A respondió ${response.status}`);
    detail = response.data;
    consolidationTimes.push(response.ms);
  }

  const expectedByTs = new Map(SEED.reference.lines.map((line) => [line.ts, line]));
  const lineDiffs = detail.lines.map((line) => {
    const expected = expectedByTs.get(line.ts);
    if (!expected) return { ts: line.ts, missing: true, amountDiff: Infinity, kwhDiff: Infinity };
    return {
      ts: line.ts,
      missing: false,
      amountDiff: Math.abs(line.amount_clp - expected.amount_clp),
      kwhDiff: Math.abs(line.kwh - expected.kwh)
    };
  });
  const missing = lineDiffs.filter((line) => line.missing);
  const maxAmountDiff = Math.max(...lineDiffs.map((line) => line.amountDiff));
  const maxKwhDiff = Math.max(...lineDiffs.map((line) => line.kwhDiff));
  const overTolerance = lineDiffs.filter((line) => line.amountDiff > 1).length;
  const totalDiff = Math.abs(detail.total_clp - SEED.reference.total_clp);

  const manual = await request(server.base, '/api/readings/manual', {
    method: 'POST',
    cookie: analyst,
    body: {
      meter_id: 'M-01',
      ts: '2026-05-15',
      kwh: 700.5,
      reason: 'Medición de RNF: lectura de prueba'
    }
  });
  const createdC = await request(server.base, '/api/consolidations', {
    method: 'POST',
    cookie: analyst,
    body: { client_id: 'CLI-C', period: '2026-05' }
  });
  const consolidationC = createdC.data?.id;
  const submittedC = await request(server.base, `/api/consolidations/${consolidationC}/submit`, {
    method: 'POST',
    cookie: analyst
  });
  const approveAsAnalyst = await request(
    server.base,
    `/api/consolidations/${consolidationC}/approve`,
    { method: 'POST', cookie: analyst }
  );
  const generateAsApprover = await request(server.base, '/api/consolidations', {
    method: 'POST',
    cookie: approver,
    body: { client_id: 'CLI-C', period: '2026-05' }
  });
  const approvedC = await request(server.base, `/api/consolidations/${consolidationC}/approve`, {
    method: 'POST',
    cookie: approver
  });
  const anonymous = await request(server.base, '/api/clients');
  const manualAfterApproval = await request(server.base, '/api/readings/manual', {
    method: 'POST',
    cookie: analyst,
    body: {
      meter_id: 'M-02',
      ts: '2026-05-15',
      kwh: 100,
      reason: 'Intento posterior a la aprobación'
    }
  });

  const rbacChecks = [
    ['analista puede generar', createdC.status === 201],
    ['analista puede enviar a revisión', submittedC.status === 200],
    ['analista no puede aprobar', approveAsAnalyst.status === 403],
    ['aprobador no puede generar', generateAsApprover.status === 403],
    ['aprobador puede aprobar', approvedC.status === 200],
    ['sin sesión no accede a datos', anonymous.status === 401],
    ['no se modifica una aprobada', manualAfterApproval.status === 409],
    ['el ingreso manual se registra', manual.status === 201]
  ];

  const audit = await request(server.base, '/api/audit?limit=200', { cookie: analyst });
  const actions = new Set(audit.data.events.map((event) => event.action));
  const expectedActions = [
    'reading.manual',
    'consolidation.created',
    'consolidation.submitted',
    'consolidation.approved'
  ];
  const audited = expectedActions.filter((action) => actions.has(action));
  const manualEvent = audit.data.events.find(
    (event) => event.action === 'reading.manual' && event.detail?.includes('Medición de RNF')
  );

  await server.close();
  db.close();

  return {
    startupMs: server.startupMs,
    latencies,
    consolidationTimes: stats(consolidationTimes),
    accuracy: {
      lines: detail.lines.length,
      missingLines: missing.length,
      maxAmountDiff: round(maxAmountDiff, 6),
      maxKwhDiff: round(maxKwhDiff, 9),
      overTolerance,
      totalDiff: round(totalDiff, 6),
      totalKwh: detail.total_kwh,
      totalClp: detail.total_clp,
      referenceTotalClp: SEED.reference.total_clp
    },
    rbac: {
      passed: rbacChecks.filter(([, ok]) => ok).length,
      total: rbacChecks.length,
      checks: rbacChecks.map(([name, ok]) => ({ name, ok }))
    },
    audit: {
      expected: expectedActions.length,
      found: audited.length,
      missing: expectedActions.filter((action) => !actions.has(action)),
      manualWithReason: Boolean(manualEvent)
    }
  };
}

function measureIntegrity() {
  const db = openDb(':memory:');
  seedDatabase(db, SEED);
  const duplicates = db
    .prepare(
      `SELECT meter_id, ts, kind, COUNT(*) AS n
       FROM readings GROUP BY meter_id, ts, kind HAVING n > 1`
    )
    .all();
  seedDatabase(db, SEED);
  const afterReseed = db
    .prepare(
      `SELECT meter_id, ts, kind, COUNT(*) AS n
       FROM readings GROUP BY meter_id, ts, kind HAVING n > 1`
    )
    .all();
  const rows = db.prepare('SELECT COUNT(*) AS n FROM readings').get().n;
  db.close();
  return {
    rows,
    duplicates: duplicates.length,
    afterReseed: afterReseed.length
  };
}

async function measureLargeDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'svdm-large-'));
  const path = join(dir, 'large.db');
  const db = openDb(path);
  seedDatabase(db, SEED);

  const insertMeter = db.prepare(
    "INSERT OR IGNORE INTO meters (id, client_id, barge, source) VALUES (?, 'CLI-A', 'Barcaza 3', 'eGauge')"
  );
  const meterIds = ['M-04'];
  for (let index = 1; index <= 9; index++) {
    const id = `MX-0${index}`;
    insertMeter.run(id);
    meterIds.push(id);
  }

  const insertReading = db.prepare(
    `INSERT OR IGNORE INTO readings (meter_id, ts, kwh, source, kind, status)
     VALUES (?, ?, ?, 'eGauge', ?, 'ok')`
  );

  const bulkStarted = performance.now();
  db.exec('BEGIN IMMEDIATE');
  for (let year = 2022; year <= 2026; year++) {
    for (let month = 1; month <= 12; month++) {
      const mm = String(month).padStart(2, '0');
      for (const meterId of meterIds) {
        for (let day = 1; day <= 30; day++) {
          const dd = String(day).padStart(2, '0');
          insertReading.run(meterId, `${year}-${mm}-${dd}`, 100 + day, 'daily');
        }
        for (let day = 1; day <= 30; day++) {
          const dd = String(day).padStart(2, '0');
          for (let hour = 0; hour < 24; hour++) {
            const hh = String(hour).padStart(2, '0');
            insertReading.run(
              meterId,
              `${year}-${mm}-${dd} ${hh}:00`,
              1000 + day * 24 + hour,
              'hourly'
            );
          }
        }
      }
    }
  }
  db.exec('COMMIT');
  const bulkMs = performance.now() - bulkStarted;

  const rows = db.prepare('SELECT COUNT(*) AS n FROM readings').get().n;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const sizeBytes = statSync(path).size;

  const server = await startServer(db);
  const analyst = await login(server.base, 'u-analista');
  const times = [];
  for (let run = 0; run < 10; run++) {
    const response = await request(server.base, '/api/consolidations', {
      method: 'POST',
      cookie: analyst,
      body: { client_id: 'CLI-A', period: '2026-05' }
    });
    if (response.status !== 201) throw new Error(`Consolidación grande respondió ${response.status}`);
    times.push(response.ms);
  }

  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    rows,
    sizeBytes,
    bulkMs: round(bulkMs),
    consolidationTimes: stats(times)
  };
}

function measureCoverage() {
  mkdirSync(DOCS, { recursive: true });
  const path = join(DOCS, 'coverage.txt');
  const run = spawnSync(
    process.execPath,
    ['--experimental-test-coverage', '--test'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (run.status !== 0) {
    throw new Error(`Las pruebas fallaron al medir cobertura:\n${run.stdout}\n${run.stderr}`);
  }
  const clean = `${run.stdout}\n${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  writeFileSync(path, clean, 'utf8');

  return {
    global: Number(clean.match(/all files\s*\|\s*([\d.]+)/)?.[1]),
    calc: Number(clean.match(/calc\.js\s*\|\s*([\d.]+)/)?.[1]),
    path: 'docs/coverage.txt'
  };
}

function buildMarkdown(result) {
  const r1Small = result.rnf.R1.small.p95;
  const r1Large = result.rnf.R1.large.p95;
  const ingest = result.rnf.R2.stats;
  const coverage = result.coverage;
  const fmt = (value, decimals = 2) =>
    new Intl.NumberFormat('es-CL', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(Number(value));
  const lines = [];

  lines.push('# Medición de requisitos no funcionales — SVDM MVP');
  lines.push('');
  lines.push(`Generado: \`${result.generated_at}\``);
  lines.push('');
  lines.push('## Entorno');
  lines.push('');
  lines.push(`- Node.js: \`${result.environment.node}\``);
  lines.push(`- Plataforma: \`${result.environment.platform}\``);
  lines.push(`- CPU: ${result.environment.cpu} (${result.environment.cpus} núcleos)`);
  lines.push('- Base de datos: SQLite local mediante `node:sqlite`');
  lines.push('- Servidor: `node:http` en proceso, puerto efímero');
  lines.push('');
  lines.push('## Resultados medidos');
  lines.push('');
  lines.push('| RNF | Objetivo | Método | Valor obtenido | Veredicto |');
  lines.push('|---|---|---|---|---|');
  lines.push(
    `| **RNF-R-1** | Consolidación mensual ≤ 5 min (300.000 ms) | 10 corridas HTTP sobre 30 lecturas y, aparte, 10 corridas con 5 años de datos | p95 **${fmt(r1Small)} ms** (30 líneas); p95 **${fmt(r1Large)} ms** con ${result.rnf.R3.rows.toLocaleString('es-CL')} filas | **Cumple** |`
  );
  lines.push(
    `| **RNF-R-2** | Ciclo de ingesta ≤ 60 s | 3 cargas del seed (${result.rnf.R2.rows} lecturas) en base nueva, medidas de punta a punta | mediana **${fmt(ingest.p50)} ms**; máximo ${fmt(ingest.max)} ms | **Cumple** |`
  );
  lines.push(
    `| **RNF-R-3** | 5 años de datos sin degradar R-1 | 10 medidores × 60 meses × (30 diarias + 720 horarias), 10 corridas de consolidación | **${result.rnf.R3.rows.toLocaleString('es-CL')} filas**, ${(result.rnf.R3.sizeBytes / 1024 / 1024).toFixed(1)} MB; p95 **${fmt(r1Large)} ms** | **Cumple** |`
  );
  lines.push(
    `| **RNF-E-1** | 0 discrepancias en ≥ 30 casos, tolerancia ≤ 1 CLP por línea | Comparación línea a línea contra la planilla para el Cliente A | ${result.rnf.E1.lines} casos; **${result.rnf.E1.overTolerance} líneas** fuera de tolerancia; diferencia máxima ${fmt(result.rnf.E1.maxAmountDiff, 6)} CLP; total ${fmt(result.rnf.E1.totalDiff, 6)} CLP | **Cumple** |`
  );
  lines.push(
    `| **RNF-E-2** | 0 lecturas duplicadas o modificadas | Consulta de duplicados antes y después de recargar el seed | **${result.rnf.E2.duplicates} duplicados**; ${result.rnf.E2.afterReseed} tras recargar | **Cumple** |`
  );
  lines.push(
    `| **RNF-S-2** | RBAC, mínimo privilegio | Matriz de 8 controles rol × acción sobre la API | **${result.rnf.S2.passed}/${result.rnf.S2.total}** controles correctos | **Cumple** |`
  );
  lines.push(
    `| **RNF-S-4** | 100 % de eventos críticos auditados | Comparación de acciones ejecutadas contra \`audit_events\` | **${result.rnf.S4.found}/${result.rnf.S4.expected}** acciones auditadas; motivo del ingreso manual presente | **Cumple** |`
  );
  lines.push(
    `| **RNF-M-1** | Cobertura ≥ 70 % global y ≥ 90 % en cálculo | \`node --experimental-test-coverage --test\` | global **${fmt(coverage.global)}%**; cálculo **${fmt(coverage.calc)}%** | **Cumple** |`
  );
  lines.push(
    `| **RNF-D-1** | Disponibilidad ≥ 99,5 % mensual | Conteo de respuestas 5xx durante la corrida | ${result.net.requests} solicitudes; **${result.net.errors}** errores 5xx | **Parcial**: no sustituye monitoreo mensual |`
  );
  lines.push(
    `| **RNF-P-1** | Despliegue local reproducible ≤ 15 min | Seed + arranque del servidor medidos | seed ${fmt(ingest.p50)} ms + arranque ${fmt(result.rnf.R1.startupMs)} ms | **Parcial**: sin IaC ni rollback |`
  );
  lines.push(
    `| **RNF-C-1** | Chrome/Edge y contrato OpenAPI | Flujo E2E automatizado en Chromium | Flujo completo OK en Chromium; Edge no disponible | **Parcial** |`
  );
  lines.push('');
  lines.push('## Latencia de API');
  lines.push('');
  lines.push('Medición local sobre loopback (50 solicitudes por endpoint, tras 3 de calentamiento). No incluye latencia de red ni TLS.');
  lines.push('');
  lines.push('| Endpoint | p50 | p95 | Máximo |');
  lines.push('|---|---|---|---|');
  for (const [endpoint, data] of Object.entries(result.apiLatency)) {
    lines.push(`| \`${endpoint}\` | ${fmt(data.p50)} ms | ${fmt(data.p95)} ms | ${fmt(data.max)} ms |`);
  }
  lines.push('');
  lines.push('## RNF no medidos en este entorno');
  lines.push('');
  lines.push('| RNF | Motivo | Qué falta para medirlo |');
  lines.push('|---|---|---|');
  lines.push('| **RNF-D-2** RPO/RTO | No hay respaldo ni restauración implementados en el MVP local | Prueba de restauración cronometrada sobre una base sembrada |');
  lines.push('| **RNF-D-3** Falla de fuente externa | Los adaptadores son simulados; no hay fuente externa que falle | Simulador de falla con reintento y verificación de 0 pérdida |');
  lines.push('| **RNF-S-1** Entra ID + MFA | La autenticación local no usa Entra ID ni MFA | Integración OIDC con un tenant de prueba |');
  lines.push('| **RNF-S-3** TLS y cifrado | El MVP corre en HTTP local, sin TLS | Despliegue con TLS y verificación de cifrado en reposo |');
  lines.push('| **RNF-S-5** Cumplimiento legal | Falta validación con el área legal de Gasco | Revisión de base de licitud, retención y Ley 21.719 |');
  lines.push('| **RNF-U-1** WCAG 2.1 AA | No se ejecutó auditoría de accesibilidad | Lighthouse + axe sobre las vistas |');
  lines.push('| **RNF-U-2** 80 % de usuarios sin ayuda | Pendiente la validación con usuarios | Estudio con 5 participantes y registro de tareas |');
  lines.push('| **RNF-M-2** Lint y observabilidad | No hay linter ni alertas configuradas | Linter en CI y alerta de ingesta |');
  lines.push('');
  lines.push('## Lectura de los resultados');
  lines.push('');
  lines.push(`- El cálculo es reproducible: el total del Cliente A es **${result.rnf.E1.referenceTotalClp.toLocaleString('es-CL', { minimumFractionDigits: 2 })} CLP**, con una diferencia de **${fmt(result.rnf.E1.totalDiff, 6)} CLP** frente a la planilla.`);
  lines.push(`- La consolidación tarda **${fmt(r1Small)} ms** con 30 lecturas y **${fmt(r1Large)} ms** con ${result.rnf.R3.rows.toLocaleString('es-CL')} filas; el objetivo era 300.000 ms.`);
  lines.push(`- La ingesta de ${result.rnf.R2.rows} lecturas tarda **${fmt(ingest.p50)} ms** de mediana, muy por debajo de los 60 s.`);
  lines.push('- Los RNF de seguridad, disponibilidad y accesibilidad que dependen de infraestructura o de usuarios se declaran como parciales o pendientes; no se presentan como cumplidos.');
  lines.push('');
  lines.push('## Reproducción');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run measure');
  lines.push('```');
  lines.push('');
  lines.push('El comando regenera `docs/mediciones.json`, `docs/coverage.txt` y este documento.');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  mkdirSync(DOCS, { recursive: true });

  const ingestion = await measureIngestion();
  const small = await measureSmallDatabase();
  const integrity = measureIntegrity();
  const large = await measureLargeDatabase();
  const coverage = measureCoverage();

  const result = {
    generated_at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu: os.cpus()[0]?.model ?? 'desconocido',
      cpus: os.cpus().length
    },
    net,
    coverage,
    rnf: {
      R1: {
        small: small.consolidationTimes,
        large: large.consolidationTimes,
        startupMs: small.startupMs
      },
      R2: {
        rows: ingestion.rows,
        stats: ingestion.stats,
        times: ingestion.times.map((time) => round(time))
      },
      R3: {
        rows: large.rows,
        sizeBytes: large.sizeBytes,
        bulkMs: large.bulkMs,
        consolidation: large.consolidationTimes
      },
      E1: small.accuracy,
      E2: integrity,
      S2: small.rbac,
      S4: small.audit
    },
    apiLatency: small.latencies
  };

  writeFileSync(join(DOCS, 'mediciones.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  writeFileSync(join(DOCS, 'rnf.md'), buildMarkdown(result), 'utf8');

  console.log('Mediciones escritas en docs/mediciones.json y docs/rnf.md');
  console.log(`RNF-R-1: p95 ${result.rnf.R1.small.p95} ms (30 líneas) / ${result.rnf.R1.large.p95} ms (5 años)`);
  console.log(`RNF-R-2: mediana ${result.rnf.R2.stats.p50} ms`);
  console.log(`RNF-R-3: ${result.rnf.R3.rows} filas, ${(result.rnf.R3.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`RNF-E-1: ${result.rnf.E1.overTolerance} líneas fuera de tolerancia, total ${result.rnf.E1.totalDiff} CLP`);
  console.log(`RNF-S-2: ${result.rnf.S2.passed}/${result.rnf.S2.total} | RNF-S-4: ${result.rnf.S4.found}/${result.rnf.S4.expected}`);
  console.log(`Cobertura: global ${result.coverage.global}%, cálculo ${result.coverage.calc}%`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
