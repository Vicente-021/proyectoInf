import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openDb, DEFAULT_DB_PATH } from './db.js';

const SEED_URL = new URL('../data/seed.json', import.meta.url);

/**
 * Carga el seed en la base. Es idempotente: limpia las tablas y vuelve a insertar.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} data Contenido de seed.json
 */
export function seedDatabase(db, data) {
  const contract = data.contracts[0];
  const meter = data.meters[0];
  const price = data.prices[0];

  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  const insertClient = db.prepare(
    'INSERT INTO clients (id, name, contact) VALUES (?, ?, ?)'
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

  const demoHash = createHash('sha256').update('demo').digest('hex');

  db.exec('BEGIN');
  try {
    db.exec(`
      DELETE FROM consolidation_lines;
      DELETE FROM consolidations;
      DELETE FROM alerts;
      DELETE FROM audit_events;
      DELETE FROM readings;
      DELETE FROM prices;
      DELETE FROM contracts;
      DELETE FROM meters;
      DELETE FROM clients;
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
      insertClient.run(client.id, client.name, client.contact ?? null);
    }

    insertMeter.run(meter.id, meter.client_id, meter.barge ?? null, meter.source);

    insertContract.run(
      contract.id,
      contract.client_id,
      contract.factor_l_per_kwh,
      contract.price_usd_per_kwh,
      contract.exchange_rate,
      contract.valid_from,
      contract.valid_to ?? null
    );

    insertPrice.run(price.date, price.usd_per_kwh, price.exchange_rate, price.source);

    // Lecturas diarias: el valor es consumo del día (kWh).
    for (const reading of data.daily_readings) {
      insertReading.run(meter.id, reading.ts, reading.kwh, 'eGauge', 'daily', 'ok', null);
    }

    // Lecturas horarias: el valor es el acumulado del medidor (kWh).
    for (const reading of data.hourly_readings) {
      insertReading.run(
        meter.id,
        reading.ts,
        reading.cum_kwh,
        'eGauge',
        'hourly',
        'ok',
        'acumulado'
      );
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
      `Carga inicial desde ${data.meta.source} (período ${data.meta.period})`
    );

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    clients: data.clients.length,
    meters: 1,
    contracts: data.contracts.length,
    dailyReadings: data.daily_readings.length,
    hourlyReadings: data.hourly_readings.length
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const data = JSON.parse(readFileSync(SEED_URL, 'utf8'));
  const db = openDb();
  const result = seedDatabase(db, data);
  const total = db
    .prepare("SELECT ROUND(SUM(kwh), 9) AS total FROM readings WHERE kind = 'daily'")
    .get();
  console.log(`Base: ${DEFAULT_DB_PATH}`);
  console.log(
    `Cargado: ${result.clients} cliente(s), ${result.dailyReadings} lecturas diarias, ` +
      `${result.hourlyReadings} horarias`
  );
  console.log(`Total diario en base: ${total.total} kWh`);
  console.log(`Referencia de la planilla: ${data.reference.total_kwh} kWh`);
  db.close();
}
