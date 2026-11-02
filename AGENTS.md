# Trabajo en Ben10Bot

- Antes de implementar una tarea, leer `docs/tasks/README.md` y su archivo `B10-nnn.md`.
- Crear tareas nuevas a partir de `docs/tasks/TEMPLATE.md` y añadirlas al índice.
- Al terminar un cambio, actualizar estado, criterios, implementación y validación con evidencia concreta. Distinguir pruebas locales de comprobaciones en Cloudflare y Discord.
- Ejecutar `npm test` para cambios de lógica y `npx wrangler deploy --dry-run` para cambios del Worker. Registrar cualquier limitación real en la tarea.
- No incluir Bot Tokens ni otros secretos en código, capturas, tareas o logs.
