# Instrumento de validación — SVDM MVP

**Uso:** imprimir o tener a mano durante la sesión. El moderador lee las tarjetas tal como están escritas y registra lo que observa.

## Antes de empezar

- [ ] `npm run seed` ejecutado y aplicación abierta en `http://localhost:3000`.
- [ ] Alerta crítica del **Cliente B** visible en la vista de Alertas.
- [ ] Consentimiento firmado.
- [ ] Cronómetro listo.
- [ ] Hoja de registro o `registro.csv` abierto.

## Guion de apertura (leer)

> «Gracias por participar. Estamos probando un prototipo del sistema de consolidación mensual de Gasco Marine. No te estamos evaluando a ti: estamos evaluando si la interfaz se entiende.
>
> La sesión dura entre 20 y 30 minutos. Te voy a pedir que hagas algunas tareas y que pienses en voz alta: dime qué ves, qué esperas que pase y qué te confunde.
>
> No hay respuestas correctas ni incorrectas. Si te bloqueas, puedes preguntar; si necesito ayudarte, lo voy a anotar.
>
> Puedes detenerte en cualquier momento. No grabaremos audio ni video salvo que lo autorices.
>
> ¿Tienes alguna pregunta antes de empezar?»

## Tarjeta T1 — Tarea principal

> «Vas a cerrar el período del **Cliente B**.
>
> 1. Entra con el usuario **analista**.
> 2. Busca la alerta del Cliente B y registra la lectura que falta, con un motivo.
> 3. Genera la consolidación del período.
> 4. Envíala a revisión.
> 5. Cierra sesión, entra como **aprobador** y aprueba la consolidación.
> 6. Verifica que la consolidación queda bloqueada.
>
> Empieza cuando quieras.»

**No leer:** dónde está cada botón, qué usuario usar en cada paso ni cómo interpretar la alerta.

## Tarjeta T2 — Auditoría

> «Ahora busca en el sistema el registro del ingreso manual que hiciste. Dime quién lo hizo, cuándo y con qué motivo.»

## Tarjeta T3 — Trazabilidad

> «Abre el detalle de la consolidación y explícame cómo se obtiene el monto de una línea. ¿Qué valores se usan y cómo se combinan?»

## Tarjeta T4 — Opcional: rechazo

> «Como aprobador, rechaza esta consolidación e indica un motivo. Quiero ver qué pasa después.»

*(Solo si el moderador preparó una consolidación en revisión y queda tiempo.)*

## Reglas de ayuda

| Nivel | Cuándo | Qué se registra |
|---|---|---|
| **0** | El participante avanza solo | Sin ayuda |
| **1** | Se bloquea más de 2 minutos | Pista verbal, sin decir el botón exacto |
| **2** | Sigue bloqueado después de la pista | Se le indica el paso o se hace con él |

Registrar también los **errores**: acciones que obligan a retroceder, repetir un paso o corregir un dato.

## Hoja de observación

| Campo | Registro |
|---|---|
| Participante | P1 / P2 / P3 / P4 / P5 |
| Perfil | analista / aprobador / ambos |
| Consentimiento | sí / no |
| T1 completada | sí / no |
| Tiempo T1 | ____ s |
| Ayuda T1 | 0 / 1 / 2 |
| Errores T1 | ____ |
| T2 completada | sí / no |
| T3 completada | sí / no |
| Facilidad (1–7) | ____ |
| Confianza (1–7) | ____ |
| Comentarios | |

### Notas de observación

| Momento | Qué pasó | ¿Ayuda? |
|---|---|---|
| Al entrar | | |
| Al ver la alerta | | |
| Al ingresar la lectura | | |
| Al generar | | |
| Al enviar a revisión | | |
| Al cambiar de rol | | |
| Al aprobar | | |
| Al buscar auditoría | | |

## Debrief (leer al final)

1. ¿Qué fue lo más fácil de la sesión?
2. ¿Qué fue lo más confuso o lento?
3. ¿Confiarías en el monto que muestra el sistema? ¿Por qué?
4. Si tuvieras que hacer este cierre cada mes, ¿qué cambiarías primero?
5. En una escala de 1 a 7, ¿qué tan fácil te resultó la tarea completa?
6. En una escala de 1 a 7, ¿qué tan seguro estás de que la consolidación quedó bien?

## Cierre

> «Gracias. Lo que hiciste y lo que comentaste nos sirve para corregir la interfaz antes de la entrega. No usaremos tu nombre en ningún documento.»

## Después de la sesión

- [ ] Completar la fila del participante en `registro.csv`.
- [ ] Anonimizar los comentarios.
- [ ] Ejecutar `npm run seed` para dejar la alerta del Cliente B abierta para la siguiente sesión.
