# Medición de requisitos no funcionales — SVDM MVP

Generado: `2026-11-16T22:55:27.897Z`

## Entorno

- Node.js: `v24.19.0`
- Plataforma: `linux x64`
- CPU: Intel(R) Core(TM) i5-8265U CPU @ 1.60GHz (8 núcleos)
- Base de datos: SQLite local mediante `node:sqlite`
- Servidor: `node:http` en proceso, puerto efímero

## Resultados medidos

| RNF | Objetivo | Método | Valor obtenido | Veredicto |
|---|---|---|---|---|
| **RNF-R-1** | Consolidación mensual ≤ 5 min (300.000 ms) | 10 corridas HTTP sobre 30 lecturas y, aparte, 10 corridas con 5 años de datos | p95 **5,08 ms** (30 líneas); p95 **46,97 ms** con 450.083 filas | **Cumple** |
| **RNF-R-2** | Ciclo de ingesta ≤ 60 s | 3 cargas del seed (840 lecturas) en base nueva, medidas de punta a punta | mediana **38,12 ms**; máximo 86,75 ms | **Cumple** |
| **RNF-R-3** | 5 años de datos sin degradar R-1 | 10 medidores × 60 meses × (30 diarias + 720 horarias), 10 corridas de consolidación | **450.083 filas**, 71.0 MB; p95 **46,97 ms** | **Cumple** |
| **RNF-E-1** | 0 discrepancias en ≥ 30 casos, tolerancia ≤ 1 CLP por línea | Comparación línea a línea contra la planilla para el Cliente A | 30 casos; **0 líneas** fuera de tolerancia; diferencia máxima 0,004952 CLP; total 0,004409 CLP | **Cumple** |
| **RNF-E-2** | 0 lecturas duplicadas o modificadas | Consulta de duplicados antes y después de recargar el seed | **0 duplicados**; 0 tras recargar | **Cumple** |
| **RNF-S-2** | RBAC, mínimo privilegio | Matriz de 8 controles rol × acción sobre la API | **8/8** controles correctos | **Cumple** |
| **RNF-S-4** | 100 % de eventos críticos auditados | Comparación de acciones ejecutadas contra `audit_events` | **4/4** acciones auditadas; motivo del ingreso manual presente | **Cumple** |
| **RNF-M-1** | Cobertura ≥ 70 % global y ≥ 90 % en cálculo | `node --experimental-test-coverage --test` | global **92,63%**; cálculo **92,38%** | **Cumple** |
| **RNF-D-1** | Disponibilidad ≥ 99,5 % mensual | Conteo de respuestas 5xx durante la corrida | 351 solicitudes; **0** errores 5xx | **Parcial**: no sustituye monitoreo mensual |
| **RNF-P-1** | Despliegue local reproducible ≤ 15 min | Seed + arranque del servidor medidos | seed 38,12 ms + arranque 6,06 ms | **Parcial**: sin IaC ni rollback |
| **RNF-C-1** | Chrome/Edge y contrato OpenAPI | Flujo E2E automatizado en Chromium | Flujo completo OK en Chromium; Edge no disponible | **Parcial** |

## Latencia de API

Medición local sobre loopback (50 solicitudes por endpoint, tras 3 de calentamiento). No incluye latencia de red ni TLS.

| Endpoint | p50 | p95 | Máximo |
|---|---|---|---|
| `/api/summary?period=2026-05` | 2,37 ms | 9,95 ms | 12,81 ms |
| `/api/clients?period=2026-05` | 2,18 ms | 9,11 ms | 10,30 ms |
| `/api/clients/CLI-A?period=2026-05` | 2,56 ms | 11,18 ms | 19,49 ms |
| `/api/consolidations?period=2026-05` | 1,97 ms | 6,82 ms | 7,97 ms |
| `/api/consolidations/1` | 2,26 ms | 9,40 ms | 10,23 ms |
| `/api/alerts?status=all` | 1,98 ms | 6,38 ms | 6,63 ms |

## RNF no medidos en este entorno

| RNF | Motivo | Qué falta para medirlo |
|---|---|---|
| **RNF-D-2** RPO/RTO | No hay respaldo ni restauración implementados en el MVP local | Prueba de restauración cronometrada sobre una base sembrada |
| **RNF-D-3** Falla de fuente externa | Los adaptadores son simulados; no hay fuente externa que falle | Simulador de falla con reintento y verificación de 0 pérdida |
| **RNF-S-1** Entra ID + MFA | La autenticación local no usa Entra ID ni MFA | Integración OIDC con un tenant de prueba |
| **RNF-S-3** TLS y cifrado | El MVP corre en HTTP local, sin TLS | Despliegue con TLS y verificación de cifrado en reposo |
| **RNF-S-5** Cumplimiento legal | Falta validación con el área legal de Gasco | Revisión de base de licitud, retención y Ley 21.719 |
| **RNF-U-1** WCAG 2.1 AA | No se ejecutó auditoría de accesibilidad | Lighthouse + axe sobre las vistas |
| **RNF-U-2** 80 % de usuarios sin ayuda | Pendiente la validación con usuarios | Estudio con 5 participantes y registro de tareas |
| **RNF-M-2** Lint y observabilidad | No hay linter ni alertas configuradas | Linter en CI y alerta de ingesta |

## Lectura de los resultados

- El cálculo es reproducible: el total del Cliente A es **21.004.949,136 CLP**, con una diferencia de **0,004409 CLP** frente a la planilla.
- La consolidación tarda **5,08 ms** con 30 lecturas y **46,97 ms** con 450.083 filas; el objetivo era 300.000 ms.
- La ingesta de 840 lecturas tarda **38,12 ms** de mediana, muy por debajo de los 60 s.
- Los RNF de seguridad, disponibilidad y accesibilidad que dependen de infraestructura o de usuarios se declaran como parciales o pendientes; no se presentan como cumplidos.

## Reproducción

```bash
npm run measure
```

El comando regenera `docs/mediciones.json`, `docs/coverage.txt` y este documento.
