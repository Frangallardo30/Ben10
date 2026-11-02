# Revisión de funcionamiento

## Comprobaciones automáticas

Con Node.js 24 o posterior, ejecutá `npm ci && npm test`. Las pruebas cubren:

- Verificación de la firma Ed25519 de Discord, modificación del cuerpo y antigüedad de la firma.
- Postulación propia sin permitir el voto de quien propone o recibe el aura.
- Votos de miembros con y sin el rol; un voto por persona y cambio de voto.
- Cierre con cuatro votos del rol cuando esa opción empata o lidera, y con seis cuando va perdiendo, en ambos sentidos.
- Bloqueo de nuevos votos después del cierre y separación por servidor.
- Flujo completo de interacción firmada, creación de propuesta, migración inicial de D1, votos, `/perfil`, `/historial` y `/info`.

`npx wrangler deploy --dry-run` comprueba que el Worker se empaqueta con sus bindings. El flujo de GitHub Actions `Check Ben10Bot` ejecuta estas comprobaciones en cada push y pull request.

## Prueba manual en Discord

1. Confirmá que la última implementación de `ben10` figure como lista en Cloudflare.
2. Ejecutá `/info`, `/perfil` y `/historial` en el servidor.
3. Creá una propuesta de aura propia y comprobá que no puedas votarla.
4. Hacé votar a una persona sin el rol: debe aparecer en el total, sin sumarse al recuento del rol.
5. Probá cuatro votos del rol del lado que empata o lidera y, en otra propuesta, seis del lado que va perdiendo.
6. Comprobá que los botones desaparezcan al cerrar y que `/perfil` e `/historial` reflejen solo las propuestas aprobadas.

## Límites conocidos

- Las propuestas sin los votos necesarios vencen a las 24 horas. El cron puede tardar hasta cinco minutos en retirar los botones; propuestas antiguas sin ID de mensaje pueden conservarlos hasta que alguien los pulse.
- El voto especial refleja si la persona tenía el rol cuando emitió o cambió ese voto. Si pierde el rol después, conserva esa condición hasta que vuelva a votar.
- Las pruebas locales usan SQLite y respuestas firmadas simuladas. No sustituyen la prueba manual de permisos, latencia y aspecto de los embeds en Discord y Cloudflare.
- Discord exige responder a las interacciones en pocos segundos. Si D1 o Discord se ralentizan o fallan, puede aparecer «La aplicación no respondió». Revisá los registros de Cloudflare en ese caso.
- Votos enviados casi simultáneamente pueden dejar el embed con un recuento visual desactualizado aunque D1 guarde el resultado correcto. En ese caso, `/perfil` y `/historial` muestran el resultado guardado; después del cierre, la propuesta ya no acepta votos. El embed no se corrige automáticamente.
