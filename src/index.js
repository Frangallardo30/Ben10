import { commands } from './commands.js';
import { AURA_VOTER_ROLE_ID, VOTES_TO_CLOSE, VOTES_TO_OVERRIDE, UPSERT_VOTE_SQL, UPSERT_ROLE_VOTE_SQL, REMOVE_ROLE_VOTE_SQL, CLOSE_PROPOSAL_SQL, canVote } from './voting.js';

const DISCORD = 'https://discord.com/api/v10';
const PROPOSAL_LIFETIME_SECONDS = 86400;
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ephemeral = (content) => reply({ type: 4, data: { content, flags: 64 } });
const bytes = (hex) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));

export async function verified(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !publicKey) {
    console.warn('Discord verification: missing signature, timestamp, or public key');
    return null;
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    console.warn('Discord verification: timestamp outside five minute window');
    return null;
  }
  const body = await request.text();
  try {
    const key = await crypto.subtle.importKey('raw', bytes(publicKey), 'Ed25519', false, ['verify']);
    if (!(await crypto.subtle.verify('Ed25519', key, bytes(signature), new TextEncoder().encode(timestamp + body)))) {
      console.warn('Discord verification: invalid signature');
      return null;
    }
    return JSON.parse(body);
  } catch (error) {
    console.warn('Discord verification: invalid key or request format', error?.name);
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

async function counts(db, id) {
  const rows = await db.prepare('SELECT choice, COUNT(*) AS n FROM votes WHERE proposal_id = ? GROUP BY choice').bind(id).all();
  const roleRows = await db.prepare('SELECT choice, COUNT(*) AS n FROM role_votes WHERE proposal_id = ? GROUP BY choice').bind(id).all();
  const values = { yes: 0, no: 0, roleYes: 0, roleNo: 0 };
  for (const row of rows.results) values[row.choice] = row.n;
  for (const row of roleRows.results) values[row.choice === 'yes' ? 'roleYes' : 'roleNo'] = row.n;
  return values;
}

function display(proposal, votes) {
  const closed = proposal.status !== 'open';
  let result = proposal.status === 'approved' ? '✅ Aprobada' : proposal.status === 'expired' ? '⌛ Vencida sin cambiar el aura' : '❌ Rechazada';
  if (!closed) {
    if (votes.roleYes >= VOTES_TO_CLOSE && votes.yes < votes.no) {
      result = `👍 del rol va perdiendo: necesita ${VOTES_TO_OVERRIDE - votes.roleYes} voto(s) más del rol`;
    } else if (votes.roleNo >= VOTES_TO_CLOSE && votes.no < votes.yes) {
      result = `👎 del rol va perdiendo: necesita ${VOTES_TO_OVERRIDE - votes.roleNo} voto(s) más del rol`;
    } else {
      result = 'Abierta: 4 del rol si empata o lidera; 6 si va perdiendo';
    }
  }
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Propuesta de aura: ${label(proposal.amount)}`,
      description: `<@${proposal.target_id}>: ${proposal.reason}\n\n🗳️ Todos pueden votar. El rol <@&${AURA_VOTER_ROLE_ID}> puede cerrar la votación.`,
      color: closed ? (proposal.status === 'approved' ? 0x21a675 : 0xc84a4a) : 0x5785f2,
      fields: [
        { name: 'Todos los votos', value: `👍 ${votes.yes} · 👎 ${votes.no}`, inline: true },
        { name: 'Votos del rol', value: `👍 ${votes.roleYes} · 👎 ${votes.roleNo}`, inline: true },
        { name: 'Estado', value: closed ? result : `${result}\nVence <t:${proposal.expires_at}:R>.`, inline: false }
      ],
      footer: { text: 'Una persona, un voto. Quien propone y quien recibe no votan.' }
    }],
    components: closed ? [] : [{ type: 1, components: [
      { type: 2, style: 3, label: 'Aprobar', emoji: { name: '👍' }, custom_id: `aura:yes:${proposal.id}` },
      { type: 2, style: 4, label: 'Desaprobar', emoji: { name: '👎' }, custom_id: `aura:no:${proposal.id}` }
    ] }]
  };
}

async function discord(env, path, method, body) {
  return fetch(`${DISCORD}${path}`, { method, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}

async function rememberOriginalMessage(env, token, proposalId) {
  for (const delay of [300, 1000, 2000]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(`${DISCORD}/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`);
      if (!response.ok) continue;
      const message = await response.json();
      if (!/^\d+$/.test(message.id ?? '')) return;
      await env.DB.prepare('UPDATE proposals SET message_id = ? WHERE id = ? AND message_id IS NULL').bind(message.id, proposalId).run();
      return;
    } catch { /* Discord may not have created the original message yet. */ }
  }
  console.warn('Could not save aura proposal message ID', proposalId);
}

async function expireProposals(env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS proposal_expiry_sync (proposal_id TEXT PRIMARY KEY, synced INTEGER NOT NULL DEFAULT 0)').run();
  await env.DB.prepare("UPDATE proposals SET status = 'expired' WHERE status = 'open' AND expires_at <= ?").bind(now).run();
  await env.DB.prepare("INSERT OR IGNORE INTO proposal_expiry_sync(proposal_id) SELECT id FROM proposals WHERE status = 'expired' AND message_id IS NOT NULL").run();
  const pending = await env.DB.prepare("SELECT p.* FROM proposals p JOIN proposal_expiry_sync s ON s.proposal_id = p.id WHERE p.status = 'expired' AND p.message_id IS NOT NULL AND s.synced = 0 ORDER BY p.expires_at LIMIT 20").all();
  for (const proposal of pending.results) {
    if (!env.DISCORD_BOT_TOKEN) break;
    try {
      const response = await discord(env, `/channels/${proposal.channel_id}/messages/${proposal.message_id}`, 'PATCH', display(proposal, await counts(env.DB, proposal.id)));
      if (response.ok || response.status === 404) {
        await env.DB.prepare('UPDATE proposal_expiry_sync SET synced = 1 WHERE proposal_id = ?').bind(proposal.id).run();
      } else {
        console.warn('Could not update expired aura message', proposal.id, response.status);
        if (response.status === 429) break;
      }
    } catch (error) {
      console.warn('Could not update expired aura message', proposal.id, error?.name);
    }
  }
}

async function ensureCommandsRegistered(env) {
  if (!env.DISCORD_BOT_TOKEN) {
    console.warn('Discord commands not registered: DISCORD_BOT_TOKEN is missing');
    return;
  }
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  const version = 'aura-profile-history-info-v4';
  const saved = await env.DB.prepare("SELECT value FROM bot_settings WHERE key = 'commands_version'").first();
  const path = `/applications/${env.DISCORD_APPLICATION_ID}/commands`;
  if (saved?.value === version) {
    const current = await discord(env, path, 'GET');
    if (!current.ok) throw new Error(`Discord command lookup failed: ${current.status}`);
    const registered = await current.json();
    if (commands.every((command) => registered.some((item) => (item.type ?? 1) === 1 && item.name === command.name && item.description === command.description))) return;
  }
  const response = await discord(env, path, 'PUT', commands);
  if (!response.ok) throw new Error(`Discord command registration failed: ${response.status}`);
  await env.DB.prepare("INSERT INTO bot_settings(key, value) VALUES ('commands_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(version).run();
  console.log('Discord commands registered');
}

let votingPolicyReady;

async function ensureVotingPolicy(db) {
  if (votingPolicyReady) return votingPolicyReady;
  votingPolicyReady = migrateVotingPolicy(db).catch((error) => {
    votingPolicyReady = undefined;
    throw error;
  });
  return votingPolicyReady;
}

async function migrateVotingPolicy(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  await db.prepare("CREATE TABLE IF NOT EXISTS role_votes (proposal_id TEXT NOT NULL, user_id TEXT NOT NULL, choice TEXT NOT NULL CHECK(choice IN ('yes', 'no')), PRIMARY KEY(proposal_id, user_id))").run();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO role_votes(proposal_id, user_id, choice) SELECT v.proposal_id, v.user_id, v.choice FROM votes v JOIN proposals p ON p.id = v.proposal_id WHERE p.status = 'open' AND EXISTS (SELECT 1 FROM bot_settings WHERE key = 'voting_policy' AND value = 'role4-v1')"),
    db.prepare("INSERT INTO bot_settings(key, value) VALUES ('voting_policy', 'all-votes-role4-v2') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  ]);
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
          { name: '👤 /perfil', value: 'Muestra el aura total, las votaciones abiertas y los últimos cambios aprobados. `usuario` es opcional; sin él, muestra tu perfil.', inline: false },
          { name: '📜 /historial', value: 'Lista los cambios aprobados con fecha, puntos, motivo y quién los propuso. Podés elegir `usuario` y `pagina` (8 cambios por página).', inline: false },
          { name: '👍 👎 Cómo se vota', value: `Todos pueden votar una vez y cambiar su voto mientras la propuesta esté abierta. Quien propone y quien recibe el aura no pueden votar. Los votos del rol <@&${AURA_VOTER_ROLE_ID}> cierran la votación: bastan 4 iguales si esa opción empata o lidera el total; si va perdiendo, necesita 6. Si no se alcanza el cierre, vence a las 24 horas sin cambiar el aura.`, inline: false }
        ],
        footer: { text: 'El aura cambia solo cuando una propuesta es aprobada.' }
      }]
    } });
  }
  if (!interaction.guild_id) return ephemeral('Usá estos comandos dentro de un servidor.');
  await ensureVotingPolicy(env.DB);
  if (interaction.data.name === 'historial') {
    const user = option(interaction, 'usuario') ?? actor(interaction);
    const page = option(interaction, 'pagina') ?? 1;
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved'").bind(interaction.guild_id, user).first();
    const total = count?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / 8));
    if (page > pages) return ephemeral(`Ese perfil tiene ${pages} página${pages === 1 ? '' : 's'} de historial.`);
    const history = await env.DB.prepare("SELECT amount, reason, proposer_id, expires_at FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved' ORDER BY expires_at DESC, id DESC LIMIT 8 OFFSET ?").bind(interaction.guild_id, user, (page - 1) * 8).all();
    const identity = profileIdentity(interaction, user);
    const entries = history.results.map((item) => {
      const reason = item.reason.replace(/\s+/g, ' ').trim();
      return `${item.amount >= 0 ? '🟢' : '🔴'} **${label(item.amount)} puntos** · <t:${item.expires_at - 86400}:d>\n${reason}\n*Propuesto por <@${item.proposer_id}>*`;
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
    const history = await env.DB.prepare("SELECT amount, reason FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved' ORDER BY expires_at DESC LIMIT 5").bind(interaction.guild_id, user).all();
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
          { name: '📜 Últimos movimientos', value: lines.length ? lines.join('\n') : 'Todavía no hay cambios aprobados.', inline: false }
        ],
        footer: { text: 'Ben 10 · El aura cambia cuando termina la votación' }
      }]
    } });
  }
  if (interaction.data.name !== 'aura') return ephemeral('Comando desconocido.');
  const target = option(interaction, 'usuario');
  const amount = option(interaction, 'puntos');
  const reason = String(option(interaction, 'motivo') ?? '').trim();
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000 || !reason || reason.length > 250) return ephemeral('Usá de -1000 a 1000 puntos (excepto 0) y un motivo de hasta 250 caracteres.');
  const proposal = { id: crypto.randomUUID(), guild_id: interaction.guild_id, channel_id: interaction.channel_id, target_id: target, proposer_id: actor(interaction), amount, reason, expires_at: Math.floor(Date.now() / 1000) + PROPOSAL_LIFETIME_SECONDS, status: 'open' };
  await env.DB.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(proposal.id, proposal.guild_id, proposal.channel_id, proposal.target_id, proposal.proposer_id, amount, reason, proposal.expires_at).run();
  if (interaction.token) ctx.waitUntil(rememberOriginalMessage(env, interaction.token, proposal.id));
  return reply({ type: 4, data: display(proposal, { yes: 0, no: 0, roleYes: 0, roleNo: 0 }) });
}

async function vote(interaction, env) {
  await ensureVotingPolicy(env.DB);
  const [, choice, id] = interaction.data.custom_id.split(':');
  if (!['yes', 'no'].includes(choice)) return ephemeral('Voto inválido.');
  const proposal = await env.DB.prepare('SELECT * FROM proposals WHERE id = ? AND guild_id = ?').bind(id, interaction.guild_id).first();
  if (!proposal) return ephemeral('Propuesta inexistente.');
  if (interaction.message?.id && !proposal.message_id) {
    await env.DB.prepare('UPDATE proposals SET message_id = ? WHERE id = ? AND message_id IS NULL').bind(interaction.message.id, id).run();
  }
  if (proposal.status === 'expired' || (proposal.status === 'open' && proposal.expires_at <= Math.floor(Date.now() / 1000))) {
    await env.DB.prepare("UPDATE proposals SET status = 'expired' WHERE id = ? AND status = 'open' AND expires_at <= unixepoch()").bind(id).run();
    const updated = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
    return updated.status === 'expired' ? reply({ type: 7, data: display(updated, await counts(env.DB, id)) }) : ephemeral('La votación ya cerró.');
  }
  if (proposal.status !== 'open') return ephemeral('La votación ya cerró.');
  const user = actor(interaction);
  if (!canVote(user, proposal)) return ephemeral('Quien propone y quien recibe no pueden votar.');
  const now = Math.floor(Date.now() / 1000);
  const hasRole = interaction.member?.roles?.includes(AURA_VOTER_ROLE_ID) ?? false;
  const roleVote = hasRole
    ? env.DB.prepare(UPSERT_ROLE_VOTE_SQL).bind(id, user, choice, id)
    : env.DB.prepare(REMOVE_ROLE_VOTE_SQL).bind(id, user);
  await env.DB.batch([
    env.DB.prepare("UPDATE proposals SET status = 'expired' WHERE id = ? AND status = 'open' AND expires_at <= ?").bind(id, now),
    env.DB.prepare(UPSERT_VOTE_SQL).bind(id, user, choice, id),
    roleVote,
    env.DB.prepare(CLOSE_PROPOSAL_SQL).bind(id, id, id, id, id)
  ]);
  const updated = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first();
  return reply({ type: 7, data: display(updated, await counts(env.DB, id)) });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      const publicKey = env.DISCORD_PUBLIC_KEY ?? '';
      return reply({
        status: 'ok',
        public_key_present: publicKey.length > 0,
        public_key_length: publicKey.length,
        public_key_trimmed_length: publicKey.trim().length,
        public_key_ready: /^[0-9a-fA-F]{64}$/.test(publicKey),
        bot_token_present: Boolean(env.DISCORD_BOT_TOKEN),
        application_id_ready: env.DISCORD_APPLICATION_ID === '1417570023370653836',
        database_ready: Boolean(env.DB)
      });
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/interactions') return new Response('Not found', { status: 404 });
    const interaction = await verified(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) return new Response('Invalid signature', { status: 401 });
    try {
      if (interaction.type === 1) {
        ctx.waitUntil(ensureCommandsRegistered(env).catch((error) => console.error(error)));
        return reply({ type: 1 });
      }
      if (interaction.type === 2) return await command(interaction, env, ctx);
      if (interaction.type === 3 && interaction.data.custom_id?.startsWith('aura:')) return await vote(interaction, env);
      return ephemeral('Interacción desconocida.');
    } catch (error) {
      console.error('Interaction failed', error);
      return ephemeral('Ocurrió un error. Intentá de nuevo.');
    }
  },
  async scheduled(_event, env) {
    try { await ensureCommandsRegistered(env); } catch (error) { console.error(error); }
    try { await expireProposals(env); } catch (error) { console.error('Aura expiry failed', error); }
  }
};
