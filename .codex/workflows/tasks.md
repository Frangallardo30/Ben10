# Flujo de tareas y especificaciones

Cada pedido nuevo o corrección obtiene una tarea `B10-nnn` basada en [`docs/tasks/TEMPLATE.md`](../../docs/tasks/TEMPLATE.md), y una fila en el [índice](../../docs/tasks/README.md). La tarea registra **por qué** se cambia algo, criterios, implementación y comprobaciones; la [spec](../../docs/specs/README.md) registra **cómo funciona hoy**.

1. Leer el código, la spec y las tareas relacionadas. Escribir criterios observables; marcar la tarea `En curso`.
2. Implementar el cambio y actualizar la spec si cambia el comportamiento. Si surge un problema distinto, abrir otra tarea en lugar de ocultarlo.
3. Realizar las comprobaciones relevantes según `AGENTS.md`; anotar comandos, resultados y límites reales. No marcar casillas que solo se infieren.
4. Revisar el diff y el índice. Marcar `Hecha` cuando los criterios y la validación requeridos estén completos; si queda una comprobación pendiente, reflejarlo en el estado y la tarea.

Para una auditoría, comparar código, spec, pruebas y funcionamiento observado. Registrar cada hallazgo accionable como una tarea con prioridad y condición de cierre.
