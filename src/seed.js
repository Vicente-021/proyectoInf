import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openDb, DEFAULT_DB_PATH } from './db.js';

const SEED_URL = new URL('../data/seed.json', import.meta.url);

function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/**
 * Carga el seed en la base. Es idempotente: limpia las tablas y vuelve a insertar.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} data Contenido de seed.json
 */
export function seedDatabase(db, data) {
  const price = data.prices[0];

  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  const insertClient = db.prepare(
    'INSERT INTO clients (id, name, contact, synthetic) VALUES (?, ?, ?, ?)'
  );
  const insertMeter = db.prepare(
    'INSERT INTO meters (id, client_id, barge, source) VALUES (?, ?, ?, ?)'
  );
  const insertContract = db.prepare(`
    INSERT INTO contracts
      (id, client_id, factor_l_per_kwh, price_usd_per_kwh, exchange_rate, valid_from, valid_to)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPrice = db.prepare(`
    INSERT INTO prices (date, usd_per_kwh, exchange_rate, source)
    VALUES (?, ?, ?, ?)
  `);
  const insertReading = db.prepare(`
    INSERT INTO readings (meter_id, ts, kwh, source, kind, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUser = db.prepare(
    'INSERT INTO users (id, name, role, password_hash) VALUES (?, ?, ?, ?)'
  );
  const insertAudit = db.prepare(`
    INSERT INTO audit_events (actor, role, action, entity, entity_id, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAlert = db.prepare(`
    INSERT INTO alerts (client_id, meter_id, type, severity, message, ref_ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAlertItem = db.prepare(`
    INSERT INTO alert_items
      (alert_id, meter_id, ts, kind, previous_value, value, delta,
       next_ts, next_value, next_delta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const demoHash = createHash('sha256').update('demo').digest('hex');

  db.exec('BEGIN');
  try {
    db.exec(`
      DELETE FROM consolidation_lines;
      DELETE FROM consolidations;
      DELETE FROM alert_items;
      DELETE FROM alerts;
      DELETE FROM audit_events;
      DELETE FROM readings;
      DELETE FROM prices;
      DELETE FROM contracts;
      DELETE FROM meters;
      DELETE FROM clients;
      DELETE FROM sessions;
      DELETE FROM users;
      DELETE FROM meta;
    `);

    for (const [key, value] of Object.entries({
      source: data.meta.source,
      period: data.meta.period,
      invoice_month: data.meta.invoice_month,
      generated_at: data.meta.generated_at,
      reference_total_kwh: data.reference.total_kwh,
      reference_total_clp: data.reference.total_clp,
      reference_total_liters: data.reference.total_liters
    })) {
      insertMeta.run(key, String(value));
    }

    for (const client of data.clients) {
      insertClient.run(client.id, client.name, client.contact ?? null, client.synthetic ? 1 : 0);
    }

    for (const meter of data.meters) {
      insertMeter.run(meter.id, meter.client_id, meter.barge ?? null, meter.source);
    }

    for (const contract of data.contracts) {
      insertContract.run(
        contract.id,
        contract.client_id,
        contract.factor_l_per_kwh,
        contract.price_usd_per_kwh,
        contract.exchange_rate,
        contract.valid_from,
        contract.valid_to ?? null
      );
    }

    insertPrice.run(price.date, price.usd_per_kwh, price.exchange_rate, price.source);

    // Lecturas diarias: el valor es consumo del día (kWh).
    for (const reading of data.daily_readings) {
      insertReading.run(
        reading.meter_id,
        reading.ts,
        reading.kwh,
        'eGauge',
        'daily',
        'ok',
        null
      );
    }

    // Lecturas horarias: el valor es el acumulado del medidor (kWh).
    for (const reading of data.hourly_readings) {
      insertReading.run(
        reading.meter_id,
        reading.ts,
        reading.cum_kwh,
        'eGauge',
        'hourly',
        'ok',
        'acumulado'
      );
    }

    // Alertas derivadas de los datos.
    const referenceMeter = data.meters[0].id;
    const expectedDates = [
      ...new Set(
        data.daily_readings
          .filter((reading) => reading.meter_id === referenceMeter)
          .map((reading) => reading.ts)
      )
    ].sort();

    const datesByMeter = new Map();
    for (const reading of data.daily_readings) {
      if (!datesByMeter.has(reading.meter_id)) {
        datesByMeter.set(reading.meter_id, new Set());
      }
      datesByMeter.get(reading.meter_id).add(reading.ts);
    }

    for (const meter of data.meters) {
      const present = datesByMeter.get(meter.id) ?? new Set();
      for (const ts of expectedDates) {
        if (!present.has(ts)) {
          const info = insertAlert.run(
            meter.client_id,
            meter.id,
            'missing_reading',
            'critical',
            `Falta la lectura del medidor ${meter.id} para ${ts}.`,
            ts
          );
          insertAlertItem.run(
            Number(info.lastInsertRowid),
            meter.id,
            ts,
            'missing',
            null,
            null,
            null,
            null,
            null,
            null
          );
        }
      }
    }

    // Consistencia de la serie horaria: caídas y saltos sobre el umbral.
    const hourly = data.hourly_readings
      .filter((reading) => reading.meter_id === referenceMeter)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const deltas = [];
    for (let index = 1; index < hourly.length; index++) {
      deltas.push({
        current: hourly[index],
        previous: hourly[index - 1],
        next: hourly[index + 1] ?? null,
        delta: hourly[index].cum_kwh - hourly[index - 1].cum_kwh
      });
    }
    const positiveDeltas = deltas.filter((item) => item.delta > 0).map((item) => item.delta);
    const q1 = quantile(positiveDeltas, 0.25);
    const q3 = quantile(positiveDeltas, 0.75);
    const upper = q1 === null ? null : q3 + 1.5 * (q3 - q1);
    const drops = deltas.filter((item) => item.delta < 0);
    const jumps = upper === null ? [] : deltas.filter((item) => item.delta > upper);

    if (drops.length || jumps.length) {
      const info = insertAlert.run(
        data.meters[0].client_id,
        referenceMeter,
        'hourly_consistency',
        'warning',
        `Se detectaron ${drops.length} caídas del acumulado y ${jumps.length} saltos sobre el umbral` +
          (upper === null ? '.' : ` (${upper.toFixed(1)} kWh).`),
        null
      );
      const alertId = Number(info.lastInsertRowid);
      for (const item of drops) {
        insertAlertItem.run(
          alertId,
          referenceMeter,
          item.current.ts,
          'negative_drop',
          item.previous.cum_kwh,
          item.current.cum_kwh,
          item.delta,
          item.next?.ts ?? null,
          item.next?.cum_kwh ?? null,
          item.next ? item.next.cum_kwh - item.current.cum_kwh : null
        );
      }
      for (const item of jumps) {
        insertAlertItem.run(
          alertId,
          referenceMeter,
          item.current.ts,
          'high_jump',
          item.previous.cum_kwh,
          item.current.cum_kwh,
          item.delta,
          item.next?.ts ?? null,
          item.next?.cum_kwh ?? null,
          item.next ? item.next.cum_kwh - item.current.cum_kwh : null
        );
      }
    }

    // Usuarios de demostración (contraseña: demo). No usar en producción.
    insertUser.run('u-analista', 'Analista Marine', 'analista', demoHash);
    insertUser.run('u-aprobador', 'Jefe Comercial Marine', 'aprobador', demoHash);

    insertAudit.run(
      'system',
      'system',
      'seed',
      'database',
      null,
      `Carga inicial de la planilla anonimizada (período ${data.meta.period})`
    );

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    clients: data.clients.length,
    meters: data.meters.length,
    contracts: data.contracts.length,
    dailyReadings: data.daily_readings.length,
    hourlyReadings: data.hourly_readings.length,
    alerts: db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n,
    alertItems: db.prepare('SELECT COUNT(*) AS n FROM alert_items').get().n
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const data = JSON.parse(readFileSync(SEED_URL, 'utf8'));
  const db = openDb();
  const result = seedDatabase(db, data);
  const total = db
    .prepare(
      "SELECT ROUND(SUM(kwh), 9) AS total FROM readings WHERE kind = 'daily' AND meter_id = 'M-04'"
    )
    .get();
  console.log(`Base: ${DEFAULT_DB_PATH}`);
  console.log(
    `Cargado: ${result.clients} clientes, ${result.dailyReadings} lecturas diarias, ` +
      `${result.hourlyReadings} horarias, ${result.alerts} alertas, ${result.alertItems} ítems de alerta`
  );
  console.log(`Total diario en base: ${total.total} kWh`);
  console.log(`Referencia de la planilla: ${data.reference.total_kwh} kWh`);
  db.close();
}
