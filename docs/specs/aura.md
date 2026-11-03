# Aura y comandos

## Proponer y votar

`/aura usuario puntos motivo` crea una propuesta en el servidor actual. `puntos` es un entero entre -1000 y 1000, excluido 0; `motivo` debe tener entre 1 y 250 caracteres después de quitar espacios de los extremos. Se permite la postulación propia.

La propuesta aparece con botones para aprobar o desaprobar. Cada persona puede emitir un voto y cambiarlo mientras esté abierta. Quien propone y quien recibe el aura no pueden votar. Todos los votos cuentan en el total general. Los miembros del rol decisor guardado en cada propuesta también suman en el recuento especial del rol. Esta condición se toma al emitir o cambiar el voto; perder el rol después no la quita hasta volver a votar.

La propuesta se aprueba o rechaza cuando una opción reúne el umbral normal de votos del rol y empata o lidera el recuento general. Si esa opción va perdiendo en el total, necesita el umbral para imponerse. Este segundo umbral tiene precedencia. Si ambas opciones alcanzan el normal y el total general empata, sigue abierta hasta que se alcance otra condición. Tras el cierre no admite más votos. El mensaje final conserva ambos recuentos y explica cuál de sus umbrales decidió el resultado guardado. Los valores históricos son cuatro y seis. Las vencidas y canceladas muestran su estado sin atribuirlo a un umbral de votos.

Si no se alcanza un resultado, vence a las 24 horas sin cambiar el aura. El cron revisa las propuestas cada cinco minutos y marca las vencidas; un voto después del plazo tampoco cuenta aunque el cron aún no haya corrido. El lote de voto comprueba el vencimiento con el reloj de D1 al ejecutarse, antes de guardar el voto y resolver el cierre; si ya venció, no puede aprobarse ni reabrirse. El bot intenta quitar los botones del mensaje original y vuelve a intentarlo si Discord falla. Las propuestas creadas antes de guardar el ID del mensaje pueden quedar con botones visibles si nadie interactuó con ellas; al pulsarlos, el bot muestra que la votación venció.

## Configuración por servidor

`/config ver` muestra de forma privada el rol decisor, los umbrales y el canal de propuestas. Cualquier miembro puede consultarlo. `/config cambiar` exige el permiso Administrar servidor o Administrador, validado en el Worker, y confirma el resultado de forma privada.

Los parámetros opcionales son `rol`, `normal`, `imponerse`, `canal` y `canal_libre`. El rol debe ser una selección resuelta por Discord, distinta de @everyone. Los umbrales son enteros entre 1 y 100 y `imponerse` debe ser igual o mayor que `normal`. No se permite combinar `canal` con `canal_libre:true`; esta última opción elimina la restricción. Se conserva lo que no se indique. Se exige al menos un cambio y un rol para activar un servidor nuevo.

El canal elegido debe ser de texto o anuncios del mismo servidor. Antes de guardarlo se consultan en Discord el canal, los roles y el miembro bot para calcular sus permisos efectivos, incluyendo sobrescrituras: Ver canal, Enviar mensajes e Insertar enlaces, o Administrador. Si la validación falla no se guarda el cambio. La configuración requiere acceso a Discord cuando hay un canal restringido.

Cada servidor guarda sus valores en `guild_config`. Dos ediciones con la misma versión no se sobrescriben: la segunda recibe un aviso para volver a consultar. `guild_config_attempts` recuerda los intentos para que una reentrega no revierta una edición posterior.

Cada propuesta guarda su rol y umbrales en `proposal_rules` dentro del lote de creación. El INSERT comprueba el canal y el rol activos en ese mismo lote, por lo que un cambio concurrente no permite saltar la restricción. Votar, explicar el cierre y actualizar el mensaje usa esas reglas fijas, incluso si cambia `/config`. Las propuestas anteriores siguen en su canal original y se pueden votar o cancelar allí.

La migración crea las tablas sin borrar datos. Las propuestas heredadas conservan el rol `1431791263547392121` y los umbrales 4/6. Los servidores con propuestas existentes heredan esos mismos valores una sola vez, sin canal restringido; la marca `guild_config_v1` impide configurar automáticamente a servidores futuros. Un servidor nuevo muestra 4/6 como valores sugeridos y bloquea `/aura` hasta elegir un rol. `/info` muestra las reglas vigentes de su servidor; cada embed conserva las de su propia propuesta.

## Propuestas duplicadas

Dentro del mismo servidor se bloquea una nueva propuesta si existe otra abierta y sin vencer para el mismo destinatario con el mismo motivo. El motivo se guarda tras quitar espacios de los extremos; la comparación del texto almacenado es exacta, distingue mayúsculas, acentos y espacios interiores. Autor, canal y cantidad de puntos no forman parte de la clave. Una propuesta aprobada, rechazada, cancelada, vencida o abierta con el plazo ya pasado no bloquea una nueva.

La comprobación y la inserción se hacen en una sola sentencia de escritura de D1, dentro de un lote que registra el ID de la interacción en `proposal_creation_attempts`. Dos envíos paralelos producen una sola propuesta y una advertencia para el otro. Reentregar una creación ya aceptada conserva la misma propuesta; reentregar una creación rechazada por duplicado no crea otra aunque la anterior ya haya cerrado. Para iniciar otra después del cierre se necesita una interacción nueva. Las propuestas duplicadas existentes antes de esta regla se conservan con sus votos; el índice de búsqueda no es único y no borra ni cierra datos heredados.

## Cancelar una propuesta

El botón «Cancelar propuesta» permite a quien la creó retirarla mientras siga abierta y no haya vencido. El rol de votación o ser la persona que recibe los puntos no otorgan ese permiso. Se comprueban el servidor y el creador tanto al leer la propuesta como al guardar la cancelación. No se puede cancelar una propuesta aprobada, rechazada o vencida.

La cancelación cambia el estado a `cancelled`, conserva los votos y el motivo, no modifica el aura ni el historial de aprobaciones, y actualiza el mensaje a «Cancelada sin cambiar el aura» sin botones. No publica un aviso separado de aprobación o rechazo. Repetir la cancelación no vuelve a cambiar el estado. Si coincide con el voto decisivo, prevalece la primera transición de estado confirmada en D1; una cancelación no revierte una aprobación y un voto no reabre una propuesta cancelada. Si el plazo ya pasó, prevalece el vencimiento.

La preparación solicita una sola vez actualizar los mensajes abiertos anteriores para agregar el botón, mediante la marca `cancel_button_v1` en `bot_settings`. El cron o la siguiente escritura activan esa preparación; la entrega depende del sincronizador y del acceso a Discord.

## Respuestas a interacciones

Después de verificar la firma, `/aura`, `/perfil`, `/historial`, `/votaciones`, `/ranking`, `/config` y `/info` en servidores reconocen la interacción de inmediato con una respuesta diferida, antes de acceder a D1. El resultado completa la respuesta original en segundo plano. `/info` en mensajes directos conserva una guía general sin consultar la base. En un servidor consulta la configuración con respuesta diferida. `/config` difiere con visibilidad efímera, también cuando luego hay un error. Los errores de entrada que se detectan sin D1 siguen siendo efímeros; los errores posteriores de un comando se muestran en su respuesta diferida pública. Los botones válidos se reconocen antes de consultar D1 y los errores de voto se informan mediante un aviso efímero, sin reemplazar la votación.

La preparación de tablas y la migración de votos se comparten una vez por binding de D1 en cada instancia del Worker, antes de las escrituras. Un fallo permite reintentar la preparación. Las consultas de perfil e historial no esperan esta migración; `/info` y `/config` sí necesitan la preparación de configuración en segundo plano.

La propuesta usa el ID de la interacción de creación; una entrega repetida de la misma interacción conserva una única propuesta. D1 guarda los IDs de votos procesados en `vote_interactions` dentro del mismo lote que el voto: repetir una entrega no vuelve a aplicarla ni deshace un cambio posterior de voto o de rol. Ejecutar un comando nuevo con otro ID intenta crear otra propuesta, sujeta a la comprobación de duplicados abiertos.

El trabajo en segundo plano tiene un plazo de veinte segundos para informar un fallo o resultado incierto. El timeout no cancela una escritura ya enviada a D1; puede completarse después. En ese caso se recomienda consultar `/perfil` antes de repetir el comando. La entrega del resultado requiere que Discord acepte el webhook de la interacción y está sujeta a los límites de ejecución del Worker. No se repiten automáticamente escrituras con un ID nuevo.

## Sincronización del mensaje

Los votos válidos se confirman sin editar el mensaje desde la respuesta de la interacción. El lote de D1 guarda también una revisión pendiente en `proposal_message_sync`. El Durable Object `ProposalMessageSync`, enlazado como `MESSAGE_SYNC` y separado por ID de propuesta, es el único que edita el mensaje de la votación. Procesa las ediciones en serie y consulta en una sola lectura de D1 el estado, ambos recuentos y la revisión. Si llegan votos durante una edición, vuelve a leer y publica la revisión nueva después de terminar la anterior. Así una respuesta antigua de un voto no puede restaurar los botones de una votación ya cerrada en el mensaje.

El cron envía hasta veinte sincronizaciones pendientes por ejecución; el vencimiento también pasa por este mismo flujo. Los errores conservan la revisión pendiente y el 429 respeta el plazo de reintento de Discord. Si falta el token o el ID del mensaje, la edición espera hasta que estén disponibles. Un mensaje eliminado (404) se considera atendido para esa revisión. La tabla anterior `proposal_expiry_sync` se conserva por compatibilidad, pero ya no dirige las ediciones. Al recuperar el ID original se solicita una sincronización del estado actual. La corrección visual requiere `DISCORD_BOT_TOKEN`, permisos en el canal y el binding `MESSAGE_SYNC`; puede demorarse durante fallos de Discord y no recrea mensajes eliminados.

## Avisos de cierre

Al aprobarse o rechazarse una propuesta, el bot publica un aviso en su mismo canal. Indica la persona afectada y los puntos con signo si se aprueba; si se rechaza, aclara que su aura no cambia. Las menciones no generan notificaciones. Las propuestas vencidas solo actualizan el mensaje original. El bot necesita el permiso Send Messages además de View Channels.

D1 guarda un único aviso por propuesta dentro del lote de cierre. El envío se inicia en segundo plano y el cron procesa hasta veinte avisos pendientes por ejecución; no se anuncian cierres históricos al crear la tabla. Una reserva condicional evita que dos ejecuciones envíen el mismo aviso. Un 429 se reintenta después del plazo indicado por Discord. Si la respuesta se pierde, Discord devuelve otro error o el proceso se interrumpe tras reservar el envío, no se reenvía automáticamente: podría haberse publicado. Esos casos requieren revisar el canal y el estado `sending` o `uncertain` de `proposal_notifications`. Puede faltar un aviso; el aura y el cierre permanecen guardados y no dependen de la entrega.

## Consultar

- `/perfil [usuario]` muestra aura total, cantidad de cambios recibidos aprobados y rechazados, propuestas abiertas, votos registrados y los cinco cambios aprobados más recientes. La evolución muestra los últimos cinco cambios aprobados en orden de creación ascendente (desempate por ID), con saldo acumulado desde la primera aprobación, no solo desde los cinco visibles. No representa la hora de aprobación porque ese dato no se guarda. Los votos registrados cuentan una vez por propuesta con un voto conservado de esa persona, incluso en propuestas cerradas; cambiar el voto no suma otro. Todos los datos se limitan al servidor consultado. Sin `usuario`, muestra el perfil de quien ejecuta el comando.
- `/historial [usuario] [pagina]` lista cambios aprobados con puntos, motivo, fecha y proponente, ocho por página. Sin `usuario`, muestra el historial propio; la primera página es la predeterminada.
- `/votaciones [usuario] [pagina]` lista todas las propuestas dirigidas a esa persona en el servidor, no las creadas por ella para terceros. Sin usuario consulta a quien ejecuta el comando. Incluye aprobadas, rechazadas, abiertas, vencidas y canceladas, con puntos propuestos, motivo, fecha de creación y proponente. Ordena por creación e ID descendentes, ocho por página; páginas enteras entre 1 y 1000000. Una propuesta abierta fuera de plazo se muestra como vencida aunque el cron no haya corrido, sin escribir su estado. No altera aura, votos ni propuestas. El mensaje indica cuando no hay resultados o la página no existe.
- `/ranking` muestra hasta diez usuarios con propuestas aprobadas en el servidor actual, ordenados por la suma de aura descendente. Incluye totales cero y negativos. Los empates comparten puesto (1, 1, 3) y se ordenan por ID de usuario ascendente; el límite sigue siendo diez entradas aunque corte un empate. Se muestran menciones sin generar notificaciones. Si no hay aprobaciones, indica que no hay datos.
- `/info` explica dentro de Discord los comandos y las reglas de votación.

El aura total suma solo propuestas aprobadas. Las consultas se separan por servidor. D1 guarda IDs de servidor y usuarios, puntos, motivos y votos. `created_at` guarda la fecha de creación en segundos Unix y ordena el historial y los últimos movimientos del perfil, con el ID descendente como desempate. `expires_at` se reserva para el vencimiento. Las propuestas nuevas guardan ambas fechas al crearse; repetir su interacción no las modifica.

La migración añade `created_at` si falta y completa solo valores nulos con `expires_at - 86400`, conservando la fecha que ya se mostraba para datos antiguos. Puede repetirse y admite la carrera entre instancias que intentan añadir la columna. Las lecturas no ejecutan esa migración: antes de que exista la columna usan el cálculo heredado y después usan `COALESCE(created_at, expires_at - 86400)` para soportar filas de versiones anteriores. El índice de historial se crea durante la migración, después de añadir la columna; aplicar de nuevo `schema.sql` sobre una base antigua sigue siendo seguro.

Los límites y comprobaciones conocidos están en [`QUALITY.md`](../../QUALITY.md). Las mejoras pendientes se registran en [`docs/tasks/`](../tasks/README.md).

## Diagnóstico operativo

`/health` devuelve únicamente `{"status":"ok"}`; confirma la respuesta HTTP del Worker sin publicar configuración ni consultar D1. Los logs de aplicación usan eventos JSON con área (`d1`, `discord`, `validation`, `config` o `worker`), códigos fijos y estado HTTP cuando corresponde. No incluyen errores crudos, URLs, tokens, motivos ni IDs. El registro de comandos distingue alta correcta, lista ya actualizada, falta de token y errores. La [guía de operación](../operations/cloudflare.md) explica los códigos y cómo recuperar el servicio. Las invocaciones automáticas no se registran en la configuración de observabilidad; sí los eventos de aplicación.

## Panel de administración

`/moderar` es exclusivo de personas con Administrador, comprobado por el permiso 8 en cada solicitud y oculto por defecto al resto en el registro del comando. Administrar servidor por sí solo permite configurar el bot, pero no usar este panel. El panel se limita al servidor de la interacción y difiere todas sus respuestas como efímeras.

Incluye `listar` (filtros de destinatario y estado), `inspeccionar`, `cancelar`, `sincronizar` y `acciones` (auditoría por propuesta opcional). Listas y auditoría se paginan de a ocho con orden estable y límites de Discord. Las consultas muestran como vencidas las abiertas cuyo plazo ya pasó, sin escribir su estado; la inspección aclara el estado guardado si aún está pendiente el cron. Los IDs se pueden copiar desde el panel. La inspección no incluye los botones públicos de votación.

Cancelar permite a un administrador retirar una propuesta ajena abierta y sin vencer, sin modificar puntos ni borrar votos. Exige motivo y `confirmar:true`; si se omite la confirmación, devuelve una vista previa sin aplicar la acción. El lote de D1 guarda auditoría y cambio de estado de forma atómica; una carrera con el voto decisivo conserva la primera transición confirmada. No se puede cancelar una aprobada para revertir sus puntos en esta versión.

Sincronizar también exige confirmación y registra que se solicitó actualizar el mensaje, no que Discord lo haya entregado. Usa el sincronizador por propuesta y sus reintentos; no cambia votos ni reenvía avisos de cierre. Requiere un ID de mensaje original conocido.

`admin_actions` conserva un registro por interacción con servidor, propuesta, administrador, acción, motivo, fecha y estados. Reentregar una acción no duplica el registro ni su cambio. El motivo administrativo se muestra solo a administradores en la auditoría, no en el mensaje público ni en los logs. Ajustar puntos por la fuerza y retirar propuestas aprobadas del historial corresponde a B10-020. La [guía del panel](../operations/moderation.md) contiene ejemplos.
