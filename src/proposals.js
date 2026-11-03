export const CREATION_ATTEMPTS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS proposal_creation_attempts (
  interaction_id TEXT PRIMARY KEY
)`;
export const RECORD_CREATION_ATTEMPT_SQL = 'INSERT OR IGNORE INTO proposal_creation_attempts(interaction_id) VALUES (?)';

export const DUPLICATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS proposals_duplicates
  ON proposals(guild_id, target_id, reason, expires_at) WHERE status = 'open'`;

// The check and insertion are one write statement on D1's primary, so parallel
// Worker instances cannot both create an open proposal for the same exact key.
// Existing duplicates are kept intact; this is intentionally not a unique index.
export const INSERT_PROPOSAL_SQL = `INSERT INTO proposals
  (id, guild_id, channel_id, target_id, proposer_id, amount, reason, created_at, expires_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM proposal_creation_attempts WHERE interaction_id = ?)
    AND NOT EXISTS (
    SELECT 1 FROM proposals WHERE guild_id = ? AND target_id = ? AND reason = ?
      AND status = 'open' AND expires_at > unixepoch()
  ) ON CONFLICT(id) DO NOTHING`;
