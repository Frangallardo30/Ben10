import { display } from './presentation.js';

export const MESSAGE_SYNC_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS proposal_message_sync (
  proposal_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  synced_revision INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
)`;

export const QUEUE_MESSAGE_SYNC_SQL = `INSERT INTO proposal_message_sync(proposal_id) VALUES (?)
  ON CONFLICT(proposal_id) DO UPDATE SET revision = revision + 1`;

// One SQL statement provides a consistent snapshot of status, counts and revision.
export async function readProposalMessage(db, id) {
  const proposal = await db.prepare(`SELECT p.*, s.revision, s.synced_revision, s.retry_at,
    (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id AND choice = 'yes') AS yes,
    (SELECT COUNT(*) FROM votes WHERE proposal_id = p.id AND choice = 'no') AS no,
    (SELECT COUNT(*) FROM role_votes WHERE proposal_id = p.id AND choice = 'yes') AS roleYes,
    (SELECT COUNT(*) FROM role_votes WHERE proposal_id = p.id AND choice = 'no') AS roleNo
    FROM proposals p LEFT JOIN proposal_message_sync s ON s.proposal_id = p.id WHERE p.id = ?`).bind(id).first();
  return proposal ? { proposal, body: display(proposal, proposal) } : null;
}

export async function requestMessageSync(env, id) {
  if (!env.MESSAGE_SYNC) throw new Error('MESSAGE_SYNC binding is missing');
  const stub = env.MESSAGE_SYNC.get(env.MESSAGE_SYNC.idFromName(id));
  const response = await stub.fetch('https://message-sync.internal/', {
    method: 'POST', body: JSON.stringify({ id })
  });
  if (!response.ok) throw new Error(`Message synchronization deferred: ${response.status}`);
}

export async function retryMessageSync(env) {
  await env.DB.prepare(MESSAGE_SYNC_SCHEMA_SQL).run();
  const pending = await env.DB.prepare(`SELECT s.proposal_id FROM proposal_message_sync s
    JOIN proposals p ON p.id = s.proposal_id
    WHERE s.revision > s.synced_revision AND s.retry_at <= unixepoch() AND p.message_id IS NOT NULL
    ORDER BY s.retry_at, s.proposal_id LIMIT 20`).all();
  for (const row of pending.results) {
    try { await requestMessageSync(env, row.proposal_id); }
    catch (error) { console.warn('Message synchronization pending', row.proposal_id, error?.name); }
  }
}

// All message writers use this per-proposal Durable Object. Awaiting the previous
// PATCH prevents an older edit from completing after a newer one in normal delivery.
// D1 keeps pending work across object eviction, Worker restarts and Discord errors.
export class ProposalMessageSync {
  constructor(_ctx, env) {
    this.env = env;
    this.tail = Promise.resolve();
  }

  fetch(request) {
    const next = this.tail.then(() => this.synchronize(request));
    this.tail = next.catch(() => {});
    return next;
  }

  async defer(id) {
    await this.env.DB.prepare('UPDATE proposal_message_sync SET retry_at = unixepoch() + 60 WHERE proposal_id = ?').bind(id).run();
  }

  async synchronize(request) {
    const { id } = await request.json();
    if (typeof id !== 'string' || !id) return new Response('Invalid proposal', { status: 400 });
    if (!this.env.DISCORD_BOT_TOKEN) return new Response('Bot token missing', { status: 503 });
    // Bound each request; any remaining revision stays pending for the next call/cron.
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await readProposalMessage(this.env.DB, id);
      if (!snapshot) return new Response('Proposal missing', { status: 404 });
      const { proposal, body } = snapshot;
      if (proposal.revision == null || proposal.revision <= proposal.synced_revision) return new Response('Current');
      if (!proposal.message_id || proposal.retry_at > Math.floor(Date.now() / 1000)) return new Response('Pending', { status: 503 });
      try {
        const response = await fetch(`https://discord.com/api/v10/channels/${proposal.channel_id}/messages/${proposal.message_id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (response.status === 429) {
          const rateLimit = await response.json();
          const seconds = Number(rateLimit.retry_after);
          const delay = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
          await this.env.DB.prepare('UPDATE proposal_message_sync SET retry_at = unixepoch() + ? WHERE proposal_id = ?').bind(delay, id).run();
          return new Response('Rate limited', { status: 503 });
        }
        if (!response.ok && response.status !== 404) {
          await this.defer(id);
          return new Response('Discord error', { status: 503 });
        }
        // A vote may have arrived while PATCH was in flight. Acknowledge only the
        // version actually rendered, then read again before the next edit.
        await this.env.DB.prepare(`UPDATE proposal_message_sync
          SET synced_revision = ?, retry_at = 0 WHERE proposal_id = ?`).bind(proposal.revision, id).run();
      } catch (error) {
        console.warn('Message edit failed', id, error?.name);
        await this.defer(id);
        return new Response('Delivery uncertain', { status: 503 });
      }
    }
    return new Response('Pending', { status: 503 });
  }
}
