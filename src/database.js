import { OPERATIONS_SCHEMA_SQL, ITEMS_SCHEMA_SQL, ADJUSTMENTS_SCHEMA_SQL, OPERATIONS_INDEX_SQL } from './admin-operations.js';
import { ADMIN_ACTIONS_SCHEMA_SQL, ADMIN_ACTIONS_INDEX_SQL } from './moderation.js';
import { migrateGuildConfig } from './guild-config.js';
import { CREATION_ATTEMPTS_SCHEMA_SQL, DUPLICATE_INDEX_SQL } from './proposals.js';
import { diagnosticDatabase } from './diagnostics.js';
import { migrateProposalDates } from './proposal-dates.js';
import { MESSAGE_SYNC_SCHEMA_SQL } from './message-sync.js';
import { NOTIFICATION_SCHEMA_SQL } from './notifications.js';

export const VOTE_INTERACTIONS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS vote_interactions (
  interaction_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL
)`;

// Cache by database binding, not globally across databases. Failed preparation
// is evicted so a later interaction can retry; read-only commands do not need it.
const preparations = new WeakMap();
export function prepareWrites(db) {
  db = diagnosticDatabase(db);
  if (preparations.has(db)) return preparations.get(db);
  const ready = prepare(db).catch((error) => {
    preparations.delete(db);
    throw error;
  });
  preparations.set(db, ready);
  return ready;
}

async function prepare(db) {
  await migrateProposalDates(db);
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    db.prepare("CREATE TABLE IF NOT EXISTS role_votes (proposal_id TEXT NOT NULL, user_id TEXT NOT NULL, choice TEXT NOT NULL CHECK(choice IN ('yes', 'no')), PRIMARY KEY(proposal_id, user_id))"),
    db.prepare(MESSAGE_SYNC_SCHEMA_SQL),
    db.prepare(NOTIFICATION_SCHEMA_SQL),
    db.prepare(VOTE_INTERACTIONS_SCHEMA_SQL),
    db.prepare(DUPLICATE_INDEX_SQL),
    db.prepare(CREATION_ATTEMPTS_SCHEMA_SQL),
    db.prepare(ADMIN_ACTIONS_SCHEMA_SQL),
    db.prepare(ADMIN_ACTIONS_INDEX_SQL),
    db.prepare(OPERATIONS_SCHEMA_SQL),
    db.prepare(ITEMS_SCHEMA_SQL),
    db.prepare(ADJUSTMENTS_SCHEMA_SQL),
    db.prepare(OPERATIONS_INDEX_SQL)
  ]);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO role_votes(proposal_id, user_id, choice) SELECT v.proposal_id, v.user_id, v.choice FROM votes v JOIN proposals p ON p.id = v.proposal_id WHERE p.status = 'open' AND EXISTS (SELECT 1 FROM bot_settings WHERE key = 'voting_policy' AND value = 'role4-v1')"),
    db.prepare("INSERT INTO bot_settings(key, value) VALUES ('voting_policy', 'all-votes-role4-v2') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    // Refresh existing open messages once so they also receive the cancel button.
    db.prepare(`INSERT INTO proposal_message_sync(proposal_id)
      SELECT id FROM proposals WHERE status = 'open' AND message_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM bot_settings WHERE key = 'cancel_button_v1')
      ON CONFLICT(proposal_id) DO UPDATE SET revision = revision + 1`),
    db.prepare("INSERT OR IGNORE INTO bot_settings(key, value) VALUES ('cancel_button_v1', 'ready')"),
    // Upgrade known historical messages once; the durable queue retries delivery.
    db.prepare(`INSERT INTO proposal_message_sync(proposal_id)
      SELECT id FROM proposals WHERE message_id IS NOT NULL AND status <> 'voided'
        AND NOT EXISTS (SELECT 1 FROM admin_adjustments WHERE proposal_id = proposals.id)
        AND NOT EXISTS (SELECT 1 FROM bot_settings WHERE key = 'vote_list_button_v1')
      ON CONFLICT(proposal_id) DO UPDATE SET revision = revision + 1`),
    db.prepare("INSERT OR IGNORE INTO bot_settings(key, value) VALUES ('vote_list_button_v1', 'ready')")
  ]);
  await migrateGuildConfig(db);
}
