# Aura y comandos

## Proponer y votar

`/aura usuario puntos motivo` crea una propuesta en el servidor actual. `puntos` es un entero entre -1000 y 1000, excluido 0; `motivo` debe tener entre 1 y 250 caracteres después de quitar espacios de los extremos. Se permite la postulación propia.

La propuesta aparece con botones para aprobar o desaprobar. Cada persona puede emitir un voto y cambiarlo mientras esté abierta. Quien propone y quien recibe el aura no pueden votar. Todos los votos cuentan en el total general. Los miembros del rol `1431791263547392121` también suman en el recuento especial del rol. Esta condición se toma al emitir o cambiar el voto; perder el rol después no la quita hasta volver a votar.

La propuesta se aprueba o rechaza cuando una opción reúne cuatro votos del rol y empata o lidera el recuento general. Si esa opción va perdiendo en el total, necesita seis votos del rol para imponerse. Seis votos del rol en una opción tienen precedencia en el cierre. Si ambas opciones tienen cuatro votos del rol y el total general empata, sigue abierta hasta que se alcance otra condición. Tras el cierre no admite más votos. El mensaje final conserva los recuentos general y del rol e indica si decidió la regla de cuatro votos del rol (empatando o liderando el total) o la de seis (que decide incluso si va perdiendo). La explicación usa el resultado guardado y los votos conservados, no la opción del último botón pulsado. Una propuesta vencida muestra el vencimiento sin atribuirlo a un umbral de votos.

Si no se alcanza un resultado, vence a las 24 horas sin cambiar el aura. El cron revisa las propuestas cada cinco minutos y marca las vencidas; un voto después del plazo tampoco cuenta aunque el cron aún no haya corrido. El lote de voto comprueba el vencimiento con el reloj de D1 al ejecutarse, antes de guardar el voto y resolver el cierre; si ya venció, no puede aprobarse ni reabrirse. El bot intenta quitar los botones del mensaje original y vuelve a intentarlo si Discord falla. Las propuestas creadas antes de guardar el ID del mensaje pueden quedar con botones visibles si nadie interactuó con ellas; al pulsarlos, el bot muestra que la votación venció.

## Cancelar una propuesta

El botón «Cancelar propuesta» permite a quien la creó retirarla mientras siga abierta y no haya vencido. El rol de votación o ser la persona que recibe los puntos no otorgan ese permiso. Se comprueban el servidor y el creador tanto al leer la propuesta como al guardar la cancelación. No se puede cancelar una propuesta aprobada, rechazada o vencida.

La cancelación cambia el estado a `cancelled`, conserva los votos y el motivo, no modifica el aura ni el historial de aprobaciones, y actualiza el mensaje a «Cancelada sin cambiar el aura» sin botones. No publica un aviso separado de aprobación o rechazo. Repetir la cancelación no vuelve a cambiar el estado. Si coincide con el voto decisivo, prevalece la primera transición de estado confirmada en D1; una cancelación no revierte una aprobación y un voto no reabre una propuesta cancelada. Si el plazo ya pasó, prevalece el vencimiento.

La preparación solicita una sola vez actualizar los mensajes abiertos anteriores para agregar el botón, mediante la marca `cancel_button_v1` en `bot_settings`. El cron o la siguiente escritura activan esa preparación; la entrega depende del sincronizador y del acceso a Discord.

## Respuestas a interacciones

Después de verificar la firma, `/aura`, `/perfil` y `/historial` reconocen la interacción de inmediato con una respuesta diferida, antes de acceder a D1. El resultado completa la respuesta original en segundo plano. `/info` responde directamente porque no consulta la base. Los errores de entrada que se detectan sin D1 siguen siendo efímeros; los errores posteriores de un comando se muestran en su respuesta diferida pública. Los botones válidos se reconocen antes de consultar D1 y los errores de voto se informan mediante un aviso efímero, sin reemplazar la votación.

La preparación de tablas y la migración de votos se comparten una vez por binding de D1 en cada instancia del Worker, antes de las escrituras. Un fallo permite reintentar la preparación. Las consultas de perfil e historial no esperan esta migración.

La propuesta usa el ID de la interacción de creación; una entrega repetida de la misma interacción conserva una única propuesta. D1 guarda los IDs de votos procesados en `vote_interactions` dentro del mismo lote que el voto: repetir una entrega no vuelve a aplicarla ni deshace un cambio posterior de voto o de rol. Ejecutar un comando nuevo con otro ID sigue siendo una propuesta nueva.

El trabajo en segundo plano tiene un plazo de veinte segundos para informar un fallo o resultado incierto. El timeout no cancela una escritura ya enviada a D1; puede completarse después. En ese caso se recomienda consultar `/perfil` antes de repetir el comando. La entrega del resultado requiere que Discord acepte el webhook de la interacción y está sujeta a los límites de ejecución del Worker. No se repiten automáticamente escrituras con un ID nuevo.

## Sincronización del mensaje

Los votos válidos se confirman sin editar el mensaje desde la respuesta de la interacción. El lote de D1 guarda también una revisión pendiente en `proposal_message_sync`. El Durable Object `ProposalMessageSync`, enlazado como `MESSAGE_SYNC` y separado por ID de propuesta, es el único que edita el mensaje de la votación. Procesa las ediciones en serie y consulta en una sola lectura de D1 el estado, ambos recuentos y la revisión. Si llegan votos durante una edición, vuelve a leer y publica la revisión nueva después de terminar la anterior. Así una respuesta antigua de un voto no puede restaurar los botones de una votación ya cerrada en el mensaje.

El cron envía hasta veinte sincronizaciones pendientes por ejecución; el vencimiento también pasa por este mismo flujo. Los errores conservan la revisión pendiente y el 429 respeta el plazo de reintento de Discord. Si falta el token o el ID del mensaje, la edición espera hasta que estén disponibles. Un mensaje eliminado (404) se considera atendido para esa revisión. La tabla anterior `proposal_expiry_sync` se conserva por compatibilidad, pero ya no dirige las ediciones. Al recuperar el ID original se solicita una sincronización del estado actual. La corrección visual requiere `DISCORD_BOT_TOKEN`, permisos en el canal y el binding `MESSAGE_SYNC`; puede demorarse durante fallos de Discord y no recrea mensajes eliminados.

## Avisos de cierre

Al aprobarse o rechazarse una propuesta, el bot publica un aviso en su mismo canal. Indica la persona afectada y los puntos con signo si se aprueba; si se rechaza, aclara que su aura no cambia. Las menciones no generan notificaciones. Las propuestas vencidas solo actualizan el mensaje original. El bot necesita el permiso Send Messages además de View Channels.

D1 guarda un único aviso por propuesta dentro del lote de cierre. El envío se inicia en segundo plano y el cron procesa hasta veinte avisos pendientes por ejecución; no se anuncian cierres históricos al crear la tabla. Una reserva condicional evita que dos ejecuciones envíen el mismo aviso. Un 429 se reintenta después del plazo indicado por Discord. Si la respuesta se pierde, Discord devuelve otro error o el proceso se interrumpe tras reservar el envío, no se reenvía automáticamente: podría haberse publicado. Esos casos requieren revisar el canal y el estado `sending` o `uncertain` de `proposal_notifications`. Puede faltar un aviso; el aura y el cierre permanecen guardados y no dependen de la entrega.

## Consultar

- `/perfil [usuario]` muestra aura total, cantidad de cambios aprobados, propuestas abiertas y los cinco cambios aprobados más recientes. Sin `usuario`, muestra el perfil de quien ejecuta el comando.
- `/historial [usuario] [pagina]` lista cambios aprobados con puntos, motivo, fecha y proponente, ocho por página. Sin `usuario`, muestra el historial propio; la primera página es la predeterminada.
- `/info` explica dentro de Discord los comandos y las reglas de votación.

El aura total suma solo propuestas aprobadas. Las consultas se separan por servidor. D1 guarda IDs de servidor y usuarios, puntos, motivos y votos. `expires_at` marca el vencimiento y sirve para calcular la fecha mostrada en historial.

Los límites y comprobaciones conocidos están en [`QUALITY.md`](../../QUALITY.md). Las mejoras pendientes se registran en [`docs/tasks/`](../tasks/README.md).
