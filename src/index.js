const DISCORD = 'https://discord.com/api/v10';
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ephemeral = (content) => reply({ type: 4, data: { content, flags: 64 } });
const bytes = (hex) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));

async function verified(request, publicKey) {
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

async function counts(db, id) {
  const rows = await db.prepare('SELECT choice, COUNT(*) AS n FROM votes WHERE proposal_id = ? GROUP BY choice').bind(id).all();
  const values = { yes: 0, no: 0 };
  for (const row of rows.results) values[row.choice] = row.n;
  return values;
}

function display(proposal, votes) {
  const closed = proposal.status !== 'open';
  const result = closed ? (proposal.status === 'approved' ? '✅ Aprobada' : '❌ Rechazada') : `Votación abierta hasta <t:${proposal.expires_at}:R>`;
  return {
    embeds: [{
      title: `Propuesta de aura: ${label(proposal.amount)}`,
      description: `<@${proposal.target_id}>: ${proposal.reason}`,
      color: closed ? (proposal.status === 'approved' ? 0x21a675 : 0xc84a4a) : 0x5785f2,
      fields: [{ name: 'Votos', value: `👍 ${votes.yes} · 👎 ${votes.no}`, inline: true }, { name: 'Estado', value: result, inline: true }],
      footer: { text: 'Una persona, un voto. No votan quien propone ni quien recibe.' }
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

async function rememberMessage(env, interaction, id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${DISCORD}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`);
    if (response.ok) {
      const message = await response.json();
      await env.DB.prepare('UPDATE proposals SET message_id = ? WHERE id = ?').bind(message.id, id).run();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function finish(env, proposal) {
  if (proposal.status !== 'open' || proposal.expires_at > Math.floor(Date.now() / 1000)) return proposal;
  const votes = await counts(env.DB, proposal.id);
  const status = votes.yes > votes.no ? 'approved' : 'rejected';
  const update = await env.DB.prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = 'open'").bind(status, proposal.id).run();
  if (update.meta.changes === 0) return env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(proposal.id).first();
  proposal.status = status;
  if (proposal.message_id) await discord(env, `/channels/${proposal.channel_id}/messages/${proposal.message_id}`, 'PATCH', display(proposal, votes));
  return proposal;
}

async function command(interaction, env, ctx) {
  if (!interaction.guild_id) return ephemeral('Usá estos comandos dentro de un servidor.');
  if (interaction.data.name === 'perfil') {
    const user = option(interaction, 'usuario') ?? actor(interaction);
    const score = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS aura FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved'").bind(interaction.guild_id, user).first();
    const history = await env.DB.prepare("SELECT amount, reason FROM proposals WHERE guild_id = ? AND target_id = ? AND status = 'approved' ORDER BY expires_at DESC LIMIT 5").bind(interaction.guild_id, user).all();
    const lines = history.results.map((item) => `${label(item.amount)} · ${item.reason}`);
    return reply({ type: 4, data: { embeds: [{ title: `Aura de <@${user}>`, description: `**Total: ${score?.aura ?? 0}**\n\n${lines.length ? lines.join('\n') : 'Sin movimientos aprobados.'}`, color: 0x52b9ed }] } });
  }
  if (interaction.data.name !== 'aura') return ephemeral('Comando desconocido.');
  const target = option(interaction, 'usuario');
  const amount = option(interaction, 'puntos');
  const reason = String(option(interaction, 'motivo') ?? '').trim();
  if (target === actor(interaction)) return ephemeral('No podés proponer aura para vos mismo.');
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000 || !reason || reason.length > 250) return ephemeral('Usá de -1000 a 1000 puntos (excepto 0) y un motivo de hasta 250 caracteres.');
  const proposal = { id: crypto.randomUUID(), guild_id: interaction.guild_id, channel_id: interaction.channel_id, target_id: target, proposer_id: actor(interaction), amount, reason, expires_at: Math.floor(Date.now() / 1000) + 86400, status: 'open' };
  await env.DB.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(proposal.id, proposal.guild_id, proposal.channel_id, proposal.target_id, proposal.proposer_id, amount, reason, proposal.expires_at).run();
  ctx.waitUntil(rememberMessage(env, interaction, proposal.id));
  return reply({ type: 4, data: display(proposal, { yes: 0, no: 0 }) });
}

async function vote(interaction, env) {
  const [, choice, id] = interaction.data.custom_id.split(':');
  if (!['yes', 'no'].includes(choice)) return ephemeral('Voto inválido.');
  const proposal = await env.DB.prepare('SELECT * FROM proposals WHERE id = ? AND guild_id = ?').bind(id, interaction.guild_id).first();
  if (!proposal) return ephemeral('Propuesta inexistente.');
  if (proposal.expires_at <= Math.floor(Date.now() / 1000)) { await finish(env, proposal); return ephemeral('La votación ya cerró.'); }
  if (proposal.status !== 'open') return ephemeral('La votación ya cerró.');
  const user = actor(interaction);
  if (user === proposal.target_id || user === proposal.proposer_id) return ephemeral('Quien propone y quien recibe no pueden votar.');
  await env.DB.prepare('INSERT INTO votes(proposal_id, user_id, choice) VALUES (?, ?, ?) ON CONFLICT(proposal_id, user_id) DO UPDATE SET choice = excluded.choice').bind(id, user, choice).run();
  return reply({ type: 7, data: display(proposal, await counts(env.DB, id)) });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      return reply({ status: 'ok', public_key_ready: /^[0-9a-fA-F]{64}$/.test(env.DISCORD_PUBLIC_KEY ?? ''), database_ready: Boolean(env.DB) });
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/interactions') return new Response('Not found', { status: 404 });
    const interaction = await verified(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) return new Response('Invalid signature', { status: 401 });
    try {
      if (interaction.type === 1) return reply({ type: 1 });
      if (interaction.type === 2) return await command(interaction, env, ctx);
      if (interaction.type === 3 && interaction.data.custom_id?.startsWith('aura:')) return await vote(interaction, env);
      return ephemeral('Interacción desconocida.');
    } catch (error) {
      console.error('Interaction failed', error);
      return ephemeral('Ocurrió un error. Intentá de nuevo.');
    }
  },
  async scheduled(_event, env) {
    const due = await env.DB.prepare("SELECT * FROM proposals WHERE status = 'open' AND expires_at <= ? LIMIT 100").bind(Math.floor(Date.now() / 1000)).all();
    for (const proposal of due.results) await finish(env, proposal);
  }
};
