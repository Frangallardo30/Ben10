# Panel de administración en Discord

El comando `/moderar` exige el permiso **Administrador** (no alcanza Administrar servidor). La comprobación se hace también en el Worker, aunque alguien cambie la visibilidad del comando en Discord. Todas las respuestas del panel son privadas y no generan menciones.

| Acción | Uso |
| --- | --- |
| `/moderar listar` | Muestra propuestas de este servidor y sus IDs. Permite filtrar por destinatario, estado y página; ocho por página. |
| `/moderar inspeccionar propuesta:ID` | Muestra estado, votos, reglas originales, proponente y vencimiento sin botones de votación. No cambia datos. |
| `/moderar cancelar propuesta:ID motivo:...` | Presenta una vista previa. Para ejecutar, repetí el comando con el mismo ID, un motivo de 3–250 caracteres y `confirmar:true`. Solo cancela propuestas abiertas sin vencer. |
| `/moderar sincronizar propuesta:ID` | Presenta una vista previa. Con `confirmar:true` solicita actualizar el mensaje original desde D1. Puede incluir un motivo privado; requiere que se haya guardado el ID original del mensaje. |
| `/moderar ajustar usuario:... puntos:-100 motivo:...` | Prepara sumar o restar puntos sin votación. Entre -1000000 y 1000000, excepto cero. |
| `/moderar anular propuesta:ID motivo:...` | Prepara retirar un registro y deshacer sus puntos si estaba aprobado. |
| `/moderar anular_varias propuestas:ID1,ID2 motivo:...` | Selecciona hasta diez IDs; el lote se aplica completo o no se aplica. |
| `/moderar anular_ultima usuario:... motivo:...` | Prepara retirar la última propuesta visible recibida por esa persona, fijando el ID en la vista previa. |
| `/moderar confirmar codigo:...` | Confirma una vista previa propia aún vigente; también se puede usar su botón privado. |
| `/moderar operacion codigo:...` | Consulta selección, efecto, motivo y resultado de una operación del servidor. |
| `/moderar acciones` | Consulta la auditoría del servidor, ocho acciones por página. Permite filtrar por ID de propuesta. |

Copiá el ID desde la lista o la inspección. Antes de confirmar, revisá destinatario y estado. Ajustar y anular requieren una vista previa y una confirmación propias. Cancelar una abierta conserva sus votos, retira sus botones y no afecta al aura. Si otra persona termina la votación primero, la cancelación no revierte el resultado.

Las cancelaciones exitosas y las solicitudes de sincronización se guardan en `admin_actions` con actor, fecha, motivo y estados. Las vistas previas de ajustes y anulaciones se conservan en `admin_operations`; solo las aplicadas aparecen en `/moderar acciones`. La auditoría no está disponible para miembros sin Administrador ni se comparte entre servidores. El motivo administrativo permanece en esta vista privada y no se añade al mensaje público ni a los logs.

La sincronización es una solicitud, no una confirmación de entrega de Discord. Si falla, la revisión queda pendiente para el cron. No reenvía el aviso separado de cierre ni modifica votos o puntos. Consultá [la guía de Cloudflare](cloudflare.md) si el mensaje sigue desactualizado. El panel no recrea mensajes eliminados ni recupera un ID original que no se guardó.

Para deshacer una resta de prueba, ejecutá `/moderar anular_ultima usuario:tu_amigo motivo:Prueba incorrecta`, revisá el ID y el efecto positivo en la vista previa y pulsá **Confirmar operación**. Si no es la propuesta buscada, descartá y elegí su ID desde `/moderar listar`. Anular una resta de -100 devuelve 100 sin agregar una compensación al historial. La propuesta deja de aparecer en `/historial` y `/votaciones`; las estadísticas y el ranking se recalculan.

La selección vence en diez minutos y no cambia aunque aparezcan propuestas nuevas. Solo quien creó la vista puede confirmarla y debe conservar Administrador. Si cambia algún registro seleccionado, no se aplica nada: prepará otra vista. Repetir la confirmación no duplica efectos. Los motivos siguen siendo privados; los ajustes se identifican públicamente como administrativos con un motivo genérico.

Se conservan indefinidamente los registros, votos y auditoría privados. La anulación oculta del historial público y retira su efecto; no realiza un borrado físico. Neutraliza el mensaje original y el aviso de cierre cuando sus IDs están guardados; los pendientes se cancelan. No puede eliminar copias o neutralizar automáticamente un aviso de entrega incierta cuyo ID no se guardó. La corrección del aura es inmediata en D1; la actualización de mensajes depende de Discord y puede demorarse. Si falta el ID original pero se conoce el del aviso, el cron también reintenta ese aviso.
