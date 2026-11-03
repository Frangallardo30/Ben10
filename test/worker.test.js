import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../src/index.js';
import { QUEUE_NOTIFICATION_SQL, sendClosureNotifications } from '../src/notifications.js';
import { AURA_VOTER_ROLE_ID } from '../src/voting.js';

class D1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async run() { return { meta: { changes: this.db.prepare(this.sql).run(...this.args).changes } }; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}

class LocalD1 {
  constructor(legacy = false) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    if (legacy) this.db.exec('DROP TABLE role_votes; DROP TABLE bot_settings;');
  }
  prepare(sql) { return new D1Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

async function interaction(env, data) {
  const body = JSON.stringify(data);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  const background = [];
  const response = await worker.fetch(new Request('https://ben10.test/interactions', {
    method: 'POST',
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    body
  }), env, { waitUntil(promise) { background.push(promise); } });
  await Promise.all(background);
  assert.equal(response.status, 200);
  return response.json();
}

const member = (id, hasRole = false) => ({ user: { id, username: id }, roles: hasRole ? [AURA_VOTER_ROLE_ID] : [] });
const base = (id, hasRole = false) => ({ guild_id: 'guild-1', channel_id: 'channel-1', member: member(id, hasRole) });

test('flujo completo: migra D1, propuesta propia, voto del rol, perfil e historial', async () => {
  const DB = new LocalD1(true);
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const proposal = await interaction(env, { ...base('fran'), type: 2, data: { name: 'aura', options: [
      { name: 'usuario', value: 'fran' }, { name: 'puntos', value: 100 }, { name: 'motivo', value: 'Ganó una partida' }
    ] } });
    assert.equal(proposal.type, 4);
    assert.match(proposal.data.embeds[0].description, /Ganó una partida/);
    const customId = proposal.data.components[0].components[0].custom_id;

    const selfVote = await interaction(env, { ...base('fran', true), type: 3, data: { custom_id: customId } });
    assert.equal(selfVote.data.flags, 64);
    assert.match(selfVote.data.content, /no pueden votar/);

    const otherGuild = await interaction(env, { ...base('visitor', true), guild_id: 'guild-2', type: 3, data: { custom_id: customId } });
    assert.match(otherGuild.data.content, /inexistente/);

    const generalVote = await interaction(env, { ...base('friend'), type: 3, data: { custom_id: customId.replace(':yes:', ':no:') } });
    assert.equal(generalVote.type, 7);
    assert.equal(generalVote.data.embeds[0].fields[0].value, '👍 0 · 👎 1');
    assert.equal(generalVote.data.embeds[0].fields[1].value, '👍 0 · 👎 0');

    for (let i = 0; i < 4; i++) {
      const result = await interaction(env, { ...base(`voter-${i}`, true), type: 3, data: { custom_id: customId } });
      assert.equal(result.type, 7);
      if (i === 3) {
        assert.match(result.data.embeds[0].fields[2].value, /Aprobada/);
        assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposal_notifications').get().n, 1);
        assert.deepEqual(result.data.components, []);
      }
    }

    const profile = await interaction(env, { ...base('fran'), type: 2, data: { name: 'perfil', options: [] } });
    assert.match(profile.data.embeds[0].description, /100 puntos/);
    assert.equal(profile.data.embeds[0].fields[0].value, '1');

    const history = await interaction(env, { ...base('fran'), type: 2, data: { name: 'historial', options: [] } });
    assert.match(history.data.embeds[0].description, /Ganó una partida/);
    assert.match(history.data.embeds[0].description, /Propuesto por/);

    const info = await interaction(env, { ...base('fran'), type: 2, data: { name: 'info' } });
    assert.match(info.data.embeds[0].fields.map((field) => field.name).join(' '), /aura.*perfil.*historial/);
  } finally { DB.close(); }
});

test('un voto cuyo lote llega después del plazo no aprueba ni suma aura', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const beforeDeadline = Date.now() - 10000;
  t.mock.method(Date, 'now', () => beforeDeadline);
  try {
    // La interacción se recibe antes del plazo; D1 ejecuta el lote después.
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('expires', 'guild-1', 'channel-1', 'fran', 'other', 100, 'No debe sumar', Math.floor(beforeDeadline / 1000) + 1);
    for (let i = 0; i < 3; i++) {
      DB.db.prepare('INSERT INTO votes VALUES (?, ?, ?)').run('expires', `previous-${i}`, 'yes');
      DB.db.prepare('INSERT INTO role_votes VALUES (?, ?, ?)').run('expires', `previous-${i}`, 'yes');
    }
    const result = await interaction(env, { ...base('fourth', true), type: 3, data: { custom_id: 'aura:yes:expires' } });
    assert.equal(result.type, 7);
    assert.match(result.data.embeds[0].fields[2].value, /Vencida/);
    assert.deepEqual(result.data.components, []);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'expires'").get().status, 'expired');
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 3);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM role_votes').get().n, 3);
    const again = await interaction(env, { ...base('fourth', true), type: 3, data: { custom_id: 'aura:yes:expires' } });
    assert.deepEqual(again.data.components, []);
    const profile = await interaction(env, { ...base('fran'), type: 2, data: { name: 'perfil', options: [] } });
    assert.match(profile.data.embeds[0].description, /0 puntos/);
    assert.equal(profile.data.embeds[0].fields[0].value, '0');
    const history = await interaction(env, { ...base('fran'), type: 2, data: { name: 'historial', options: [] } });
    assert.match(history.data.embeds[0].description, /Todavía no hay cambios/);
  } finally { DB.close(); }
});

test('el cron caduca solo abiertas vencidas y reintenta quitar botones', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex, DISCORD_BOT_TOKEN: 'test-only' };
  const now = Math.floor(Date.now() / 1000);
  const insert = DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, message_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, deadline, status, message] of [
    ['due', now, 'open', '123'], ['legacy', now - 1, 'open', null],
    ['future', now + 3600, 'open', '456'], ['approved', now - 1, 'approved', '789']
  ]) insert.run(id, 'guild-1', 'channel-1', message, 'fran', 'other', 100, 'Motivo', deadline, status);
  const patches = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'PUT') return Response.json([]);
    if (options.method === 'GET') return Response.json([]);
    assert.equal(options.method, 'PATCH');
    patches.push(JSON.parse(options.body));
    return new Response(null, { status: patches.length === 1 ? 503 : 200 });
  });
  try {
    await worker.scheduled({}, env);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'due'").get().status, 'expired');
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'legacy'").get().status, 'expired');
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'future'").get().status, 'open');
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'approved'").get().status, 'approved');
    assert.equal(DB.db.prepare("SELECT synced FROM proposal_expiry_sync WHERE proposal_id = 'due'").get().synced, 0);
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    assert.equal(patches.length, 2);
    for (const body of patches) {
      assert.deepEqual(body.components, []);
      assert.match(body.embeds[0].fields[2].value, /Vencida/);
    }
    const late = await interaction(env, { ...base('late', true), type: 3, data: { custom_id: 'aura:yes:due' } });
    assert.deepEqual(late.data.components, []);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
  } finally { DB.close(); }
});

for (const choice of ['yes', 'no']) {
  for (const threshold of [4, 6]) {
    test(`el cierre ${choice} explica la regla de ${threshold} con recuentos guardados`, async () => {
      const DB = new LocalD1();
      const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
      try {
        const proposal = await interaction(env, { ...base('fran'), type: 2, data: { name: 'aura', options: [
          { name: 'usuario', value: 'fran' }, { name: 'puntos', value: 100 }, { name: 'motivo', value: 'Cierre explicado' }
        ] } });
        const customId = proposal.data.components[0].components[0].custom_id.replace(':yes:', `:${choice}:`);
        const opposite = choice === 'yes' ? 'no' : 'yes';
        const against = threshold === 6 ? 7 : 4;
        for (let i = 0; i < against; i++) {
          await interaction(env, { ...base(`general-${i}`), type: 3, data: { custom_id: customId.replace(`:${choice}:`, `:${opposite}:`) } });
        }
        let result;
        for (let i = 0; i < threshold; i++) {
          result = await interaction(env, { ...base(`role-${i}`, true), type: 3, data: { custom_id: customId } });
        }
        assert.match(result.data.embeds[0].fields[2].value, choice === 'yes' ? /Aprobada/ : /Rechazada/);
        assert.match(result.data.embeds[0].fields[2].value, new RegExp(`Regla de ${threshold} votos del rol`));
        assert.match(result.data.embeds[0].fields[2].value, threshold === 4 ? /empata/ : /incluso si va perdiendo/);
        assert.equal(result.data.embeds[0].fields[0].value, choice === 'yes' ? `👍 ${threshold} · 👎 ${against}` : `👍 ${against} · 👎 ${threshold}`);
        assert.equal(result.data.embeds[0].fields[1].value, choice === 'yes' ? `👍 ${threshold} · 👎 0` : `👍 0 · 👎 ${threshold}`);
        assert.deepEqual(result.data.components, []);
      } finally { DB.close(); }
    });
  }
}

test('un voto en curso refleja el rechazo guardado por otro voto que cierra primero', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const proposal = await interaction(env, { ...base('fran'), type: 2, data: { name: 'aura', options: [
      { name: 'usuario', value: 'fran' }, { name: 'puntos', value: 100 }, { name: 'motivo', value: 'Carrera' }
    ] } });
    const yesId = proposal.data.components[0].components[0].custom_id;
    for (let i = 0; i < 3; i++) {
      await interaction(env, { ...base(`no-${i}`, true), type: 3, data: { custom_id: yesId.replace(':yes:', ':no:') } });
    }
    const prepare = DB.prepare.bind(DB);
    let race = true;
    DB.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === 'SELECT * FROM proposals WHERE id = ? AND guild_id = ?' && race) {
        const first = statement.first.bind(statement);
        statement.first = async () => {
          const snapshot = await first();
          race = false;
          await interaction(env, { ...base('deciding-no', true), type: 3, data: { custom_id: yesId.replace(':yes:', ':no:') } });
          return snapshot;
        };
      }
      return statement;
    };
    const result = await interaction(env, { ...base('late-yes', true), type: 3, data: { custom_id: yesId } });
    assert.match(result.data.embeds[0].fields[2].value, /Rechazada\nRegla de 4 votos del rol en contra: lidera/);
    assert.equal(result.data.embeds[0].fields[0].value, '👍 0 · 👎 4');
    assert.equal(result.data.embeds[0].fields[1].value, '👍 0 · 👎 4');
    assert.deepEqual(result.data.components, []);
  } finally { DB.close(); }
});

for (const status of ['approved', 'rejected']) {
  test(`aviso ${status}: entrega única, resultado guardado y menciones desactivadas`, async (t) => {
    const DB = new LocalD1();
    const env = { DB, DISCORD_BOT_TOKEN: 'test-only' };
    const posted = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://discord.com/api/v10/channels/channel/messages');
      assert.equal(options.method, 'POST');
      posted.push(JSON.parse(options.body));
      return Response.json({ id: 'notice' });
    });
    try {
      DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('notice', 'guild', 'channel', '123', '456', -100, '@everyone', 1, status);
      DB.db.prepare(QUEUE_NOTIFICATION_SQL).run('notice');
      DB.db.prepare(QUEUE_NOTIFICATION_SQL).run('notice');
      await Promise.all([sendClosureNotifications(env), sendClosureNotifications(env)]);
      await sendClosureNotifications(env);
      assert.equal(posted.length, 1);
      assert.deepEqual(posted[0].allowed_mentions, { parse: [] });
      assert.match(posted[0].content, /<@123>/);
      assert.doesNotMatch(posted[0].content, /@everyone/);
      assert.match(posted[0].content, status === 'approved' ? /aprobada.*-100 puntos/ : /rechazada.*aura no cambia/);
      assert.equal(DB.db.prepare('SELECT state FROM proposal_notifications').get().state, 'sent');
      const aura = DB.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM proposals WHERE status = 'approved'").get().total;
      assert.equal(aura, status === 'approved' ? -100 : 0);
    } finally { DB.close(); }
  });
}

test('avisos: reintenta un 429 y no repite entregas ambiguas ni tras reinicio', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_BOT_TOKEN: 'test-only' };
  let calls = 0;
  let mode = 'rate-limit';
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (mode === 'rate-limit') return Response.json({ retry_after: 10 }, { status: 429 });
    if (mode === 'lost-response') throw new TypeError('Connection lost after creation');
    if (mode === 'server-error') return new Response(null, { status: 503 });
    return Response.json({ id: 'delivered' });
  });
  try {
    const insert = DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('retry', 'guild', 'channel', '123', '456', 100, 'Motivo', 1, 'approved');
    DB.db.prepare(QUEUE_NOTIFICATION_SQL).run('retry');
    await sendClosureNotifications(env);
    await sendClosureNotifications(env);
    assert.equal(calls, 1);
    assert.equal(DB.db.prepare('SELECT state FROM proposal_notifications').get().state, 'pending');
    DB.db.exec('UPDATE proposal_notifications SET retry_at = 0');
    mode = 'success';
    await sendClosureNotifications(env);
    await sendClosureNotifications(env);
    assert.equal(calls, 2);
    for (const failure of ['lost-response', 'server-error']) {
      insert.run(failure, 'guild', 'channel', '123', '456', 100, 'Motivo', 1, 'rejected');
      DB.db.prepare(QUEUE_NOTIFICATION_SQL).run(failure);
      mode = failure;
      await sendClosureNotifications(env);
      const afterFailure = calls;
      mode = 'success';
      await sendClosureNotifications({ DB, DISCORD_BOT_TOKEN: 'test-only' });
      assert.equal(calls, afterFailure);
      assert.equal(DB.db.prepare('SELECT state FROM proposal_notifications WHERE proposal_id = ?').get(failure).state,
        failure === 'lost-response' ? 'sending' : 'uncertain');
    }
    insert.run('expired', 'guild', 'channel', '123', '456', 100, 'Motivo', 1, 'expired');
    DB.db.prepare(QUEUE_NOTIFICATION_SQL).run('expired');
    assert.equal(DB.db.prepare("SELECT COUNT(*) AS n FROM proposal_notifications WHERE proposal_id = 'expired'").get().n, 0);
  } finally { DB.close(); }
});

test('el voto decisivo crea y envía el aviso; migra D1 sin anunciar cierres antiguos', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    posted.push(JSON.parse(options.body));
    return Response.json({ id: 'new-notice' });
  });
  try {
    DB.db.exec('DROP TABLE proposal_notifications');
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('old', 'guild-1', 'channel-1', 'fran', 'other', 100, 'Vieja', 1, 'approved');
    const proposal = await interaction(env, { ...base('fran'), type: 2, data: { name: 'aura', options: [
      { name: 'usuario', value: 'fran' }, { name: 'puntos', value: 50 }, { name: 'motivo', value: 'Nueva' }
    ] } });
    const customId = proposal.data.components[0].components[0].custom_id;
    for (let i = 0; i < 3; i++) {
      await interaction(env, { ...base(`voter-${i}`, true), type: 3, data: { custom_id: customId } });
    }
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposal_notifications').get().n, 0);
    env.DISCORD_BOT_TOKEN = 'test-only';
    await interaction(env, { ...base('last', true), type: 3, data: { custom_id: customId } });
    await interaction(env, { ...base('late', true), type: 3, data: { custom_id: customId } });
    assert.equal(posted.length, 1);
    assert.match(posted[0].content, /aprobada.*\+50 puntos/);
    assert.deepEqual(posted[0].allowed_mentions, { parse: [] });
    assert.equal(DB.db.prepare('SELECT state FROM proposal_notifications').get().state, 'sent');
  } finally { DB.close(); }
});
