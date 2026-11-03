import { discordRequest, discordJSON, OperationalError } from './diagnostics.js';
const API = 'https://discord.com/api/v10';
const OPERATION_TIMEOUT_MS = 20000;

async function webhook(interaction, env, method, path, data) {
  const appId = interaction.application_id ?? env.DISCORD_APPLICATION_ID;
  const response = await discordRequest(`${API}/webhooks/${appId}/${interaction.token}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...data, allowed_mentions: { parse: [] } })
  });
  if (!response.ok) throw new OperationalError('DISCORD_WEBHOOK_FAILED', 'discord', response.status);
  return discordJSON(response);
}

export function editDeferred(interaction, env, data) {
  // Visibility was set by the initial defer and cannot be changed by this edit.
  const { flags: _flags, ...body } = data;
  return webhook(interaction, env, 'PATCH', '/messages/@original', body);
}

export function deferredButtonError(interaction, env, content) {
  return webhook(interaction, env, 'POST', '', { content, flags: 64 });
}

export async function withDeadline(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new OperationalError('INTERACTION_TIMEOUT', 'worker')), OPERATION_TIMEOUT_MS);
      })
    ]);
  } finally { clearTimeout(timer); }
}
