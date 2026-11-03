# Operar Ben10 en Cloudflare

## Salud pública y diagnóstico privado

`GET /health` devuelve únicamente `{"status":"ok"}` con HTTP 200. Confirma que el Worker responde; no consulta D1 ni comprueba el token, el registro de comandos o los permisos de Discord. Ya no publica presencia de secretos, IDs ni longitudes de claves. Una solicitud sin firma a `/interactions` debe responder 401, sin tocar los datos.

En Cloudflare abrí **Workers & Pages → ben10 → Observability → Logs**. La configuración del repositorio activa los logs de aplicación y desactiva el registro automático de invocaciones. Buscá los campos `event`, `area`, `code` y `status` de los registros JSON. Para ver eventos en vivo desde una terminal autenticada, usá `npx wrangler tail ben10 --format pretty`. No hace falta generar una propuesta para comprobar las lecturas: `/perfil` y `/historial` ejercitan D1.

Los logs del código no incluyen tokens, claves, URLs de webhooks, cabeceras, cuerpos, motivos, IDs de usuarios o propuestas, ni errores crudos. La plataforma y las herramientas de terceros pueden presentar metadatos adicionales; no publiques capturas o volcados que contengan credenciales. Consultar los logs y desplegar requieren acceso a la cuenta correcta de Cloudflare.

| Código o evento | Significado y acción |
| --- | --- |
| `SIGNATURE_DATA_MISSING`, `SIGNATURE_INVALID`, `SIGNATURE_OR_BODY_INVALID`, `SIGNATURE_TIMESTAMP_INVALID` | Validación rechazada. Un POST manual sin firma produce estos eventos de forma esperada. Si ocurre con Discord, verificá su clave pública en la configuración del Worker y el endpoint de la aplicación. |
| `D1_FAILURE` con `DATABASE_PREPARATION_FAILED`, `INTERACTION_FAILED` u otro evento | Falló una operación de D1. Revisá el binding `DB`, el destino de la base y su disponibilidad; las migraciones se reintentan tras un fallo. No borres tablas ni restaures datos como primer paso. |
| `COMMANDS_TOKEN_MISSING`, `MESSAGE_SYNC_TOKEN_MISSING` | Falta el secreto del bot en esa versión del Worker. Configuralo en producción; `/health` no revela su presencia. |
| `CONFIG_TOKEN_MISSING`, `CONFIG_DISCORD_LOOKUP_FAILED` | No se pudo validar el canal para un cambio de configuración. Revisá el token, el estado HTTP y acceso del bot al servidor/canal; el cambio no se aplica sin validar permisos. |
| `MESSAGE_SYNC_BINDING_MISSING` | El despliegue no tiene el binding del Durable Object declarado en `wrangler.toml`. Revisá la configuración y la migración del despliegue. |
| `COMMANDS_REGISTERED` | Discord aceptó el registro completo y D1 guardó la versión. |
| `COMMANDS_CURRENT` | Se consultó Discord y los comandos esperados ya están presentes. |
| `COMMANDS_SYNC_FAILED` | Revisá `area`, `code` y `status` del mismo registro para distinguir D1 de Discord. |
| `DISCORD_COMMAND_LOOKUP_FAILED`, `DISCORD_COMMAND_REGISTER_FAILED`, `DISCORD_WEBHOOK_FAILED`, `DISCORD_MESSAGE_EDIT_FAILED` | Discord rechazó una consulta o escritura. 401 indica autenticación inválida; 403 suele indicar falta de permiso; 429 requiere esperar; 5xx indica un fallo del servicio. El estado HTTP queda en `status`; no se imprime el cuerpo de error. |
| `DISCORD_NETWORK_FAILURE`, `DISCORD_RESPONSE_INVALID` | Falló el transporte o la respuesta no tiene el formato esperado. Revisá conectividad y estado de Discord; no interpretes esto automáticamente como token ausente. |
| `INTERACTION_TIMEOUT` | La operación superó veinte segundos. La escritura puede terminar después; consultá `/perfil` antes de ejecutar un comando nuevo. Reentregar la misma interacción conserva su ID y no duplica el cambio. |
| `DISCORD_MESSAGE_RATE_LIMITED`, `DISCORD_NOTICE_RATE_LIMITED` | El proceso conserva la espera indicada por Discord antes de reintentar. |
| `MESSAGE_SYNC_PENDING`, `MESSAGE_SYNC_RETRY_FAILED`, `ADMIN_MESSAGE_SYNC_PENDING` | Queda una revisión de mensaje pendiente. El cron vuelve a procesarla; comprobá token, binding y permisos del canal. Un mensaje eliminado no se recrea. |
| `CLOSURE_NOTICE_REVIEW_REQUIRED`, `CLOSURE_NOTICE_UNCERTAIN` | La entrega del aviso puede haberse realizado. Revisá el canal y `proposal_notifications`; no restablezcas el aviso a pendiente sin confirmar que falta, para evitar duplicados. |
| `UNEXPECTED_ERROR` | Error no clasificado. No se imprime su contenido; reproducilo con las pruebas locales y acotá el evento que lo identifica. |

## Recuperar el servicio después de rotar el token

1. En **Discord Developer Portal → Ben 10 → Bot**, regenerá el token cuando corresponda. No lo pegues en el chat, el repositorio, los logs ni una línea de comandos guardada en el historial.
2. En **Cloudflare → ben10 → Settings → Variables and Secrets**, actualizá `DISCORD_BOT_TOKEN` como secreto en producción y guardá/aplicá la versión correspondiente. Como alternativa desde una terminal autenticada, `npx wrangler secret put DISCORD_BOT_TOKEN` pide el valor de forma interactiva. Este paso modifica producción; no es parte de las pruebas locales.
3. Conservá el Application ID y la clave pública de firmas de Discord; son distintos del Bot Token. Confirmá que la versión activa conserve `DB`, `MESSAGE_SYNC` y el cron de cinco minutos.
4. Ejecutá `/perfil` o esperá la siguiente ejecución del cron. Buscá `COMMANDS_REGISTERED` o `COMMANDS_CURRENT`, y verificá que no persistan errores 401. No basta con obtener 200 en `/health`.
5. Comprobá **View Channels**, **Send Messages** y **Embed Links** en el canal y los permisos del rol de votación. Si falta un comando, el proceso automático vuelve a registrar la lista completa al detectarlo; no hace falta copiar el token a GitHub.
6. Verificá `/info`, `/perfil` e `/historial` en Discord. En un canal de prueba autorizado, comprobá el cierre y la cancelación de propuestas. Las revisiones de mensaje pendientes se recuperan por cron; los avisos ambiguos requieren revisión antes de reenviarlos.

No se necesita un token real para `npm test` ni para los scripts locales de workerd: usan claves generadas y respuestas de Discord simuladas. La validación de producción se registra por separado en [B10-006](../tasks/B10-006.md).

El [panel privado de administración](moderation.md) permite solicitar una sincronización del mensaje original sin modificar el resultado ni reenviar avisos de cierre. Si una acción devuelve resultado incierto, revisá `/moderar acciones` antes de repetirla.
