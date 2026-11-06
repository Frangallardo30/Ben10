import { administrativeExpression } from './admin-operations.js';

const PAGE_SIZE = 20;

export function parseVoteList(customId) {
  const match = /^ballot:([A-Za-z0-9_-]{1,64}):([1-9][0-9]{0,6})$/.exec(customId ?? '');
  if (!match || Number(match[2]) > 1000000) return null;
  return { id: match[1], page: Number(match[2]) };
}

export async function voteList(interaction, db) {
  const selection = parseVoteList(interaction.data.custom_id);
  if (!interaction.guild_id || !selection) return { content: 'Usá Ver votos desde una propuesta de este servidor.', components: [] };
  const { id, page } = selection;
  const administrative = await administrativeExpression(db);
  // One snapshot keeps totals, visibility and the current page consistent.
  const rows = await db.prepare(`WITH visible AS (
      SELECT id, status FROM proposals WHERE id = ? AND guild_id = ? AND status <> 'voided' AND NOT (${administrative})
    ), totals AS (
      SELECT COUNT(*) AS total, COALESCE(SUM(choice = 'yes'), 0) AS yes, COALESCE(SUM(choice = 'no'), 0) AS no
      FROM votes WHERE proposal_id IN (SELECT id FROM visible)
    ), entries AS (
      SELECT user_id, choice FROM votes WHERE proposal_id IN (SELECT id FROM visible)
      ORDER BY user_id LIMIT ? OFFSET ?
    ) SELECT visible.id, totals.*, entries.user_id, entries.choice
      FROM visible CROSS JOIN totals LEFT JOIN entries ON 1 = 1 ORDER BY entries.user_id`)
    .bind(id, interaction.guild_id, PAGE_SIZE, (page - 1) * PAGE_SIZE).all();
  const first = rows.results[0];
  if (!first) return { content: 'Esta propuesta no está disponible para consultar votos en este servidor.', components: [] };
  const pages = Math.max(1, Math.ceil(first.total / PAGE_SIZE));
  if (page > pages) return { content: `Esta votación tiene ${pages} página(s). Volvé a abrir Ver votos.`, components: [] };
  const entries = rows.results.filter(row => row.user_id != null).map(row => `<@${row.user_id}> · ${row.choice === 'yes' ? '👍 Aprobar' : '👎 Rechazar'}`);
  const buttons = [];
  if (page > 1) buttons.push({ type: 2, style: 2, label: 'Anterior', custom_id: `ballot:${id}:${page - 1}` });
  if (page < pages) buttons.push({ type: 2, style: 2, label: 'Siguiente', custom_id: `ballot:${id}:${page + 1}` });
  return { allowed_mentions: { parse: [] }, embeds: [{ title: '🗳️ Quién votó', color: 0x5785f2,
    description: `Propuesta: \`${id}\`\n👍 Aprobar: **${first.yes}** · 👎 Rechazar: **${first.no}**\n\n${entries.join('\n') || 'Todavía no hay votos.'}`,
    footer: { text: `Página ${page} de ${pages} · ${first.total} votos · Opción actual al consultar; 20 por página.` }
  }], components: buttons.length ? [{ type: 1, components: buttons }] : [] };
}
