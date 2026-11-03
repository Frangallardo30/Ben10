import { diagnostic, diagnosticDatabase, discordRequest, discordJSON, OperationalError, reportFailure } from './diagnostics.js';
import { historyDateExpression } from './proposal-dates.js';
import { prepareWrites } from './database.js';
import { editDeferred, deferredButtonError, withDeadline } from './deferred.js';
import { QUEUE_MESSAGE_SYNC_SQL, requestMessageSync, retryMessageSync, readProposalMessage } from './message-sync.js';
export { ProposalMessageSync } from './message-sync.js';
import { QUEUE_NOTIFICATION_SQL, sendClosureNotifications } from './notifications.js';
import { commands } from './commands.js';
import { AURA_VOTER_ROLE_ID, UPSERT_VOTE_SQL, UPSERT_ROLE_VOTE_SQL, REMOVE_ROLE_VOTE_SQL, CLOSE_PROPOSAL_SQL, CANCEL_PROPOSAL_SQL, canVote } from './voting.js';

const DISCORD = 'https://discord.com/api/v10';
const PROPOSAL_LIFETIME_SECONDS = 86400;
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ephemeral = (content) => reply({ type: 4, data: { content, flags: 64 } });
const bytes = (hex) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));

export async function verified(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !publicKey) {
    diagnostic('warn', 'SIGNATURE_DATA_MISSING', 'validation');
    return null;
  }
  if (!Number.isFinite(Number(timestamp)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    diagnostic('warn', 'SIGNATURE_TIMESTAMP_INVALID', 'validation');
    return null;
  }
  try {
    const body = await request.text();
    const key = await crypto.subtle.importKey('raw', bytes(publicKey), 'Ed25519', false, ['verify']);
    if (!(await crypto.subtle.verify('Ed25519', key, bytes(signature), new TextEncoder().encode(timestamp + body)))) {
      diagnostic('warn', 'SIGNATURE_INVALID', 'validation');
      return null;
    }
    return JSON.parse(body);
  } catch (error) {
    diagnostic('warn', 'SIGNATURE_OR_BODY_INVALID', 'validation');
    return null;
  }
}

const option = (interaction, name) => interaction.data.options?.find((item) => item.name === name)?.value;
const actor = (interaction) => interaction.member?.user?.id ?? interaction.user?.id;
const label = (amount) => `${amount > 0 ? '+' : ''}${amount}`;
const formatNumber = (value) => new Intl.NumberFormat('es-AR').format(value);

function profileIdentity(interaction, userId) {
  const user = interaction.data.resolved?.users?.[userId] ??
    (actor(interaction) === userId ? (interaction.member?.user ?? interaction.user) : null);
  const member = interaction.data.resolved?.members?.[userId];
  const name = member?.nick || user?.global_name || user?.username || 'Miembro del servidor';
  const avatarHash = member?.avatar || user?.avatar;
  const defaultAvatar = /^\d+$/.test(userId) ? Number((BigInt(userId) >> 22n) % 6n) : 0;
  const avatar = avatarHash
    ? `https://cdn.discordapp.com/${member?.avatar ? `guilds/${interaction.guild_id}/users/${userId}/avatars` : `avatars/${userId}`}/${avatarHash}.${avatarHash.startsWith('a_') ? 'gif' : 'png'}?size=256`
    : `https://cdn.discordapp.com/embed/avatars/${defaultAvatar}.png`;
  return { name, avatar };
}

async function discord(env, path, method, body) {
  return discordRequest(`${DISCORD}${path}`, { method, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}

async function expireProposals(env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO proposal_message_sync(proposal_id)
      SELECT id FROM proposals WHERE status = 'open' AND expires_at <= ?
      ON CONFLICT(proposal_id) DO UPDATE SET revision = revision + 1`).bind(now),
    env.DB.prepare("UPDATE proposals SET status = 'expired' WHERE status = 'open' AND expires_at <= ?").bind(now),
    // Include expired messages from deployments before message synchronization existed.
    env.DB.prepare(`INSERT OR IGNORE INTO proposal_message_sync(proposal_id)
      SELECT id FROM proposals WHERE status = 'expired' AND message_id IS NOT NULL`)
  ]);
}

function synchronizeInBackground(env, ctx, id) {
  ctx.waitUntil(requestMessageSync(env, id).catch((error) => {
    reportFailure('MESSAGE_SYNC_PENDING', error);
  }));
}

async function ensureCommandsRegistered(env) {
  if (!env.DISCORD_BOT_TOKEN) {
    diagnostic('warn', 'COMMANDS_TOKEN_MISSING', 'config');
    return;
  }
  await prepareWrites(env.DB);
  const version = 'aura-profile-history-info-ranking-stats-v6';
  const saved = await env.DB.prepare("SELECT value FROM bot_settings WHERE key = 'commands_version'").first();
  const path = `/applications/${env.DISCORD_APPLICATION_ID}/commands`;
  if (saved?.value === version) {
    const current = await discord(env, path, 'GET');
    if (!current.ok) throw new OperationalError('DISCORD_COMMAND_LOOKUP_FAILED', 'discord', current.status);
    const registered = await discordJSON(current);
    if (!Array.isArray(registered) || registered.some((item) => !item || typeof item.name !== 'string')) {
      throw new OperationalError('DISCORD_RESPONSE_INVALID', 'discord');
    }
    if (commands.every((command) => registered.some((item) => (item.type ?? 1) === 1 && item.name === command.name && item.description === command.description))) {
      diagnostic('info', 'COMMANDS_CURRENT', 'discord');
      return;
    }
  }
  const response = await discord(env, path, 'PUT', commands);
  if (!response.ok) throw new OperationalError('DISCORD_COMMAND_REGISTER_FAILED', 'discord', response.status);
  await env.DB.prepare("INSERT INTO bot_settings(key, value) VALUES ('commands_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(version).run();
  diagnostic('info', 'COMMANDS_REGISTERED', 'discord');
}

let nextCommandCheckAt = 0;

function checkCommandsInBackground(env, ctx) {
  if (Date.now() < nextCommandCheckAt) return;
  nextCommandCheckAt = Date.now() + 300000;
  ctx.waitUntil(ensureCommandsRegistered(env).catch((error) => {
    nextCommandCheckAt = 0;
    reportFailure('COMMANDS_SYNC_FAILED', error);
  }));
}

async function command(interaction, env, ctx) {
  if (interaction.data.name === 'info') {
    return reply({ type: 4, data: {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: '✨ Ben 10 · Guía de aura',
        description: 'Postulá cambios de aura, votá con tus amigos y consultá los resultados.',
        color: 0xff9c53,
        fields: [
          { name: '🗳️ /aura', value: 'Propone sumar o restar puntos a alguien. Elegí `usuario`, `puntos` (de -1000 a 1000, sin 0) y `motivo`. Podés postularte a vos mismo.', inline: false },
          { name: '👤 /perfil', value: 'Muestra aura, propuestas recibidas aprobadas/rechazadas, votos registrados y evolución por fecha de creación. `usuario` es opcional; sin él, muestra tu perfil.', inline: false },
          { name: '📜 /historial', value: 'Lista los cambios aprobados con fecha, puntos, motivo y quién los propuso. Podés elegir `usuario` y `pagina` (8 cambios por página).', inline: false },
          { name: '🏆 /ranking', value: 'Muestra las 10 personas con más aura de este servidor. Solo cuentan los cambios aprobados; los empates comparten puesto.', inline: false },
          { name: '👍 👎 Cómo se vota', value: `Todos pueden votar una vez y cambiar su voto mientras la propuesta esté abierta. Quien propone y quien recibe el aura no pueden votar. Quien creó la propuesta puede cancelarla mientras esté abierta, sin cambiar el aura. Los votos del rol <@&${AURA_VOTER_ROLE_ID}> cierran la votación: bastan 4 iguales si esa opción empata o lidera el total; si va perdiendo, necesita 6. Si no se alcanza el cierre, vence a las 24 horas sin cambiar el aura.`, inline: false }
        ],
        footer: { text: 'El aura cambia solo cuando una propuesta es aprobada.' }
      }]
    } });
  }
  if (!interaction.guild_id) return ephemeral('Usá estos comandos dentro de un servidor.');
  if (interaction.data.name === 'ranking') {
    const rows = await env.DB.prepare(`SELECT target_id, SUM(amount) AS aura,
      RANK() OVER (ORDER BY SUM(amount) DESC) AS position
      FROM proposals WHERE guild_id = ? AND status = 'approved'
      GROUP BY target_id ORDER BY aura DESC, target_id ASC LIMIT 10`).bind(interaction.guild_id).all();
    const lines = rows.results.map((row) => `**${row.position}.** <@${row.target_id}> · **${formatNumber(row.aura)}** puntos`);
    return reply({ type: 4, data: {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: '🏆 Ranking de aura',
        description: lines.length ? lines.join('\n') : 'Todavía no hay cambios de aura aprobados en este servidor.',
        color: 0xff9c53,
        footer: { text: 'Top 10 del servidor · Empates: mismo puesto y orden por ID de usuario.' }
      }]
    } });
  }
  if (interaction.data.name === 'historial') {
    const user = option(interaction, 'usuario') ?? actor(interaction);
    const page = option(interaction, 'pagina') ?? 1;
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved'").bind(interaction.guild_id, user).first();
    const total = count?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / 8));
    if (page > pages) return ephemeral(`Ese perfil tiene ${pages} página${pages === 1 ? '' : 's'} de historial.`);
    const date = await historyDateExpression(env.DB);
    const history = await env.DB.prepare(`SELECT amount, reason, proposer_id, ${date} AS created_at FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved' ORDER BY created_at DESC, id DESC LIMIT 8 OFFSET ?`).bind(interaction.guild_id, user, (page - 1) * 8).all();
    const identity = profileIdentity(interaction, user);
    const entries = history.results.map((item) => {
      const reason = item.reason.replace(/\s+/g, ' ').trim();
      return `${item.amount >= 0 ? '🟢' : '🔴'} **${label(item.amount)} puntos** · <t:${item.created_at}:d>\n${reason}\n*Propuesto por <@${item.proposer_id}>*`;
    });
    return reply({ type: 4, data: {
      allowed_mentions: { parse: [] },
      embeds: [{
        author: { name: `${identity.name} · Historial de aura`, icon_url: identity.avatar },
        description: `**Movimientos aprobados de <@${user}>**\n\n${entries.length ? entries.join('\n\n') : 'Todavía no hay cambios de aura aprobados.'}`,
        color: 0xff9c53,
        thumbnail: { url: identity.avatar },
        footer: { text: `Página ${page} de ${pages} · ${formatNumber(total)} movimientos${page < pages ? ' · Usá la opción pagina para continuar' : ''}` }
      }]
    } });
  }
  if (interaction.data.name === 'perfil') {
    const user = option(interaction, 'usuario') ?? actor(interaction);
    const score = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS aura, COUNT(*) AS approved FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved'").bind(interaction.guild_id, user).first();
    const pending = await env.DB.prepare("SELECT COUNT(*) AS total FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'open'").bind(interaction.guild_id, user).first();
    const date = await historyDateExpression(env.DB);
    const history = await env.DB.prepare(`SELECT amount, reason, ${date} AS created_at FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved' ORDER BY created_at DESC, id DESC LIMIT 5`).bind(interaction.guild_id, user).all();
    const stats = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'rejected') AS rejected,
      (SELECT COUNT(*) FROM votes v JOIN proposals p ON p.id = v.proposal_id WHERE p.guild_id = ? AND v.user_id = ?) AS votes`)
      .bind(interaction.guild_id, user, interaction.guild_id, user).first();
    const evolution = await env.DB.prepare(`SELECT amount, created_at, balance FROM (
      SELECT id, amount, ${date} AS created_at,
        SUM(amount) OVER (ORDER BY ${date} ASC, id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
      FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved'
    ) ORDER BY created_at DESC, id DESC LIMIT 5`).bind(interaction.guild_id, user).all();
    const trajectory = evolution.results.reverse().map((item) => `<t:${item.created_at}:d> · ${label(item.amount)} → **${formatNumber(item.balance)}** puntos`);
    const identity = profileIdentity(interaction, user);
    const lines = history.results.map((item) => `${item.amount >= 0 ? '🟢' : '🔴'} **${label(item.amount)}** · ${item.reason.slice(0, 100)}`);
    return reply({ type: 4, data: {
      allowed_mentions: { parse: [] },
      embeds: [{
        author: { name: `${identity.name} · Perfil de aura`, icon_url: identity.avatar },
        description: `✨ **Aura total**\n# ${formatNumber(score?.aura ?? 0)} puntos\n\n<@${user}>`,
        color: 0xff9c53,
        thumbnail: { url: identity.avatar },
        fields: [
          { name: '✅ Cambios aprobados', value: formatNumber(score?.approved ?? 0), inline: true },
          { name: '🗳️ Votaciones abiertas', value: formatNumber(pending?.total ?? 0), inline: true },
          { name: '📜 Últimos movimientos', value: lines.length ? lines.join('\n') : 'Todavía no hay cambios aprobados.', inline: false },
          { name: '❌ Propuestas recibidas rechazadas', value: formatNumber(stats.rejected), inline: true },
          { name: '🗳️ Votos registrados', value: formatNumber(stats.votes), inline: true },
          { name: '📈 Evolución del aura', value: trajectory.length ? trajectory.join('\n') : 'Todavía no hay cambios aprobados.', inline: false }
        ],
        footer: { text: 'Evolución: últimos 5 cambios aprobados, por fecha de creación. Un voto registrado por propuesta.' }
      }]
    } });
  }
  if (interaction.data.name !== 'aura') return ephemeral('Comando desconocido.');
  const target = option(interaction, 'usuario');
  const amount = option(interaction, 'puntos');
  const reason = String(option(interaction, 'motivo') ?? '').trim();
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000 || !reason || reason.length > 250) return ephemeral('Usá de -1000 a 1000 puntos (excepto 0) y un motivo de hasta 250 caracteres.');
  await prepareWrites(env.DB);
  const createdAt = Math.floor(Date.now() / 1000);
  const proposal = { id: interaction.id, guild_id: interaction.guild_id, channel_id: interaction.channel_id, target_id: target, proposer_id: actor(interaction), amount, reason, created_at: createdAt, expires_at: createdAt + PROPOSAL_LIFETIME_SECONDS, status: 'open' };
  await env.DB.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(proposal.id, proposal.guild_id, proposal.channel_id, proposal.target_id, proposal.proposer_id, amount, reason, proposal.created_at, proposal.expires_at).run();
  return reply({ type: 4, data: (await readProposalMessage(env.DB, proposal.id)).body });
}

async function vote(interaction, env, ctx) {
  await prepareWrites(env.DB);
  const [, choice, id] = interaction.data.custom_id.split(':');
  if (!['yes', 'no'].includes(choice)) return ephemeral('Voto inválido.');
  const proposal = await env.DB.prepare('SELECT * FROM proposals WHERE id = ? AND guild_id = ?').bind(id, interaction.guild_id).first();
  if (!proposal) return ephemeral('Propuesta inexistente.');
  if (interaction.message?.id && !proposal.message_id) {
    await env.DB.prepare('UPDATE proposals SET message_id = ? WHERE id = ? AND message_id IS NULL').bind(interaction.message.id, id).run();
  }
  if (proposal.status === 'expired' || (proposal.status === 'open' && proposal.expires_at <= Math.floor(Date.now() / 1000))) {
    await env.DB.batch([
      env.DB.prepare("UPDATE proposals SET status = 'expired' WHERE id = ? AND status = 'open' AND expires_at <= unixepoch()").bind(id),
      env.DB.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(id)
    ]);
    synchronizeInBackground(env, ctx, id);
    return reply({ type: 6 });
  }
  if (proposal.status !== 'open') {
    // A stale button can still be visible after an earlier failed edit.
    await env.DB.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(id).run();
    synchronizeInBackground(env, ctx, id);
    return ephemeral('La votación ya cerró.');
  }
  const user = actor(interaction);
  if (!canVote(user, proposal)) return ephemeral('Quien propone y quien recibe no pueden votar.');
  const hasRole = interaction.member?.roles?.includes(AURA_VOTER_ROLE_ID) ?? false;
  const roleVote = hasRole
    ? env.DB.prepare(UPSERT_ROLE_VOTE_SQL).bind(id, user, choice, id, interaction.id)
    : env.DB.prepare(REMOVE_ROLE_VOTE_SQL).bind(id, user, interaction.id);
  await env.DB.batch([
    env.DB.prepare("UPDATE proposals SET status = 'expired' WHERE id = ? AND status = 'open' AND expires_at <= unixepoch()").bind(id),
    env.DB.prepare(UPSERT_VOTE_SQL).bind(id, user, choice, id, interaction.id),
    roleVote,
    env.DB.prepare(CLOSE_PROPOSAL_SQL).bind(id, id, id, id, id),
    env.DB.prepare(QUEUE_NOTIFICATION_SQL).bind(id),
    env.DB.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(id),
    env.DB.prepare('INSERT OR IGNORE INTO vote_interactions(interaction_id, proposal_id) VALUES (?, ?)').bind(interaction.id, id)
  ]);
  synchronizeInBackground(env, ctx, id);
  ctx.waitUntil(sendClosureNotifications(env, id).catch((error) => reportFailure('CLOSURE_NOTICE_FAILED', error)));
  return reply({ type: 6 });
}

async function cancelProposal(interaction, env, ctx) {
  await prepareWrites(env.DB);
  const id = interaction.data.custom_id.split(':')[2];
  const user = actor(interaction);
  const proposal = await env.DB.prepare('SELECT * FROM proposals WHERE id = ? AND guild_id = ?').bind(id, interaction.guild_id).first();
  if (!proposal) return ephemeral('Propuesta inexistente.');
  if (!user || proposal.proposer_id !== user) return ephemeral('Solo quien creó la propuesta puede cancelarla.');
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE proposals SET status = 'expired' WHERE id = ? AND status = 'open' AND expires_at <= unixepoch()").bind(id),
    env.DB.prepare(CANCEL_PROPOSAL_SQL).bind(id, interaction.guild_id, user),
    env.DB.prepare('UPDATE proposals SET message_id = ? WHERE id = ? AND message_id IS NULL AND ? IS NOT NULL')
      .bind(interaction.message?.id ?? null, id, interaction.message?.id ?? null),
    env.DB.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(id)
  ]);
  synchronizeInBackground(env, ctx, id);
  if (results[1].meta.changes === 1) return reply({ type: 6 });
  const updated = await env.DB.prepare('SELECT status FROM proposals WHERE id = ?').bind(id).first();
  return ephemeral(updated.status === 'cancelled' ? 'La propuesta ya está cancelada.' : 'La votación ya cerró; no se puede cancelar.');
}

async function performInteraction(interaction, env, ctx) {
  const isCommand = interaction.type === 2;
  let result;
  if (isCommand) result = await command(interaction, env, ctx);
  else if (interaction.data.custom_id.split(':')[1] === 'cancel') result = await cancelProposal(interaction, env, ctx);
  else result = await vote(interaction, env, ctx);
  const payload = await result.json();
  if (!isCommand) {
    if (payload.type === 4) await deferredButtonError(interaction, env, payload.data.content);
    return;
  }
  if (interaction.data.name !== 'aura' || !payload.data.embeds) {
    await editDeferred(interaction, env, payload.data);
    return;
  }
  const proposal = await env.DB.prepare('SELECT message_id FROM proposals WHERE id = ?').bind(interaction.id).first();
  if (!proposal.message_id) {
    // Only the per-proposal synchronizer publishes interactive buttons. Replaying
    // a creation cannot restore an old set of buttons after a later closure.
    const message = await editDeferred(interaction, env, { ...payload.data, components: [] });
    if (!/^\d+$/.test(message?.id ?? '')) throw new OperationalError('DISCORD_MESSAGE_ID_MISSING', 'discord');
    await env.DB.batch([
      env.DB.prepare('UPDATE proposals SET message_id = ? WHERE id = ? AND message_id IS NULL').bind(message.id, interaction.id),
      env.DB.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(interaction.id)
    ]);
  } else {
    await env.DB.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(interaction.id).run();
  }
  synchronizeInBackground(env, ctx, interaction.id);
}

async function finishInteraction(interaction, env, ctx) {
  const isCommand = interaction.type === 2;
  try {
    await withDeadline(performInteraction(interaction, env, ctx));
  } catch (error) {
    reportFailure('INTERACTION_FAILED', error);
    const message = isCommand && interaction.data.name !== 'aura'
      ? 'No pude consultar los datos. Intentá de nuevo en unos segundos.'
      : 'No pude confirmar la operación. Consultá /perfil antes de volver a intentarlo.';
    try {
      if (isCommand) await editDeferred(interaction, env, { content: message, embeds: [], components: [] });
      else await deferredButtonError(interaction, env, message);
    } catch (deliveryError) { reportFailure('INTERACTION_ERROR_DELIVERY_FAILED', deliveryError); }
  }
}

function deferInteraction(interaction, env, ctx) {
  if (!interaction.id || !interaction.token) {
    diagnostic('warn', 'INTERACTION_DATA_MISSING', 'validation');
    return ephemeral('La interacción no tiene los datos necesarios. Intentá de nuevo.');
  }
  ctx.waitUntil(Promise.resolve().then(() => finishInteraction(interaction, env, ctx)));
  return reply({ type: interaction.type === 2 ? 5 : 6 });
}

export default {
  async fetch(request, env, ctx) {
    env = { ...env, DB: diagnosticDatabase(env.DB) };
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      return reply({ status: 'ok' });
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/interactions') return new Response('Not found', { status: 404 });
    const interaction = await verified(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) return new Response('Invalid signature', { status: 401 });
    try {
      if (interaction.type === 1) {
        checkCommandsInBackground(env, ctx);
        return reply({ type: 1 });
      }
      if (interaction.type === 2) {
        if (!['aura', 'perfil', 'historial', 'ranking', 'info'].includes(interaction.data?.name)) return ephemeral('Comando desconocido.');
        checkCommandsInBackground(env, ctx);
        if (interaction.data.name === 'info') return command(interaction, env, ctx);
        if (!interaction.guild_id) return ephemeral('Usá estos comandos dentro de un servidor.');
        if (interaction.data.name === 'aura') {
          const amount = option(interaction, 'puntos');
          const reason = String(option(interaction, 'motivo') ?? '').trim();
          if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000 || !reason || reason.length > 250) {
            return ephemeral('Usá de -1000 a 1000 puntos (excepto 0) y un motivo de hasta 250 caracteres.');
          }
        }
        return deferInteraction(interaction, env, ctx);
      }
      if (interaction.type === 3 && interaction.data?.custom_id?.startsWith('aura:')) {
        if (!['yes', 'no', 'cancel'].includes(interaction.data.custom_id.split(':')[1])) return ephemeral('Voto inválido.');
        return deferInteraction(interaction, env, ctx);
      }
      return ephemeral('Interacción desconocida.');
    } catch (error) {
      reportFailure('INTERACTION_FAILED', error);
      return ephemeral('Ocurrió un error. Intentá de nuevo.');
    }
  },
  async scheduled(_event, env) {
    env = { ...env, DB: diagnosticDatabase(env.DB) };
    try { await prepareWrites(env.DB); } catch (error) { reportFailure('DATABASE_PREPARATION_FAILED', error); return; }
    try { await ensureCommandsRegistered(env); } catch (error) { reportFailure('COMMANDS_SYNC_FAILED', error); }
    try { await expireProposals(env); } catch (error) { reportFailure('EXPIRY_FAILED', error); }
    try { await retryMessageSync(env); } catch (error) { reportFailure('MESSAGE_SYNC_RETRY_FAILED', error); }
    try {
      await sendClosureNotifications(env);
    } catch (error) { reportFailure('CLOSURE_NOTICE_RETRY_FAILED', error); }
  }
};
