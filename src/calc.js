/**
 * Cálculo de negocio del SVDM.
 *
 * Fórmulas (E1 §7):
 *  - Monto de una lectura: kWh x precio USD/kWh x tipo de cambio.
 *  - Gas equivalente: kWh x factor contractual (litros por kWh).
 *
 * Las funciones son puras para poder probarlas sin base de datos.
 */

/** Redondea a una cantidad de decimales, evitando errores de punto flotante. */
export function round(value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('round: el valor debe ser un número finito');
  }
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function positive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} debe ser un número mayor que 0`);
  }
  return value;
}

/** Monto en CLP de una lectura, sin redondear. */
export function amountClp({ kwh, priceUsdPerKwh, exchangeRate }) {
  if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh < 0) {
    throw new RangeError('kwh debe ser un número mayor o igual que 0');
  }
  positive(priceUsdPerKwh, 'priceUsdPerKwh');
  positive(exchangeRate, 'exchangeRate');
  return kwh * priceUsdPerKwh * exchangeRate;
}

/** Litros de GLP equivalentes a una cantidad de kWh. */
export function litersFromKwh({ kwh, factorLPerKwh }) {
  if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh < 0) {
    throw new RangeError('kwh debe ser un número mayor o igual que 0');
  }
  positive(factorLPerKwh, 'factorLPerKwh');
  return kwh * factorLPerKwh;
}

/**
 * Consolida un conjunto de lecturas diarias.
 *
 * @param {object} params
 * @param {Array<{id?: number, ts: string, kwh: number}>} params.readings
 * @param {{factor_l_per_kwh: number, price_usd_per_kwh: number, exchange_rate: number}} params.contract
 * @param {{usd_per_kwh?: number, exchange_rate?: number}} [params.price]
 * @returns {{lines: Array<object>, totalKwh: number, totalLiters: number, totalClp: number}}
 */
export function consolidate({ readings, contract, price }) {
  if (!Array.isArray(readings) || readings.length === 0) {
    throw new RangeError('readings debe ser un arreglo con al menos una lectura');
  }
  if (!contract) {
    throw new TypeError('contract es obligatorio');
  }

  const priceUsdPerKwh = price?.usd_per_kwh ?? contract.price_usd_per_kwh;
  const exchangeRate = price?.exchange_rate ?? contract.exchange_rate;
  positive(priceUsdPerKwh, 'price.usd_per_kwh');
  positive(exchangeRate, 'price.exchange_rate');
  positive(contract.factor_l_per_kwh, 'contract.factor_l_per_kwh');

  const lines = readings.map((reading) => {
    if (!reading || typeof reading.ts !== 'string' || reading.ts.length === 0) {
      throw new TypeError('cada lectura debe tener ts');
    }
    const amount = amountClp({
      kwh: reading.kwh,
      priceUsdPerKwh,
      exchangeRate
    });
    const liters = litersFromKwh({
      kwh: reading.kwh,
      factorLPerKwh: contract.factor_l_per_kwh
    });

    return {
      reading_id: reading.id ?? null,
      ts: reading.ts,
      kwh: reading.kwh,
      price_usd_per_kwh: priceUsdPerKwh,
      exchange_rate: exchangeRate,
      factor_l_per_kwh: contract.factor_l_per_kwh,
      amount_clp: round(amount, 2),
      liters: round(liters, 6),
      source: reading.source ?? null,
      status: reading.status ?? null
    };
  });

  const totalKwh = lines.reduce((sum, line) => sum + line.kwh, 0);
  const totalLiters = lines.reduce((sum, line) => sum + line.liters, 0);
  const totalClp = lines.reduce((sum, line) => sum + line.amount_clp, 0);

  return {
    lines,
    totalKwh: round(totalKwh, 9),
    totalLiters: round(totalLiters, 6),
    totalClp: round(totalClp, 2)
  };
}
