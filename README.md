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
npm test         # 47 pruebas
npm run coverage # cobertura con la herramienta integrada de Node
```

`npm run seed` es idempotente: limpia y vuelve a cargar los datos.

## Interfaz web

`npm start` sirve la aplicación en **http://localhost:3000**. Incluye:

- **Login** con los dos usuarios de demostración.
- **Resumen**: KPIs, consumo por cliente, estado del cierre, fuentes y actividad.
- **Consolidación**: generar, ver líneas con su **origen** (`eGauge`/`manual`), enviar a revisión, aprobar o rechazar.
- **Clientes**: cartera y ficha por cliente con contrato, lecturas y alertas.
- **Alertas**: detalle de las mediciones afectadas, corrección del valor con motivo y resolución con nota.
- **Auditoría**: historial de acciones.

La interfaz usa la misma sesión por cookie que la API; no hay datos en memoria del navegador: todo se lee y escribe en SQLite.

## Entregables de E3

| Entregable | Ubicación |
|---|---|
| Deck de E3 | `entrega_3/main.pdf` (fuente: `entrega_3/main.tex`) |
| Guion de exposición y demo | `entrega_3/guion.md` |
| Medición de RNF | `docs/rnf.md` y `docs/mediciones.json` |
| Ciencias aplicadas | `docs/ciencias.md` y `docs/ciencias.json` |
| Kit de validación | `docs/validacion/` |
| RF-13 y RF-14 | `docs/rf13_rf14.md` |
| Índice de evidencia | `docs/README.md` |

El deck tiene 13 láminas principales (10 minutos) y 9 de respaldo. Se compila con `pdflatex main.tex` dos veces desde `entrega_3/`.

## Usuarios de demostración

| Usuario | Rol operativo | Administrador TI | Contraseña |
|---|---|---|---|
| `u-admin` | Sin rol operativo | **Sí** | `demo` |
| `u-sinrol` | Sin rol | No | `demo` |
| `u-analista` | analista | No | `demo` |
| `u-aprobador` | aprobador | No | `demo` |

La sesión usa una cookie `HttpOnly` y dura 8 horas. El rol se lee de la base en cada solicitud: un cambio de permisos rige en la siguiente petición, aunque la sesión siga abierta. El hash es SHA-256 **solo para la demo**; en producción corresponde Argon2/scrypt con sal.

## Datos

- **Cliente A**: dato real anonimizado, base de la prueba de concepto.
- **Clientes B, C y D**: cartera sintética derivada de A, marcada con `synthetic = 1`.
- **118 lecturas diarias** y **751 horarias**.
- El Cliente B tiene una lectura faltante (`2026-05-15`).
- El Cliente D tiene una lectura faltante (`2026-05-12`) y dos consumos diarios atípicos.
- El Cliente A tiene la alerta horaria de consistencia y un consumo diario atípico; B y C también tienen outliers diarios detectados por Tukey.
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
2. Abrir la alerta crítica del Cliente B (lectura faltante del `2026-05-15`) y revisar la medición afectada.
3. Corregir el valor desde el detalle de la alerta, con un motivo.
4. Generar la consolidación del período.
5. Enviarla a revisión.
6. Login como `u-aprobador` y aprobar o rechazar con motivo.
7. Verificar que la consolidación aprobada queda bloqueada y que todo aparece en auditoría.
8. Como `u-admin`, abrir **Administración**, asignar o revocar un rol y revisar la auditoría del cambio.
9. Como analista, abrir una consolidación aprobada y usar **Rectificar** con un motivo; mostrar `v2` en borrador mientras `v1` sigue vigente.
10. Aprobar la rectificación y revisar el historial: `v2` vigente, `v1` histórica.

## Reglas implementadas

- Una **alerta crítica abierta** impide enviar a revisión y aprobar.
- Una consolidación **aprobada es inmutable**: no se recalcula ni admite ingreso manual o corrección.
- El **rechazo exige motivo** y devuelve la consolidación a borrador.
- El **ingreso manual o la corrección de una alerta exigen motivo**; la alerta se resuelve cuando no quedan mediciones abiertas.
- Cada acción de escritura deja un evento en `audit_events` con actor, rol, acción y detalle.
- Los roles se validan en el servidor: el analista no aprueba y el aprobador no genera.
- **RF-13:** solo un administrador cambia roles; una cuenta sin rol operativo recibe 403; el último administrador no se puede eliminar.
- **RF-14:** una consolidación aprobada es inmutable; una rectificación crea una versión nueva, la anterior sigue vigente hasta aprobar el reemplazo y solo existe una versión aprobada vigente por cliente/período.
- Un borrador con lecturas cambiadas queda **desactualizado** y no se puede enviar hasta regenerarlo.

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
| GET | `/api/alerts?status=open&client=CLI-B` | sesión | Alertas con conteo de mediciones afectadas |
| GET | `/api/alerts/:id` | sesión | Detalle con las mediciones afectadas |
| POST | `/api/alerts/:id/correct` | analista | `{ ts, value, reason }`; corrige la medición |
| POST | `/api/alerts/:id/resolve` | analista | Resuelve una alerta revisada con nota |
| GET | `/api/consolidations?period=2026-05` | sesión | Lista de consolidaciones |
| GET | `/api/consolidations/:id` | sesión | Detalle con líneas |
| POST | `/api/consolidations` | analista | `{ client_id, period }` |
| POST | `/api/consolidations/:id/submit` | analista | Envía a revisión |
| POST | `/api/consolidations/:id/approve` | aprobador | Aprueba y bloquea |
| POST | `/api/consolidations/:id/reject` | aprobador | `{ reason }` |
| POST | `/api/readings/manual` | analista | `{ meter_id, ts, kwh, reason }` |
| GET | `/api/audit?limit=50` | sesión | Registro de auditoría |
| GET | `/api/admin/users` | administrador | Cuentas y permisos |
| PATCH | `/api/admin/users/:id` | administrador | `{ role, is_admin, reason }` |
| POST | `/api/consolidations/:id/rectify` | analista | `{ reason }`; crea la versión siguiente |

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

- **47 pruebas**: cálculo, seed, autenticación, permisos, máquina de estados, inmutabilidad, alertas, API e interfaz estática.
- **91,46 %** de cobertura de línea (servidor: 90,06 %).

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
| Consolidación mensual (R-1) | p95 **7,8 ms** con 30 líneas; **6,04 ms** con 450.112 filas |
| Ingesta (R-2) | mediana **9,43 ms** para 869 lecturas |
| Volumen 5 años (R-3) | **450.112 filas**, 71,0 MB, sin degradar la consolidación |
| Exactitud (E-1) | **0 líneas** fuera de tolerancia; diferencia total **0,004409 CLP** |
| Integridad (E-2) | **0 duplicados** antes y después de recargar |
| RBAC (S-2) | **8/8** controles rol × acción |
| Auditoría (S-4) | **4/4** acciones críticas registradas |
| Cobertura (M-1) | global **91,46 %**; cálculo **92,52 %** |

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

Completar las 5 sesiones de validación y las horas ejecutadas, actualizar las láminas C5 y C6 del deck, y preparar el informe E4 y la defensa E5. El deck y la evidencia de E3 ya están en el repositorio.
