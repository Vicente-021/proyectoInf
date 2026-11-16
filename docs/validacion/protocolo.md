# Validación con usuarios — SVDM MVP

**Objetivo:** comprobar si usuarios del perfil analista/aprobador completan la tarea principal del sistema **sin ayuda** y detectar fricciones concretas antes de la entrega E3.

**Requisito asociado:** RNF-U-2 — al menos **80 % de los usuarios de prueba** completa la tarea principal sin ayuda. Con 5 participantes, el umbral es **4 de 5**.

## 1. Diseño

- **Tipo:** estudio de usabilidad formativo, no experimental.
- **Participantes:** **5** personas (mínimo definido en E1). Muestreo por conveniencia.
- **Perfil:** personas con experiencia en análise administrativo, facturación o gestión comercial; no integrantes del equipo.
- **Mezcla sugerida:** 3 con perfil analista y 2 con perfil aprobador, o 5 que puedan desempeñar ambos roles.
- **Duración:** 20–30 minutos por sesión.
- **Roles de la sesión:** moderador (lee tareas y observa) y, si es posible, un segundo observador que registra tiempos y errores.
- **Datos:** identificadores `P1` a `P5`; sin nombres, correos ni datos personales.

## 2. Tareas

### T1 — Tarea principal: cerrar el período del Cliente B

El participante debe:

1. Entrar como `u-analista`.
2. Ir a **Alertas** y encontrar la alerta crítica del Cliente B.
3. Registrar la lectura manual del `2026-05-15` con un motivo.
4. Ir a **Consolidación**, seleccionar Cliente B y generar la consolidación.
5. Enviarla a revisión.
6. Cerrar sesión, entrar como `u-aprobador` y aprobar la consolidación.
7. Verificar que queda bloqueada.

**Éxito para RNF-U-2:** completa los 7 pasos con **nivel de ayuda 0**. Se registra también si completa con ayuda (nivel 1 o 2), pero ese caso no cuenta para el umbral de 80 %.
**Tiempo:** se mide desde que termina la lectura de la tarea hasta la aprobación.
**Ayuda:** 0 = sin ayuda; 1 = pista verbal; 2 = ayuda directa.
**Errores:** acciones que obligan a retroceder o repetir un paso.

### T2 — Auditoría

Encontrar el evento de **ingreso manual** en la vista de Auditoría e indicar quién lo hizo y cuál fue el motivo.

**Éxito:** encuentra el evento y lee correctamente actor y motivo.

### T3 — Trazabilidad

En el detalle de la consolidación, explicar cómo se obtiene el monto de una línea:

```text
kWh × precio USD/kWh × tipo de cambio = monto CLP
kWh × factor contractual = litros
```

**Éxito:** identifica los cuatro valores y la operación.

### T4 — Opcional: rechazo con motivo

Si el tiempo lo permite: como aprobador, rechazar una consolidación preparada por el moderador e indicar un motivo.

**Éxito:** rechaza, escribe un motivo y la consolidación vuelve a borrador.

## 3. Métricas

| Métrica | Registro |
|---|---|
| Éxito T1 | sí / no |
| Tiempo T1 | segundos |
| Nivel de ayuda T1 | 0 / 1 / 2 |
| Errores T1 | cantidad |
| Éxito T2 y T3 | sí / no |
| Facilidad percibida | escala 1–7 |
| Confianza en el resultado | escala 1–7 |
| Comentarios | texto breve, anonimizado |

## 4. Procedimiento

### Antes de cada sesión

```bash
cd mvp
npm run seed
npm start
```

Verificar en el navegador que la alerta crítica del Cliente B está abierta. Si la sesión anterior aprobó esa consolidación, **volver a ejecutar `npm run seed`**.

### Durante la sesión

1. Entregar y firmar el consentimiento (`consentimiento.md`).
2. Leer la introducción del instrumento (`instrumento.md`).
3. Pedir al participante que piense en voz alta.
4. Leer cada tarea y no explicar los pasos.
5. Si se bloquea más de **2 minutos**, ofrecer ayuda y registrar el nivel.
6. Al terminar, aplicar el debrief y las escalas 1–7.

### Después de cada sesión

1. Completar una fila de `registro.csv`.
2. Reiniciar el seed.
3. Anonimizar los comentarios antes de guardarlos.

## 5. Análisis

Se hará un análisis **descriptivo**, adecuado a 5 participantes:

- tasa de éxito de T1: `éxitos / 5`;
- mediana y rango intercuartílico del tiempo;
- distribución de niveles de ayuda y cantidad de errores;
- éxito de T2 y T3;
- mediana de facilidad y confianza;
- análisis temático breve de comentarios (2–3 temas);
- conclusión con límites explícitos.

**Criterio de cumplimiento:** T1 con éxito sin ayuda en **al menos 4 de 5** participantes.

Si no se alcanza, se identifican las fricciones, se corrige la interfaz y se repite la medición con el mismo instrumento.

## 6. Ética y datos

- Consentimiento informado antes de empezar.
- Participación voluntaria y posibilidad de retirarse en cualquier momento.
- Sin grabaciones de audio o video salvo autorización explícita.
- Solo se guardan identificadores `P1`–`P5`, tiempos, respuestas y comentarios anonimizados.
- Los datos se usan solo para el proyecto del ramo y se eliminan al terminar el semestre.
- No se muestran nombres, correos ni datos de clientes reales.

## 7. Limitaciones

- Muestra pequeña y por conveniencia: no permite generalizar.
- El prototipo corre en local, con datos simulados y sin las integraciones reales.
- El cambio de rol dentro de la misma sesión es artificial; en producción serían personas distintas.
- Una sola sesión por participante: puede haber efecto de aprendizaje.
- El moderador puede influir sin querer; por eso se registra el nivel de ayuda.
- No se evalúa accesibilidad con lectores de pantalla ni con usuarios con discapacidad.

## 8. Archivos

| Archivo | Uso |
|---|---|
| `protocolo.md` | Este documento |
| `instrumento.md` | Guion, tarjetas de tareas y hoja de observación |
| `consentimiento.md` | Consentimiento informado |
| `registro.csv` | Registro de las 5 sesiones |
| `resultados.md` | Se genera con `npm run validate:analyze` |
| `formulario.html` | Hoja imprimible para la sesión |
