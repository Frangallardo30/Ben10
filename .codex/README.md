# Guía de trabajo con Codex

Esta carpeta adapta la organización de `.claude` de FrangaFlix a Ben10Bot. Contiene contexto, reglas y guías de trabajo versionadas. No forma parte del Worker ni configura Discord.

`AGENTS.md` es la entrada que Codex lee en este repositorio y enlaza estas pautas. La carpeta `.codex` por sí sola no activa instrucciones automáticas. Los comandos, agentes y skills de Claude tienen formatos propios: las guías de aquí son documentos de trabajo, no comandos `/` ejecutables.

## Dónde mirar

- [Proyecto](context/project.md): alcance y datos estables.
- [Arquitectura](context/architecture.md): componentes y despliegue.
- [Ingeniería](rules/engineering.md): reglas al cambiar el bot.
- [Tareas](workflows/tasks.md): seguimiento de pedidos y comprobaciones.
- [Nueva función](playbooks/feature.md) y [revisión](playbooks/review.md): pasos prácticos.
- [`docs/specs/`](../docs/specs/README.md): comportamiento vigente.
- [`docs/tasks/`](../docs/tasks/README.md): pedidos, decisiones y validación histórica.

La regla es mantener las tareas y la especificación al día en el mismo cambio que afecta al comportamiento.
