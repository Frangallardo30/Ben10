const knownColumns = new WeakSet();
const migrations = new WeakMap();

async function hasCreatedAt(db) {
  if (knownColumns.has(db)) return true;
  const columns = await db.prepare('PRAGMA table_info(proposals)').all();
  const present = columns.results.some((column) => column.name === 'created_at');
  if (present) knownColumns.add(db);
  // Do not cache absence: another Worker instance may migrate this database.
  return present;
}

export async function historyDateExpression(db) {
  return await hasCreatedAt(db) ? 'COALESCE(created_at, expires_at - 86400)' : '(expires_at - 86400)';
}

export function migrateProposalDates(db) {
  if (migrations.has(db)) return migrations.get(db);
  const ready = migrate(db).catch((error) => {
    migrations.delete(db);
    throw error;
  });
  migrations.set(db, ready);
  return ready;
}

async function migrate(db) {
  if (!await hasCreatedAt(db)) {
    try { await db.prepare('ALTER TABLE proposals ADD COLUMN created_at INTEGER').run(); }
    catch (error) {
      // Another instance may have added it between the check and ALTER. Confirm
      // the schema before treating this as a successful concurrent migration.
      if (!await hasCreatedAt(db)) throw error;
    }
    knownColumns.add(db);
  }
  await db.batch([
    // Preserve the exact date previously displayed for every legacy proposal.
    db.prepare('UPDATE proposals SET created_at = expires_at - 86400 WHERE created_at IS NULL'),
    db.prepare('CREATE INDEX IF NOT EXISTS proposals_history ON proposals(guild_id, target_id, status, created_at DESC, id DESC)')
  ]);
}
