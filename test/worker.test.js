import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import worker from '../src/index.js';
import { commands } from '../src/commands.js';
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
    return { type: 4, data: { ...body, ...(initial.data?.flags ? { flags: initial.data.flags } : {}) } };
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

test('ranking suma aprobadas, separa servidores e incluye aura cero y negativa con empates estables', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  let next = 0;
  const add = (user, amount, status = 'approved', guild = 'guild-1') => {
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(String(next++), guild, 'channel', user, 'creator', amount, 'Motivo privado', 1, status);
  };
  try {
    add('200', 80); add('200', 20); add('100', 100);
    add('300', 50); add('300', -50); add('400', -10);
    for (const status of ['open', 'rejected', 'expired', 'cancelled']) add('not-approved', 1000, status);
    add('other-guild', 1000, 'approved', 'guild-2');
    const result = await interaction(env, { ...base('reader'), type: 2, data: { name: 'ranking' } });
    const lines = result.data.embeds[0].description.split('\n');
    assert.deepEqual(lines, [
      '**1.** <@100> · **100** puntos', '**1.** <@200> · **100** puntos',
      '**3.** <@300> · **0** puntos', '**4.** <@400> · **-10** puntos'
    ]);
    assert.deepEqual(result.data.allowed_mentions, { parse: [] });
    assert.doesNotMatch(lines.join('\n'), /not-approved|other-guild|Motivo privado/);
    const again = await interaction(env, { ...base('reader'), type: 2, data: { name: 'ranking' } });
    assert.equal(again.data.embeds[0].description, result.data.embeds[0].description);
    const other = await interaction(env, { ...base('reader'), guild_id: 'guild-2', type: 2, data: { name: 'ranking' } });
    assert.match(other.data.embeds[0].description, /other-guild/);
    assert.doesNotMatch(other.data.embeds[0].description, /<@100>/);
  } finally { DB.close(); }
});

test('ranking vacío es claro y no se puede consultar fuera de un servidor', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const empty = await interaction(env, { ...base('reader'), type: 2, data: { name: 'ranking' } });
    assert.match(empty.data.embeds[0].description, /Todavía no hay cambios de aura aprobados/);
    const direct = await interaction(env, { user: { id: 'reader' }, type: 2, data: { name: 'ranking' } });
    assert.equal(direct.data.flags, 64);
    assert.match(direct.data.content, /dentro de un servidor/);
    const info = await interaction(env, { ...base('reader'), type: 2, data: { name: 'info' } });
    assert.ok(info.data.embeds[0].fields.some((field) => field.name.includes('/ranking')));
  } finally { DB.close(); }
});

test('ranking limita a diez entradas con desempate fijo y un embed dentro de los límites', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    for (let i = 14; i >= 0; i--) {
      const id = String(100000000000000000n + BigInt(i));
      DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'guild-1', 'channel', id, 'creator', 1000, 'Motivo', 1, 'approved');
    }
    const result = await interaction(env, { ...base('reader'), type: 2, data: { name: 'ranking' } });
    const embed = result.data.embeds[0];
    const lines = embed.description.split('\n');
    assert.equal(lines.length, 10);
    assert.match(lines[0], /100000000000000000/);
    assert.match(lines[9], /100000000000000009/);
    assert.ok(lines.every((line) => line.startsWith('**1.**')));
    assert.ok(embed.description.length <= 4096);
    assert.ok(embed.title.length + embed.description.length + embed.footer.text.length <= 6000);
  } finally { DB.close(); }
});

test('el registro automático incorpora ranking y repara una lista que no lo tiene', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_APPLICATION_ID: 'application', DISCORD_BOT_TOKEN: 'test-only' };
  const writes = [];
  mockDiscord(t, async (_url, options) => {
    if (options.method === 'GET') return Response.json([{ type: 1, name: 'info', description: 'Vieja' }]);
    assert.equal(options.method, 'PUT');
    writes.push(JSON.parse(options.body));
    return Response.json([]);
  });
  try {
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    assert.equal(writes.length, 2);
    assert.ok(writes.every((list) => list.some((command) => command.name === 'ranking')));
    assert.ok(writes.every((list) => list.some((command) => command.name === 'votaciones')));
  } finally { DB.close(); }
});

test('perfil calcula estadísticas y evolución acumulada solo del servidor y de aprobaciones', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const insert = DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  try {
    for (const [id, amount, date] of [['a', 100, 100], ['b', -20, 200], ['c', 30, 200], ['d', 40, 300], ['e', -10, 400], ['f', 50, 500]]) {
      insert.run(id, 'guild-1', 'channel', 'target', 'creator', amount, id, date, date + 86400, 'approved');
    }
    for (const status of ['rejected', 'open', 'expired', 'cancelled']) insert.run(status, 'guild-1', 'channel', 'target', 'creator', 999, 'Exclude', 600, 87000, status);
    insert.run('foreign', 'guild-2', 'channel', 'target', 'creator', 1000, 'Foreign', 700, 87100, 'approved');
    insert.run('foreign-reject', 'guild-2', 'channel', 'target', 'creator', 1, 'Foreign', 700, 87100, 'rejected');
    DB.db.exec("INSERT INTO votes VALUES ('a', 'target', 'yes'); INSERT INTO votes VALUES ('rejected', 'target', 'no'); INSERT INTO votes VALUES ('foreign', 'target', 'yes'); INSERT INTO votes VALUES ('a', 'other', 'yes');");
    const result = await interaction(env, { ...base('target'), type: 2, data: { name: 'perfil' } });
    const fields = result.data.embeds[0].fields;
    assert.match(result.data.embeds[0].description, /190 puntos/);
    assert.equal(fields[0].value, '6');
    assert.equal(fields.find((field) => field.name.includes('rechazadas')).value, '1');
    assert.equal(fields.find((field) => field.name.includes('registrados')).value, '2');
    assert.deepEqual(fields.find((field) => field.name.includes('Evolución')).value.split('\n'), [
      '<t:200:d> · -20 → **80** puntos', '<t:200:d> · +30 → **110** puntos',
      '<t:300:d> · +40 → **150** puntos', '<t:400:d> · -10 → **140** puntos', '<t:500:d> · +50 → **190** puntos'
    ]);
    assert.deepEqual(result.data.allowed_mentions, { parse: [] });
    assert.ok(fields.every((field) => field.value.length <= 1024));
    DB.db.exec("UPDATE votes SET choice = 'no' WHERE proposal_id = 'a' AND user_id = 'target'");
    const changed = await interaction(env, { ...base('target'), type: 2, data: { name: 'perfil' } });
    assert.equal(changed.data.embeds[0].fields.find((field) => field.name.includes('registrados')).value, '2');
    const resolved = await interaction(env, { ...base('other'), type: 2, data: { name: 'perfil', options: [{ name: 'usuario', value: 'target' }] } });
    assert.equal(resolved.data.embeds[0].fields.find((field) => field.name.includes('Evolución')).value, fields.find((field) => field.name.includes('Evolución')).value);
  } finally { DB.close(); }
});

test('estadísticas personales funcionan sin movimientos y con fechas heredadas sin migrar', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    DB.db.exec('DROP INDEX IF EXISTS proposals_history; ALTER TABLE proposals DROP COLUMN created_at');
    const empty = await interaction(env, { ...base('target'), type: 2, data: { name: 'perfil' } });
    assert.equal(empty.data.embeds[0].fields.find((field) => field.name.includes('rechazadas')).value, '0');
    assert.equal(empty.data.embeds[0].fields.find((field) => field.name.includes('registrados')).value, '0');
    assert.match(empty.data.embeds[0].fields.find((field) => field.name.includes('Evolución')).value, /Todavía no hay/);
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy', 'guild-1', 'channel', 'target', 'creator', -10, 'Legacy', 86500, 'approved');
    const legacy = await interaction(env, { ...base('target'), type: 2, data: { name: 'perfil' } });
    assert.equal(legacy.data.embeds[0].fields.find((field) => field.name.includes('Evolución')).value, '<t:100:d> · -10 → **-10** puntos');
  } finally { DB.close(); }
});

test('votaciones muestra todos los estados recibidos y no modifica propuestas ni aura', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const now = Math.floor(Date.now() / 1000);
  const insert = DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  try {
    for (const [i, status] of ['approved', 'rejected', 'open', 'expired', 'cancelled'].entries()) {
      insert.run(status, 'guild-1', 'channel', 'target', 'creator', 100, status, now - i, now + 86400, status);
    }
    insert.run('past-open', 'guild-1', 'channel', 'target', 'creator', -100, 'Plazo pasado', now - 10, now - 1, 'open');
    insert.run('foreign', 'guild-2', 'channel', 'target', 'creator', 999, 'Otro servidor', now, now + 86400, 'approved');
    insert.run('created-by-target', 'guild-1', 'channel', 'other', 'target', 999, 'Creada por la persona', now, now + 86400, 'approved');
    const before = DB.db.prepare('SELECT * FROM proposals ORDER BY id').all();
    const result = await interaction(env, { ...base('target'), type: 2, data: { name: 'votaciones' } });
    const description = result.data.embeds[0].description;
    for (const state of ['Aprobada', 'Rechazada', 'Abierta', 'Vencida', 'Cancelada']) assert.match(description, new RegExp(state));
    assert.match(description, /Propuestas recibidas por <@target>/);
    assert.match(description, /Propuesto por <@creator>/);
    assert.doesNotMatch(description, /Otro servidor|Creada por la persona/);
    assert.match(result.data.embeds[0].footer.text, /6 propuestas/);
    assert.deepEqual(result.data.allowed_mentions, { parse: [] });
    assert.deepEqual(DB.db.prepare('SELECT * FROM proposals ORDER BY id').all(), before);
    assert.equal(DB.db.prepare("SELECT SUM(amount) AS aura FROM proposals WHERE guild_id = 'guild-1' AND target_id = 'target' AND status = 'approved'").get().aura, 100);
    const other = await interaction(env, { ...base('reader'), type: 2, data: { name: 'votaciones', options: [{ name: 'usuario', value: 'target' }] } });
    assert.equal(other.data.embeds[0].description, description);
    const info = await interaction(env, { ...base('reader'), type: 2, data: { name: 'info' } });
    assert.ok(info.data.embeds[0].fields.some((field) => field.name.includes('/votaciones')));
  } finally { DB.close(); }
});

test('votaciones pagina de forma estable y respeta límites incluso con motivos largos', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    for (let i = 0; i < 10; i++) {
      DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(String(i), 'guild-1', 'channel', 'target', '100000000000000000', 1000, `row-${i} ${'x'.repeat(250)}`, 100, 86500, 'rejected');
    }
    const get = (page) => interaction(env, { ...base('target'), type: 2, data: { name: 'votaciones', options: [{ name: 'pagina', value: page }] } });
    const first = await get(1);
    const second = await get(2);
    assert.match(first.data.embeds[0].description, /row-9[\s\S]*row-2/);
    assert.doesNotMatch(first.data.embeds[0].description, /row-1|row-0/);
    assert.match(second.data.embeds[0].description, /row-1[\s\S]*row-0/);
    assert.match(second.data.embeds[0].footer.text, /Página 2 de 2/);
    assert.ok(first.data.embeds[0].description.length <= 4096);
    const out = await get(3);
    assert.match(out.data.content, /2 páginas de votaciones/);
    for (const page of [0, -1, 1.5, 1000001]) assert.match((await get(page)).data.content, /página entera/);
  } finally { DB.close(); }
});

test('votaciones funciona vacío, con fechas heredadas y sin acceso entre servidores', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    DB.db.exec('DROP INDEX IF EXISTS proposals_history; ALTER TABLE proposals DROP COLUMN created_at');
    const empty = await interaction(env, { ...base('target'), type: 2, data: { name: 'votaciones' } });
    assert.match(empty.data.embeds[0].description, /Todavía no hay propuestas/);
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy', 'guild-1', 'channel', 'target', 'creator', 100, 'Heredada', 86500, 'approved');
    const legacy = await interaction(env, { ...base('target'), type: 2, data: { name: 'votaciones' } });
    assert.match(legacy.data.embeds[0].description, /<t:100:d>/);
    const foreign = await interaction(env, { ...base('target'), guild_id: 'guild-2', type: 2, data: { name: 'votaciones' } });
    assert.match(foreign.data.embeds[0].description, /Todavía no hay propuestas/);
    const dm = await interaction(env, { user: { id: 'target' }, type: 2, data: { name: 'votaciones' } });
    assert.equal(dm.data.flags, 64);
    assert.match(dm.data.content, /dentro de un servidor/);
    assert.equal(DB.db.prepare('PRAGMA table_info(proposals)').all().some((column) => column.name === 'created_at'), false);
  } finally { DB.close(); }
});

function duplicateInput(id, overrides = {}) {
  return { ...base('creator'), id, type: 2, data: { name: 'aura', options: [
    { name: 'usuario', value: overrides.target ?? 'target' }, { name: 'puntos', value: overrides.amount ?? 100 },
    { name: 'motivo', value: overrides.reason ?? 'Mismo motivo' }
  ] }, ...overrides.interaction };
}

test('duplicados se bloquean por destinatario, servidor y motivo exacto sin importar autor, canal o puntos', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    await interaction(env, duplicateInput('first'));
    const duplicate = await interaction(env, duplicateInput('second', { reason: '  Mismo motivo  ', amount: -100,
      interaction: { ...base('other'), channel_id: 'another-channel' } }));
    assert.match(duplicate.data.content, /Ya hay una votación abierta/);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
    assert.equal(DB.db.prepare('SELECT amount FROM proposals').get().amount, 100);
    const replay = await interaction(env, duplicateInput('first'));
    assert.match(replay.data.embeds[0].description, /Mismo motivo/);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
    await interaction(env, duplicateInput('other-guild', { interaction: { guild_id: 'guild-2' } }));
    await interaction(env, duplicateInput('other-target', { target: 'someone-else' }));
    await interaction(env, duplicateInput('other-reason', { reason: 'Otro motivo' }));
    await interaction(env, duplicateInput('different-case', { reason: 'mismo motivo' }));
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 5);
  } finally { DB.close(); }
});

for (const status of ['approved', 'rejected', 'expired', 'cancelled', 'past-open']) {
  test(`una propuesta ${status} no bloquea otra con la misma clave`, async () => {
    const DB = new LocalD1();
    const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
    try {
      await interaction(env, duplicateInput('old'));
      if (status === 'past-open') DB.db.exec("UPDATE proposals SET expires_at = 0 WHERE id = 'old'");
      else DB.db.prepare("UPDATE proposals SET status = ? WHERE id = 'old'").run(status);
      const fresh = await interaction(env, duplicateInput('new'));
      assert.ok(fresh.data.embeds);
      assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 2);
      assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'old'").get().status, status === 'past-open' ? 'open' : status);
    } finally { DB.close(); }
  });
}

test('dos creaciones concurrentes generan una propuesta y una advertencia explícita', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const results = await Promise.all([interaction(env, duplicateInput('parallel-a')), interaction(env, duplicateInput('parallel-b'))]);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
    assert.equal(results.filter((result) => result.data.embeds).length, 1);
    assert.equal(results.filter((result) => result.data.content?.includes('Ya hay una votación abierta')).length, 1);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
  } finally { DB.close(); }
});

test('reentregar una creación rechazada por duplicado no crea otra después del cierre', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    await interaction(env, duplicateInput('first'));
    await interaction(env, duplicateInput('blocked'));
    DB.db.exec("UPDATE proposals SET status = 'cancelled' WHERE id = 'first'");
    const replay = await interaction(env, duplicateInput('blocked'));
    assert.ok(replay.data.content);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 1);
    const fresh = await interaction(env, duplicateInput('fresh'));
    assert.ok(fresh.data.embeds);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 2);
  } finally { DB.close(); }
});

test('las propuestas duplicadas heredadas se conservan y no permiten una tercera', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const insert = DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const id of ['old-a', 'old-b']) insert.run(id, 'guild-1', 'channel', 'target', 'creator', 100, 'Mismo motivo', Math.floor(Date.now() / 1000) + 86400);
    DB.db.exec("INSERT INTO votes VALUES ('old-a', 'voter', 'yes')");
    const result = await interaction(env, duplicateInput('third'));
    assert.match(result.data.content, /Ya hay una votación abierta/);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 2);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
  } finally { DB.close(); }
});

function configInput(id, values = {}, interaction = {}) {
  const role = values.rol;
  return { ...base('admin'), id, type: 2, member: { user: { id: 'admin' }, roles: [], permissions: '32' },
    data: { name: 'config', options: [{ type: 1, name: 'cambiar', options: Object.entries(values).map(([name, value]) => ({ name, value })) }],
      resolved: { roles: role ? { [role]: { id: role, name: 'Decisor' } } : {} } }, ...interaction };
}

test('configuración exige permisos, separa servidores y requiere rol explícito en servidores nuevos', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const missing = await interaction(env, duplicateInput('unconfigured', { interaction: { guild_id: 'brand-new' } }));
    assert.match(missing.data.content, /necesita un rol decisor/);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
    const denied = await interaction(env, configInput('unauthorized', { normal: 1 }, { member: { user: { id: 'ordinary' }, permissions: '0' } }));
    assert.equal(denied.data.flags, 64);
    assert.match(denied.data.content, /Administrar servidor/);
    const saved = await interaction(env, configInput('first-config', { rol: 'custom-role', normal: 2, imponerse: 3 }, { guild_id: 'brand-new' }));
    assert.equal(saved.data.flags, 64);
    assert.match(saved.data.content, /Configuración guardada/);
    assert.equal(DB.db.prepare("SELECT voter_role_id FROM guild_config WHERE guild_id = 'brand-new'").get().voter_role_id, 'custom-role');
    assert.equal(DB.db.prepare("SELECT votes_to_close FROM guild_config WHERE guild_id = 'guild-1'").get().votes_to_close, 4);
    const info = await interaction(env, { ...base('reader'), guild_id: 'brand-new', type: 2, data: { name: 'info' } });
    assert.match(info.data.embeds[0].fields.at(-1).value, /custom-role[\s\S]*2[\s\S]*3/);
    const view = await interaction(env, { ...base('reader'), guild_id: 'brand-new', type: 2, data: { name: 'config', options: [{ name: 'ver' }] } });
    assert.equal(view.data.flags, 64);
    assert.match(view.data.content, /custom-role/);
    const dm = await interaction(env, { user: { id: 'reader' }, type: 2, data: { name: 'config', options: [{ name: 'ver' }] } });
    assert.match(dm.data.content, /dentro de un servidor/);
  } finally { DB.close(); }
});

test('las propuestas conservan rol y umbrales al cambiar la configuración', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const voteAs = (id, role, user) => interaction(env, { ...base(user), member: { user: { id: user }, roles: [role] }, type: 3, data: { custom_id: `aura:yes:${id}` } });
  try {
    await interaction(env, configInput('config-old', { rol: 'old-role', normal: 2, imponerse: 3 }));
    await interaction(env, duplicateInput('old-rules'));
    await interaction(env, configInput('config-new', { rol: 'new-role', normal: 3, imponerse: 4 }));
    await interaction(env, duplicateInput('new-rules', { reason: 'Otro motivo' }));
    await voteAs('old-rules', 'old-role', 'old-voter-1');
    await voteAs('old-rules', 'old-role', 'old-voter-2');
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'old-rules'").get().status, 'approved');
    await voteAs('new-rules', 'old-role', 'ordinary');
    for (let i = 0; i < 2; i++) await voteAs('new-rules', 'new-role', `new-${i}`);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'new-rules'").get().status, 'open');
    await voteAs('new-rules', 'new-role', 'new-2');
    const old = await readProposalMessage(DB, 'old-rules');
    const fresh = await readProposalMessage(DB, 'new-rules');
    assert.equal(fresh.proposal.status, 'approved');
    assert.match(old.body.embeds[0].description, /old-role/);
    assert.match(old.body.embeds[0].fields[2].value, /Regla de 2/);
    assert.match(fresh.body.embeds[0].description, /new-role/);
    assert.match(fresh.body.embeds[0].fields[2].value, /Regla de 3/);
    assert.equal(fresh.proposal.roleYes, 3);
  } finally { DB.close(); }
});

test('umbrales inválidos se rechazan y reentregar una configuración no revierte otra posterior', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    for (const values of [{ normal: 0 }, { normal: 1.5 }, { imponerse: 101 }, { normal: 7, imponerse: 6 }]) {
      const rejected = await interaction(env, configInput(`invalid-${Object.keys(values)[0]}-${Object.values(values).join('-')}`, values));
      assert.match(rejected.data.content, /umbrales/);
    }
    const initial = configInput('replayed-config', { normal: 2, imponerse: 3 });
    await interaction(env, initial);
    await interaction(env, configInput('later-config', { normal: 5, imponerse: 7 }));
    const replay = await interaction(env, initial);
    assert.match(replay.data.content, /ya fue procesada/);
    assert.equal(DB.db.prepare("SELECT votes_to_close FROM guild_config WHERE guild_id = 'guild-1'").get().votes_to_close, 5);
    const before = DB.db.prepare("SELECT version FROM guild_config WHERE guild_id = 'guild-1'").get().version;
    const prepare = DB.prepare.bind(DB);
    let readers = 0;
    let releaseReaders;
    const bothRead = new Promise((resolve) => { releaseReaders = resolve; });
    DB.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === 'SELECT * FROM guild_config WHERE guild_id = ?') {
        const first = statement.first.bind(statement);
        statement.first = async () => {
          const snapshot = await first();
          if (readers < 2) {
            readers++;
            if (readers === 2) releaseReaders();
            await bothRead;
          }
          return snapshot;
        };
      }
      return statement;
    };
    const results = await Promise.all([
      interaction(env, configInput('concurrent-config-a', { normal: 2 })),
      interaction(env, configInput('concurrent-config-b', { normal: 3 }))
    ]);
    assert.equal(results.filter((result) => result.data.content.includes('Configuración guardada')).length, 1);
    assert.equal(results.filter((result) => result.data.content.includes('cambió mientras')).length, 1);
    assert.equal(DB.db.prepare("SELECT version FROM guild_config WHERE guild_id = 'guild-1'").get().version, before + 1);
  } finally { DB.close(); }
});

test('canal configurado se valida con permisos efectivos y no restringe votos o cancelaciones antiguas', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex, DISCORD_BOT_TOKEN: 'test-only' };
  let allowed = false;
  mockDiscord(t, async (url, options) => {
    if (url.includes('/applications/')) return Response.json([]);
    if (options?.method === 'PATCH') return Response.json({ id: '999123' });
    if (url.endsWith('/users/@me')) return Response.json({ id: 'bot' });
    if (url.includes('/members/bot')) return Response.json({ roles: [] });
    if (url.endsWith('/roles')) return Response.json([{ id: 'guild-1', permissions: allowed ? '19456' : '1024' }]);
    if (url.includes('/channels/')) return Response.json({ guild_id: 'guild-1', type: 0, permission_overwrites: [] });
    throw new Error('Unexpected test route');
  });
  try {
    const rejected = await interaction(env, configInput('channel-denied', { canal: 'only-channel' }));
    assert.match(rejected.data.content, /No puedo usar ese canal/);
    allowed = true;
    const saved = await interaction(env, configInput('channel-allowed', { canal: 'only-channel' }));
    assert.match(saved.data.content, /Configuración guardada/);
    const wrong = await interaction(env, duplicateInput('wrong-channel'));
    assert.match(wrong.data.content, /only-channel/);
    const old = await interaction(env, duplicateInput('old-channel-proposal', { interaction: { channel_id: 'only-channel' } }));
    assert.ok(old.data.embeds);
    await interaction(env, configInput('new-channel', { canal: 'different-channel' }));
    const cancelled = await interaction(env, { ...base('creator'), channel_id: 'only-channel', type: 3, data: { custom_id: 'aura:cancel:old-channel-proposal' } });
    assert.deepEqual(cancelled, { type: 6 });
    await interaction(env, configInput('clear-channel', { canal_libre: true }));
    assert.equal(DB.db.prepare("SELECT channel_id FROM guild_config WHERE guild_id = 'guild-1'").get().channel_id, null);
    assert.ok((await interaction(env, duplicateInput('any-channel'))).data.embeds);
  } finally { DB.close(); }
});

for (const choice of ['yes', 'no']) {
  test(`umbrales personalizados permiten imponerse con 3 votos del rol: ${choice}`, async () => {
    const DB = new LocalD1();
    const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
    try {
      await interaction(env, configInput('custom-thresholds', { normal: 2, imponerse: 3 }));
      await interaction(env, duplicateInput('custom-vote'));
      for (let i = 0; i < 4; i++) await interaction(env, { ...base(`general-${i}`), type: 3, data: { custom_id: `aura:${choice === 'yes' ? 'no' : 'yes'}:custom-vote` } });
      for (let i = 0; i < 2; i++) await interaction(env, { ...base(`role-${i}`, true), type: 3, data: { custom_id: `aura:${choice}:custom-vote` } });
      assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'custom-vote'").get().status, 'open');
      await interaction(env, { ...base('role-last', true), type: 3, data: { custom_id: `aura:${choice}:custom-vote` } });
      const snapshot = await readProposalMessage(DB, 'custom-vote');
      assert.equal(snapshot.proposal.status, choice === 'yes' ? 'approved' : 'rejected');
      assert.match(snapshot.body.embeds[0].fields[2].value, /Regla de 3/);
    } finally { DB.close(); }
  });
}

for (const change of ['channel', 'rules']) {
  test(`crear una propuesta consulta la configuración dentro del lote si cambia ${change}`, async () => {
    const DB = new LocalD1();
    const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
    try {
      await interaction(env, configInput('initial-policy', { normal: 4, imponerse: 6 }));
      const batch = DB.batch.bind(DB);
      let changed = false;
      DB.batch = async (statements) => {
        if (!changed && statements.some((statement) => statement.sql.includes('FROM guild_config g WHERE'))) {
          changed = true;
          if (change === 'channel') DB.db.exec("UPDATE guild_config SET channel_id = 'new-channel' WHERE guild_id = 'guild-1'");
          else DB.db.exec("UPDATE guild_config SET voter_role_id = 'fresh-role', votes_to_close = 2, votes_to_override = 3 WHERE guild_id = 'guild-1'");
        }
        return batch(statements);
      };
      const result = await interaction(env, duplicateInput('policy-race'));
      if (change === 'channel') {
        assert.match(result.data.content, /configuración cambió/);
        assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
      } else {
        assert.ok(result.data.embeds);
        assert.equal(DB.db.prepare("SELECT voter_role_id FROM proposal_rules WHERE proposal_id = 'policy-race'").get().voter_role_id, 'fresh-role');
        assert.equal(DB.db.prepare("SELECT votes_to_close FROM proposal_rules WHERE proposal_id = 'policy-race'").get().votes_to_close, 2);
      }
    } finally { DB.close(); }
  });
}

test('configuración rechaza @everyone y roles no resueltos por Discord', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const everyone = await interaction(env, configInput('everyone-role', { rol: 'guild-1' }));
    assert.match(everyone.data.content, /distinto de @everyone/);
    const unknown = configInput('unknown-role', { rol: 'unknown' });
    unknown.data.resolved.roles = {};
    assert.match((await interaction(env, unknown)).data.content, /rol del servidor/);
    assert.equal(DB.db.prepare("SELECT voter_role_id FROM guild_config WHERE guild_id = 'guild-1'").get().voter_role_id, '1431791263547392121');
  } finally { DB.close(); }
});

function adminInput(id, action, values = {}, extra = {}) {
  return { ...base('administrator'), id, type: 2,
    member: { user: { id: 'administrator' }, roles: [], permissions: '8' },
    data: { name: 'moderar', options: [{ name: action, options: Object.entries(values).map(([name, value]) => ({ name, value })) }] }, ...extra };
}

test('todas las acciones de moderación exigen Administrador y las respuestas son privadas', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    for (const action of ['listar', 'inspeccionar', 'cancelar', 'sincronizar', 'acciones', 'ajustar', 'anular', 'anular_varias', 'anular_ultima', 'confirmar', 'operacion']) {
      for (const permissions of ['0', '32', '-1', 'invalid']) {
        const denied = await interaction(env, adminInput(`denied-${action}-${permissions}`, action, {}, { member: { user: { id: 'ordinary' }, permissions } }));
        assert.equal(denied.data.flags, 64);
        assert.match(denied.data.content, /exclusivo.*Administrador/);
      }
    }
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n, 0);
    const view = await interaction(env, adminInput('admin-list', 'listar'));
    assert.equal(view.data.flags, 64);
    assert.match(view.data.embeds[0].description, /No hay propuestas/);
    assert.equal(commands.find((command) => command.name === 'moderar').default_member_permissions, '8');
    const dm = await interaction(env, adminInput('admin-dm', 'listar', {}, { guild_id: undefined }));
    assert.equal(dm.data.flags, 64);
    assert.match(dm.data.content, /dentro de un servidor/);
    const regularInfo = await interaction(env, { ...base('ordinary'), type: 2, data: { name: 'info' } });
    assert.ok(!regularInfo.data.embeds[0].fields.some((field) => field.name.includes('/moderar')));
  } finally { DB.close(); }
});

test('inspección y filtros del panel no filtran datos de otros servidores ni cambian la propuesta', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const { id } = await cancellableProposal(env);
    const before = DB.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    const inspect = await interaction(env, adminInput('inspect-own', 'inspeccionar', { propuesta: id }));
    assert.equal(inspect.data.flags, 64);
    assert.deepEqual(inspect.data.components, []);
    assert.match(inspect.data.embeds[0].description, /Propuesta retirada/);
    assert.ok(inspect.data.embeds[0].fields.some((field) => field.name === 'ID' && field.value === id));
    const foreign = await interaction(env, adminInput('inspect-foreign', 'inspeccionar', { propuesta: id }, { guild_id: 'guild-2' }));
    assert.match(foreign.data.content, /inexistente en este servidor/);
    assert.doesNotMatch(foreign.data.content, /Propuesta retirada/);
    const filtered = await interaction(env, adminInput('list-filtered', 'listar', { usuario: 'someone-else' }));
    assert.match(filtered.data.embeds[0].description, /No hay propuestas/);
    const list = await interaction(env, adminInput('list-open', 'listar', { usuario: 'target', estado: 'open' }));
    assert.match(list.data.embeds[0].description, new RegExp(id));
    assert.deepEqual(DB.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id), before);
  } finally { DB.close(); }
});

test('cancelación administrativa exige confirmación y audita el motivo sin publicarlo', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const edits = [];
  mockDiscord(t, async (_url, options) => {
    assert.equal(options.method, 'PATCH');
    edits.push(JSON.parse(options.body));
    return Response.json({ id: '999123' });
  });
  try {
    const { id } = await cancellableProposal(env);
    const values = { propuesta: id, motivo: 'Motivo administrativo privado' };
    const preview = await interaction(env, adminInput('cancel-preview', 'cancelar', values));
    assert.match(preview.data.content, /Vista previa/);
    assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'open');
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n, 0);
    const emptyReason = await interaction(env, adminInput('cancel-no-reason', 'cancelar', { propuesta: id, motivo: '  ', confirmar: true }));
    assert.match(emptyReason.data.content, /motivo/);
    env.DISCORD_BOT_TOKEN = 'test-only';
    const request = adminInput('admin-cancel-confirmed', 'cancelar', { ...values, confirmar: true });
    const cancelled = await interaction(env, request);
    assert.equal(cancelled.data.flags, 64);
    assert.match(cancelled.data.content, /cancelada y acción auditada/);
    assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'cancelled');
    const action = DB.db.prepare('SELECT * FROM admin_actions').get();
    assert.equal(action.actor_id, 'administrator');
    assert.equal(action.reason, values.motivo);
    assert.equal(action.previous_status, 'open');
    assert.equal(action.result_status, 'cancelled');
    assert.deepEqual(edits.at(-1).components, []);
    assert.match(edits.at(-1).embeds[0].fields[2].value, /Cancelada/);
    assert.doesNotMatch(JSON.stringify(edits), /Motivo administrativo privado/);
    await interaction(env, request);
    await interaction(env, adminInput('admin-cancel-again', 'cancelar', { ...values, confirmar: true }));
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n, 1);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposal_notifications').get().n, 0);
    const audit = await interaction(env, adminInput('view-audit', 'acciones', { propuesta: id }));
    assert.match(audit.data.embeds[0].description, /Motivo administrativo privado/);
    assert.match(audit.data.embeds[0].description, /administrator/);
    const foreign = await interaction(env, adminInput('foreign-audit', 'acciones', { propuesta: id }, { guild_id: 'guild-2' }));
    assert.match(foreign.data.embeds[0].description, /No hay acciones/);
  } finally { DB.close(); }
});

test('el fallo del lote administrativo revierte la cancelación y su auditoría', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const { id } = await cancellableProposal(env);
    const batch = DB.batch.bind(DB);
    let fail = true;
    DB.batch = async (statements) => {
      if (fail && statements.some((statement) => statement.sql.includes('INSERT OR IGNORE INTO admin_actions'))) {
        fail = false;
        statements.push(DB.prepare('INSERT INTO missing_admin_table VALUES (1)'));
      }
      return batch(statements);
    };
    const request = adminInput('admin-rollback', 'cancelar', { propuesta: id, motivo: 'Prueba de reversión', confirmar: true });
    const failure = await interaction(env, request);
    assert.match(failure.data.content, /No pude confirmar la acción/);
    assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'open');
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n, 0);
    await interaction(env, request);
    assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'cancelled');
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n, 1);
  } finally { DB.close(); }
});

for (const winner of ['vote', 'cancel']) {
  test(`carrera con administrador: ${winner} confirma primero y no se corrige aura aprobada`, async () => {
    const DB = new LocalD1();
    const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
    try {
      const { id, voteId } = await cancellableProposal(env);
      for (let i = 0; i < 3; i++) await interaction(env, { ...base(`role-${i}`, true), type: 3, data: { custom_id: voteId } });
      const cancel = adminInput('admin-race', 'cancelar', { propuesta: id, motivo: 'Cancelación concurrente', confirmar: true });
      const vote = { ...base('deciding', true), type: 3, data: { custom_id: voteId } };
      const batch = DB.batch.bind(DB);
      let race = true;
      DB.batch = async (statements) => {
        const pending = winner === 'vote'
          ? statements.some((statement) => statement.sql.includes('INSERT OR IGNORE INTO admin_actions'))
          : statements.some((statement) => statement.sql.startsWith('INSERT INTO votes('));
        if (race && pending) { race = false; await interaction(env, winner === 'vote' ? vote : cancel); }
        return batch(statements);
      };
      await interaction(env, winner === 'vote' ? cancel : vote);
      assert.equal(DB.db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, winner === 'vote' ? 'approved' : 'cancelled');
      assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n, winner === 'vote' ? 0 : 1);
      assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, winner === 'vote' ? 4 : 3);
    } finally { DB.close(); }
  });
}

test('sincronizar es privado, confirmado y auditable sin reenviar avisos ni cambiar votos', async (t) => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  const edits = [];
  mockDiscord(t, async (_url, options) => {
    assert.equal(options.method, 'PATCH');
    edits.push(JSON.parse(options.body));
    return Response.json({ id: '999123' });
  });
  try {
    const { id, cancelId } = await cancellableProposal(env);
    await interaction(env, { ...base('creator'), type: 3, data: { custom_id: cancelId } });
    const preview = await interaction(env, adminInput('sync-preview', 'sincronizar', { propuesta: id }));
    assert.match(preview.data.content, /Vista previa/);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n, 0);
    env.DISCORD_BOT_TOKEN = 'test-only';
    const request = adminInput('admin-sync', 'sincronizar', { propuesta: id, confirmar: true });
    const response = await interaction(env, request);
    assert.match(response.data.content, /solicitada y auditada/);
    await interaction(env, request);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n, 1);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposal_notifications').get().n, 0);
    assert.deepEqual(edits.at(-1).components, []);
    assert.match(edits.at(-1).embeds[0].fields[2].value, /Cancelada/);
  } finally { DB.close(); }
});

test('listas y auditoría administrativas están paginadas, filtran por estado y no vencen datos al leer', async () => {
  const DB = new LocalD1();
  const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const insert = DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 10; i++) {
      insert.run(`panel-${i}`, 'guild-1', 'channel', 'target', 'creator', 100, `${i} ${'x'.repeat(250)}`, 100, 1);
      DB.db.prepare('INSERT INTO admin_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`audit-${i}`, 'guild-1', `panel-${i}`, 'administrator', 'sync', 'x'.repeat(250), 100, 'open', 'open');
    }
    const first = await interaction(env, adminInput('page-one', 'listar', { estado: 'expired', pagina: 1 }));
    const second = await interaction(env, adminInput('page-two', 'listar', { estado: 'expired', pagina: 2 }));
    assert.match(first.data.embeds[0].description, /panel-9[\s\S]*panel-2/);
    assert.doesNotMatch(first.data.embeds[0].description, /panel-1`|panel-0`/);
    assert.match(second.data.embeds[0].description, /panel-1[\s\S]*panel-0/);
    assert.ok(first.data.embeds[0].description.length <= 4096);
    const inspect = await interaction(env, adminInput('inspect-expired', 'inspeccionar', { propuesta: 'panel-0' }));
    assert.match(inspect.data.embeds[0].fields[2].value, /Vencida/);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id = 'panel-0'").get().status, 'open');
    const audit = await interaction(env, adminInput('audit-page', 'acciones', { pagina: 2 }));
    assert.match(audit.data.embeds[0].description, /panel-1[\s\S]*panel-0/);
    assert.ok(audit.data.embeds[0].description.length <= 4096);
    const filtered = await interaction(env, adminInput('audit-filter', 'acciones', { propuesta: 'panel-0' }));
    assert.match(filtered.data.embeds[0].description, /panel-0/);
    assert.doesNotMatch(filtered.data.embeds[0].description, /panel-1/);
    assert.match((await interaction(env, adminInput('invalid-page', 'listar', { pagina: 0 }))).data.content, /página entera/);
    assert.match((await interaction(env, adminInput('invalid-state', 'listar', { estado: 'invalid' }))).data.content, /estado válido/);
    assert.match((await interaction(env, adminInput('invalid-id', 'inspeccionar', { propuesta: '`bad`' }))).data.content, /ID de propuesta válido/);
    assert.match((await interaction(env, adminInput('out-of-range', 'acciones', { pagina: 3 }))).data.content, /2 página/);
  } finally { DB.close(); }
});

const operationCode = (view) => view.data.components[0].components[0].custom_id.split(':')[2];
const publicQuery = (name, user = 'target') => ({ ...base(user), type: 2, data: { name, options: [{ name: 'usuario', value: user }] } });
function seedCorrection(DB, id, amount, status = 'approved', guild = 'guild-1', created = 100) {
  DB.db.prepare(`INSERT INTO proposals(id,guild_id,channel_id,target_id,proposer_id,amount,reason,created_at,expires_at,status)
    VALUES (?,?,'channel-1','target','creator',?, ?, ?,unixepoch()+86400,?)`).run(id,guild,amount,`Motivo ${id}`,created,status);
}

test('ajustes administrativos: vista privada, confirmación única, signos y consultas públicas coherentes', async () => {
  const DB = new LocalD1(); const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    for (const amount of [0, 1000001, -1000001, 1.5]) {
      const invalid = await interaction(env, adminInput(`invalid-adjust-${amount}`, 'ajustar', { usuario: 'target', puntos: amount, motivo: 'Prueba privada' }));
      assert.match(invalid.data.content, /enteros/);
    }
    for (const [index, amount] of [250, -100].entries()) {
      const request = adminInput(`adjust-${index}`, 'ajustar', { usuario: 'target', puntos: amount, motivo: 'Motivo confidencial' });
      const view = await interaction(env, request); const code = operationCode(view);
      assert.equal(view.data.flags, 64);
      assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, index);
      assert.equal(operationCode(await interaction(env, request)), code);
      const confirmed = adminInput(`confirm-adjust-${index}`, 'confirmar', { codigo: code });
      const results = await Promise.all([interaction(env, confirmed), interaction(env, { ...confirmed, id: `parallel-adjust-${index}` })]);
      assert.ok(results.some(result => /aplicada y auditada/.test(result.data.content)));
      await interaction(env, confirmed);
      assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, index + 1);
    }
    assert.equal(DB.db.prepare("SELECT SUM(amount) AS n FROM proposals WHERE status='approved'").get().n, 150);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM admin_adjustments').get().n, 2);
    for (const name of ['perfil', 'historial', 'votaciones', 'ranking']) {
      const view = await interaction(env, publicQuery(name));
      assert.doesNotMatch(JSON.stringify(view), /Motivo confidencial/);
      if (name !== 'ranking') assert.match(JSON.stringify(view), /administrativo/i);
      if (name === 'perfil' || name === 'ranking') assert.match(JSON.stringify(view), /150/);
    }
    const audit = await interaction(env, adminInput('adjust-audit', 'acciones'));
    assert.match(JSON.stringify(audit), /Motivo confidencial/);
  } finally { DB.close(); }
});

test('anular una resta de prueba devuelve puntos y retira historia, votos y ambos mensajes públicos', async (t) => {
  const DB = new LocalD1(); const env = { DB, DISCORD_PUBLIC_KEY: publicHex, DISCORD_BOT_TOKEN: 'local-test' };
  const edits = [];
  mockDiscord(t, (_url, options) => { edits.push(JSON.parse(options.body)); return Response.json({ id: '999' }); });
  try {
    seedCorrection(DB, 'baseline', 200); seedCorrection(DB, 'trial', -100);
    DB.db.exec("UPDATE proposals SET message_id='123' WHERE id='trial'; INSERT INTO proposal_notifications(proposal_id,state,message_id) VALUES ('trial','sent','456'); INSERT INTO votes VALUES ('trial','target','yes')");
    const preview = await interaction(env, adminInput('void-preview', 'anular', { propuesta: 'trial', motivo: 'Era una prueba privada' }));
    assert.match(JSON.stringify(preview), /efecto \+100/);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id='trial'").get().status, 'approved');
    const code = operationCode(preview);
    const button = { ...base('administrator'), id: 'void-confirm', type: 3, member: { user: { id: 'administrator' }, permissions: '8' }, message: { flags: 64 }, data: { custom_id: `admin:confirm:${code}` } };
    assert.match((await interaction(env, button)).data.content, /aplicada y auditada/);
    await interaction(env, button);
    assert.equal(DB.db.prepare("SELECT SUM(amount) AS n FROM proposals WHERE status='approved'").get().n, 200);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id='trial'").get().status, 'voided');
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
    assert.equal(edits.length, 2);
    assert.ok(edits.every(edit => !JSON.stringify(edit).includes('Motivo trial') && !JSON.stringify(edit).includes('Era una prueba privada')));
    for (const name of ['perfil', 'historial', 'votaciones', 'ranking']) {
      const view = await interaction(env, publicQuery(name));
      assert.doesNotMatch(JSON.stringify(view), /Motivo trial/);
      if (name === 'perfil' || name === 'ranking') assert.match(JSON.stringify(view), /200/);
      if (name === 'perfil') assert.equal(view.data.embeds[0].fields.find(f => f.name.includes('Votos registrados')).value, '0');
    }
    const inspect = await interaction(env, adminInput('void-inspect', 'inspeccionar', { propuesta: 'trial' }));
    assert.match(JSON.stringify(inspect), /Motivo trial/);
    const audit = await interaction(env, adminInput('void-audit', 'acciones', { propuesta: 'trial' }));
    assert.match(JSON.stringify(audit), /Era una prueba privada/);
  } finally { DB.close(); }
});

test('anulación múltiple es atómica, deduplica IDs y bloquea cualquier selección modificada', async () => {
  const DB = new LocalD1(); const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    seedCorrection(DB, 'positive', 100); seedCorrection(DB, 'negative', -40); seedCorrection(DB, 'pending', 30, 'open');
    seedCorrection(DB, 'foreign', 50, 'approved', 'guild-2');
    for (const [index, ids] of ['positive foreign', Array.from({ length: 11 }, (_, i) => `id${i}`).join(','), 'missing'].entries()) {
      const result = await interaction(env, adminInput(`invalid-bulk-${index}`, 'anular_varias', { propuestas: ids, motivo: 'Prueba de selección' }));
      assert.equal(result.data.components, undefined);
    }
    const values = { propuestas: 'positive, negative pending positive', motivo: 'Prueba múltiple' };
    const preview = await interaction(env, adminInput('bulk-preview', 'anular_varias', values));
    assert.match(JSON.stringify(preview), /Efecto total: -60/);
    DB.db.exec("UPDATE proposals SET status='rejected' WHERE id='pending'");
    const result = await interaction(env, adminInput('stale-confirm', 'confirmar', { codigo: operationCode(preview) }));
    assert.match(result.data.content, /alguna propuesta cambió/);
    assert.equal(DB.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='voided'").get().n, 0);
    const fresh = await interaction(env, adminInput('fresh-bulk', 'anular_varias', values));
    await interaction(env, adminInput('bulk-confirm', 'confirmar', { codigo: operationCode(fresh) }));
    assert.equal(DB.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='voided'").get().n, 3);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id='foreign'").get().status, 'approved');
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 4);
  } finally { DB.close(); }
});

test('última propuesta fija destinatario e ID y dos vistas superpuestas nunca anulan dos veces', async () => {
  const DB = new LocalD1(); const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    seedCorrection(DB, 'old', 20); seedCorrection(DB, 'latest', -10, 'approved', 'guild-1', 200);
    const values = { usuario: 'target', motivo: 'Retirar última prueba' };
    const a = operationCode(await interaction(env, adminInput('latest-a', 'anular_ultima', values)));
    const b = operationCode(await interaction(env, adminInput('latest-b', 'anular_ultima', values)));
    seedCorrection(DB, 'newer', 40, 'approved', 'guild-1', 300);
    await Promise.all([interaction(env, adminInput('latest-confirm-a', 'confirmar', { codigo: a })), interaction(env, adminInput('latest-confirm-b', 'confirmar', { codigo: b }))]);
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id='latest'").get().status, 'voided');
    assert.equal(DB.db.prepare("SELECT status FROM proposals WHERE id='newer'").get().status, 'approved');
    assert.equal(DB.db.prepare("SELECT COUNT(*) AS n FROM admin_operations WHERE status='applied'").get().n, 1);
    assert.equal(DB.db.prepare("SELECT COUNT(*) AS n FROM admin_operations WHERE status='stale'").get().n, 1);
  } finally { DB.close(); }
});

test('confirmaciones verifican propietario, servidor, permiso actual, mensaje privado, descarte y vencimiento', async () => {
  const DB = new LocalD1(); const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const preview = await interaction(env, adminInput('guard-preview', 'ajustar', { usuario: 'target', puntos: 10, motivo: 'Prueba de guardas' }));
    const code = operationCode(preview);
    const other = await interaction(env, adminInput('guard-owner', 'confirmar', { codigo: code }, { member: { user: { id: 'other-admin' }, permissions: '8' } }));
    assert.match(other.data.content, /Solo el administrador/);
    const foreign = await interaction(env, adminInput('guard-guild', 'confirmar', { codigo: code }, { guild_id: 'guild-2' }));
    assert.match(foreign.data.content, /inexistente/);
    for (const [permissions, flags] of [['32', 64], ['8', 0]]) {
      const result = await interaction(env, { ...base('administrator'), type: 3, member: { user: { id: 'administrator' }, permissions }, message: { flags }, data: { custom_id: `admin:confirm:${code}` } });
      assert.equal(result.data.flags, 64);
    }
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
    const discarded = await interaction(env, { ...base('administrator'), type: 3, member: { user: { id: 'administrator' }, permissions: '8' }, message: { flags: 64 }, data: { custom_id: `admin:discard:${code}` } });
    assert.match(discarded.data.content, /descartada/);
    await interaction(env, adminInput('guard-after-discard', 'confirmar', { codigo: code }));
    const expired = operationCode(await interaction(env, adminInput('expired-preview', 'ajustar', { usuario: 'target', puntos: -10, motivo: 'Vista vencida' })));
    DB.db.exec('UPDATE admin_operations SET expires_at=0');
    assert.match((await interaction(env, adminInput('expired-confirm', 'confirmar', { codigo: expired }))).data.content, /venció/);
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
  } finally { DB.close(); }
});

test('fallo a mitad del lote revierte ajuste y auditoría y permite confirmar otra vez', async () => {
  const DB = new LocalD1(); const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    const code = operationCode(await interaction(env, adminInput('rollback-preview', 'ajustar', { usuario: 'target', puntos: 70, motivo: 'Prueba atómica' })));
    DB.db.exec("CREATE TRIGGER fail_adjustment BEFORE INSERT ON admin_adjustments BEGIN SELECT RAISE(ABORT,'local failure'); END");
    await interaction(env, adminInput('rollback-confirm', 'confirmar', { codigo: code }));
    assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
    assert.equal(DB.db.prepare('SELECT status FROM admin_operations').get().status, 'pending');
    DB.db.exec('DROP TRIGGER fail_adjustment');
    await interaction(env, adminInput('rollback-retry', 'confirmar', { codigo: code }));
    assert.equal(DB.db.prepare("SELECT SUM(amount) AS n FROM proposals WHERE status='approved'").get().n, 70);
  } finally { DB.close(); }
});

test('aviso en vuelo al anular se guarda y neutraliza; los pendientes no se publican', async (t) => {
  const DB = new LocalD1(); const env = { DB, DISCORD_PUBLIC_KEY: publicHex, DISCORD_BOT_TOKEN: 'local-test' };
  env.MESSAGE_SYNC = messageSyncBinding(env);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const posted = new Promise(resolve => { started = resolve; });
  const patched = [];
  mockDiscord(t, async (_url, options) => {
    if (options.method === 'POST') { started(); await gate; return Response.json({ id: 'late-notice' }); }
    patched.push(JSON.parse(options.body)); return Response.json({});
  });
  try {
    seedCorrection(DB, 'in-flight', -25); seedCorrection(DB, 'unsent', 20);
    DB.db.exec("INSERT INTO proposal_notifications(proposal_id) VALUES ('in-flight'),('unsent')");
    const sending = sendClosureNotifications(env, 'in-flight');
    await posted;
    const code = operationCode(await interaction(env, adminInput('late-preview', 'anular_varias', { propuestas: 'in-flight unsent', motivo: 'Anular avisos de prueba' })));
    await interaction(env, adminInput('late-confirm', 'confirmar', { codigo: code }));
    assert.equal(DB.db.prepare("SELECT state FROM proposal_notifications WHERE proposal_id='unsent'").get().state, 'cancelled');
    release(); await sending;
    await sendClosureNotifications(env, 'unsent');
    assert.equal(patched.length, 1);
    assert.match(patched[0].content, /anulada/);
    assert.equal(DB.db.prepare("SELECT message_id FROM proposal_notifications WHERE proposal_id='in-flight'").get().message_id, 'late-notice');
  } finally { release(); DB.close(); }
});

test('consultas anteriores a la migración administrativa funcionan sin crear tablas', async () => {
  const DB = new LocalD1(); const env = { DB, DISCORD_PUBLIC_KEY: publicHex };
  try {
    seedCorrection(DB, 'legacy-approved', 70);
    DB.db.exec('DROP TABLE admin_adjustments; DROP TABLE admin_operation_items; DROP TABLE admin_operations');
    for (const name of ['perfil', 'historial', 'votaciones', 'ranking']) {
      const view = await interaction(env, publicQuery(name));
      assert.ok(view.data.embeds);
    }
    assert.equal(DB.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='admin_adjustments'").get().n, 0);
    const preview = await interaction(env, adminInput('migration-adjust', 'ajustar', { usuario: 'target', puntos: 10, motivo: 'Migración compatible' }));
    await interaction(env, adminInput('migration-confirm', 'confirmar', { codigo: operationCode(preview) }));
    assert.equal(DB.db.prepare("SELECT SUM(amount) AS n FROM proposals WHERE status='approved'").get().n, 80);
  } finally { DB.close(); }
});
