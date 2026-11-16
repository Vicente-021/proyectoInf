import test from 'node:test';
import assert from 'node:assert/strict';
import { round, amountClp, litersFromKwh, consolidate } from '../src/calc.js';

const contract = {
  factor_l_per_kwh: 1.1,
  price_usd_per_kwh: 0.5,
  exchange_rate: 900
};

test('round redondea a 2 decimales sin arrastrar error de punto flotante', () => {
  assert.equal(round(0.999999, 2), 1);
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(21004949.135590836, 2), 21004949.14);
});

test('amountClp aplica kWh x USD/kWh x tipo de cambio', () => {
  assert.equal(
    amountClp({ kwh: 1000, priceUsdPerKwh: 0.5, exchangeRate: 900 }),
    450000
  );
});

test('litersFromKwh aplica el factor contractual', () => {
  assert.equal(litersFromKwh({ kwh: 1000, factorLPerKwh: 1.1 }), 1100);
});

test('consolidate calcula líneas y totales', () => {
  const result = consolidate({
    readings: [
      { id: 1, ts: '2026-05-01', kwh: 1000 },
      { id: 2, ts: '2026-05-02', kwh: 500 }
    ],
    contract,
    price: { usd_per_kwh: 0.5, exchange_rate: 900 }
  });

  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].amount_clp, 450000);
  assert.equal(result.lines[1].amount_clp, 225000);
  assert.equal(result.lines[0].liters, 1100);
  assert.equal(result.totalKwh, 1500);
  assert.equal(result.totalLiters, 1650);
  assert.equal(result.totalClp, 675000);
});

test('consolidate usa el precio del contrato si no recibe precio del período', () => {
  const result = consolidate({
    readings: [{ id: 1, ts: '2026-05-01', kwh: 1000 }],
    contract
  });

  assert.equal(result.totalClp, 450000);
  assert.equal(result.lines[0].price_usd_per_kwh, 0.5);
});

test('consolidate redondea cada línea y suma los montos redondeados', () => {
  const result = consolidate({
    readings: [{ id: 1, ts: '2026-05-01', kwh: 1 }],
    contract: { ...contract, price_usd_per_kwh: 0.333333, exchange_rate: 3 }
  });

  assert.equal(result.lines[0].amount_clp, 1);
  assert.equal(result.totalClp, 1);
});

test('consolidate rechaza un arreglo vacío', () => {
  assert.throws(() => consolidate({ readings: [], contract }), RangeError);
});

test('consolidate rechaza kWh negativo', () => {
  assert.throws(
    () =>
      consolidate({
        readings: [{ id: 1, ts: '2026-05-01', kwh: -1 }],
        contract
      }),
    RangeError
  );
});

test('consolidate rechaza precio o tipo de cambio no positivos', () => {
  assert.throws(
    () =>
      consolidate({
        readings: [{ id: 1, ts: '2026-05-01', kwh: 1 }],
        contract: { ...contract, exchange_rate: 0 }
      }),
    RangeError
  );
  assert.throws(
    () =>
      consolidate({
        readings: [{ id: 1, ts: '2026-05-01', kwh: 1 }],
        contract: { ...contract, factor_l_per_kwh: 0 }
      }),
    RangeError
  );
});
