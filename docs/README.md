# Documentación y evidencia — SVDM MVP

Índice de la evidencia que respalda la entrega E3.

## Verificación y RNF

| Archivo | Contenido |
|---|---|
| `rnf.md` | Tabla de RNF: objetivo, método, valor y veredicto |
| `mediciones.json` | Resultados crudos, latencias y volúmenes |
| `coverage.txt` | Reporte de cobertura de las pruebas |

## Ciencias aplicadas

| Archivo | Contenido |
|---|---|
| `ciencias.md` | Balance energía/masa, complejidad e índices, detección de anomalías |
| `ciencias.json` | Resultados crudos del análisis |

## Validación con usuarios

| Archivo | Contenido |
|---|---|
| `validacion/protocolo.md` | Diseño, tareas, métricas y análisis |
| `validacion/instrumento.md` | Guion, tarjetas y hoja de observación |
| `validacion/consentimiento.md` | Consentimiento informado |
| `validacion/formulario.html` | Hoja imprimible |
| `validacion/registro.csv` | Registro de P1 a P5 |
| `validacion/resultados.md` | Resultado del análisis; queda pendiente hasta completar las sesiones |

## Presentación

| Archivo | Contenido |
|---|---|
| `../entrega_3/main.pdf` | Deck de E3 compilado |
| `../entrega_3/main.tex` | Fuente Beamer |
| `../entrega_3/guion.md` | Tiempos, demo y preguntas |

## Reproducción

```bash
npm test
npm run coverage
npm run measure
npm run sciences
npm run validate:analyze
```
