import assert from 'node:assert/strict';
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalD1 } from '../test-support/local-d1.js';
import { historyDateExpression, migrateProposalDates } from '../src/proposal-dates.js';

function legacyDatabase() {
  const DB = new LocalD1();
  DB.db.exec('DROP INDEX IF EXISTS proposals_history; ALTER TABLE proposals DROP COLUMN created_at');
  const insert = DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, date, status] of [['older', 100, 'approved'], ['tie-a', 200, 'approved'], ['tie-b', 200, 'approved'], ['open', 300, 'open']]) {
    insert.run(id, 'guild', 'channel', 'target', 'creator', 100, id, date + 86400, status);
  }
  DB.db.exec("INSERT INTO votes VALUES ('open', 'voter', 'yes'); INSERT INTO role_votes VALUES ('open', 'voter', 'yes');");
  return DB;
}

async function visibleHistory(DB) {
  const date = await historyDateExpression(DB);
  return DB.db.prepare(`SELECT id, ${date} AS created_at FROM proposals WHERE status = 'approved' ORDER BY created_at DESC, id DESC`).all();
}

test('una copia local de datos heredados conserva fechas, orden, propuestas y votos tras migraciones repetidas', async () => {
  const source = legacyDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'ben10-dates-'));
  const copy = new LocalD1();
  copy.db.close();
  try {
    await backup(source.db, join(directory, 'copy.sqlite'));
    copy.db = new DatabaseSync(join(directory, 'copy.sqlite'));
    // Reapplying the bootstrap schema must also work against an old checkout's DB.
    copy.db.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    const before = await visibleHistory(copy);
    const originalRows = copy.db.prepare('SELECT * FROM proposals ORDER BY id').all();
    await migrateProposalDates(copy);
    // Use a new binding to exercise persistence rather than only the promise cache.
    await migrateProposalDates({ prepare: copy.prepare.bind(copy), batch: copy.batch.bind(copy) });
    assert.deepEqual(await visibleHistory(copy), before);
    const migratedRows = copy.db.prepare('SELECT * FROM proposals ORDER BY id').all();
    for (let i = 0; i < migratedRows.length; i++) {
      const { created_at, ...rest } = migratedRows[i];
      assert.equal(created_at, originalRows[i].expires_at - 86400);
      assert.deepEqual(rest, { ...originalRows[i] });
    }
    assert.equal(copy.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
    assert.equal(copy.db.prepare('SELECT COUNT(*) AS n FROM role_votes').get().n, 1);
    assert.equal(source.db.prepare('PRAGMA table_info(proposals)').all().some((column) => column.name === 'created_at'), false);
  } finally { source.close(); if (copy.db.isOpen) copy.close(); await rm(directory, { recursive: true, force: true }); }
});

test('dos instancias pueden competir por añadir created_at sin perder la migración', async () => {
  const DB = legacyDatabase();
  try {
    const binding = () => ({ prepare: DB.prepare.bind(DB), batch: DB.batch.bind(DB) });
    await Promise.all([migrateProposalDates(binding()), migrateProposalDates(binding())]);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE created_at IS NULL').get().n, 0);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 4);
  } finally { DB.close(); }
});

test('no se sobrescriben fechas explícitas y cambiar el vencimiento no cambia el historial', async () => {
  const DB = new LocalD1();
  try {
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('new', 'guild', 'channel', 'target', 'creator', 100, 'Actual', 500, 999999, 'approved');
    await migrateProposalDates(DB);
    assert.equal((await visibleHistory(DB))[0].created_at, 500);
    DB.db.exec('UPDATE proposals SET expires_at = 1');
    await migrateProposalDates({ prepare: DB.prepare.bind(DB), batch: DB.batch.bind(DB) });
    assert.equal((await visibleHistory(DB))[0].created_at, 500);
  } finally { DB.close(); }
});

test('una lectura heredada detecta luego la columna añadida por otra instancia', async () => {
  const DB = legacyDatabase();
  try {
    assert.equal(await historyDateExpression(DB), '(expires_at - 86400)');
    await migrateProposalDates({ prepare: DB.prepare.bind(DB), batch: DB.batch.bind(DB) });
    assert.equal(await historyDateExpression(DB), 'COALESCE(created_at, expires_at - 86400)');
  } finally { DB.close(); }
});

test('un fallo de ALTER se informa y no impide una migración posterior', async () => {
  const DB = legacyDatabase();
  const prepare = DB.prepare.bind(DB);
  let fail = true;
  DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith('ALTER TABLE') && fail) {
      fail = false;
      statement.run = () => { throw new Error('Transient D1 failure'); };
    }
    return statement;
  };
  try {
    await assert.rejects(migrateProposalDates(DB), /Transient D1 failure/);
    await migrateProposalDates(DB);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE created_at IS NULL').get().n, 0);
  } finally { DB.close(); }
});
