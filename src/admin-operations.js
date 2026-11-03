import { isAdministrator } from './admin-permissions.js';
import { historyDateExpression } from './proposal-dates.js';
import { requestMessageSync } from './message-sync.js';
import { reportFailure } from './diagnostics.js';

export const OPERATIONS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS admin_operations (
  id TEXT PRIMARY KEY, preview_interaction_id TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  processed_at INTEGER, confirmation_interaction_id TEXT
)`;
export const ITEMS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS admin_operation_items (
  operation_id TEXT NOT NULL, proposal_id TEXT NOT NULL, target_id TEXT NOT NULL,
  previous_status TEXT NOT NULL, amount INTEGER NOT NULL, effect INTEGER NOT NULL,
  PRIMARY KEY(operation_id, proposal_id)
)`;
export const ADJUSTMENTS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS admin_adjustments (
  proposal_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE
)`;
export const OPERATIONS_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS admin_operations_scope ON admin_operations(guild_id, status, processed_at DESC)';

const opt = (interaction, name) => interaction.data.options?.[0]?.options?.find((option) => option.name === name)?.value;
const signed = (n) => `${n > 0 ? '+' : ''}${n}`;
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
const operationName = (kind) => kind === 'adjust' ? 'Ajuste administrativo' : 'Anulación de historial';

export async function operationView(interaction, db, id) {
  if (!isAdministrator(interaction)) return { content: 'Esta acción exige Administrador.' };
  const operation = await db.prepare('SELECT * FROM admin_operations WHERE id = ? AND guild_id = ?').bind(id, interaction.guild_id).first();
  if (!operation) return { content: 'Operación inexistente en este servidor.' };
  const items = await db.prepare('SELECT * FROM admin_operation_items WHERE operation_id = ? ORDER BY proposal_id').bind(id).all();
  const total = items.results.reduce((sum, item) => sum + item.effect, 0);
  const lines = items.results.map((item) => `ID: \`${item.proposal_id}\` · <@${item.target_id}>\n${item.previous_status} · ${signed(item.amount)} puntos originales · efecto ${signed(item.effect)}`);
  const expired = operation.expires_at <= Math.floor(Date.now() / 1000);
  return { allowed_mentions: { parse: [] }, embeds: [{ title: operationName(operation.kind), color: 0x747f8d,
    description: `**Estado: ${operation.status}${operation.status === 'pending' && expired ? ' (vencida)' : ''}**\n${lines.join('\n\n')}\n\n**Efecto total: ${signed(total)} puntos**\nMotivo privado: ${operation.reason}\nAdministrador: <@${operation.actor_id}>\nCódigo: \`${operation.id}\`\n${operation.status === 'pending' ? 'La selección está fijada y vence a los 10 minutos. Confirmar aplica solo estos IDs; no vuelve a buscar la última propuesta.' : 'La auditoría conserva esta selección y su resultado.'}`
  }], components: operation.status === 'pending' && !expired && operation.actor_id === interaction.member.user.id ? [{ type: 1, components: [
    { type: 2, style: 4, label: 'Confirmar operación', custom_id: `admin:confirm:${id}` },
    { type: 2, style: 2, label: 'Descartar', custom_id: `admin:discard:${id}` }
  ] }] : [] };
}

export async function previewOperation(interaction, env) {
  if (!isAdministrator(interaction)) return { content: 'Esta acción exige Administrador.' };
  const db = env.DB;
  const action = interaction.data.options?.[0]?.name;
  const reason = String(opt(interaction, 'motivo') ?? '').trim();
  if (reason.length < 3 || reason.length > 250) return { content: 'Escribí un motivo administrativo de entre 3 y 250 caracteres.' };
  const prior = await db.prepare('SELECT id FROM admin_operations WHERE preview_interaction_id = ? AND guild_id = ?')
    .bind(interaction.id, interaction.guild_id).first();
  if (prior) return operationView(interaction, db, prior.id);
  const id = crypto.randomUUID();
  let items;
  if (action === 'ajustar') {
    const target = opt(interaction, 'usuario');
    const amount = opt(interaction, 'puntos');
    if (!validId(target) || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) return { content: 'Elegí una persona y puntos enteros entre -1000000 y 1000000, excepto cero.' };
    items = [{ proposal_id: `admin-${id}`, target_id: target, previous_status: 'new', amount, effect: amount }];
  } else {
    let ids;
    if (action === 'anular_ultima') {
      const target = opt(interaction, 'usuario');
      if (!validId(target)) return { content: 'Elegí la persona que recibió la propuesta.' };
      const date = await historyDateExpression(db);
      const row = await db.prepare(`SELECT id FROM proposals WHERE guild_id = ? AND target_id = ? AND status <> 'voided' ORDER BY ${date} DESC, id DESC LIMIT 1`)
        .bind(interaction.guild_id, target).first();
      if (!row) return { content: 'No hay propuestas visibles para esa persona en este servidor.' };
      ids = [row.id];
    } else if (action === 'anular') ids = [opt(interaction, 'propuesta')];
    else ids = [...new Set(String(opt(interaction, 'propuestas') ?? '').split(/[\s,]+/).filter(Boolean))];
    if (!ids.length || ids.length > 10 || !ids.every(validId)) return { content: 'Elegí de 1 a 10 IDs válidos, separados por comas o espacios.' };
    const rows = await db.prepare(`SELECT id, target_id, status, amount FROM proposals WHERE guild_id = ? AND status <> 'voided' AND id IN (${ids.map(() => '?').join(',')})`)
      .bind(interaction.guild_id, ...ids).all();
    if (rows.results.length !== ids.length) return { content: 'Alguna propuesta no existe en este servidor o ya fue anulada. No se preparó la operación.' };
    items = rows.results.map((row) => ({ proposal_id: row.id, target_id: row.target_id, previous_status: row.status,
      amount: row.amount, effect: row.status === 'approved' ? -row.amount : 0 }));
  }
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO admin_operations(id, preview_interaction_id, guild_id, actor_id, kind, reason, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch() + 600)`)
      .bind(id, interaction.id, interaction.guild_id, interaction.member.user.id, action === 'ajustar' ? 'adjust' : 'void', reason),
    ...items.map((item) => db.prepare(`INSERT OR IGNORE INTO admin_operation_items(operation_id, proposal_id, target_id, previous_status, amount, effect)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM admin_operations WHERE id = ?)`)
      .bind(id, item.proposal_id, item.target_id, item.previous_status, item.amount, item.effect, id))
  ]);
  // A duplicate delivery can race with another preview of the same interaction.
  const stored = await db.prepare('SELECT id FROM admin_operations WHERE preview_interaction_id = ? AND guild_id = ?').bind(interaction.id, interaction.guild_id).first();
  return operationView(interaction, db, stored.id);
}

export async function confirmOperation(interaction, env, ctx, id, discard = false) {
  if (!isAdministrator(interaction)) return { content: 'Esta acción exige Administrador.' };
  const db = env.DB;
  if (!validId(id)) return { content: 'Indicá un código de operación válido.' };
  const operation = await db.prepare('SELECT * FROM admin_operations WHERE id = ? AND guild_id = ?').bind(id, interaction.guild_id).first();
  if (!operation) return { content: 'Operación inexistente en este servidor.' };
  if (operation.actor_id !== interaction.member.user.id) return { content: 'Solo el administrador que creó esta vista previa puede confirmarla o descartarla.' };
  if (operation.status !== 'pending') return { content: `Esta operación ya fue procesada (${operation.status}). Consultá /moderar operacion con su código.`, components: [] };
  if (discard) {
    const discarded = await db.prepare("UPDATE admin_operations SET status = 'cancelled', processed_at = unixepoch() WHERE id = ? AND guild_id = ? AND actor_id = ? AND status = 'pending'")
      .bind(id, interaction.guild_id, interaction.member.user.id).run();
    if (discarded.meta.changes !== 1) return { content: 'La operación ya fue procesada. Consultá /moderar operacion con su código.', components: [] };
    return { content: 'Vista previa descartada. No se modificó el aura ni el historial.', components: [] };
  }
  await db.batch([
    db.prepare(`UPDATE admin_operations SET status = 'applying', confirmation_interaction_id = ?, processed_at = unixepoch()
      WHERE id = ? AND guild_id = ? AND actor_id = ? AND status = 'pending' AND expires_at > unixepoch()
      AND EXISTS (SELECT 1 FROM admin_operation_items WHERE operation_id = admin_operations.id)
      AND (kind = 'adjust' OR NOT EXISTS (
        SELECT 1 FROM admin_operation_items i LEFT JOIN proposals p ON p.id = i.proposal_id
        WHERE i.operation_id = admin_operations.id AND (p.id IS NULL OR p.guild_id <> admin_operations.guild_id
          OR p.status <> i.previous_status OR p.amount <> i.amount OR p.target_id <> i.target_id OR p.status = 'voided')
      ))`).bind(interaction.id, id, interaction.guild_id, interaction.member.user.id),
    db.prepare(`INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, created_at, expires_at, status)
      SELECT i.proposal_id, o.guild_id, ?, i.target_id, o.actor_id, i.amount, 'Ajuste administrativo', unixepoch(), unixepoch() + 86400, 'approved'
      FROM admin_operations o JOIN admin_operation_items i ON i.operation_id = o.id
      WHERE o.id = ? AND o.kind = 'adjust' AND o.status = 'applying' AND o.confirmation_interaction_id = ?`)
      .bind(interaction.channel_id ?? 'administrative', id, interaction.id),
    db.prepare(`INSERT INTO admin_adjustments(proposal_id, operation_id)
      SELECT i.proposal_id, o.id FROM admin_operations o JOIN admin_operation_items i ON i.operation_id = o.id
      WHERE o.id = ? AND o.kind = 'adjust' AND o.status = 'applying' AND o.confirmation_interaction_id = ?`).bind(id, interaction.id),
    db.prepare(`UPDATE proposals SET status = 'voided' WHERE id IN (
      SELECT i.proposal_id FROM admin_operation_items i JOIN admin_operations o ON o.id = i.operation_id
      WHERE o.id = ? AND o.kind = 'void' AND o.status = 'applying' AND o.confirmation_interaction_id = ?
    )`).bind(id, interaction.id),
    db.prepare(`UPDATE proposal_notifications SET state = 'cancelled' WHERE state = 'pending' AND proposal_id IN (
      SELECT i.proposal_id FROM admin_operation_items i JOIN admin_operations o ON o.id = i.operation_id
      WHERE o.id = ? AND o.kind = 'void' AND o.status = 'applying' AND o.confirmation_interaction_id = ?
    )`).bind(id, interaction.id),
    db.prepare(`INSERT INTO proposal_message_sync(proposal_id)
      SELECT i.proposal_id FROM admin_operation_items i JOIN admin_operations o ON o.id = i.operation_id
      WHERE o.id = ? AND o.kind = 'void' AND o.status = 'applying' AND o.confirmation_interaction_id = ?
      ON CONFLICT(proposal_id) DO UPDATE SET revision = revision + 1`).bind(id, interaction.id),
    db.prepare("UPDATE admin_operations SET status = 'applied' WHERE id = ? AND status = 'applying' AND confirmation_interaction_id = ?").bind(id, interaction.id),
    db.prepare("UPDATE admin_operations SET status = 'stale', processed_at = unixepoch() WHERE id = ? AND status = 'pending' AND guild_id = ? AND actor_id = ?")
      .bind(id, interaction.guild_id, interaction.member.user.id)
  ]);
  const result = await db.prepare('SELECT status FROM admin_operations WHERE id = ?').bind(id).first();
  if (result.status !== 'applied') return { content: 'La vista previa venció o alguna propuesta cambió. No se aplicó ningún cambio; creá una vista previa nueva.', components: [] };
  if (operation.kind === 'void') {
    const items = await db.prepare('SELECT proposal_id FROM admin_operation_items WHERE operation_id = ?').bind(id).all();
    for (const item of items.results) ctx.waitUntil(requestMessageSync(env, item.proposal_id).catch((error) => reportFailure('ADMIN_MESSAGE_SYNC_PENDING', error)));
  }
  return { content: `${operationName(operation.kind)} aplicada y auditada. Los cambios ya se reflejan en perfil, ranking e historial. Los mensajes conocidos se actualizan en segundo plano.\nCódigo: \`${id}\``, components: [] };
}

const metadataReady = new WeakSet();
export async function administrativeExpression(db) {
  if (!metadataReady.has(db)) {
    const found = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_adjustments'").first();
    if (!found) return '0';
    metadataReady.add(db);
  }
  return 'EXISTS (SELECT 1 FROM admin_adjustments WHERE proposal_id = proposals.id)';
}
