# SVDM MVP — ejecución local

MVP local del **Sistema de Venta y Despacho Marino (SVDM)** para el área Marine de Gasco.
Esta es la base del **paso 1 de E3**: esquema, carga de datos, cálculo y primeros tests.

## Requisitos

- **Node.js >= 22.5** (probado con 24.19).
- Sin dependencias externas: usa `node:sqlite`, `node:http` y `node:test`.

## Puesta en marcha

```bash
npm run seed     # crea data/svdm.db y carga el seed
npm start        # API en http://localhost:3000
npm test         # suite de pruebas
npm run coverage # cobertura con la herramienta integrada de Node
```

Si se cambia el seed, basta volver a ejecutar `npm run seed` (es idempotente).

## Datos

- Fuente: `entrega_2/ENERGIA CALBUCO JUN 2026.xlsx`.
- **Anonimizado**: el cliente se llama `Cliente A`, el medidor `M-04` y el contacto es ficticio.
- **30 lecturas diarias** de consumo, del `2026-05-01` al `2026-05-30`.
- **751 lecturas horarias** acumuladas, del `2026-05-30 17:00` al `2026-06-30 23:00`.
- Referencia de la planilla:
  - consumo: **30.811,227520 kWh**;
  - gas equivalente: **34.079,6 L**;
  - monto: **21.004.949,14 CLP**.

Notas de procedencia:

- La hoja se llama `JUN KWh`, pero las fechas registradas de las lecturas diarias son de **mayo**. Se conservan las fechas tal como están en la planilla; no se reetiquetan.
- Las lecturas horarias son un **acumulado** del medidor. Para analizarlas se usan diferencias entre horas, no el valor directo.
- El seed se genera con `python3 scripts/build_seed.py`, que lee el `.xlsx` sin dependencias. El `data/seed.json` ya está versionado, así que no hace falta la planilla para ejecutar.

## Cálculo

Fórmulas implementadas en `src/calc.js`:

```text
monto_clp = kWh × precio_usd_por_kwh × tipo_de_cambio
litros_glp = kWh × factor_l_por_kwh
```

- El monto se redondea por línea a 2 decimales y el total es la suma de las líneas.
- El factor contractual del cliente es `1,106077321258 L/kWh` (obtenido de la planilla).
- Precio de la muestra: `0,74232 USD/kWh`; tipo de cambio: `918,378`.

## API disponible

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado y conteos de la base |
| GET | `/api/clients` | Clientes con medidor y total diario |
| GET | `/api/readings?kind=daily&limit=50` | Lecturas (`daily` o `hourly`) |
| GET | `/api/consolidation/preview?client=CLI-A&period=2026-05` | Cálculo en vivo, sin persistir |

Ejemplo:

```bash
curl "http://localhost:3000/api/consolidation/preview?client=CLI-A&period=2026-05"
```

## Estado del paso 1

Implementado:

- esquema SQLite con clientes, medidores, contratos, precios, lecturas, consolidaciones, líneas, alertas, auditoría y usuarios;
- seed idempotente desde la planilla;
- cálculo puro con validaciones;
- API de lectura y preview de consolidación;
- 21 pruebas (unitarias, de base y de API) y cobertura de línea superior al 92 %.

Pendiente para los siguientes pasos:

- persistir consolidaciones y líneas;
- máquina de estados borrador → revisión → aprobada, con rechazo y motivo;
- roles y autenticación local;
- ingreso manual, alertas, auditoría y exportación;
- interfaz conectada a la API.

## Usuarios de demostración

| Usuario | Rol | Contraseña |
|---|---|---|
| `u-analista` | analista | `demo` |
| `u-aprobador` | aprobador | `demo` |

El hash es SHA-256 **solo para la demo**. No es un esquema de contraseñas para producción.
