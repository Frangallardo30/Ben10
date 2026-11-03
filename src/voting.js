export const AURA_VOTER_ROLE_ID = '1431791263547392121';
export const VOTES_TO_CLOSE = 4;
export const VOTES_TO_OVERRIDE = 6;

export const UPSERT_VOTE_SQL = "INSERT INTO votes(proposal_id, user_id, choice) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'open') AND NOT EXISTS (SELECT 1 FROM vote_interactions WHERE interaction_id = ?) ON CONFLICT(proposal_id, user_id) DO UPDATE SET choice = excluded.choice";
export const UPSERT_ROLE_VOTE_SQL = "INSERT INTO role_votes(proposal_id, user_id, choice) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'open') AND NOT EXISTS (SELECT 1 FROM vote_interactions WHERE interaction_id = ?) ON CONFLICT(proposal_id, user_id) DO UPDATE SET choice = excluded.choice";
export const REMOVE_ROLE_VOTE_SQL = "DELETE FROM role_votes WHERE proposal_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM proposals WHERE id = role_votes.proposal_id AND status = 'open') AND NOT EXISTS (SELECT 1 FROM vote_interactions WHERE interaction_id = ?)";

export const CLOSE_PROPOSAL_SQL = `UPDATE proposals SET status = (
  SELECT CASE
    WHEN role_yes >= ${VOTES_TO_OVERRIDE} THEN 'approved'
    WHEN role_no >= ${VOTES_TO_OVERRIDE} THEN 'rejected'
    WHEN role_yes >= ${VOTES_TO_CLOSE} AND (all_yes > all_no OR (all_yes = all_no AND role_no < ${VOTES_TO_CLOSE})) THEN 'approved'
    WHEN role_no >= ${VOTES_TO_CLOSE} AND (all_no > all_yes OR (all_yes = all_no AND role_yes < ${VOTES_TO_CLOSE})) THEN 'rejected'
    ELSE 'open'
  END FROM (
    SELECT
      (SELECT COUNT(*) FROM votes WHERE proposal_id = ? AND choice = 'yes') AS all_yes,
      (SELECT COUNT(*) FROM votes WHERE proposal_id = ? AND choice = 'no') AS all_no,
      (SELECT COUNT(*) FROM role_votes WHERE proposal_id = ? AND choice = 'yes') AS role_yes,
      (SELECT COUNT(*) FROM role_votes WHERE proposal_id = ? AND choice = 'no') AS role_no
  )
) WHERE id = ? AND status = 'open'`;

export function canVote(userId, proposal) {
  return Boolean(userId && userId !== proposal.target_id && userId !== proposal.proposer_id);
}

export const CANCEL_PROPOSAL_SQL = "UPDATE proposals SET status = 'cancelled' WHERE id = ? AND guild_id = ? AND proposer_id = ? AND status = 'open' AND expires_at > unixepoch()";
