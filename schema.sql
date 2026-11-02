CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  target_id TEXT NOT NULL,
  proposer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
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
