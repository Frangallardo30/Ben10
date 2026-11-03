# Ben10Bot

Bot de aura para Discord, pensado para el servidor de amigos. Usa Cloudflare Workers para recibir comandos y botones, Cloudflare D1 para guardar las propuestas y los votos, y un Durable Object por propuesta para sincronizar las ediciones del mensaje. No necesita un proceso encendido todo el día ni una clave de YouTube.

Las pruebas y los límites conocidos están en [Revisión de funcionamiento](QUALITY.md). Para ejecutarlas necesitás Node.js 24 o posterior: `npm ci && npm test`.

El seguimiento del proyecto está en la [lista de tareas](docs/tasks/README.md). Cada tarea usa la [plantilla](docs/tasks/TEMPLATE.md) compartida con FrangaFlix. Las [pautas para trabajar con Codex](.codex/README.md) y la [especificación vigente](docs/specs/README.md) acompañan ese seguimiento.

## Cómo funciona

- `/aura usuario:@Fran puntos:-100 motivo:Perdió una partida` publica una propuesta con botones 👍 **Aprobar** y 👎 **Desaprobar**. También podés postular tu propia aura.
- Todos pueden votar y sus votos aparecen en el recuento. Los votos de miembros con el rol `1431791263547392121` también aparecen en un recuento separado. Quien propone y quien recibe los puntos no pueden votar; cada persona puede cambiar su voto mientras la propuesta esté abierta.
- La votación se cierra con **cuatro votos iguales del rol** si esa opción empata o lidera el total general. Si va perdiendo en el total, necesita **seis votos iguales del rol** para imponerse. Los votos del resto siempre cuentan en el total y pueden cambiar cuándo se alcanza el cierre. Si no hay resultado, vence a las 24 horas sin cambiar el aura.
- `/perfil usuario:@Fran` muestra el total de aura y los últimos cinco cambios aprobados. Sin usuario, muestra tu perfil.
- `/historial usuario:@Fran pagina:1` muestra todos los cambios aprobados, con puntos, motivos, fecha y quién los propuso. Hay ocho movimientos por página; sin usuario, muestra tu historial.
- `/info` explica los comandos y las reglas de votación dentro de Discord.

## Preparación

Necesitás una cuenta gratuita de Cloudflare y la aplicación de Discord **Ben 10** (`1417570023370653836`). Cloudflare puede cambiar límites y requisitos de su plan gratuito; revisalos al crear la cuenta. El bot requiere **Guild Install** con `applications.commands` y permisos **View Channels** y **Send Messages** para actualizar la votación y publicar el aviso de cierre.

### Desde el navegador, sin instalar nada

1. En Cloudflare **D1 SQL Database → ben10bot → Console**, copiá las tres instrucciones `CREATE TABLE` y la instrucción `CREATE INDEX` de [`schema.sql`](schema.sql). Ejecutalas una por una. Si indica que la tabla ya existe, podés continuar.
2. En **Workers y Pages → Crear aplicación**, elegí crear un **Worker** desde un repositorio de GitHub y seleccioná `Frangallardo30/Ben10`. Si pide un comando de despliegue, usá `npx wrangler deploy`; el directorio raíz es `/`.
3. El binding `MESSAGE_SYNC` y la migración del Durable Object están declarados en `wrangler.toml` y se crean al desplegar con Wrangler. La Public Key y el Application ID ya están declarados en `wrangler.toml`. En el Worker `ben10`, abrí **Settings → Variables and Secrets** y agregá `DISCORD_BOT_TOKEN` como secreto de producción. El token está en la sección **Bot** de Discord. No lo guardes en archivos del repositorio ni lo pegues en el chat.
4. En **Discord Developer Portal → Ben 10 → General Information**, guardá `https://ben10.<tu-subdominio>.workers.dev/interactions` como **Interactions Endpoint URL**. Usá la URL exacta que Cloudflare muestre para tu Worker.
5. El Worker registra `/aura`, `/perfil`, `/historial` y `/info` automáticamente cuando Discord verifica el endpoint o cuando se ejecuta la tarea programada (cada cinco minutos). No hace falta copiar el token a GitHub. Los comandos globales pueden tardar un poco más en aparecer en el servidor.

El endpoint no necesita que mantengas una computadora encendida. Los secretos se guardan en Cloudflare y nunca en GitHub.

### Desde una terminal propia

1. Instalá Node.js 20 o posterior. En este directorio, ejecutá `npm install` y `npx wrangler login`.
2. La base D1 `ben10bot` ya está creada y su ID figura en `wrangler.toml`.
3. Si usás una terminal, también podés aplicar el esquema con `npx wrangler d1 execute ben10bot --remote --file=schema.sql`.
4. Configurá `DISCORD_BOT_TOKEN` con `npx wrangler secret put DISCORD_BOT_TOKEN`. La Public Key y el Application ID ya están en `wrangler.toml`. Guardá el token fuera del repositorio y no lo compartas por chat.
5. Ejecutá `npm run deploy`. Copiá la URL `https://ben10.<tu-subdominio>.workers.dev/interactions`.
6. En **Discord Developer Portal → Ben 10 → General Information**, pegá esa URL en **Interactions Endpoint URL** y guardá. Discord verificará la firma y la respuesta del endpoint.
7. Registrá los comandos desde tu terminal con el token en una variable privada: `DISCORD_BOT_TOKEN=... npm run register`. No guardes ese comando con el valor real en archivos ni en el historial del shell.
8. Invitá el bot al servidor con [esta URL](https://discord.com/oauth2/authorize?client_id=1417570023370653836&scope=bot%20applications.commands&permissions=3072).

Para probar, usá `/aura` en un canal de texto y votá con miembros del rol y sin él. `/perfil` se actualiza cuando cuatro miembros del rol votan positivo. El Worker responde solo a solicitudes firmadas por Discord.
Los votos de propuestas abiertas bajo la regla anterior se conservan; sus votos del rol se trasladan al recuento especial.

## Datos

El bot guarda IDs de servidor y usuario, motivo, puntos y votos en D1. El puntaje se calcula a partir de propuestas aprobadas. Para eliminar estos datos, borrá la base D1 desde tu cuenta Cloudflare.
