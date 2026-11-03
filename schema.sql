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
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  voter_role_id TEXT NOT NULL,
  votes_to_close INTEGER NOT NULL CHECK(votes_to_close BETWEEN 1 AND 100),
  votes_to_override INTEGER NOT NULL CHECK(votes_to_override BETWEEN votes_to_close AND 100),
  channel_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  last_interaction_id TEXT
);
CREATE TABLE IF NOT EXISTS proposal_rules (
  proposal_id TEXT PRIMARY KEY,
  voter_role_id TEXT NOT NULL,
  votes_to_close INTEGER NOT NULL,
  votes_to_override INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_config_attempts (
  interaction_id TEXT PRIMARY KEY,
  applied INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_actions (
  interaction_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  previous_status TEXT NOT NULL,
  result_status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_actions_scope ON admin_actions(guild_id, created_at DESC, interaction_id DESC);
CREATE TABLE IF NOT EXISTS admin_operations (
  id TEXT PRIMARY KEY,
  preview_interaction_id TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  processed_at INTEGER,
  confirmation_interaction_id TEXT
);
CREATE TABLE IF NOT EXISTS admin_operation_items (
  operation_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  amount INTEGER NOT NULL,
  effect INTEGER NOT NULL,
  PRIMARY KEY(operation_id, proposal_id)
);
CREATE TABLE IF NOT EXISTS admin_adjustments (
  proposal_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS admin_operations_scope ON admin_operations(guild_id, status, processed_at DESC);
