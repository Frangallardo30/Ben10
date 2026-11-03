CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  target_id TEXT NOT NULL,
  proposer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS proposals_duplicates ON proposals(guild_id, target_id, reason, expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS proposals_due ON proposals(status, expires_at);
CREATE TABLE IF NOT EXISTS votes (
  proposal_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK(choice IN ('yes', 'no')),
  PRIMARY KEY(proposal_id, user_id)
);
CREATE TABLE IF NOT EXISTS role_votes (
  proposal_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK(choice IN ('yes', 'no')),
  PRIMARY KEY(proposal_id, user_id)
);
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposal_expiry_sync (
  proposal_id TEXT PRIMARY KEY,
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS proposal_notifications (
  proposal_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  retry_at INTEGER NOT NULL DEFAULT 0,
  message_id TEXT
);
CREATE TABLE IF NOT EXISTS proposal_message_sync (
  proposal_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  synced_revision INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vote_interactions (
  interaction_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposal_creation_attempts (
  interaction_id TEXT PRIMARY KEY
);
