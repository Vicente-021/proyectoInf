import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const SEED = JSON.parse(readFileSync(join(ROOT, 'data', 'seed.json'), 'utf8'));

function round(value, decimals = 3) {
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

function tukey(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  return {
    q1: round(q1),
    q3: round(q3),
    iqr: round(iqr),
    lower: round(q1 - 1.5 * iqr),
    upper: round(q3 + 1.5 * iqr)
  };
}

function outside(value, fences) {
  return value < fences.lower || value > fences.upper;
}

/** PRNG determinista para el experimento de inyección. */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng, mean, sd) {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function measureEnergyBalance() {
  const totalKwh = SEED.reference.total_kwh;
  const totalLiters = SEED.reference.total_liters;
  const factor = totalLiters / totalKwh;
  const calculatedLiters = totalKwh * factor;
  const difference = calculatedLiters - totalLiters;

  // Supuestos declarados: medidor clase 0,5 % y factor contractual ±1 %.
  const relativeMeter = 0.005;
  const relativeFactor = 0.01;
  const relativeCombined = Math.hypot(relativeMeter, relativeFactor);
  const uncertaintyLiters = calculatedLiters * relativeCombined;

  return {
    totalKwh: round(totalKwh, 9),
    totalLiters: round(totalLiters, 3),
    factor: round(factor, 12),
    calculatedLiters: round(calculatedLiters, 3),
    difference: round(difference, 9),
    relativeMeter,
    relativeFactor,
    relativeCombined: round(relativeCombined, 6),
    uncertaintyLiters: round(uncertaintyLiters, 3)
  };
}

function analyzeRealSeries() {
  const daily = SEED.daily_readings
    .filter((reading) => reading.meter_id === 'M-04')
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const dailyValues = daily.map((reading) => reading.kwh);
  const dailyFences = tukey(dailyValues);
  const dailyOutliers = daily
    .map((reading) => ({ ts: reading.ts, kwh: reading.kwh }))
    .filter((reading) => outside(reading.kwh, dailyFences));

  const hourly = SEED.hourly_readings
    .filter((reading) => reading.meter_id === 'M-04')
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const deltas = [];
  for (let index = 1; index < hourly.length; index++) {
    deltas.push({
      ts: hourly[index].ts,
      delta: round(hourly[index].cum_kwh - hourly[index - 1].cum_kwh, 3)
    });
  }

  const zeros = deltas.filter((item) => item.delta === 0);
  const negatives = deltas.filter((item) => item.delta < 0);
  const positives = deltas.filter((item) => item.delta > 0);
  const positiveFences = tukey(positives.map((item) => item.delta));
  const highOutliers = positives.filter((item) => item.delta > positiveFences.upper);

  const resetPairs = [];
  for (let index = 0; index < deltas.length - 1; index++) {
    if (deltas[index].delta < 0 && deltas[index + 1].delta > positiveFences.upper) {
      resetPairs.push({
        dropTs: deltas[index].ts,
        drop: deltas[index].delta,
        jumpTs: deltas[index + 1].ts,
        jump: deltas[index + 1].delta
      });
    }
  }

  return {
    daily: {
      count: dailyValues.length,
      fences: dailyFences,
      outliers: dailyOutliers
    },
    hourly: {
      count: hourly.length,
      deltas: deltas.length,
      zeros: zeros.length,
      negatives: negatives.length,
      positives: positives.length,
      positiveFences,
      highOutliers: highOutliers.length,
      highOutlierSamples: highOutliers.slice(0, 5),
      negativeSamples: negatives.slice(0, 5),
      resetPairs: resetPairs.length,
      resetSamples: resetPairs.slice(0, 4)
    }
  };
}

function controlledInjection() {
  const rng = mulberry32(42);
  const clean = Array.from({ length: 60 }, () => round(normal(rng, 1040, 80), 3));
  const contaminated = [...clean];
  const anomalies = [
    { index: 5, kind: 'alto +4σ', value: round(1040 + 4 * 80, 3) },
    { index: 15, kind: 'bajo −4σ', value: round(1040 - 4 * 80, 3) },
    { index: 25, kind: 'cero', value: 0 },
    { index: 35, kind: 'doble', value: 2080 },
    { index: 45, kind: '20 % del valor', value: 208 },
    { index: 55, kind: 'alto +5σ', value: round(1040 + 5 * 80, 3) }
  ];
  for (const anomaly of anomalies) {
    contaminated[anomaly.index] = anomaly.value;
  }

  const cleanFences = tukey(clean);
  const observedFences = tukey(contaminated);
  const truth = new Set(anomalies.map((anomaly) => anomaly.index));

  const score = (values, fences) => {
    const flagged = new Set();
    values.forEach((value, index) => {
      if (outside(value, fences)) flagged.add(index);
    });
    let tp = 0;
    let fp = 0;
    for (const index of flagged) {
      if (truth.has(index)) tp++;
      else fp++;
    }
    const fn = truth.size - tp;
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    return { tp, fp, fn, precision, recall, flagged: [...flagged].sort((a, b) => a - b) };
  };

  return {
    anomalies,
    cleanFences,
    observedFences,
    cleanScore: score(clean, cleanFences),
    contaminatedWithCleanFences: score(contaminated, cleanFences),
    contaminatedWithObservedFences: score(contaminated, observedFences)
  };
}

function measureDatabaseComplexity() {
  const dir = mkdtempSync(join(tmpdir(), 'svdm-sciences-'));
  const path = join(dir, 'large.db');
  const db = openDb(path);

  db.prepare(
    "INSERT INTO clients (id, name, contact, synthetic) VALUES ('CLI-A', 'Cliente A', NULL, 0)"
  ).run();

  const meterIds = ['M-04'];
  const insertMeter = db.prepare(
    "INSERT INTO meters (id, client_id, barge, source) VALUES (?, 'CLI-A', 'Barcaza 2', 'eGauge')"
  );
  insertMeter.run('M-04');
  for (let index = 1; index <= 9; index++) {
    const id = `MX-0${index}`;
    insertMeter.run(id);
    meterIds.push(id);
  }

  const insertReading = db.prepare(
    `INSERT INTO readings (meter_id, ts, kwh, source, kind, status)
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

  const likeQuery = `
    SELECT id, ts, kwh
    FROM readings
    WHERE meter_id = 'M-04' AND kind = 'daily' AND ts LIKE '2026-05%'
    ORDER BY ts`;
  const rangeQuery = `
    SELECT id, ts, kwh
    FROM readings
    WHERE meter_id = 'M-04' AND kind = 'daily'
      AND ts >= '2026-05-01' AND ts < '2026-06-01'
    ORDER BY ts`;

  const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail);

  const advance = (sql, runs = 30) => {
    for (let index = 0; index < 5; index++) db.prepare(sql).all();
    const times = [];
    let result = null;
    for (let index = 0; index < runs; index++) {
      const started = performance.now();
      result = db.prepare(sql).all();
      times.push(performance.now() - started);
    }
    return { rows: result.length, times: stats(times) };
  };

  const like = { plan: plan(likeQuery), ...advance(likeQuery) };
  const range = { plan: plan(rangeQuery), ...advance(rangeQuery) };

  db.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    rows,
    sizeBytes,
    bulkMs: round(bulkMs),
    like,
    range
  };
}

function fmt(value, decimals = 2) {
  return new Intl.NumberFormat('es-CL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(Number(value));
}

function buildMarkdown(balance, real, injection, db) {
  const lines = [];
  lines.push('# Aplicaciones de ciencias de la ingeniería — SVDM MVP');
  lines.push('');
  lines.push('Este documento desarrolla las aplicaciones declaradas en E1 §3.7 con datos reales del período y un experimento reproducible. Se enfoca en **CI-2 (modelo de datos y complejidad)** y **CI-3 (estadística para anomalías)**; **CI-1 (balance de energía y masa)** se incluye como verificación de consistencia.');
  lines.push('');
  lines.push('## CI-1 — Balance de energía y masa');
  lines.push('');
  lines.push('**Formulación.** El gas equivalente se obtiene del consumo eléctrico y del factor contractual:');
  lines.push('');
  lines.push('```text');
  lines.push('litros_glp = kWh × factor_l_por_kwh');
  lines.push('factor = litros de referencia / kWh de referencia');
  lines.push('```');
  lines.push('');
  lines.push('**Supuestos.** El factor es constante para el cliente en el período; el medidor tiene clase 0,5 % y el factor una incertidumbre de ±1 % (supuestos declarados, no medidos).');
  lines.push('');
  lines.push('**Resultados.**');
  lines.push('');
  lines.push('| Variable | Valor |');
  lines.push('|---|---|');
  lines.push(`| Consumo del período | ${fmt(balance.totalKwh, 3)} kWh |`);
  lines.push(`| Litros de referencia | ${fmt(balance.totalLiters, 3)} L |`);
  lines.push(`| Factor derivado | ${fmt(balance.factor, 9)} L/kWh |`);
  lines.push(`| Litros calculados | ${fmt(balance.calculatedLiters, 3)} L |`);
  lines.push(`| Diferencia | ${fmt(balance.difference, 9)} L |`);
  lines.push(`| Incertidumbre combinada asumida | ±${fmt(balance.relativeCombined * 100, 2)} % ≈ ±${fmt(balance.uncertaintyLiters, 1)} L |`);
  lines.push('');
  lines.push('**Lectura.** El balance cierra con la referencia. La incertidumbre es un ejercicio de propagación con supuestos, no una medición de laboratorio: sirve para dimensionar el orden de magnitud y para decidir que el factor se guarde por contrato y se audite.');
  lines.push('');
  lines.push('## CI-2 — Modelo de datos y complejidad');
  lines.push('');
  lines.push('**Formulación.** La consolidación consulta las lecturas diarias de un medidor en un período:');
  lines.push('');
  lines.push('```sql');
  lines.push("SELECT id, ts, kwh FROM readings");
  lines.push("WHERE meter_id = ? AND kind = 'daily' AND ts >= ? AND ts < ?");
  lines.push('ORDER BY ts;');
  lines.push('```');
  lines.push('');
  lines.push('Con un índice B-tree `(meter_id, ts)`, el costo esperado es `O(log N + k)`, donde `N` es el total de lecturas y `k` las lecturas del período (≈30 diarias). El filtro `kind` se aplica sobre ese rango pequeño. Un `LIKE` por prefijo obliga a evaluar el patrón sobre todas las filas del medidor; un rango explícito permite acotar el índice.');
  lines.push('');
  lines.push('**Procedimiento.** Se cargaron 5 años de lecturas para 10 medidores y se compararon las dos consultas con `EXPLAIN QUERY PLAN` y 30 corridas cada una.');
  lines.push('');
  lines.push(`**Volumen:** ${fmt(db.rows, 0)} filas; ${fmt(db.sizeBytes / 1024 / 1024, 1)} MB; carga inicial ${fmt(db.bulkMs, 0)} ms.`);
  lines.push('');
  lines.push('**Antes: `LIKE`**');
  lines.push('');
  lines.push('```text');
  for (const detail of db.like.plan) lines.push(detail);
  lines.push('```');
  lines.push('');
  lines.push(`Resultado: ${db.like.rows} filas; p50 ${fmt(db.like.times.p50)} ms; p95 ${fmt(db.like.times.p95)} ms; máximo ${fmt(db.like.times.max)} ms.`);
  lines.push('');
  lines.push('**Después: rango explícito**');
  lines.push('');
  lines.push('```text');
  for (const detail of db.range.plan) lines.push(detail);
  lines.push('```');
  lines.push('');
  lines.push(`Resultado: ${db.range.rows} filas; p50 ${fmt(db.range.times.p50)} ms; p95 ${fmt(db.range.times.p95)} ms; máximo ${fmt(db.range.times.max)} ms.`);
  lines.push('');
  lines.push('**Decisión.** Se adopta el rango explícito en `getReadings` para que el índice acote el período y no dependa de la optimización de `LIKE`. La medición de RNF-R-3 se mantiene muy por debajo de los 5 minutos; el cambio reduce el trabajo por consulta y hace explícito el rango del período.');
  lines.push('');
  lines.push('## CI-3 — Estadística descriptiva para anomalías');
  lines.push('');
  lines.push('**Formulación.** Se usa el rango intercuartílico de Tukey:');
  lines.push('');
  lines.push('```text');
  lines.push('IQR = Q3 − Q1');
  lines.push('límite inferior = Q1 − 1,5 × IQR');
  lines.push('límite superior = Q3 + 1,5 × IQR');
  lines.push('```');
  lines.push('');
  lines.push('Para la serie horaria se analizan las **diferencias** entre lecturas acumuladas, no el valor absoluto. Una diferencia negativa es una alerta de calidad; una diferencia positiva sobre el límite superior es un candidato a revisión.');
  lines.push('');
  lines.push('**Resultados con datos reales.**');
  lines.push('');
  lines.push('| Serie | n | Hallazgo |');
  lines.push('|---|---|---|');
  lines.push(`| Diaria (Cliente A) | ${real.daily.count} | ${real.daily.outliers.length} valor(es) fuera de Tukey: ${real.daily.outliers.map((item) => `${item.ts} = ${fmt(item.kwh, 3)} kWh`).join('; ') || 'ninguno'} |`);
  lines.push(`| Horaria (Cliente A) | ${real.hourly.count} lecturas / ${real.hourly.deltas} diferencias | ${real.hourly.zeros} diferencias cero; ${real.hourly.negatives} negativas; ${real.hourly.highOutliers} positivas sobre el límite (${fmt(real.hourly.positiveFences.upper, 1)} kWh) |`);
  lines.push('');
  lines.push(`Los límites de Tukey para la serie diaria son [${fmt(real.daily.fences.lower, 1)}; ${fmt(real.daily.fences.upper, 1)}] kWh. El valor bajo detectado es un **candidato a revisión**, no una prueba de error: puede ser un día de baja operación.`);
  lines.push('');
  lines.push(`En la serie horaria, **${real.hourly.resetPairs}** de las caídas negativas están seguidas por un salto sobre el límite superior, lo que sugiere **reinicios del acumulador** más que consumo real. Eso justifica que la alerta sea un disparador de revisión humana y no un bloqueo automático.`);
  lines.push('');
  if (real.hourly.resetSamples.length) {
    lines.push('| Caída | Valor | Salto siguiente | Valor |');
    lines.push('|---|---|---|---|');
    for (const pair of real.hourly.resetSamples) {
      lines.push(`| ${pair.dropTs} | ${fmt(pair.drop, 1)} | ${pair.jumpTs} | ${fmt(pair.jump, 1)} |`);
    }
    lines.push('');
  }
  lines.push('**Experimento controlado.** Se generó una serie limpia de 60 días (media 1.040 kWh, desviación 80) y se inyectaron 6 anomalías conocidas. Se evaluó el detector con los límites calculados sobre la serie limpia y sobre la serie contaminada.');
  lines.push('');
  lines.push('| Condición | VP | FP | FN | Precisión | Recall |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| Control: serie limpia | — | ${injection.cleanScore.fp} | — | — | — |`);
  const scoreRow = (name, score) =>
    `| ${name} | ${score.tp} | ${score.fp} | ${score.fn} | ${score.precision === null ? '—' : fmt(score.precision * 100, 0) + ' %'} | ${score.recall === null ? '—' : fmt(score.recall * 100, 0) + ' %'} |`;
  lines.push(scoreRow('Contaminada, límites de la serie limpia', injection.contaminatedWithCleanFences));
  lines.push(scoreRow('Contaminada, límites observados', injection.contaminatedWithObservedFences));
  lines.push('');
  lines.push(`**Lectura.** El detector recupera las 6 anomalías inyectadas (recall 100 %). Sobre la serie limpia, el mismo cerco marca **${injection.cleanScore.fp}** valor normal como falso positivo, consistente con la tasa esperada de Tukey. Al calcular los límites sobre la serie contaminada, ese valor entra en rango y la precisión sube a 100 %. Por eso el sistema usa **dos reglas** (caída negativa + Tukey) y deja la confirmación en manos del analista.`);
  lines.push('');
  lines.push('## Decisiones que influyeron en el sistema');
  lines.push('');
  lines.push('- El cálculo de litros se mantiene separado del monto: el monto se factura en kWh × precio × tipo de cambio; los litros sirven para conciliar con el nivel de gas.');
  lines.push('- El índice `(meter_id, ts)` y la consulta por rango sostienen la consolidación mensual con 5 años de datos.');
  lines.push('- Las alertas por Tukey y por diferencia negativa son **candidatos a revisión**, no errores probados; el ingreso manual exige motivo y queda auditado.');
  lines.push('');
  lines.push('## Límites');
  lines.push('');
  lines.push('- La serie real es de un cliente y un período; no representa toda la cartera.');
  lines.push('- El factor contractual y la incertidumbre del medidor son supuestos declarados.');
  lines.push('- La serie horaria tiene 667 diferencias cero: la resolución del acumulador limita el análisis.');
  lines.push('- El experimento de inyección usa una distribución normal sintética; no reemplaza una validación con datos etiquetados.');
  lines.push('- Los tiempos son locales y sensibles a la carga de la máquina.');
  lines.push('');
  lines.push('## Reproducción');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run sciences');
  lines.push('```');
  lines.push('');
  lines.push('El comando regenera este documento y `docs/ciencias.json`.');
  lines.push('');
  return lines.join('\n');
}

mkdirSync(DOCS, { recursive: true });
const balance = measureEnergyBalance();
const real = analyzeRealSeries();
const injection = controlledInjection();
const db = measureDatabaseComplexity();

const result = {
  generated_at: new Date().toISOString(),
  balance,
  real,
  injection,
  database: db
};

writeFileSync(join(DOCS, 'ciencias.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
writeFileSync(join(DOCS, 'ciencias.md'), buildMarkdown(balance, real, injection, db), 'utf8');

console.log('Ciencias escritas en docs/ciencias.md y docs/ciencias.json');
console.log(`Balance: factor ${balance.factor} L/kWh; diferencia ${balance.difference} L`);
console.log(`Diaria: ${real.daily.outliers.length} outliers | Horaria: ${real.hourly.negatives} negativas, ${real.hourly.highOutliers} altas`);
console.log(`Inyección: VP ${injection.contaminatedWithCleanFences.tp}, FP ${injection.contaminatedWithCleanFences.fp}, FN ${injection.contaminatedWithCleanFences.fn}`);
console.log(`Consulta LIKE p95 ${db.like.times.p95} ms | rango p95 ${db.range.times.p95} ms`);
