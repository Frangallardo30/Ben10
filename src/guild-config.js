import { AURA_VOTER_ROLE_ID, VOTES_TO_CLOSE, VOTES_TO_OVERRIDE } from './voting.js';
import { discordRequest, discordJSON, OperationalError } from './diagnostics.js';

export const CONFIG_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY, voter_role_id TEXT NOT NULL,
  votes_to_close INTEGER NOT NULL CHECK(votes_to_close BETWEEN 1 AND 100),
  votes_to_override INTEGER NOT NULL CHECK(votes_to_override BETWEEN votes_to_close AND 100),
  channel_id TEXT, version INTEGER NOT NULL DEFAULT 1, last_interaction_id TEXT
)`;
export const RULES_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS proposal_rules (
  proposal_id TEXT PRIMARY KEY, voter_role_id TEXT NOT NULL,
  votes_to_close INTEGER NOT NULL, votes_to_override INTEGER NOT NULL
)`;
export const CONFIG_ATTEMPTS_SQL = `CREATE TABLE IF NOT EXISTS guild_config_attempts (
  interaction_id TEXT PRIMARY KEY, applied INTEGER NOT NULL
)`;

export async function migrateGuildConfig(db) {
  await db.batch([db.prepare(CONFIG_SCHEMA_SQL), db.prepare(RULES_SCHEMA_SQL), db.prepare(CONFIG_ATTEMPTS_SQL)]);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO guild_config(guild_id, voter_role_id, votes_to_close, votes_to_override)
      SELECT DISTINCT guild_id, ?, ?, ? FROM proposals
      WHERE NOT EXISTS (SELECT 1 FROM bot_settings WHERE key = 'guild_config_v1')`)
      .bind(AURA_VOTER_ROLE_ID, VOTES_TO_CLOSE, VOTES_TO_OVERRIDE),
    db.prepare(`INSERT OR IGNORE INTO proposal_rules(proposal_id, voter_role_id, votes_to_close, votes_to_override)
      SELECT id, ?, ?, ? FROM proposals`).bind(AURA_VOTER_ROLE_ID, VOTES_TO_CLOSE, VOTES_TO_OVERRIDE),
    db.prepare("INSERT OR IGNORE INTO bot_settings(key, value) VALUES ('guild_config_v1', 'ready')")
  ]);
}

export async function getGuildConfig(db, guildId) {
  return await db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').bind(guildId).first() ?? {
    guild_id: guildId, voter_role_id: null, votes_to_close: 4, votes_to_override: 6, channel_id: null, version: 0
  };
}

export function canManageGuild(interaction) {
  try {
    const permissions = BigInt(interaction.member?.permissions ?? '0');
    return Boolean(interaction.guild_id && permissions >= 0n && (permissions & 32n || permissions & 8n));
  } catch { return false; }
}

export function configSummary(config) {
  return [
    `Rol decisor: ${config.voter_role_id ? `<@&${config.voter_role_id}>` : 'Sin configurar: elegí un rol para habilitar /aura.'}`,
    `Umbral normal: **${config.votes_to_close}** votos del rol.`,
    `Para imponerse: **${config.votes_to_override}** votos del rol.`,
    `Canal de propuestas: ${config.channel_id ? `<#${config.channel_id}>` : 'Cualquier canal donde pueda operar el bot.'}`,
    'Los cambios afectan solo a propuestas nuevas.'
  ].join('\n');
}

async function api(env, path) {
  if (!env.DISCORD_BOT_TOKEN) throw new OperationalError('CONFIG_TOKEN_MISSING', 'config');
  const response = await discordRequest(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
  if (!response.ok) throw new OperationalError('CONFIG_DISCORD_LOOKUP_FAILED', 'discord', response.status);
  return discordJSON(response);
}

export function channelPermissions(guildId, channel, roles, member, botId) {
  const ids = new Set([guildId, ...member.roles]);
  let permissions = roles.filter((role) => ids.has(role.id)).reduce((value, role) => value | BigInt(role.permissions), 0n);
  if (permissions & 8n) return permissions;
  const overwrites = channel.permission_overwrites ?? [];
  const apply = (deny, allow) => { permissions = permissions & ~deny | allow; };
  const everyone = overwrites.find((item) => Number(item.type) === 0 && item.id === guildId);
  if (everyone) apply(BigInt(everyone.deny), BigInt(everyone.allow));
  let deny = 0n, allow = 0n;
  for (const item of overwrites) if (Number(item.type) === 0 && item.id !== guildId && ids.has(item.id)) {
    deny |= BigInt(item.deny); allow |= BigInt(item.allow);
  }
  apply(deny, allow);
  const personal = overwrites.find((item) => Number(item.type) === 1 && item.id === botId);
  if (personal) apply(BigInt(personal.deny), BigInt(personal.allow));
  return permissions;
}

export async function validateChannel(env, guildId, channelId) {
  const [channel, roles, bot] = await Promise.all([
    api(env, `/channels/${channelId}`), api(env, `/guilds/${guildId}/roles`), api(env, '/users/@me')
  ]);
  if (!channel || !Array.isArray(roles) || typeof bot?.id !== 'string') throw new OperationalError('DISCORD_RESPONSE_INVALID', 'discord');
  if (channel.guild_id !== guildId || ![0, 5].includes(channel.type)) return false;
  const member = await api(env, `/guilds/${guildId}/members/${bot.id}`);
  if (!Array.isArray(member?.roles)) throw new OperationalError('DISCORD_RESPONSE_INVALID', 'discord');
  let permissions;
  try { permissions = channelPermissions(guildId, channel, roles, member, bot.id); }
  catch { throw new OperationalError('DISCORD_RESPONSE_INVALID', 'discord'); }
  const required = 1024n | 2048n | 16384n;
  return Boolean(permissions & 8n) || (permissions & required) === required;
}

export async function changeGuildConfig(interaction, env) {
  const db = env.DB;
  const processed = await db.prepare('SELECT applied FROM guild_config_attempts WHERE interaction_id = ?').bind(interaction.id).first();
  if (processed) return { content: `Esta solicitud ya fue procesada. Configuración vigente:\n${configSummary(await getGuildConfig(db, interaction.guild_id))}` };
  const options = interaction.data.options?.[0]?.options ?? [];
  const values = Object.fromEntries(options.map((option) => [option.name, option.value]));
  const old = await getGuildConfig(db, interaction.guild_id);
  if (!options.length) return { content: 'Elegí al menos un valor para cambiar.' };
  if (values.canal && values.canal_libre) return { content: 'Elegí un canal o canal_libre, no ambos.' };
  const next = { ...old, voter_role_id: values.rol ?? old.voter_role_id,
    votes_to_close: values.normal ?? old.votes_to_close,
    votes_to_override: values.imponerse ?? old.votes_to_override,
    channel_id: values.canal_libre === true ? null : values.canal ?? old.channel_id };
  if (!next.voter_role_id) return { content: 'Elegí un rol decisor para habilitar las propuestas en este servidor.' };
  if (values.rol && (!interaction.data.resolved?.roles?.[values.rol] || values.rol === interaction.guild_id)) return { content: 'Elegí un rol del servidor distinto de @everyone.' };
  if (![next.votes_to_close, next.votes_to_override].every((value) => Number.isInteger(value) && value >= 1 && value <= 100) || next.votes_to_override < next.votes_to_close) {
    return { content: 'Los umbrales deben ser enteros de 1 a 100; imponerse debe ser igual o mayor que normal.' };
  }
  if (next.channel_id && !await validateChannel(env, interaction.guild_id, next.channel_id)) {
    return { content: 'No puedo usar ese canal: debe ser de texto de este servidor y permitirme Ver canal, Enviar mensajes e Insertar enlaces.' };
  }
  await db.batch([
    db.prepare(`INSERT INTO guild_config(guild_id, voter_role_id, votes_to_close, votes_to_override, channel_id, version, last_interaction_id)
      SELECT ?, ?, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM guild_config_attempts WHERE interaction_id = ?)
      ON CONFLICT(guild_id) DO UPDATE SET voter_role_id = excluded.voter_role_id, votes_to_close = excluded.votes_to_close,
        votes_to_override = excluded.votes_to_override, channel_id = excluded.channel_id,
        version = guild_config.version + 1, last_interaction_id = excluded.last_interaction_id
      WHERE guild_config.version = ?`)
      .bind(interaction.guild_id, next.voter_role_id, next.votes_to_close, next.votes_to_override, next.channel_id, interaction.id, interaction.id, old.version),
    db.prepare(`INSERT OR IGNORE INTO guild_config_attempts(interaction_id, applied)
      SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM guild_config WHERE guild_id = ? AND last_interaction_id = ?) THEN 1 ELSE 0 END`)
      .bind(interaction.id, interaction.guild_id, interaction.id)
  ]);
  const result = await db.prepare('SELECT applied FROM guild_config_attempts WHERE interaction_id = ?').bind(interaction.id).first();
  return { content: result.applied
    ? `Configuración guardada.\n${configSummary(await getGuildConfig(db, interaction.guild_id))}`
    : 'La configuración cambió mientras la editabas. Consultá /config ver y enviá una solicitud nueva.' };
}
