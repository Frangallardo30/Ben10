# Ben10Bot

Bot de aura para Discord, pensado para el servidor de amigos. Usa Cloudflare Workers para recibir comandos y botones, y Cloudflare D1 para guardar las propuestas y los votos. No necesita un proceso encendido todo el día ni una clave de YouTube.

## Cómo funciona

- `/aura usuario:@Fran puntos:-100 motivo:Perdió una partida` publica una propuesta con botones 👍 **Aprobar** y 👎 **Desaprobar**.
- Cada miembro puede votar una vez y cambiar su voto durante 24 horas. Quien propone y quien recibe los puntos no votan.
- Al terminar las 24 horas, se aprueba si hay más votos a favor que en contra. Un empate rechaza la propuesta. La tarea programada revisa los resultados cada cinco minutos.
- `/perfil usuario:@Fran` muestra el total de aura y los últimos cinco cambios aprobados. Sin usuario, muestra tu perfil.

## Preparación

Necesitás una cuenta gratuita de Cloudflare y la aplicación de Discord **Ben 10** (`1417570023370653836`). Cloudflare puede cambiar límites y requisitos de su plan gratuito; revisalos al crear la cuenta. El bot requiere **Guild Install** con `applications.commands` y permiso **View Channels** para editar el mensaje al cerrar la votación.

1. Instalá Node.js 20 o posterior. En este directorio, ejecutá `npm install` y `npx wrangler login`.
2. Creá la base: `npx wrangler d1 create ben10bot`. Copiá el `database_id` devuelto a `wrangler.toml`.
3. Aplicá el esquema: `npx wrangler d1 execute ben10bot --remote --file=schema.sql`.
4. Configurá tres secretos con `npx wrangler secret put NOMBRE` para `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` y `DISCORD_APPLICATION_ID`. La clave pública y el Application ID están en **General Information**; el token está en **Bot**. Para `DISCORD_APPLICATION_ID`, ingresá `1417570023370653836`. Guardá el token fuera del repositorio y no lo compartas por chat.
5. Ejecutá `npm run deploy`. Copiá la URL `https://ben10bot.<tu-subdominio>.workers.dev/interactions`.
6. En **Discord Developer Portal → Ben 10 → General Information**, pegá esa URL en **Interactions Endpoint URL** y guardá. Discord verificará la firma y la respuesta del endpoint.
7. Registrá los comandos desde tu terminal con el token en una variable privada: `DISCORD_BOT_TOKEN=... npm run register`. No guardes ese comando con el valor real en archivos ni en el historial del shell.
8. Invitá el bot al servidor con [esta URL](https://discord.com/oauth2/authorize?client_id=1417570023370653836&scope=bot%20applications.commands&permissions=1024).

Para probar, usá `/aura` en un canal de texto y votá con otra cuenta. La primera actualización de `/perfil` llega después de las 24 horas si la propuesta gana. El Worker responde solo a solicitudes firmadas por Discord.

## Datos

El bot guarda IDs de servidor y usuario, motivo, puntos y votos en D1. El puntaje se calcula a partir de propuestas aprobadas. Para eliminar estos datos, borrá la base D1 desde tu cuenta Cloudflare.
