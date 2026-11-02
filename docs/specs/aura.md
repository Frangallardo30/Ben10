# Aura y comandos

## Proponer y votar

`/aura usuario puntos motivo` crea una propuesta en el servidor actual. `puntos` es un entero entre -1000 y 1000, excluido 0; `motivo` debe tener entre 1 y 250 caracteres después de quitar espacios de los extremos. Se permite la postulación propia.

La propuesta aparece con botones para aprobar o desaprobar. Cada persona puede emitir un voto y cambiarlo mientras esté abierta. Quien propone y quien recibe el aura no pueden votar. Todos los votos cuentan en el total general. Los miembros del rol `1431791263547392121` también suman en el recuento especial del rol. Esta condición se toma al emitir o cambiar el voto; perder el rol después no la quita hasta volver a votar.

La propuesta se aprueba o rechaza cuando una opción reúne cuatro votos del rol y empata o lidera el recuento general. Si esa opción va perdiendo en el total, necesita seis votos del rol para imponerse. Seis votos del rol en una opción tienen precedencia en el cierre. Si ambas opciones tienen cuatro votos del rol y el total general empata, sigue abierta hasta que se alcance otra condición. Tras el cierre no admite más votos. No hay cierre automático por tiempo.

## Consultar

- `/perfil [usuario]` muestra aura total, cantidad de cambios aprobados, propuestas abiertas y los cinco cambios aprobados más recientes. Sin `usuario`, muestra el perfil de quien ejecuta el comando.
- `/historial [usuario] [pagina]` lista cambios aprobados con puntos, motivo, fecha y proponente, ocho por página. Sin `usuario`, muestra el historial propio; la primera página es la predeterminada.
- `/info` explica dentro de Discord los comandos y las reglas de votación.

El aura total suma solo propuestas aprobadas. Las consultas se separan por servidor. D1 guarda IDs de servidor y usuarios, puntos, motivos y votos. El campo histórico `expires_at` se usa para calcular la fecha mostrada en historial, aunque las propuestas ya no vencen.

Los límites y comprobaciones conocidos están en [`QUALITY.md`](../../QUALITY.md). Las mejoras pendientes se registran en [`docs/tasks/`](../tasks/README.md).
