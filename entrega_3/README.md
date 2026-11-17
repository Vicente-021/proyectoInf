# Deck E3 — Revisión crítica de diseño

Contiene la presentación de E3 y su guion de exposición.

| Archivo | Contenido |
|---|---|
| `main.tex` | Fuente Beamer (21 páginas: 13 principales + 8 de respaldo) |
| `main.pdf` | PDF compilado |
| `guion.md` | Tiempos, expositores, demo y asignación de preguntas |
| `img/` | Capturas de la interfaz usadas en las láminas |

## Compilar

```bash
cd entrega_3
pdflatex main.tex
pdflatex main.tex
```

Se compila con pdfLaTeX y los paquetes habituales de TeX Live (`beamer`, `tikz`, `booktabs`, `graphicx`).

## Antes de presentar

- Completar la lámina **C5** con los resultados de las 5 sesiones (`docs/validacion/resultados.md`).
- Completar las **horas ejecutadas** de la lámina C6 con la bitácora del equipo.
- Revisar que las observaciones de la lámina C1 coincidan con las observaciones textuales de E1.
- Ejecutar `npm run seed` y `npm start` para la demo.

## Estructura

- Láminas 1–13: exposición de 10 minutos.
- Láminas 14–20: respaldo para preguntas (RF, RNF, arquitectura, validación, repositorio, riesgos y captura de la interfaz).
