# Trabajo con Codex en Ben10Bot

Leer `.codex/README.md` al iniciar trabajo en este repositorio. El comportamiento vigente está en `docs/specs/` y el motivo de cada cambio en `docs/tasks/`.

## Pautas permanentes

- Para un pedido nuevo o una corrección, abrir o actualizar una tarea `B10-nnn` desde `docs/tasks/TEMPLATE.md` y mantener el índice. Ponerla `En curso` antes de implementar y `Hecha` solo con criterios y validación reales. Al marcarla `Hecha`, mover el archivo a `docs/tasks/complete/` y actualizar los enlaces del índice y otras referencias. Si se reabre, devolverla a `docs/tasks/` conservando su ID. Seguir `.codex/workflows/tasks.md`.
- Leer la especificación del área antes de cambiar su comportamiento y actualizarla en el mismo cambio. No convertir la spec en un historial de commits.
- Para cambios de lógica, ejecutar `npm test`; para cambios del Worker, además `npx wrangler deploy --dry-run`. Documentar resultados y límites en la tarea. Las pruebas locales no prueban el despliegue ni la interacción real con Discord.
- Usar consultas preparadas de D1; validar las interacciones firmadas de Discord; no publicar tokens, secretos, motivos sensibles ni trazas internas.
- Mantener separado el bot de aura `Frangallardo30/Ben10` del bot de música `Frangallardo30/FrangaDJ`. El destino de Ben10 es Cloudflare Workers con D1.
- Antes de publicar, revisar el diff, comprobar que no haya secretos y respetar la autorización vigente del usuario. No hacer force push.
