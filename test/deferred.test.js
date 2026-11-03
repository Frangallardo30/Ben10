import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import worker from '../src/index.js';
import { prepareWrites } from '../src/database.js';
import { LocalD1, messageSyncBinding } from '../test-support/local-d1.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
let sequence = 100000;

function setup(t) {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex, DISCORD_APPLICATION_ID: '1417570023370653836' };
  env.MESSAGE_SYNC = messageSyncBinding(env);
  const delivered = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /^https:\/\/discord.com\/api\/v10\/webhooks\//);
    delivered.push({ url, method: options.method, body: JSON.parse(options.body) });
    return Response.json({ id: '999123' });
  });
  t.after(() => DB.close());
  return { env, DB, delivered };
}

function barrier() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function start(env, input) {
  const id = String(sequence++);
  const interaction = { id, token: `local-interaction-${id}`, guild_id: 'guild',
    member: { user: { id: 'voter' }, roles: [] }, ...input };
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  const background = [];
  let timer;
  try {
    const response = await Promise.race([
      worker.fetch(new Request('https://worker.test/interactions', {
        method: 'POST', headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp }, body
      }), env, { waitUntil(promise) { background.push(promise); } }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ACK waited for D1')), 1000); })
    ]);
    assert.equal(response.status, 200);
    return { initial: await response.json(), interaction, async flush() {
      for (let i = 0; i < background.length; i++) await background[i];
    } };
  } finally { clearTimeout(timer); }
}

const aura = { type: 2, channel_id: 'channel', data: { name: 'aura', options: [
  { name: 'usuario', value: 'target' }, { name: 'puntos', value: 100 }, { name: 'motivo', value: 'Motivo' }
] } };

function seed(DB) {
  DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('proposal', 'guild', 'channel', 'target', 'proposer', 100, 'Motivo', Math.floor(Date.now() / 1000) + 3600);
}

test('aura reconoce antes de preparar D1 lento y termina una única propuesta', async (t) => {
  const { env, DB, delivered } = setup(t);
  const gate = barrier();
  const batch = DB.batch.bind(DB);
  let started = false;
  DB.batch = async (statements) => { started = true; await gate.promise; return batch(statements); };
  const attempt = await start(env, aura);
  assert.deepEqual(attempt.initial, { type: 5 });
  assert.equal(started, true);
  assert.equal(delivered.length, 0);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
  gate.release();
  await attempt.flush();
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
  assert.equal(delivered[0].method, 'PATCH');
  assert.match(delivered[0].body.embeds[0].title, /Propuesta de aura/);
  assert.deepEqual(delivered[0].body.components, []);
  // A repeated Discord delivery has the same id and original-response endpoint.
  const replay = await start(env, { ...aura, id: attempt.interaction.id, token: attempt.interaction.token });
  await replay.flush();
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
});

test('un botón reconoce antes de la lectura lenta de D1 y conserva el mensaje original', async (t) => {
  const { env, DB, delivered } = setup(t);
  await prepareWrites(DB);
  seed(DB);
  const gate = barrier();
  const prepare = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql === 'SELECT * FROM proposals WHERE id = ? AND guild_id = ?') {
      const first = statement.first.bind(statement);
      statement.first = async () => { await gate.promise; return first(); };
    }
    return statement;
  };
  const attempt = await start(env, { type: 3, data: { custom_id: 'aura:yes:proposal' } });
  assert.deepEqual(attempt.initial, { type: 6 });
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
  gate.release();
  await attempt.flush();
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
  assert.equal(delivered.length, 0);
});

test('error de D1 en un comando completa el diferido sin exponer detalles', async (t) => {
  const { env, DB, delivered } = setup(t);
  DB.prepare = () => { throw new Error('sensitive database error'); };
  const attempt = await start(env, { type: 2, data: { name: 'perfil' } });
  assert.deepEqual(attempt.initial, { type: 5 });
  await attempt.flush();
  assert.match(delivered[0].body.content, /No pude consultar/);
  assert.doesNotMatch(JSON.stringify(delivered), /sensitive/);
  assert.deepEqual(delivered[0].body.allowed_mentions, { parse: [] });
});

test('un fallo del lote de voto se revierte y permite reintentar la misma interacción', async (t) => {
  const { env, DB, delivered } = setup(t);
  await prepareWrites(DB);
  seed(DB);
  const batch = DB.batch.bind(DB);
  let fail = true;
  DB.batch = async (statements) => {
    if (fail) {
      fail = false;
      statements.push(DB.prepare('INSERT INTO missing_table VALUES (1)'));
    }
    return batch(statements);
  };
  const attempt = await start(env, { type: 3, data: { custom_id: 'aura:yes:proposal' } });
  await attempt.flush();
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM vote_interactions').get().n, 0);
  assert.equal(delivered[0].method, 'POST');
  assert.equal(delivered[0].body.flags, 64);
  assert.match(delivered[0].body.content, /No pude confirmar/);
  const replay = await start(env, { ...attempt.interaction });
  await replay.flush();
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM vote_interactions').get().n, 1);
});

test('reentregar un voto antiguo no deshace un cambio posterior de voto ni del rol', async (t) => {
  const { env, DB } = setup(t);
  seed(DB);
  const oldVote = await start(env, { type: 3, member: { user: { id: 'voter' }, roles: ['1431791263547392121'] }, data: { custom_id: 'aura:yes:proposal' } });
  await oldVote.flush();
  const changed = await start(env, { type: 3, data: { custom_id: 'aura:no:proposal' } });
  await changed.flush();
  const replay = await start(env, oldVote.interaction);
  await replay.flush();
  assert.equal(DB.db.prepare('SELECT choice FROM votes').get().choice, 'no');
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM role_votes').get().n, 0);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM vote_interactions').get().n, 2);
});

test('perfil e historial no preparan tablas; las escrituras preparan una sola vez por D1', async (t) => {
  const { env, DB } = setup(t);
  const batch = DB.batch.bind(DB);
  let preparations = 0;
  DB.batch = async (statements) => {
    if (statements.some((statement) => statement.sql.startsWith('CREATE TABLE IF NOT EXISTS bot_settings'))) preparations++;
    return batch(statements);
  };
  for (const name of ['perfil', 'historial', 'votaciones', 'ranking']) {
    const attempt = await start(env, { type: 2, data: { name } });
    await attempt.flush();
  }
  assert.equal(preparations, 0);
  const first = await start(env, aura);
  await first.flush();
  const second = await start(env, aura);
  await second.flush();
  assert.equal(preparations, 1);
});

test('un timeout informa resultado incierto; una escritura tardía y su replay no duplican la propuesta', async (t) => {
  const { env, DB, delivered } = setup(t);
  const gate = barrier();
  const batch = DB.batch.bind(DB);
  DB.batch = async (statements) => { await gate.promise; return batch(statements); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempt = await start(env, aura);
  assert.deepEqual(attempt.initial, { type: 5 });
  t.mock.timers.tick(20000);
  await attempt.flush();
  assert.match(delivered.at(-1).body.content, /No pude confirmar/);
  gate.release();
  await prepareWrites(DB);
  await new Promise(setImmediate);
  const replay = await start(env, attempt.interaction);
  await replay.flush();
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
});

test('un fallo preparando tablas no queda cacheado y puede recuperarse', async (t) => {
  const { env, DB } = setup(t);
  const batch = DB.batch.bind(DB);
  let fail = true;
  DB.batch = async (statements) => {
    if (fail) { fail = false; throw new Error('Temporary initialization error'); }
    return batch(statements);
  };
  const attempt = await start(env, aura);
  await attempt.flush();
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
  const replay = await start(env, attempt.interaction);
  await replay.flush();
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
});


test('ranking reconoce antes de D1 lento y completa la respuesta sin migrar tablas', async (t) => {
  const { env, DB, delivered } = setup(t);
  const gate = barrier();
  const prepare = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.includes('RANK() OVER')) {
      const all = statement.all.bind(statement);
      statement.all = async () => { await gate.promise; return all(); };
    }
    return statement;
  };
  const attempt = await start(env, { type: 2, data: { name: 'ranking' } });
  assert.deepEqual(attempt.initial, { type: 5 });
  assert.equal(delivered.length, 0);
  gate.release();
  await attempt.flush();
  assert.equal(delivered[0].method, 'PATCH');
  assert.match(delivered[0].body.embeds[0].title, /Ranking de aura/);
});
