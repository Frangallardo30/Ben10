# Reglas de ingeniería

1. Mantener la verificación de firmas y tiempo de las interacciones de Discord antes de procesar comandos o botones.
2. Usar consultas preparadas para todo dato variable en D1 y aislar propuestas, perfiles e historial por servidor.
3. Preservar un voto por persona, la posibilidad de cambiarlo mientras esté abierto y la exclusión de quien propone y quien recibe el aura. Revisar la regla exacta en [`docs/specs/aura.md`](../../docs/specs/aura.md) antes de tocar el cierre.
4. Evitar exponer secretos, trazas internas y datos sensibles en respuestas o archivos. El token del bot es un secreto de Cloudflare.
5. Al cambiar esquema o datos, considerar votaciones existentes y migración. No asumir que `schema.sql` se aplicará solo en producción.
6. En cambios de lógica ejecutar `npm test`; en cambios del Worker, `npx wrangler deploy --dry-run`. Registrar los resultados reales en la tarea. Diferenciar pruebas locales de comprobaciones en Discord y Cloudflare.
