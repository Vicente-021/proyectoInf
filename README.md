# SVDM MVP — ejecución local

MVP local del **Sistema de Venta y Despacho Marino (SVDM)** para el área Marine de Gasco.
Incluye el flujo de negocio completo: ingesta, cálculo, consolidación, revisión, aprobación, ingreso manual, alertas y auditoría.

## Requisitos

- **Node.js >= 22.5** (probado con 24.19).
- Sin dependencias externas: usa `node:sqlite`, `node:http`, `node:crypto` y `node:test`.

## Puesta en marcha

```bash
npm run seed     # crea data/svdm.db y carga el seed
npm start        # API en http://localhost:3000
npm test         # 31 pruebas
npm run coverage # cobertura con la herramienta integrada de Node
```

`npm run seed` es idempotente: limpia y vuelve a cargar los datos.

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

- **31 pruebas**: cálculo, seed, autenticación, permisos, máquina de estados, inmutabilidad, alertas y API.
- **92,95 %** de cobertura de línea (servidor: 92,08 %).

## Limitaciones declaradas

- Las integraciones con eGauge, WiseData, EIA y SAP son **adaptadores simulados**: el MVP corre local, sin Azure ni credenciales.
- Una sola tabla de precios para todos los clientes; en producción el precio se indexa por contrato.
- Si se ingresa una lectura manual sobre un borrador ya generado, hay que **regenerar** la consolidación para actualizar las líneas.
- La autenticación es local y de demostración, no Entra ID.

## Siguiente paso

Conectar la interfaz a esta API y agregar la medición de RNF, la validación con usuarios y el deck de E3.
