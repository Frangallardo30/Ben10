const appId = '1417570023370653836';
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('Definí DISCORD_BOT_TOKEN en tu terminal para registrar los comandos.');
const commands = [
  { name: 'aura', description: 'Propone puntos de aura para votación', options: [
    { type: 6, name: 'usuario', description: 'Miembro que recibe el aura', required: true },
    { type: 4, name: 'puntos', description: 'Puntos entre -1000 y 1000', required: true, min_value: -1000, max_value: 1000 },
    { type: 3, name: 'motivo', description: 'Por qué merece ese cambio', required: true, max_length: 250 }
  ] },
  { name: 'perfil', description: 'Muestra el aura y los últimos movimientos aprobados', options: [
    { type: 6, name: 'usuario', description: 'Miembro a consultar', required: false }
  ] }
];
const response = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: 'PUT', headers: { Authorization: `Bot ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(commands)
});
if (!response.ok) throw new Error(`Discord devolvió ${response.status}: ${await response.text()}`);
console.log('Comandos /aura y /perfil registrados.');
