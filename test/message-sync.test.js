import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalD1, messageSyncBinding } from '../test-support/local-d1.js';
import { QUEUE_MESSAGE_SYNC_SQL, requestMessageSync, retryMessageSync } from '../src/message-sync.js';
import { CLOSE_PROPOSAL_SQL, UPSERT_ROLE_VOTE_SQL, UPSERT_VOTE_SQL } from '../src/voting.js';

function setup() {
  const DB = new LocalD1();
  DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, message_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('proposal', 'guild', 'channel', '123', 'target', 'proposer', 100, 'Motivo', Math.floor(Date.now() / 1000) + 3600);
  DB.db.prepare(QUEUE_MESSAGE_SYNC_SQL).run('proposal');
  const env = { DB, DISCORD_BOT_TOKEN: 'test-only' };
  env.MESSAGE_SYNC = messageSyncBinding(env);
  return env;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function cast(env, user, choice) {
  await env.DB.batch([
    env.DB.prepare(UPSERT_VOTE_SQL).bind('proposal', user, choice, 'proposal', null),
    env.DB.prepare(UPSERT_ROLE_VOTE_SQL).bind('proposal', user, choice, 'proposal', null),
    env.DB.prepare(CLOSE_PROPOSAL_SQL).bind('proposal', 'proposal', 'proposal', 'proposal', 'proposal'),
    env.DB.prepare(QUEUE_MESSAGE_SYNC_SQL).bind('proposal')
  ]);
}

const syncState = (env) => env.DB.db.prepare('SELECT * FROM proposal_message_sync').get();

test('una edición abierta demorada termina antes del cierre y no restaura botones', async (t) => {
  const env = setup();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const edits = [];
  let active = 0;
  let maxActive = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.method, 'PATCH');
    active++;
    maxActive = Math.max(maxActive, active);
    const body = JSON.parse(options.body);
    if (edits.length === 0) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    edits.push(body);
    active--;
    return Response.json({ id: '123' });
  });
  try {
    for (let i = 0; i < 3; i++) await cast(env, `voter-${i}`, 'yes');
    const oldEdit = requestMessageSync(env, 'proposal');
    await firstStarted.promise;
    await cast(env, 'last', 'yes');
    const newEdit = requestMessageSync(env, 'proposal');
    releaseFirst.resolve();
    await Promise.all([newEdit, oldEdit]);
    assert.equal(maxActive, 1);
    assert.equal(edits.length, 2);
    assert.notDeepEqual(edits[0].components, []);
    assert.deepEqual(edits[1].components, []);
    assert.equal(edits[1].embeds[0].fields[0].value, '👍 4 · 👎 0');
    assert.match(edits[1].embeds[0].fields[2].value, /Aprobada/);
    assert.deepEqual(edits[1].allowed_mentions, { parse: [] });
    assert.equal(syncState(env).revision, syncState(env).synced_revision);
    // A late vote or delayed synchronization request cannot reopen the proposal.
    await cast(env, 'late', 'no');
    await requestMessageSync(env, 'proposal');
    assert.deepEqual(edits.at(-1).components, []);
    assert.equal(edits.at(-1).embeds[0].fields[0].value, '👍 4 · 👎 0');
  } finally {
    releaseFirst.resolve();
    env.DB.close();
  }
});

test('un fallo conserva la revisión pendiente y otra instancia recupera el estado actual', async (t) => {
  const env = setup();
  const edits = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    edits.push(JSON.parse(options.body));
    return new Response(null, { status: edits.length === 1 ? 503 : 200 });
  });
  try {
    await assert.rejects(requestMessageSync(env, 'proposal'), /503/);
    assert.equal(syncState(env).synced_revision, 0);
    for (let i = 0; i < 4; i++) await cast(env, `no-${i}`, 'no');
    env.MESSAGE_SYNC = messageSyncBinding(env);
    env.DB.db.exec('UPDATE proposal_message_sync SET retry_at = 0');
    await retryMessageSync(env);
    assert.equal(edits.length, 2);
    assert.match(edits[1].embeds[0].fields[2].value, /Rechazada/);
    assert.deepEqual(edits[1].components, []);
    assert.equal(syncState(env).revision, syncState(env).synced_revision);
  } finally { env.DB.close(); }
});

test('el 429 respeta retry_after y las revisiones nuevas no saltan esa espera', async (t) => {
  const env = setup();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? Response.json({ retry_after: 60 }, { status: 429 }) : new Response(null);
  });
  try {
    await assert.rejects(requestMessageSync(env, 'proposal'), /503/);
    assert.ok(syncState(env).retry_at > Math.floor(Date.now() / 1000));
    await cast(env, 'new-voter', 'yes');
    await assert.rejects(requestMessageSync(env, 'proposal'), /503/);
    await retryMessageSync(env);
    assert.equal(calls, 1);
    env.DB.db.exec('UPDATE proposal_message_sync SET retry_at = 0');
    await retryMessageSync(env);
    assert.equal(calls, 2);
    assert.equal(syncState(env).revision, syncState(env).synced_revision);
  } finally { env.DB.close(); }
});

test('sin token o sin ID del mensaje no se pierde la sincronización pendiente', async (t) => {
  const env = setup();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null); });
  try {
    delete env.DISCORD_BOT_TOKEN;
    await assert.rejects(requestMessageSync(env, 'proposal'), /503/);
    env.DISCORD_BOT_TOKEN = 'test-only';
    env.DB.db.exec('UPDATE proposals SET message_id = NULL');
    await assert.rejects(requestMessageSync(env, 'proposal'), /503/);
    assert.equal(calls, 0);
    assert.equal(syncState(env).synced_revision, 0);
    env.DB.db.exec("UPDATE proposals SET message_id = '123'");
    await retryMessageSync(env);
    assert.equal(calls, 1);
  } finally { env.DB.close(); }
});

test('dos cambios simultáneos conservan un solo voto por persona y el último recuento abierto', async (t) => {
  const env = setup();
  const edits = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    edits.push(JSON.parse(options.body));
    return new Response(null);
  });
  try {
    await Promise.all([cast(env, 'same-person', 'yes'), cast(env, 'same-person', 'no')]);
    await Promise.all([requestMessageSync(env, 'proposal'), requestMessageSync(env, 'proposal')]);
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM role_votes').get().n, 1);
    assert.equal(edits.at(-1).embeds[0].fields[0].value, '👍 0 · 👎 1');
    assert.equal(edits.at(-1).embeds[0].fields[1].value, '👍 0 · 👎 1');
    assert.notDeepEqual(edits.at(-1).components, []);
    assert.equal(syncState(env).revision, syncState(env).synced_revision);
  } finally { env.DB.close(); }
});

test('cron reintenta neutralizar un aviso conocido aunque falte el mensaje original', async (t) => {
  const env = setup();
  const edits = [];
  let unavailable = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (unavailable) return new Response('', { status: 503 });
    edits.push({ url, body: JSON.parse(options.body) }); return Response.json({});
  });
  try {
    env.DB.db.exec("UPDATE proposals SET status='voided',message_id=NULL; INSERT INTO proposal_notifications(proposal_id,state,message_id) VALUES ('proposal','sent','456')");
    await assert.rejects(requestMessageSync(env, 'proposal'));
    assert.equal(env.DB.db.prepare('SELECT synced_revision FROM proposal_message_sync').get().synced_revision, 0);
    unavailable = false;
    env.DB.db.exec('UPDATE proposal_message_sync SET retry_at=0');
    await retryMessageSync(env);
    assert.equal(edits.length, 1);
    assert.ok(edits[0].url.endsWith('/messages/456'));
    assert.match(edits[0].body.content, /anulada/);
    const row = env.DB.db.prepare('SELECT revision,synced_revision FROM proposal_message_sync').get();
    assert.equal(row.synced_revision, row.revision);
  } finally { env.DB.close(); }
});
