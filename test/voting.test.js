import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canVote, CLOSE_PROPOSAL_SQL, REMOVE_ROLE_VOTE_SQL, UPSERT_ROLE_VOTE_SQL, UPSERT_VOTE_SQL } from '../src/voting.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('proposal', 'guild', 'channel', 'target', 'proposer', 100, 'Motivo', 1);
  return db;
}

function cast(db, user, choice, hasRole) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(UPSERT_VOTE_SQL).run('proposal', user, choice, 'proposal', null);
    if (hasRole) db.prepare(UPSERT_ROLE_VOTE_SQL).run('proposal', user, choice, 'proposal', null);
    else db.prepare(REMOVE_ROLE_VOTE_SQL).run('proposal', user, null);
    db.prepare(CLOSE_PROPOSAL_SQL).run('proposal', 'proposal', 'proposal', 'proposal', 'proposal');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const status = (db) => db.prepare("SELECT status FROM proposals WHERE id = 'proposal'").get().status;
const count = (db, table, choice) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE choice = ?`).get(choice).n;

test('quien propone o recibe no vota, incluso en una postulación propia', () => {
  const ownProposal = { proposer_id: 'fran', target_id: 'fran' };
  assert.equal(canVote('fran', ownProposal), false);
  assert.equal(canVote('otro', ownProposal), true);
  assert.equal(canVote('proposer', { proposer_id: 'proposer', target_id: 'target' }), false);
  assert.equal(canVote('target', { proposer_id: 'proposer', target_id: 'target' }), false);
});

test('los votos generales cuentan, pero no cierran sin el rol', () => {
  const db = database();
  for (let i = 0; i < 8; i++) cast(db, `general-${i}`, 'no', false);
  assert.equal(count(db, 'votes', 'no'), 8);
  assert.equal(count(db, 'role_votes', 'no'), 0);
  assert.equal(status(db), 'open');
  db.close();
});

test('cuatro votos del rol aprueban si empatan o lideran el total', () => {
  const db = database();
  for (let i = 0; i < 4; i++) cast(db, `general-${i}`, 'no', false);
  for (let i = 0; i < 4; i++) cast(db, `role-${i}`, 'yes', true);
  assert.equal(status(db), 'approved');
  assert.equal(count(db, 'votes', 'yes'), 4);
  assert.equal(count(db, 'votes', 'no'), 4);
  db.close();
});

test('cuatro rechazos del rol cierran si lideran el total', () => {
  const db = database();
  for (let i = 0; i < 4; i++) cast(db, `role-${i}`, 'no', true);
  assert.equal(status(db), 'rejected');
  db.close();
});

test('cuatro votos del rol que van perdiendo esperan; seis se imponen', () => {
  const db = database();
  for (let i = 0; i < 7; i++) cast(db, `general-${i}`, 'no', false);
  for (let i = 0; i < 4; i++) cast(db, `role-${i}`, 'yes', true);
  assert.equal(status(db), 'open');
  cast(db, 'role-4', 'yes', true);
  assert.equal(status(db), 'open');
  cast(db, 'role-5', 'yes', true);
  assert.equal(status(db), 'approved');
  assert.equal(count(db, 'votes', 'no'), 7);
  db.close();
});

test('cuatro rechazos del rol que van perdiendo esperan; seis rechazan', () => {
  const db = database();
  for (let i = 0; i < 7; i++) cast(db, `general-${i}`, 'yes', false);
  for (let i = 0; i < 6; i++) {
    cast(db, `role-${i}`, 'no', true);
    if (i === 3 || i === 4) assert.equal(status(db), 'open');
  }
  assert.equal(status(db), 'rejected');
  db.close();
});

test('cambiar el voto no duplica a la persona y el cierre bloquea votos nuevos', () => {
  const db = database();
  cast(db, 'voter', 'yes', true);
  cast(db, 'voter', 'no', true);
  assert.equal(count(db, 'votes', 'yes'), 0);
  assert.equal(count(db, 'votes', 'no'), 1);
  assert.equal(count(db, 'role_votes', 'no'), 1);
  for (let i = 1; i < 4; i++) cast(db, `role-${i}`, 'no', true);
  assert.equal(status(db), 'rejected');
  cast(db, 'late', 'yes', false);
  assert.equal(count(db, 'votes', 'yes'), 0);
  db.close();
});

test('si una persona pierde el rol antes de cambiar su voto, deja de contar para el cierre', () => {
  const db = database();
  cast(db, 'voter', 'yes', true);
  cast(db, 'voter', 'no', false);
  assert.equal(count(db, 'votes', 'no'), 1);
  assert.equal(count(db, 'role_votes', 'yes'), 0);
  assert.equal(count(db, 'role_votes', 'no'), 0);
  db.close();
});
