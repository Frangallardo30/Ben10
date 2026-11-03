import { QUEUE_MESSAGE_SYNC_SQL, requestMessageSync } from './message-sync.js';
import { diagnostic, diagnosticDatabase, discordRequest, discordJSON, reportFailure } from './diagnostics.js';
// A claimed delivery is never automatically reclaimed: after a lost response,
// Discord may already have created the message. Prefer a missing notice to a duplicate.
export const NOTIFICATION_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS proposal_notifications (
  proposal_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  retry_at INTEGER NOT NULL DEFAULT 0,
  message_id TEXT
)`;

export const QUEUE_NOTIFICATION_SQL = `INSERT OR IGNORE INTO proposal_notifications(proposal_id)
  SELECT id FROM proposals WHERE id = ? AND status IN ('approved', 'rejected')`;

export async function sendClosureNotifications(env, proposalId) {
  env = { ...env, DB: diagnosticDatabase(env.DB) };
  if (!env.DISCORD_BOT_TOKEN) return;
  const pending = await env.DB.prepare(`SELECT p.* FROM proposals p
    JOIN proposal_notifications n ON n.proposal_id = p.id
    WHERE n.state = 'pending' AND n.retry_at <= unixepoch()
      AND p.status IN ('approved', 'rejected') AND (? IS NULL OR p.id = ?)
    ORDER BY n.retry_at, p.id LIMIT 20`).bind(proposalId ?? null, proposalId ?? null).all();
  for (const proposal of pending.results) {
    const claim = await env.DB.prepare(`UPDATE proposal_notifications SET state = 'sending'
      WHERE proposal_id = ? AND state = 'pending' AND retry_at <= unixepoch()
      AND EXISTS (SELECT 1 FROM proposals WHERE id = proposal_notifications.proposal_id AND status IN ('approved', 'rejected'))`)
      .bind(proposal.id).run();
    if (claim.meta.changes !== 1) continue;
    try {
      const approved = proposal.status === 'approved';
      const content = approved
        ? `✅ Propuesta aprobada: <@${proposal.target_id}> recibe ${proposal.amount > 0 ? '+' : ''}${proposal.amount} puntos de aura.`
        : `❌ Propuesta rechazada para <@${proposal.target_id}>. Su aura no cambia.`;
      const response = await discordRequest(`https://discord.com/api/v10/channels/${proposal.channel_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
      });
      if (response.status === 429) {
        diagnostic('warn', 'DISCORD_NOTICE_RATE_LIMITED', 'discord', 429);
        const data = await discordJSON(response);
        const delay = Math.max(1, Math.ceil(Number(data.retry_after) || 60));
        await env.DB.prepare(`UPDATE proposal_notifications SET state = 'pending', retry_at = unixepoch() + ? WHERE proposal_id = ?`)
          .bind(delay, proposal.id).run();
        break;
      }
      if (!response.ok) {
        // 5xx may occur after creation; even a failed delivery must not be reposted blindly.
        await env.DB.prepare("UPDATE proposal_notifications SET state = 'uncertain' WHERE proposal_id = ?").bind(proposal.id).run();
        diagnostic('warn', 'CLOSURE_NOTICE_REVIEW_REQUIRED', 'discord', response.status);
        continue;
      }
      const message = await discordJSON(response);
      await env.DB.prepare("UPDATE proposal_notifications SET state = 'sent', message_id = ? WHERE proposal_id = ?")
        .bind(message.id ?? null, proposal.id).run();
      const current = await env.DB.prepare('SELECT status FROM proposals WHERE id = ?').bind(proposal.id).first();
      if (current?.status === 'voided') {
        await env.DB.prepare(QUEUE_MESSAGE_SYNC_SQL).bind(proposal.id).run();
        await requestMessageSync(env, proposal.id);
      }
    } catch (error) {
      // Keep the durable delivery state; never blindly repost after an uncertain result.
      reportFailure('CLOSURE_NOTICE_UNCERTAIN', error);
    }
  }
}
