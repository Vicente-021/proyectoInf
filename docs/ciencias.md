# Aplicaciones de ciencias de la ingeniería — SVDM MVP

Este documento desarrolla las aplicaciones declaradas en E1 §3.7 con datos reales del período y un experimento reproducible. Se enfoca en **CI-2 (modelo de datos y complejidad)** y **CI-3 (estadística para anomalías)**; **CI-1 (balance de energía y masa)** se incluye como verificación de consistencia.

## CI-1 — Balance de energía y masa

**Formulación.** El gas equivalente se obtiene del consumo eléctrico y del factor contractual:

```text
litros_glp = kWh × factor_l_por_kwh
factor = litros de referencia / kWh de referencia
```

**Supuestos.** El factor es constante para el cliente en el período; el medidor tiene clase 0,5 % y el factor una incertidumbre de ±1 % (supuestos declarados, no medidos).

**Resultados.**

| Variable | Valor |
|---|---|
| Consumo del período | 30.811,228 kWh |
| Litros de referencia | 34.079,600 L |
| Factor derivado | 1,106077321 L/kWh |
| Litros calculados | 34.079,600 L |
| Diferencia | 0,000000000 L |
| Incertidumbre combinada asumida | ±1,12 % ≈ ±381,0 L |

**Lectura.** El balance cierra con la referencia. La incertidumbre es un ejercicio de propagación con supuestos, no una medición de laboratorio: sirve para dimensionar el orden de magnitud y para decidir que el factor se guarde por contrato y se audite.

## CI-2 — Modelo de datos y complejidad

**Formulación.** La consolidación consulta las lecturas diarias de un medidor en un período:

```sql
SELECT id, ts, kwh FROM readings
WHERE meter_id = ? AND kind = 'daily' AND ts >= ? AND ts < ?
ORDER BY ts;
```

Con un índice B-tree `(meter_id, ts)`, el costo esperado es `O(log N + k)`, donde `N` es el total de lecturas y `k` las lecturas del período (≈30 diarias). El filtro `kind` se aplica sobre ese rango pequeño. Un `LIKE` por prefijo obliga a evaluar el patrón sobre todas las filas del medidor; un rango explícito permite acotar el índice.

**Procedimiento.** Se cargaron 5 años de lecturas para 10 medidores y se compararon las dos consultas con `EXPLAIN QUERY PLAN` y 30 corridas cada una.

**Volumen:** 450.000 filas; 71,0 MB; carga inicial 3.579 ms.

**Antes: `LIKE`**

```text
SEARCH readings USING INDEX idx_readings_meter_ts (meter_id=?)
```

Resultado: 30 filas; p50 4,03 ms; p95 4,21 ms; máximo 4,26 ms.

**Después: rango explícito**

```text
SEARCH readings USING INDEX idx_readings_meter_ts (meter_id=? AND ts>? AND ts<?)
```

Resultado: 30 filas; p50 0,13 ms; p95 0,20 ms; máximo 0,27 ms.

**Decisión.** Se adopta el rango explícito en `getReadings` para que el índice acote el período y no dependa de la optimización de `LIKE`. La medición de RNF-R-3 se mantiene muy por debajo de los 5 minutos; el cambio reduce el trabajo por consulta y hace explícito el rango del período.

## CI-3 — Estadística descriptiva para anomalías

**Formulación.** Se usa el rango intercuartílico de Tukey:

```text
IQR = Q3 − Q1
límite inferior = Q1 − 1,5 × IQR
límite superior = Q3 + 1,5 × IQR
```

Para la serie horaria se analizan las **diferencias** entre lecturas acumuladas, no el valor absoluto. Una diferencia negativa es una alerta de calidad; una diferencia positiva sobre el límite superior es un candidato a revisión.

**Resultados con datos reales.**

| Serie | n | Hallazgo |
|---|---|---|
| Diaria (Cliente A) | 30 | 1 valor(es) fuera de Tukey: 2026-05-02 = 479,122 kWh |
| Horaria (Cliente A) | 751 lecturas / 750 diferencias | 667 diferencias cero; 12 negativas; 13 positivas sobre el límite (78,4 kWh) |

Los límites de Tukey para la serie diaria son [856,5; 1.224,1] kWh. El valor bajo detectado es un **candidato a revisión**, no una prueba de error: puede ser un día de baja operación.

En la serie horaria, **11** de las caídas negativas están seguidas por un salto sobre el límite superior, lo que sugiere **reinicios del acumulador** más que consumo real. Eso justifica que la alerta sea un disparador de revisión humana y no un bloqueo automático.

| Caída | Valor | Salto siguiente | Valor |
|---|---|---|---|
| 2026-06-02 17:00 | -341,5 | 2026-06-02 18:00 | 341,5 |
| 2026-06-04 09:00 | -343,1 | 2026-06-04 10:00 | 343,1 |
| 2026-06-05 21:00 | -346,4 | 2026-06-05 22:00 | 346,4 |
| 2026-06-08 11:00 | -346,9 | 2026-06-08 12:00 | 346,9 |

**Experimento controlado.** Se generó una serie limpia de 60 días (media 1.040 kWh, desviación 80) y se inyectaron 6 anomalías conocidas. Se evaluó el detector con los límites calculados sobre la serie limpia y sobre la serie contaminada.

| Condición | VP | FP | FN | Precisión | Recall |
|---|---|---|---|---|---|
| Control: serie limpia | — | 1 | — | — | — |
| Contaminada, límites de la serie limpia | 6 | 1 | 0 | 86 % | 100 % |
| Contaminada, límites observados | 6 | 0 | 0 | 100 % | 100 % |

**Lectura.** El detector recupera las 6 anomalías inyectadas (recall 100 %). Sobre la serie limpia, el mismo cerco marca **1** valor normal como falso positivo, consistente con la tasa esperada de Tukey. Al calcular los límites sobre la serie contaminada, ese valor entra en rango y la precisión sube a 100 %. Por eso el sistema usa **dos reglas** (caída negativa + Tukey) y deja la confirmación en manos del analista.

## Decisiones que influyeron en el sistema

- El cálculo de litros se mantiene separado del monto: el monto se factura en kWh × precio × tipo de cambio; los litros sirven para conciliar con el nivel de gas.
- El índice `(meter_id, ts)` y la consulta por rango sostienen la consolidación mensual con 5 años de datos.
- Las alertas por Tukey y por diferencia negativa son **candidatos a revisión**, no errores probados; el ingreso manual exige motivo y queda auditado.

## Límites

- La serie real es de un cliente y un período; no representa toda la cartera.
- El factor contractual y la incertidumbre del medidor son supuestos declarados.
- La serie horaria tiene 667 diferencias cero: la resolución del acumulador limita el análisis.
- El experimento de inyección usa una distribución normal sintética; no reemplaza una validación con datos etiquetados.
- Los tiempos son locales y sensibles a la carga de la máquina.

## Reproducción

```bash
npm run sciences
```

El comando regenera este documento y `docs/ciencias.json`.
