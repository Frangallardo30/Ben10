# Revisión de funcionamiento

## Comprobaciones automáticas

Con Node.js 24 o posterior, ejecutá `npm ci && npm test`. Las pruebas cubren:

- Verificación de la firma Ed25519 de Discord, modificación del cuerpo y antigüedad de la firma.
- Postulación propia sin permitir el voto de quien propone o recibe el aura.
- Votos de miembros con y sin el rol; un voto por persona y cambio de voto.
- Cierre con cuatro votos del rol cuando esa opción empata o lidera, y con seis cuando va perdiendo, en ambos sentidos.
- Bloqueo de nuevos votos después del cierre y separación por servidor.
- Panel exclusivo de Administrador, respuestas efímeras, confirmación, auditoría por servidor, rollback, reentregas y carreras entre cancelación administrativa y voto decisivo.
- Ajustes positivos/negativos confirmados, selección individual/múltiple/última congelada, exclusión pública coherente, permisos actuales y propiedad, vencimiento, descarte, rollback, confirmaciones repetidas/concurrentes y neutralización de avisos en vuelo.
- Configuración privada por servidor, permisos Administrar servidor/Administrador, límites y ediciones concurrentes, permisos efectivos del canal y reglas de propuestas inmutables tras cambios.
- Propuestas duplicadas por destinatario/motivo/servidor, envíos concurrentes, estados que no bloquean, reintento tardío y conservación de duplicados heredados.
- Historial de votaciones de todos los estados, ámbito de destinatario y servidor, vencimiento mostrado sin escrituras, paginación estable, fechas heredadas y límites del embed.
- Estadísticas personales por servidor, votos únicos por propuesta, evolución de aprobaciones con saldo histórico completo, desempate temporal y perfiles vacíos o heredados.
- Ranking limitado a diez usuarios por servidor, sumas solo de aprobaciones, empates estables, aura cero/negativa, mensaje vacío, límites de Discord y registro del comando.
- Fechas de creación explícitas y heredadas, orden de historial/perfil, copia local de datos, migración repetida y concurrente sin pérdidas.
- Cancelación limitada al creador y al servidor, repetición, vencimiento, carreras con el voto decisivo y actualización de mensajes anteriores.
- Reconocimiento de comandos y botones sin esperar a D1 lento, errores y timeout, preparación recuperable y reentregas de interacciones sin duplicar propuestas ni revertir votos posteriores.
- Ediciones serializadas por propuesta, revisión nueva durante un PATCH demorado, recuperación tras errores y reinicio, límites 429 y votos concurrentes de una misma persona.
- Flujo completo de interacción firmada, creación de propuesta, migración inicial de D1, votos, `/perfil`, `/historial` y `/info`.

`npx wrangler deploy --dry-run` comprueba que el Worker se empaqueta con sus bindings. El flujo de GitHub Actions `Check Ben10Bot` ejecuta las pruebas de Node.js, los tres scripts de runtime descritos abajo y el empaquetado en cada push y pull request.

`node scripts/check-message-sync-runtime.mjs` ejecuta una prueba adicional con workerd, D1 y el Durable Object locales usando las dependencias fijadas de Wrangler. Retiene una edición abierta mientras llega el cierre y verifica que solo haya una edición en vuelo y que la última retire los botones. Discord está simulado y no se hacen solicitudes remotas.

`node scripts/check-deferred-runtime.mjs` comprueba con workerd, D1 y webhooks simulados el PING firmado y el rechazo de firmas inválidas, el flujo completo de propuesta/votos/perfil/ranking/votaciones con los bindings locales, el reconocimiento diferido, la publicación del resultado, la reentrega de propuestas y votos, la cancelación de una propuesta abierta y ajustes/anulaciones confirmados con botones privados y una respuesta de error ante un fallo real de SQL en D1 local.

`node scripts/check-proposal-dates-runtime.mjs` ejecuta dos instancias de Worker sobre una base D1 local heredada, comprueba la migración concurrente y repetida y conserva el orden y las fechas aunque se modifique el vencimiento. Usa datos representativos locales; no accede a producción.

## Prueba manual en Discord

1. Confirmá que la última implementación de `ben10` figure como lista en Cloudflare.
2. Ejecutá `/info`, `/perfil`, `/historial`, `/votaciones` y `/ranking` en el servidor. Compará el ranking con los perfiles y comprobá que no genere notificaciones por mención.
3. Creá una propuesta de aura propia y comprobá que no puedas votarla.
4. Hacé votar a una persona sin el rol: debe aparecer en el total, sin sumarse al recuento del rol.
5. Con reglas 4/6, probá cuatro votos del rol del lado que empata o lidera y, en otra propuesta, seis del lado que va perdiendo. Si configuraste otros umbrales, usá los que muestra cada propuesta.
6. Comprobá que los botones desaparezcan al cerrar y que `/perfil` e `/historial` reflejen solo las propuestas aprobadas.
7. Probá que solo quien creó la propuesta pueda usar **Cancelar propuesta**: debe mostrar «Cancelada», retirar todos los botones y conservar el aura e historial aprobados.
8. Con dos miembros votando casi al mismo tiempo, comprobá que el mensaje termine con los recuentos guardados y que ningún voto tardío restaure los botones. Verificá que el Worker tenga el binding `MESSAGE_SYNC` y el secreto `DISCORD_BOT_TOKEN`.

La [guía de operación en Cloudflare](docs/operations/cloudflare.md) describe los códigos de diagnóstico, el alcance de `/health` y la recuperación tras rotar el token.

Antes de probar `/config cambiar`, usá un servidor o canal de prueba autorizado: verificá que una persona sin Administrar servidor no pueda editar, que `/info` refleje el cambio y que una propuesta anterior conserve su rol y umbrales. `canal_libre:true` permite retirar la restricción de canal sin cambiar reglas de propuestas existentes.

Para la moderación, comprobá que Administrar servidor sin Administrador no habilite el panel y que solo una cancelación confirmada cambie el mensaje. La auditoría debe ser privada. Seguí [la guía del panel](docs/operations/moderation.md); probá un ajuste y anulalo con su vista previa, comparando aura e historial antes y después. Confirmá también que anular una resta devuelve puntos y que sus mensajes quedan neutros.

## Límites conocidos

- Las propuestas sin los votos necesarios vencen a las 24 horas. El cron puede tardar hasta cinco minutos en retirar los botones; propuestas antiguas sin ID de mensaje pueden conservarlos hasta que alguien los pulse.
- El voto especial refleja si la persona tenía el rol cuando emitió o cambió ese voto. Si pierde el rol después, conserva esa condición hasta que vuelva a votar.
- Las pruebas locales usan SQLite y respuestas firmadas simuladas. No sustituyen la prueba manual de permisos, latencia y aspecto de los embeds en Discord y Cloudflare.
- Los comandos y botones reconocen la interacción antes de D1; el trabajo se completa en segundo plano. Tras veinte segundos se informa un resultado incierto y una escritura ya enviada podría terminar después. Esto no evita problemas de latencia de red, verificación de firma, fallos de webhooks o límites de ejecución de Cloudflare.
- Los votos no editan el embed desde sus respuestas. Las ediciones se serializan por propuesta mediante un Durable Object y las revisiones pendientes se reintentan por cron. Mientras falte el token, el ID original o el acceso a Discord, el mensaje puede quedar desactualizado; D1 mantiene los votos y el resultado. Un 404 no recrea un mensaje eliminado.
