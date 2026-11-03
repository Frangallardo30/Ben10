import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import worker from '../src/index.js';
import { LocalD1, messageSyncBinding } from '../test-support/local-d1.js';
import { completionFor, installInteractionWebhooks, mockDiscord } from '../test-support/discord.js';
installInteractionWebhooks();
let nextInteractionId = 10000;
import { readProposalMessage } from '../src/message-sync.js';
import { QUEUE_NOTIFICATION_SQL, sendClosureNotifications } from '../src/notifications.js';
import { AURA_VOTER_ROLE_ID } from '../src/voting.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

async function interaction(env, data) {
  env.MESSAGE_SYNC ??= messageSyncBinding(env);
  env.DISCORD_APPLICATION_ID ??= '1417570023370653836';
  data = { id: String(nextInteractionId++), ...data };
  data.token ??= `local-interaction-${data.id}`;
  const body = JSON.stringify(data);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  const background = [];
  const response = await worker.fetch(new Request('https://ben10.test/interactions', {
    method: 'POST',
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    body
  }), env, { waitUntil(promise) { background.push(promise); } });
  for (let i = 0; i < background.length; i++) await background[i];
  assert.equal(response.status, 200);
  const initial = await response.json();
  const completion = completionFor(data.token);
  if (initial.type === 5) {
    assert.ok(completion, 'deferred command must complete its webhook response');
    // Aura's final interactive view is rendered from D1 by the synchronizer.
    const body = data.data.name === 'aura' && completion.embeds?.length
      ? (await readProposalMessage(env.DB, data.id)).body : completion;
    return { type: 4, data: body };
  }
  if (initial.type === 6 && completion) return { type: 4, data: completion };
  return initial;
}

// Check the ACK separately; render assertions below inspect the saved snapshot,
// since interaction responses must no longer contain edits that Discord can reorder.
async function voteAndView(env, data) {
  const response = await interaction(env, data);
  assert.deepEqual(response, { type: 6 });
  const id = data.data.custom_id.split(':')[2];
  return { type: 6, data: (await readProposalMessage(env.DB, id)).body };
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

    const generalVote = await voteAndView(env, { ...base('friend'), type: 3, data: { custom_id: customId.replace(':yes:', ':no:') } });
    assert.equal(generalVote.type, 6);
    assert.equal(generalVote.data.embeds[0].fields[0].value, '👍 0 · 👎 1');
    assert.equal(generalVote.data.embeds[0].fields[1].value, '👍 0 · 👎 0');

    for (let i = 0; i < 4; i++) {
      const result = await voteAndView(env, { ...base(`voter-${i}`, true), type: 3, data: { custom_id: customId } });
      assert.equal(result.type, 6);
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
    const result = await voteAndView(env, { ...base('fourth', true), type: 3, data: { custom_id: 'aura:yes:expires' } });
    assert.equal(result.type, 6);
    assert.match(result.data.embeds[0].fields[2].value, /Vencida/);
    assert.deepEqual(result.data.components, []);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'expires'").get().status, 'expired');
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 3);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM role_votes').get().n, 3);
    const again = await voteAndView(env, { ...base('fourth', true), type: 3, data: { custom_id: 'aura:yes:expires' } });
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
  env.MESSAGE_SYNC = messageSyncBinding(env);
  const now = Math.floor(Date.now() / 1000);
  const insert = DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, message_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, deadline, status, message] of [
    ['due', now, 'open', '123'], ['legacy', now - 1, 'open', null],
    ['future', now + 3600, 'open', '456'], ['approved', now - 1, 'approved', '789']
  ]) insert.run(id, 'guild-1', 'channel-1', message, 'fran', 'other', 100, 'Motivo', deadline, status);
  const patches = [];
  mockDiscord(t, async (_url, options) => {
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
    assert.equal(DB.db.prepare("SELECT revision, synced_revision FROM proposal_message_sync WHERE proposal_id = 'due'").get().synced_revision, 0);
    DB.db.exec('UPDATE proposal_message_sync SET retry_at = 0');
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    assert.equal(patches.length, 3); // Includes the one-time refresh of the still-open message.
    const expiredPatches = patches.filter((body) => body.embeds[0].fields[2].value.includes('Vencida'));
    assert.equal(expiredPatches.length, 2);
    assert.ok(patches.some((body) => body.components[0]?.components.some((button) => button.label === 'Cancelar propuesta')));
    for (const body of expiredPatches) {
      assert.deepEqual(body.components, []);
      assert.match(body.embeds[0].fields[2].value, /Vencida/);
    }
    const late = await voteAndView(env, { ...base('late', true), type: 3, data: { custom_id: 'aura:yes:due' } });
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
          result = await voteAndView(env, { ...base(`role-${i}`, true), type: 3, data: { custom_id: customId } });
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
    const result = await voteAndView(env, { ...base('late-yes', true), type: 3, data: { custom_id: yesId } });
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
    mockDiscord(t, async (url, options) => {
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
  mockDiscord(t, async () => {
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
  mockDiscord(t, async (_url, options) => {
    if (options.method === 'POST') posted.push(JSON.parse(options.body));
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

test('votos simultáneos del mismo usuario y cierre: ACKs sin ediciones y una sola decisión', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const edits = [];
  const notices = [];
  mockDiscord(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    if (options.method === 'PATCH') edits.push(body);
    else notices.push(body);
    return Response.json({ id: '123' });
  });
  try {
    const proposal = await interaction(env, { ...base('fran'), type: 2, data: { name: 'aura', options: [
      { name: 'usuario', value: 'fran' }, { name: 'puntos', value: 100 }, { name: 'motivo', value: 'Concurrente' }
    ] } });
    const customId = proposal.data.components[0].components[0].custom_id;
    const id = customId.split(':')[2];
    for (let i = 0; i < 3; i++) {
      await interaction(env, { ...base(`previous-${i}`, true), type: 3, data: { custom_id: customId } });
    }
    DB.db.prepare('UPDATE proposals SET message_id = ? WHERE id = ?').run('123', id);
    env.DISCORD_BOT_TOKEN = 'test-only';
    const responses = await Promise.all([
      interaction(env, { ...base('last', true), type: 3, data: { custom_id: customId }, message: { id: '123' } }),
      interaction(env, { ...base('last', true), type: 3, data: { custom_id: customId }, message: { id: '123' } })
    ]);
    // Delivering these responses in reverse order cannot edit Discord's message.
    assert.ok(responses.some((response) => response.type === 6));
    for (const response of responses.reverse()) {
      if (response.type === 6) assert.deepEqual(response, { type: 6 });
      else assert.deepEqual(response, { type: 4, data: { content: 'La votación ya cerró.', flags: 64, allowed_mentions: { parse: [] } } });
    }
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes WHERE proposal_id = ?').get(id).n, 4);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM role_votes WHERE proposal_id = ?').get(id).n, 4);
    assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'approved');
    assert.equal(notices.length, 1);
    assert.ok(edits.length >= 1);
    assert.match(edits.at(-1).embeds[0].fields[2].value, /Aprobada/);
    assert.equal(edits.at(-1).embeds[0].fields[0].value, '👍 4 · 👎 0');
    assert.deepEqual(edits.at(-1).components, []);
  } finally { DB.close(); }
});

async function cancellableProposal(env) {
  const result = await interaction(env, { ...base('creator'), type: 2, data: { name: 'aura', options: [
    { name: 'usuario', value: 'target' }, { name: 'puntos', value: 100 }, { name: 'motivo', value: 'Propuesta retirada' }
  ] } });
  const button = result.data.components[0].components.find((item) => item.label === 'Cancelar propuesta');
  assert.ok(button);
  return { id: button.custom_id.split(':')[2], cancelId: button.custom_id, voteId: button.custom_id.replace(':cancel:', ':yes:') };
}

test('solo el creador puede cancelar y el permiso se limita al servidor de la propuesta', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const { id, cancelId } = await cancellableProposal(env);
    for (const user of ['target', 'other']) {
      const denied = await interaction(env, { ...base(user, true), type: 3, data: { custom_id: cancelId } });
      assert.equal(denied.data.flags, 64);
      assert.match(denied.data.content, /Solo quien creó/);
    }
    const foreign = await interaction(env, { ...base('creator'), guild_id: 'guild-2', type: 3, data: { custom_id: cancelId } });
    assert.match(foreign.data.content, /inexistente/);
    assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'open');
  } finally { DB.close(); }
});

test('cancelar actualiza el mensaje, conserva votos e historial y no publica aviso de aprobación', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const edits = [];
  mockDiscord(t, async (_url, options) => {
    assert.equal(options.method, 'PATCH');
    edits.push(JSON.parse(options.body));
    return Response.json({ id: '999123' });
  });
  try {
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('approved-before', 'guild-1', 'channel-1', 'target', 'creator', 77, 'Aprobación previa', 1, 'approved');
    const { id, cancelId, voteId } = await cancellableProposal(env);
    await interaction(env, { ...base('voter', true), type: 3, data: { custom_id: voteId } });
    env.DISCORD_BOT_TOKEN = 'test-only';
    const cancelled = await interaction(env, { ...base('creator'), type: 3, message: { id: '999123' }, data: { custom_id: cancelId } });
    assert.deepEqual(cancelled, { type: 6 });
    assert.match(edits.at(-1).embeds[0].fields[2].value, /Cancelada sin cambiar el aura/);
    assert.deepEqual(edits.at(-1).components, []);
    assert.deepEqual(edits.at(-1).allowed_mentions, { parse: [] });
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes WHERE proposal_id = ?').get(id).n, 1);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposal_notifications WHERE proposal_id = ?').get(id).n, 0);
    const profile = await interaction(env, { ...base('target'), type: 2, data: { name: 'perfil' } });
    assert.match(profile.data.embeds[0].description, /77 puntos/);
    assert.equal(profile.data.embeds[0].fields[0].value, '1');
    assert.equal(profile.data.embeds[0].fields[1].value, '0');
    const history = await interaction(env, { ...base('target'), type: 2, data: { name: 'historial' } });
    assert.match(history.data.embeds[0].description, /Aprobación previa/);
    assert.doesNotMatch(history.data.embeds[0].description, /Propuesta retirada/);
    const lateVote = await interaction(env, { ...base('late', true), type: 3, data: { custom_id: voteId } });
    assert.match(lateVote.data.content, /ya cerró/);
    assert.deepEqual(edits.at(-1).components, []);
  } finally { DB.close(); }
});

test('cancelaciones simultáneas o repetidas producen un solo cambio de estado', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const { id, cancelId } = await cancellableProposal(env);
    DB.db.exec("CREATE TABLE status_changes (status TEXT); CREATE TRIGGER record_status AFTER UPDATE OF status ON proposals WHEN old.status <> new.status BEGIN INSERT INTO status_changes VALUES (new.status); END;");
    const cancel = () => interaction(env, { ...base('creator'), type: 3, data: { custom_id: cancelId } });
    await Promise.all([cancel(), cancel()]);
    const repeated = await cancel();
    assert.match(repeated.data.content, /ya está cancelada/);
    assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'cancelled');
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM status_changes').get().n, 1);
  } finally { DB.close(); }
});

test('cancelar después del plazo conserva el vencimiento aunque aún no haya corrido el cron', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const { id, cancelId } = await cancellableProposal(env);
    DB.db.prepare('UPDATE proposals SET expires_at = 0 WHERE id = ?').run(id);
    const result = await interaction(env, { ...base('creator'), type: 3, data: { custom_id: cancelId } });
    assert.match(result.data.content, /ya cerró/);
    assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'expired');
  } finally { DB.close(); }
});

for (const winner of ['cancel', 'vote']) {
  test(`carrera entre cancelación y voto decisivo: ${winner} confirma primero y conserva el estado final`, async () => {
    const DB = new LocalD1();
    const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
    try {
      const { id, cancelId, voteId } = await cancellableProposal(env);
      for (let i = 0; i < 3; i++) await interaction(env, { ...base(`role-${i}`, true), type: 3, data: { custom_id: voteId } });
      const cancel = { ...base('creator'), type: 3, data: { custom_id: cancelId } };
      const vote = { ...base('deciding', true), type: 3, data: { custom_id: voteId } };
      const prepare = DB.prepare.bind(DB);
      let race = true;
      DB.prepare = (sql) => {
        const statement = prepare(sql);
        if (sql === 'SELECT * FROM proposals WHERE id = ? AND guild_id = ?' && race) {
          const first = statement.first.bind(statement);
          statement.first = async () => {
            const snapshot = await first();
            race = false;
            await interaction(env, winner === 'cancel' ? cancel : vote);
            return snapshot;
          };
        }
        return statement;
      };
      await interaction(env, winner === 'cancel' ? vote : cancel);
      const snapshot = await readProposalMessage(DB, id);
      assert.equal(snapshot.proposal.status, winner === 'cancel' ? 'cancelled' : 'approved');
      assert.equal(snapshot.proposal.yes, winner === 'cancel' ? 3 : 4);
      assert.deepEqual(snapshot.body.components, []);
      assert.match(snapshot.body.embeds[0].fields[2].value, winner === 'cancel' ? /Cancelada/ : /Aprobada/);
      assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposal_notifications WHERE proposal_id = ?').get(id).n, winner === 'cancel' ? 0 : 1);
    } finally { DB.close(); }
  });
}

test('la migración solicita actualizar una sola vez los mensajes abiertos anteriores', async () => {
  const DB = new LocalD1();
  const env = { DB };
  env.MESSAGE_SYNC = messageSyncBinding(env);
  try {
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, message_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('old-open', 'guild-1', 'channel-1', '999123', 'target', 'creator', 100, 'Anterior', Math.floor(Date.now() / 1000) + 3600);
    DB.db.prepare('INSERT INTO proposal_message_sync(proposal_id, revision, synced_revision) VALUES (?, ?, ?)').run('old-open', 1, 1);
    await worker.scheduled({}, env);
    const first = DB.db.prepare('SELECT revision, synced_revision FROM proposal_message_sync').get();
    assert.equal(first.revision, 2);
    assert.equal(first.synced_revision, 1);
    const otherBinding = { prepare: DB.prepare.bind(DB), batch: DB.batch.bind(DB) };
    await worker.scheduled({}, { ...env, DB: otherBinding });
    assert.equal(DB.db.prepare('SELECT revision FROM proposal_message_sync').get().revision, 2);
    assert.ok(DB.db.prepare("SELECT value FROM bot_settings WHERE key = 'cancel_button_v1'").get());
  } finally { DB.close(); }
});

test('las propuestas nuevas guardan created_at real y el replay conserva esa fecha', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    const input = { ...base('creator'), id: 'date-new', type: 2, data: { name: 'aura', options: [
      { name: 'usuario', value: 'target' }, { name: 'puntos', value: 100 }, { name: 'motivo', value: 'Fecha real' }
    ] } };
    await interaction(env, input);
    const before = DB.db.prepare('SELECT created_at, expires_at FROM proposals WHERE id = ?').get(input.id);
    assert.equal(before.created_at, Math.floor(now / 1000));
    assert.equal(before.expires_at, before.created_at + 86400);
    t.mock.method(Date, 'now', () => now + 60000);
    await interaction(env, input);
    assert.deepEqual(DB.db.prepare('SELECT created_at, expires_at FROM proposals WHERE id = ?').get(input.id), before);
  } finally { DB.close(); }
});

for (const legacy of [false, true]) {
  test(`historial y perfil ordenan por creación y muestran fechas ${legacy ? 'heredadas sin migración' : 'explícitas'}`, async () => {
    const DB = new LocalD1();
    const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
    try {
      if (legacy) DB.db.exec('DROP INDEX IF EXISTS proposals_history; ALTER TABLE proposals DROP COLUMN created_at');
      for (const [id, createdAt, expiresAt] of [['older', 100, legacy ? 86500 : 999999], ['newer', 200, 86600]]) {
        DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, 'guild-1', 'channel-1', 'target', 'creator', 100, id, expiresAt, 'approved');
        if (!legacy) DB.db.prepare('UPDATE proposals SET created_at = ? WHERE id = ?').run(createdAt, id);
      }
      const history = await interaction(env, { ...base('target'), type: 2, data: { name: 'historial' } });
      assert.match(history.data.embeds[0].description, /<t:200:d>[\s\S]*newer[\s\S]*<t:100:d>[\s\S]*older/);
      const profile = await interaction(env, { ...base('target'), type: 2, data: { name: 'perfil' } });
      assert.match(profile.data.embeds[0].fields[2].value, /newer[\s\S]*older/);
      if (legacy) assert.equal(DB.db.prepare('PRAGMA table_info(proposals)').all().some((column) => column.name === 'created_at'), false);
    } finally { DB.close(); }
  });
}
