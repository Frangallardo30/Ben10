import { display } from './presentation.js';
import { historyDateExpression } from './proposal-dates.js';
import { QUEUE_MESSAGE_SYNC_SQL, readProposalMessage, requestMessageSync } from './message-sync.js';
import { reportFailure } from './diagnostics.js';

export const ADMIN_ACTIONS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS admin_actions (
  interaction_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
  created_at INTEGER NOT NULL, previous_status TEXT NOT NULL, result_status TEXT NOT NULL
)`;
export const ADMIN_ACTIONS_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS admin_actions_scope ON admin_actions(guild_id, created_at DESC, interaction_id DESC)';
const stateSQL = "CASE WHEN status = 'open' AND expires_at <= unixepoch() THEN 'expired' ELSE status END";
const states = { open: 'Abierta', approved: 'Aprobada', rejected: 'Rechazada', expired: 'Vencida', cancelled: 'Cancelada' };
const opt = (interaction, name) => interaction.data.options?.[0]?.options?.find((option) => option.name === name)?.value;

export function isAdministrator(interaction) {
  try {
    const permissions = BigInt(interaction.member?.permissions ?? '0');
    return Boolean(interaction.guild_id && interaction.member?.user?.id && permissions >= 0n && permissions & 8n);
  } catch { return false; }
}

function embed(title, description, footer) {
  return { allowed_mentions: { parse: [] }, embeds: [{ title, description, color: 0x747f8d, ...(footer ? { footer: { text: footer } } : {}) }] };
}

async function list(interaction, db) {
  const user = opt(interaction, 'usuario') ?? null;
  const state = opt(interaction, 'estado') ?? null;
  const page = opt(interaction, 'pagina') ?? 1;
  const where = `guild_id = ? AND (? IS NULL OR target_id = ?) AND (? IS NULL OR ${stateSQL} = ?)`;
  const args = [interaction.guild_id, user, user, state, state];
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE ${where}`).bind(...args).first();
  const pages = Math.max(1, Math.ceil(count.n / 8));
  if (page > pages) return { content: `Hay ${pages} página(s) para estos filtros.` };
  const date = await historyDateExpression(db);
  const rows = await db.prepare(`SELECT id, target_id, proposer_id, amount, reason, ${date} AS created_at, ${stateSQL} AS effective_status
    FROM proposals WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 8 OFFSET ?`).bind(...args, (page - 1) * 8).all();
  const lines = rows.results.map((row) => `**${states[row.effective_status] ?? 'Desconocida'}** · ID: \`${row.id}\`\n<@${row.target_id}> · ${row.amount > 0 ? '+' : ''}${row.amount} puntos · <t:${row.created_at}:d>\n${row.reason.replace(/\s+/g, ' ').slice(0, 250)}\nProponente: <@${row.proposer_id}>`);
  return embed('Moderación · Propuestas', lines.join('\n\n') || 'No hay propuestas para estos filtros.', `Página ${page} de ${pages} · ${count.n} propuestas. Usá el ID para inspeccionar o actuar.`);
}

async function actions(interaction, db) {
  const id = opt(interaction, 'propuesta') ?? null;
  const page = opt(interaction, 'pagina') ?? 1;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM admin_actions WHERE guild_id = ? AND (? IS NULL OR proposal_id = ?)')
    .bind(interaction.guild_id, id, id).first();
  const pages = Math.max(1, Math.ceil(count.n / 8));
  if (page > pages) return { content: `La auditoría tiene ${pages} página(s).` };
  const rows = await db.prepare(`SELECT * FROM admin_actions WHERE guild_id = ? AND (? IS NULL OR proposal_id = ?)
    ORDER BY created_at DESC, interaction_id DESC LIMIT 8 OFFSET ?`).bind(interaction.guild_id, id, id, (page - 1) * 8).all();
  return embed('Moderación · Auditoría', rows.results.map((row) => `**${row.action === 'cancel' ? 'Cancelación' : 'Sincronización solicitada'}** · \`${row.proposal_id}\`\n<@${row.actor_id}> · <t:${row.created_at}:f> · ${row.previous_status} → ${row.result_status}\n${row.reason.replace(/\s+/g, ' ').slice(0, 250)}`).join('\n\n') || 'No hay acciones administrativas para estos filtros.', `Página ${page} de ${pages}`);
}

export async function moderate(interaction, env, ctx) {
  if (!isAdministrator(interaction)) return { content: 'Este panel es exclusivo de quienes tienen Administrador.' };
  const db = env.DB;
  const action = interaction.data.options?.[0]?.name;
  if (!['listar', 'inspeccionar', 'cancelar', 'sincronizar', 'acciones'].includes(action)) return { content: 'Elegí una acción válida de /moderar.' };
  const page = opt(interaction, 'pagina') ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 1000000) return { content: 'Elegí una página entera entre 1 y 1000000.' };
  const filter = opt(interaction, 'estado');
  if (filter != null && !Object.hasOwn(states, filter)) return { content: 'Elegí un estado válido.' };
  const proposalId = opt(interaction, 'propuesta');
  if ((proposalId != null || !['listar', 'acciones'].includes(action)) && !/^[A-Za-z0-9_-]{1,100}$/.test(proposalId ?? '')) return { content: 'Indicá un ID de propuesta válido; podés copiarlo de /moderar listar.' };
  if (action === 'listar') return list(interaction, db);
  if (action === 'acciones') return actions(interaction, db);
  const id = opt(interaction, 'propuesta');
  const belongs = await db.prepare('SELECT id FROM proposals WHERE id = ? AND guild_id = ?').bind(id, interaction.guild_id).first();
  if (!belongs) return { content: 'Propuesta inexistente en este servidor.' };
  const snapshot = await readProposalMessage(db, id);
  if (!snapshot || snapshot.proposal.guild_id !== interaction.guild_id) return { content: 'Propuesta inexistente en este servidor.' };
  const proposal = snapshot.proposal;
  if (action === 'inspeccionar') {
    const expired = proposal.status === 'open' && proposal.expires_at <= Math.floor(Date.now() / 1000);
    const body = expired ? display({ ...proposal, status: 'expired' }, proposal) : snapshot.body;
    return { ...body, components: [], embeds: [{ ...body.embeds[0], fields: [
      ...body.embeds[0].fields,
      ...(expired ? [{ name: 'Estado guardado', value: 'Abierta; caducidad pendiente de procesar.' }] : []),
      { name: 'ID', value: id }, { name: 'Proponente', value: `<@${proposal.proposer_id}>` },
      { name: 'Vencimiento', value: `<t:${proposal.expires_at}:f>` }
    ] }] };
  }
  const previous = await db.prepare('SELECT action FROM admin_actions WHERE interaction_id = ? AND guild_id = ?')
    .bind(interaction.id, interaction.guild_id).first();
  if (previous) return { content: 'Esta acción ya fue procesada. Consultá /moderar acciones para ver el registro.' };
  if (action === 'cancelar' && (proposal.status !== 'open' || proposal.expires_at <= Math.floor(Date.now() / 1000))) return { content: 'La propuesta ya cerró o venció; no se puede cancelar desde este panel.' };
  const reason = String(opt(interaction, 'motivo') ?? '').trim() || (action === 'sincronizar' ? 'Actualización del mensaje solicitada' : '');
  if (reason.length < 3 || reason.length > 250) return { content: 'Escribí un motivo de entre 3 y 250 caracteres.' };
  if (action === 'sincronizar' && !proposal.message_id) return { content: 'No se guardó el ID del mensaje original; no puedo actualizarlo desde este panel.' };
  if (opt(interaction, 'confirmar') !== true) {
    return { content: `Vista previa: ${action === 'cancelar' ? 'cancelar' : 'actualizar el mensaje de'} la propuesta \`${id}\` para <@${proposal.target_id}>. Estado guardado: ${states[proposal.status] ?? proposal.status}.\nNo cambia puntos ni borra datos. Ejecutá de nuevo /moderar ${action} con esta propuesta y confirmar:true para continuar.` };
  }
  if (action === 'cancelar') {
    await db.batch([
      db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ? AND guild_id = ? AND status = 'open' AND expires_at <= unixepoch()")
        .bind(id, interaction.guild_id),
      db.prepare(`INSERT OR IGNORE INTO admin_actions(interaction_id, guild_id, proposal_id, actor_id, action, reason, created_at, previous_status, result_status)
        SELECT ?, guild_id, id, ?, 'cancel', ?, unixepoch(), status, 'cancelled' FROM proposals
        WHERE id = ? AND guild_id = ? AND status = 'open' AND expires_at > unixepoch()`)
        .bind(interaction.id, interaction.member.user.id, reason, id, interaction.guild_id),
      db.prepare(`UPDATE proposals SET status = 'cancelled' WHERE id = ? AND guild_id = ? AND status = 'open'
        AND EXISTS (SELECT 1 FROM admin_actions WHERE interaction_id = ? AND guild_id = ? AND proposal_id = ? AND action = 'cancel')`)
        .bind(id, interaction.guild_id, interaction.id, interaction.guild_id, id),
      db.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(id)
    ]);
    const applied = await db.prepare('SELECT action FROM admin_actions WHERE interaction_id = ? AND guild_id = ?')
      .bind(interaction.id, interaction.guild_id).first();
    if (!applied) return { content: 'La propuesta ya cerró o venció; no se canceló ni se modificó su aura.' };
  } else if (action === 'sincronizar') {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO admin_actions(interaction_id, guild_id, proposal_id, actor_id, action, reason, created_at, previous_status, result_status)
        SELECT ?, guild_id, id, ?, 'sync', ?, unixepoch(), status, status FROM proposals WHERE id = ? AND guild_id = ?`)
        .bind(interaction.id, interaction.member.user.id, reason.slice(0, 250), id, interaction.guild_id),
      db.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(id)
    ]);
  }
  ctx.waitUntil(requestMessageSync(env, id).catch((error) => reportFailure('ADMIN_MESSAGE_SYNC_PENDING', error)));
  return { content: action === 'cancelar'
    ? 'Propuesta cancelada y acción auditada. El mensaje se actualizará desde el estado guardado; los puntos no cambiaron.'
    : 'Actualización del mensaje solicitada y auditada. Se reintentará si Discord falla; no se reenvían avisos de cierre ni se cambian votos.' };
}
