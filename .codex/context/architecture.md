# Arquitectura

- `src/index.js`: rutas del Worker, firma de Discord, comandos, botones y registro programado de comandos.
- `src/commands.js`: definición de comandos slash.
- `src/voting.js`: reglas y consultas de voto/cierre.
- `schema.sql`: esquema inicial de D1; el Worker también gestiona compatibilidad con datos anteriores.
- `wrangler.toml`: configuración pública del Worker, aplicación, D1 y cron. `DISCORD_BOT_TOKEN` va como secreto en Cloudflare.
- `test/`: pruebas locales. `QUALITY.md`: cobertura, comprobación manual y límites conocidos.

El comportamiento actual se describe en [`docs/specs/aura.md`](../../docs/specs/aura.md). La tarea correspondiente explica el motivo de cada cambio; la spec describe cómo funciona ahora.
