# SVDM MVP — ejecución local

MVP local del **Sistema de Venta y Despacho Marino (SVDM)** para el área Marine de Gasco.
Incluye el flujo de negocio completo: ingesta, cálculo, consolidación, revisión, aprobación, ingreso manual, alertas y auditoría.

## Requisitos

- **Node.js >= 22.5** (probado con 24.19).
- Sin dependencias externas: usa `node:sqlite`, `node:http`, `node:crypto` y `node:test`.

## Puesta en marcha

```bash
npm run seed     # crea data/svdm.db y carga el seed
npm start        # interfaz en http://localhost:3000 y API
npm test         # 33 pruebas
npm run coverage # cobertura con la herramienta integrada de Node
```

`npm run seed` es idempotente: limpia y vuelve a cargar los datos.

## Interfaz web

`npm start` sirve la aplicación en **http://localhost:3000**. Incluye:

- **Login** con los dos usuarios de demostración.
- **Resumen**: KPIs, consumo por cliente, estado del cierre, fuentes y actividad.
- **Consolidación**: generar, ver líneas, enviar a revisión, aprobar o rechazar.
- **Clientes**: cartera y ficha por cliente con contrato, lecturas y alertas.
- **Alertas**: filtro por estado, ingreso manual y resolución con nota.
- **Auditoría**: historial de acciones.

La interfaz usa la misma sesión por cookie que la API; no hay datos en memoria del navegador: todo se lee y escribe en SQLite.

## Usuarios de demostración

| Usuario | Rol | Contraseña |
|---|---|---|
| `u-analista` | analista | `demo` |
| `u-aprobador` | aprobador | `demo` |

La sesión usa una cookie `HttpOnly` y dura 8 horas. El hash es SHA-256 **solo para la demo**; en producción corresponde Argon2/scrypt con sal.

## Datos

- **Cliente A**: dato real anonimizado, base de la prueba de concepto.
- **Clientes B y C**: cartera sintética derivada de A, marcada con `synthetic = 1`.
- **89 lecturas diarias** y **751 horarias**.
- El Cliente B tiene **una lectura faltante** (`2026-05-15`) para demostrar el ingreso manual.
- Referencia del Cliente A:
  - consumo: **30.811,227520 kWh**;
  - gas equivalente: **34.079,6 L**;
  - monto: **21.004.949,14 CLP**.

Notas de procedencia:

- La hoja se llama `JUN KWh`, pero las fechas registradas de las lecturas diarias son de **mayo**. Se conservan las fechas tal como están en la planilla.
- Las lecturas horarias son un **acumulado** del medidor; para analizarlas se usan diferencias.
- El seed se genera con `python3 scripts/build_seed.py` y ya está versionado en `data/seed.json`.

## Flujo de demostración

1. Login como `u-analista`.
2. Ver la alerta crítica del Cliente B (lectura faltante del `2026-05-15`).
3. Ingresar la lectura manual con un motivo.
4. Generar la consolidación del período.
5. Enviarla a revisión.
6. Login como `u-aprobador` y aprobar o rechazar con motivo.
7. Verificar que la consolidación aprobada queda bloqueada y que todo aparece en auditoría.

## Reglas implementadas

- Una **alerta crítica abierta** impide enviar a revisión y aprobar.
- Una consolidación **aprobada es inmutable**: no se recalcula ni admite ingreso manual.
- El **rechazo exige motivo** y devuelve la consolidación a borrador.
- El **ingreso manual exige motivo** y resuelve la alerta de lectura faltante del medidor y fecha.
- Cada acción de escritura deja un evento en `audit_events` con actor, rol, acción y detalle.
- Los roles se validan en el servidor: el analista no aprueba y el aprobador no genera.

## API

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/api/health` | público | Estado y conteos |
| POST | `/api/auth/login` | público | `{ username, password }` |
| POST | `/api/auth/logout` | sesión | Cierra la sesión |
| GET | `/api/auth/me` | sesión | Usuario actual |
| GET | `/api/summary?period=2026-05` | sesión | KPIs del período |
| GET | `/api/clients` | sesión | Cartera con totales y alertas |
| GET | `/api/clients/:id?period=2026-05` | sesión | Ficha del cliente |
| GET | `/api/readings?kind=daily&meter=M-01` | sesión | Lecturas |
| GET | `/api/alerts?status=open&client=CLI-B` | sesión | Alertas |
| POST | `/api/alerts/:id/resolve` | analista | Resuelve alerta con nota |
| GET | `/api/consolidations?period=2026-05` | sesión | Lista de consolidaciones |
| GET | `/api/consolidations/:id` | sesión | Detalle con líneas |
| POST | `/api/consolidations` | analista | `{ client_id, period }` |
| POST | `/api/consolidations/:id/submit` | analista | Envía a revisión |
| POST | `/api/consolidations/:id/approve` | aprobador | Aprueba y bloquea |
| POST | `/api/consolidations/:id/reject` | aprobador | `{ reason }` |
| POST | `/api/readings/manual` | analista | `{ meter_id, ts, kwh, reason }` |
| GET | `/api/audit?limit=50` | sesión | Registro de auditoría |

Ejemplo con `curl`:

```bash
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"u-analista","password":"demo"}' \
  http://localhost:3000/api/auth/login

curl -b cookies.txt "http://localhost:3000/api/summary?period=2026-05"
```

## Cálculo

```text
monto_clp = kWh × precio_usd_por_kwh × tipo_de_cambio
litros_glp = kWh × factor_l_por_kwh
```

El monto se redondea por línea a 2 decimales y el total es la suma de las líneas.

## Pruebas y cobertura

- **33 pruebas**: cálculo, seed, autenticación, permisos, máquina de estados, inmutabilidad, alertas, API e interfaz estática.
- **92,74 %** de cobertura de línea (servidor: 91,81 %).

## Evidencia de RNF

```bash
npm run measure
```

Genera:

- `docs/rnf.md`: tabla de objetivos, método, valor y veredicto por RNF.
- `docs/mediciones.json`: resultados crudos y latencias.
- `docs/coverage.txt`: reporte de cobertura.

Resultados principales de la última corrida:

| RNF | Resultado |
|---|---|
| Consolidación mensual (R-1) | p95 **3,17 ms** con 30 líneas; **5,26 ms** con 450.083 filas |
| Ingesta (R-2) | mediana **9,31 ms** para 840 lecturas |
| Volumen 5 años (R-3) | **450.083 filas**, 71 MB, sin degradar la consolidación |
| Exactitud (E-1) | **0 líneas** fuera de tolerancia; diferencia total **0,004409 CLP** |
| Integridad (E-2) | **0 duplicados** antes y después de recargar |
| RBAC (S-2) | **8/8** controles rol × acción |
| Auditoría (S-4) | **4/4** acciones críticas registradas |
| Cobertura (M-1) | global **92,74 %**; cálculo **92,38 %** |

Los RNF que dependen de infraestructura o de usuarios (MFA, TLS, RPO/RTO, WCAG, validación) quedan declarados como parciales o pendientes en `docs/rnf.md`.

## Ciencias aplicadas

```bash
npm run sciences
```

Genera `docs/ciencias.md` y `docs/ciencias.json` con:

| Aplicación | Resultado |
|---|---|
| **CI-1** Balance energía/masa | factor **1,106077321 L/kWh**; 34.079,6 L calculados; diferencia **0 L** |
| **CI-2** Complejidad e índices | índice `(meter_id, ts)`; consulta por rango **0,20 ms** vs `LIKE` **4,21 ms** (p95) con 450.000 filas |
| **CI-3** Estadística de anomalías | 1 outlier diario; 12 caídas y 13 saltos horarios; inyección controlada con **recall 100 %** |

El cambio de `LIKE` a rango explícito se aplicó en `getReadings` y en las consultas del resumen; es una de las iteraciones de diseño que se documentan para E3.

## Validación con usuarios

El kit está en `docs/validacion/`:

- `protocolo.md`: diseño, tareas, métricas y análisis.
- `instrumento.md`: guion, tarjetas y hoja de observación.
- `consentimiento.md`: consentimiento informado.
- `formulario.html`: hoja imprimible.
- `registro.csv`: registro de las 5 sesiones.

Con 5 participantes, el umbral de RNF-U-2 es **4 de 5 sin ayuda**. Después de las sesiones:

```bash
npm run validate:analyze
```

Genera `docs/validacion/resultados.md` con la tasa de éxito, tiempos, ayuda, errores y comentarios. Si aún no hay registros, el informe queda en estado **Pendiente**.

## Limitaciones declaradas

- Las integraciones con eGauge, WiseData, EIA y SAP son **adaptadores simulados**: el MVP corre local, sin Azure ni credenciales.
- Una sola tabla de precios para todos los clientes; en producción el precio se indexa por contrato.
- Si se ingresa una lectura manual sobre un borrador ya generado, hay que **regenerar** la consolidación para actualizar las líneas.
- La autenticación es local y de demostración, no Entra ID.

## Siguiente paso

Ejecutar las 5 sesiones de validación, completar `docs/validacion/registro.csv`, correr `npm run validate:analyze` y construir el deck de E3 con las mediciones y los resultados.
