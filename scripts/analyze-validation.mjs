import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = join(ROOT, 'docs', 'validacion', 'registro.csv');
const OUTPUT = join(ROOT, 'docs', 'validacion', 'resultados.md');
const MIN_PARTICIPANTS = 5;
const MIN_SUCCESS = 4;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isYes(value) {
  return ['si', 'sí', 'true', '1'].includes(normalize(value));
}

function isNo(value) {
  return ['no', 'false', '0'].includes(normalize(value));
}

function number(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const parsed = Number(text.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function fmt(value, decimals = 1) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CL', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      }).format(value)
    : '—';
}

function markdownCell(value) {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';
}

function readRecords() {
  const raw = readFileSync(INPUT, 'utf8');
  const [header, ...rows] = parseCsv(raw);
  const columns = header.map((name) => name.trim());
  return rows
    .map((cells) => Object.fromEntries(columns.map((name, index) => [name, cells[index] ?? ''])))
    .filter((record) => record.participante && record.participante.trim() !== '');
}

function analyze(records) {
  const complete = records.filter((record) => {
    const time = number(record.t1_tiempo_s);
    const help = number(record.t1_ayuda);
    return (
      (isYes(record.t1_exito) || isNo(record.t1_exito)) &&
      Number.isFinite(time) &&
      time > 0 &&
      Number.isFinite(help) &&
      [0, 1, 2].includes(help)
    );
  });

  const successful = complete.filter((record) => isYes(record.t1_exito));
  const withoutHelp = successful.filter((record) => number(record.t1_ayuda) === 0);
  const times = complete.map((record) => number(record.t1_tiempo_s)).filter(Number.isFinite);
  const errors = complete.map((record) => number(record.t1_errores)).filter(Number.isFinite);
  const ease = complete.map((record) => number(record.facilidad_1_7)).filter((value) => value >= 1 && value <= 7);
  const confidence = complete.map((record) => number(record.confianza_1_7)).filter((value) => value >= 1 && value <= 7);

  const helpCounts = { 0: 0, 1: 0, 2: 0 };
  for (const record of complete) {
    const help = number(record.t1_ayuda);
    if (help in helpCounts) helpCounts[help]++;
  }

  const t2Success = complete.filter((record) => isYes(record.t2_exito)).length;
  const t3Success = complete.filter((record) => isYes(record.t3_exito)).length;

  const total = complete.length;
  const rate = total ? (withoutHelp.length / total) * 100 : 0;

  let verdict = 'Pendiente';
  if (total >= MIN_PARTICIPANTS && withoutHelp.length >= MIN_SUCCESS) verdict = 'Cumple';
  if (total >= MIN_PARTICIPANTS && withoutHelp.length < MIN_SUCCESS) verdict = 'No cumple';

  return {
    total,
    successful: successful.length,
    withoutHelp: withoutHelp.length,
    rate,
    verdict,
    times: {
      median: percentile(times, 0.5),
      q1: percentile(times, 0.25),
      q3: percentile(times, 0.75),
      min: times.length ? Math.min(...times) : null,
      max: times.length ? Math.max(...times) : null
    },
    errors: {
      total: errors.reduce((sum, value) => sum + value, 0),
      mean: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null
    },
    helpCounts,
    t2Success,
    t3Success,
    easeMedian: percentile(ease, 0.5),
    confidenceMedian: percentile(confidence, 0.5),
    comments: complete
      .filter((record) => String(record.comentarios ?? '').trim() !== '')
      .map((record) => ({ participant: record.participante, text: record.comentarios.trim() }))
  };
}

function buildReport(records, result) {
  const lines = [];
  lines.push('# Resultados de validación con usuarios — SVDM MVP');
  lines.push('');
  lines.push('Generado por `npm run validate:analyze` a partir de `docs/validacion/registro.csv`.');
  lines.push('');
  lines.push('## Estado');
  lines.push('');
  if (result.verdict === 'Pendiente') {
    lines.push(
      `**Pendiente.** Hay **${result.total}/${MIN_PARTICIPANTS}** registros completos. ` +
        'Completa `registro.csv` con las sesiones y vuelve a ejecutar el análisis.'
    );
  } else if (result.verdict === 'Cumple') {
    lines.push(
      `**Cumple RNF-U-2.** **${result.withoutHelp}/${result.total}** participantes completaron la tarea principal sin ayuda ` +
        `(${fmt(result.rate, 0)} %; umbral: ${MIN_SUCCESS}/${MIN_PARTICIPANTS}).`
    );
  } else {
    lines.push(
      `**No cumple RNF-U-2.** **${result.withoutHelp}/${result.total}** participantes completaron la tarea principal sin ayuda ` +
        `(${fmt(result.rate, 0)} %; umbral: ${MIN_SUCCESS}/${MIN_PARTICIPANTS}).`
    );
  }
  lines.push('');
  lines.push('## Registro por participante');
  lines.push('');
  lines.push('| Participante | Perfil | T1 | Tiempo | Ayuda | Errores | T2 | T3 | Facilidad | Confianza |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const record of records) {
    const time = number(record.t1_tiempo_s);
    const help = number(record.t1_ayuda);
    lines.push(
      `| ${markdownCell(record.participante)} | ${markdownCell(record.perfil)} | ` +
        `${isYes(record.t1_exito) ? 'Sí' : isNo(record.t1_exito) ? 'No' : '—'} | ` +
        `${Number.isFinite(time) ? fmt(time, 0) + ' s' : '—'} | ` +
        `${Number.isFinite(help) ? help : '—'} | ` +
        `${markdownCell(record.t1_errores)} | ` +
        `${isYes(record.t2_exito) ? 'Sí' : isNo(record.t2_exito) ? 'No' : '—'} | ` +
        `${isYes(record.t3_exito) ? 'Sí' : isNo(record.t3_exito) ? 'No' : '—'} | ` +
        `${markdownCell(record.facilidad_1_7)} | ${markdownCell(record.confianza_1_7)} |`
    );
  }
  lines.push('');
  lines.push('## Agregados');
  lines.push('');
  lines.push('| Métrica | Valor |');
  lines.push('|---|---|');
  lines.push(`| Participantes con registro completo | ${result.total}/${MIN_PARTICIPANTS} |`);
  lines.push(`| T1 completada (con o sin ayuda) | ${result.successful}/${result.total} |`);
  lines.push(`| T1 sin ayuda | **${result.withoutHelp}/${result.total}** (${fmt(result.rate, 0)} %) |`);
  lines.push(
    `| Tiempo T1 | mediana ${fmt(result.times.median, 0)} s; RIC ${fmt(result.times.q1, 0)}–${fmt(result.times.q3, 0)} s; rango ${fmt(result.times.min, 0)}–${fmt(result.times.max, 0)} s |`
  );
  lines.push(
    `| Nivel de ayuda | 0: ${result.helpCounts[0]} · 1: ${result.helpCounts[1]} · 2: ${result.helpCounts[2]} |`
  );
  lines.push(
    `| Errores T1 | total ${result.errors.total}; media ${fmt(result.errors.mean)} por participante |`
  );
  lines.push(`| T2 auditoría | ${result.t2Success}/${result.total} |`);
  lines.push(`| T3 trazabilidad | ${result.t3Success}/${result.total} |`);
  lines.push(`| Facilidad percibida | mediana ${fmt(result.easeMedian)} / 7 |`);
  lines.push(`| Confianza en el resultado | mediana ${fmt(result.confidenceMedian)} / 7 |`);
  lines.push('');
  lines.push('## Comentarios');
  lines.push('');
  if (result.comments.length) {
    for (const comment of result.comments) {
      lines.push(`- **${comment.participant}:** ${comment.text}`);
    }
    lines.push('');
    lines.push('> Revisar que los comentarios no contengan datos personales antes de publicarlos.');
  } else {
    lines.push('Sin comentarios registrados.');
  }
  lines.push('');
  lines.push('## Lectura');
  lines.push('');
  if (result.verdict === 'Pendiente') {
    lines.push('Todavía no hay evidencia suficiente para pronunciarse sobre RNF-U-2.');
  } else {
    lines.push(
      `La tarea principal se completó sin ayuda en **${result.withoutHelp} de ${result.total}** casos. ` +
        `La mediana de tiempo fue **${fmt(result.times.median, 0)} s** y se registraron **${result.errors.total}** errores en total.`
    );
    lines.push('');
    lines.push(
      result.verdict === 'Cumple'
        ? 'Con este resultado se cumple el umbral de 80 % definido en E1 para RNF-U-2, con las limitaciones del estudio.'
        : 'Con este resultado no se cumple el umbral de 80 %. Corresponde identificar las fricciones, corregir la interfaz y repetir la medición.'
    );
  }
  lines.push('');
  lines.push('## Límites del estudio');
  lines.push('');
  lines.push('- Muestra pequeña y por conveniencia (5 participantes); no permite generalizar.');
  lines.push('- Prototipo local con datos simulados, sin integraciones reales.');
  lines.push('- Cambio de rol dentro de la misma sesión; en producción serían personas distintas.');
  lines.push('- Una sesión por participante y posible efecto de aprendizaje.');
  lines.push('- El moderador puede influir; por eso se registra el nivel de ayuda.');
  lines.push('');
  return lines.join('\n');
}

const records = readRecords();
const result = analyze(records);
writeFileSync(OUTPUT, buildReport(records, result), 'utf8');
console.log(`Resultados escritos en ${OUTPUT}`);
console.log(
  `Completos: ${result.total}/${MIN_PARTICIPANTS} | Sin ayuda: ${result.withoutHelp}/${result.total} | Veredicto: ${result.verdict}`
);
