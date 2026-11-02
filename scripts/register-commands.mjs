import { commands } from '../src/commands.js';

const appId = '1417570023370653836';
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('Definí DISCORD_BOT_TOKEN en tu terminal para registrar los comandos.');
const response = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: 'PUT', headers: { Authorization: `Bot ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(commands)
});
if (!response.ok) throw new Error(`Discord devolvió ${response.status}: ${await response.text()}`);
console.log('Comandos /aura, /perfil, /historial y /info registrados.');
