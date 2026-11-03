# Panel de administración en Discord

El comando `/moderar` exige el permiso **Administrador** (no alcanza Administrar servidor). La comprobación se hace también en el Worker, aunque alguien cambie la visibilidad del comando en Discord. Todas las respuestas del panel son privadas y no generan menciones.

| Acción | Uso |
| --- | --- |
| `/moderar listar` | Muestra propuestas de este servidor y sus IDs. Permite filtrar por destinatario, estado y página; ocho por página. |
| `/moderar inspeccionar propuesta:ID` | Muestra estado, votos, reglas originales, proponente y vencimiento sin botones de votación. No cambia datos. |
| `/moderar cancelar propuesta:ID motivo:...` | Presenta una vista previa. Para ejecutar, repetí el comando con el mismo ID, un motivo de 3–250 caracteres y `confirmar:true`. Solo cancela propuestas abiertas sin vencer. |
| `/moderar sincronizar propuesta:ID` | Presenta una vista previa. Con `confirmar:true` solicita actualizar el mensaje original desde D1. Puede incluir un motivo privado; requiere que se haya guardado el ID original del mensaje. |
| `/moderar acciones` | Consulta la auditoría del servidor, ocho acciones por página. Permite filtrar por ID de propuesta. |

Copiá el ID desde la lista o la inspección. Antes de confirmar, revisá destinatario y estado. El panel no aprueba ni rechaza por la fuerza, no ajusta puntos y no borra datos. Cancelar una abierta conserva sus votos, retira sus botones y no afecta al aura. Si otra persona termina la votación primero, la cancelación no revierte el resultado.

Las cancelaciones exitosas y las solicitudes de sincronización se guardan en `admin_actions` con actor, fecha, motivo y estados. Las consultas y vistas previas no generan una acción. La auditoría no está disponible para miembros sin Administrador ni se comparte entre servidores. El motivo administrativo permanece en esta vista privada y no se añade al mensaje público ni a los logs.

La sincronización es una solicitud, no una confirmación de entrega de Discord. Si falla, la revisión queda pendiente para el cron. No reenvía el aviso separado de cierre ni modifica votos o puntos. Consultá [la guía de Cloudflare](cloudflare.md) si el mensaje sigue desactualizado. El panel no recrea mensajes eliminados ni recupera un ID original que no se guardó.

Los ajustes forzados y retirar propuestas del historial visible quedan para [B10-020](../tasks/B10-020.md). Esa tarea incluye deshacer el efecto de una propuesta aprobada —por ejemplo, devolver una resta de prueba— y quitarla del historial visible, individualmente o mediante una selección múltiple confirmada, conservando una auditoría privada.
