# Guion E3 — Revisión crítica de diseño

**Objetivo:** 10:00 de exposición + 5:00 de preguntas. La rúbrica tolera hasta 12:00; no conviene llegar al límite.

**Total estimado:** 10:00, con 1:45 de demo en vivo.

| # | Lámina | Tiempo | Mensaje clave | Expone |
|---|---|---|---|---|
| 1 | Portada | 0:10 | Grupo 14; E3: construcción, verificación y validación. | P1 |
| 2 | Qué cambió desde E2 | 0:20 | El diseño está construido y medido; la validación está en curso. | P1 |
| 3 | C1 · Observaciones | 1:00 | Cada observación tiene acción y evidencia. | P1 |
| 4 | C1 · Iteración datos | 0:50 | El dato real corrigió el dimensionamiento. | P2 |
| 5 | C1 · Iteración índice | 0:50 | El plan de consulta cambió el código y el p95. | P2 |
| 6 | C2 · Estado | 0:50 | RF-1 a RF-11; persistencia, roles y auditoría. | P3 |
| 7 | C2 · Demo | 1:45 | Flujo completo en vivo, sin video. | P3 |
| 8 | C3 · Complejidad | 0:50 | Índice y rango: 4,21 → 0,20 ms. | P4 |
| 9 | C3 · Anomalías | 0:50 | Tukey + caídas; alerta, no veredicto. | P4 |
| 10 | C4 · RNF | 1:00 | 8 RNF cumplen; los pendientes se declaran. | P5 |
| 11 | C5 · Validación | 0:40 | Diseño 5 usuarios, umbral 4/5; sesiones planificadas. | P6 |
| 12 | C6 · Costos/riesgos | 0:40 | 0 USD de infraestructura; alcance replanificado. | P6 |
| 13 | Cierre | 0:15 | Construido, medido y con compromisos claros. | P1 |

**Total:** 10:00.

## Antes de presentar

- [ ] `npm run seed` y `npm start`.
- [ ] Navegador en `http://localhost:3000`, zoom 100 %.
- [ ] Login de analista y aprobador probado.
- [ ] PDF de respaldo abierto en otra ventana.
- [ ] Capturas de respaldo disponibles (`entrega_3/img/`).
- [ ] Cronómetro visible para el moderador.

## Guion de la demo (1:45)

1. **Analista** → **Alertas** → alerta del Cliente B.
2. **Ver detalle** de la alerta → revisar la medición faltante → **Registrar lectura** `2026-05-15`, valor `700,5`, motivo «medidor sin señal; valor tomado en terreno» → guardar.
3. **Consolidación** → Cliente B → **Generar consolidación**.
4. Mostrar totales y una línea: kWh, precio, tipo de cambio, factor, monto.
5. **Enviar a revisión**.
6. **Cerrar sesión** → **Aprobador** → Consolidación → Cliente B → **Aprobar** → confirmar.
7. Mostrar que queda **Aprobada e inmutable**.
8. **Auditoría** → mostrar ingreso manual, envío y aprobación.

### Si la demo falla

- No improvisar más de 30 segundos.
- Pasar a la lámina de respaldo 20 (captura de consolidación).
- Explicar que el flujo está cubierto por 37 pruebas y por la evidencia de `docs/rnf.md`.
- Continuar con C3.

## Preguntas: quién responde

| Tema | Responsable | Apoyo |
|---|---|---|
| Problema, alcance, observaciones | P1 | P2 |
| Datos, dimensionamiento, índice | P2 | P4 |
| Arquitectura, RF, demo | P3 | P5 |
| Ciencias, anomalías, límites | P4 | P2 |
| Pruebas, RNF, cobertura | P5 | P3 |
| Validación, costos, riesgos, replan | P6 | P1 |

## Puntos delicados

- **C5:** si aún no están las 5 sesiones, decir «diseño listo, sesiones en ejecución»; no inventar resultados. Si ya están, reemplazar el bloque «Estado» por la tabla de `docs/validacion/resultados.md`.
- **C6:** el costo de infraestructura ejecutado es 0 porque el MVP corre local; el estimado corresponde a Azure. Completar las horas ejecutadas con la bitácora antes de presentar.
- **C1:** las observaciones se tomaron de E1 y del registro de la revisión anterior; no atribuir frases textuales que no estén respaldadas.
- **RF-12:** declararla fuera de alcance desde el inicio.
- **RF-7:** decir «simulador de SAP», no «integrado con SAP».

## Frases de cierre

- «El diseño no solo se describe: se ejecuta, se prueba y se mide.»
- «Lo que no está medido se declara; no se presenta como cumplido.»
- «La validación con usuarios es el siguiente paso, no un resultado inventado.»
