import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Response, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const events = [];
const listeners = new Set();
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-06-01',
  d1Databases: ['DB'], durableObjects: { MESSAGE_SYNC: { className: 'ProposalMessageSync', useSQLite: true } },
  bindings: { DISCORD_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    DISCORD_APPLICATION_ID: '1417570023370653836', DISCORD_BOT_TOKEN: 'local-test-only' },
  outboundService: async (request) => {
    assert.equal(new URL(request.url).hostname, 'discord.com');
    const body = request.method === 'GET' ? null : await request.json();
    events.push({ url: request.url, method: request.method, body });
    for (const listener of listeners) listener();
    return Response.json(request.url.includes('/applications/') ? [] : { id: '999123' });
  }
}));

async function until(predicate) {
  if (predicate()) return;
  let timer;
  let listener;
  try {
    await new Promise((resolve, reject) => {
      listener = () => { if (predicate()) resolve(); };
      listeners.add(listener);
      timer = setTimeout(() => reject(new Error('Deferred completion did not arrive')), 10000);
    });
  } finally { clearTimeout(timer); listeners.delete(listener); }
}

async function dispatch(interaction) {
  const body = JSON.stringify({ application_id: '1417570023370653836', guild_id: 'guild', channel_id: 'channel', ...interaction });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  const response = await runtime.dispatchFetch('https://worker.test/interactions', { method: 'POST',
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp }, body });
  assert.equal(response.status, 200);
  return response.json();
}

const messageEdits = () => events.filter((event) => event.method === 'PATCH' && event.url.includes('/channels/'));
try {
  const health = await runtime.dispatchFetch('https://worker.test/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const db = await runtime.getD1Database('DB');
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const sql of schema.split(';').map((sql) => sql.trim()).filter(Boolean)) await db.prepare(sql).run();
  assert.deepEqual(await dispatch({ id: '100000', type: 1 }), { type: 1 });
  const invalid = await runtime.dispatchFetch('https://worker.test/interactions', {
    method: 'POST', headers: { 'X-Signature-Ed25519': '00'.repeat(64),
      'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000)) }, body: JSON.stringify({ type: 1 })
  });
  assert.equal(invalid.status, 401);
  const aura = { id: '100001', token: 'runtime-aura', type: 2, member: { user: { id: 'proposer' } }, data: { name: 'aura', options: [
    { name: 'usuario', value: 'target' }, { name: 'puntos', value: 100 }, { name: 'motivo', value: 'Runtime deferred' }
  ] } };
  assert.deepEqual(await dispatch(aura), { type: 5 });
  await until(() => messageEdits().length >= 1);
  const original = events.find((event) => event.url.includes('/webhooks/') && event.method === 'PATCH');
  assert.deepEqual(original.body.components, []);
  assert.notDeepEqual(messageEdits().at(-1).body.components, []);
  assert.deepEqual(await dispatch(aura), { type: 5 });
  await until(() => messageEdits().length >= 2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM proposals').first()).n, 1);
  const vote = { id: '100002', token: 'runtime-vote', type: 3, member: { user: { id: 'voter' }, roles: ['1431791263547392121'] },
    data: { custom_id: 'aura:yes:100001' }, message: { id: '999123' } };
  assert.deepEqual(await dispatch(vote), { type: 6 });
  await until(() => messageEdits().length >= 3);
  assert.deepEqual(await dispatch({ ...vote, id: '100003', token: 'runtime-changed', member: { user: { id: 'voter' }, roles: [] },
    data: { custom_id: 'aura:no:100001' } }), { type: 6 });
  await until(() => messageEdits().length >= 4);
  assert.deepEqual(await dispatch(vote), { type: 6 });
  await until(() => messageEdits().length >= 5);
  assert.equal((await db.prepare('SELECT choice FROM votes').first()).choice, 'no');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM role_votes').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM vote_interactions').first()).n, 2);
  const beforeCancel = messageEdits().length;
  assert.deepEqual(await dispatch({ id: '100005', token: 'runtime-cancel', type: 3,
    member: { user: { id: 'proposer' } }, data: { custom_id: 'aura:cancel:100001' }, message: { id: '999123' } }), { type: 6 });
  await until(() => messageEdits().length > beforeCancel);
  assert.equal((await db.prepare('SELECT status FROM proposals').first()).status, 'cancelled');
  assert.match(messageEdits().at(-1).body.embeds[0].fields[2].value, /Cancelada/);
  assert.deepEqual(messageEdits().at(-1).body.components, []);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM proposal_notifications').first()).n, 0);
  const approval = { ...aura, id: '100010', token: 'runtime-approval' };
  assert.deepEqual(await dispatch(approval), { type: 5 });
  await until(() => messageEdits().some((event) => event.body.components[0]?.components[0]?.custom_id === 'aura:yes:100010'));
  for (let i = 0; i < 4; i++) {
    const previous = messageEdits().length;
    assert.deepEqual(await dispatch({ id: String(100011 + i), token: `runtime-role-${i}`, type: 3,
      member: { user: { id: `role-${i}` }, roles: ['1431791263547392121'] },
      data: { custom_id: 'aura:yes:100010' }, message: { id: '999123' } }), { type: 6 });
    await until(() => messageEdits().length > previous);
  }
  assert.equal((await db.prepare('SELECT status FROM proposals WHERE id = ?').bind('100010').first()).status, 'approved');
  assert.deepEqual(messageEdits().at(-1).body.components, []);
  assert.equal(messageEdits().at(-1).body.embeds[0].fields[0].value, '👍 4 · 👎 0');
  assert.equal(messageEdits().at(-1).body.embeds[0].fields[1].value, '👍 4 · 👎 0');
  assert.deepEqual(await dispatch({ id: '100020', token: 'runtime-profile', type: 2,
    member: { user: { id: 'target' } }, data: { name: 'perfil' } }), { type: 5 });
  await until(() => events.some((event) => event.url.includes('runtime-profile') && event.body?.embeds?.[0]?.description.includes('100 puntos')));
  const profile = events.find((event) => event.url.includes('runtime-profile')).body;
  assert.equal(profile.embeds[0].fields.find((field) => field.name.includes('rechazadas')).value, '0');
  assert.equal(profile.embeds[0].fields.find((field) => field.name.includes('registrados')).value, '0');
  assert.match(profile.embeds[0].fields.find((field) => field.name.includes('Evolución')).value, /\+100 → \*\*100\*\* puntos/);
  assert.deepEqual(await dispatch({ id: '100021', token: 'runtime-ranking', type: 2,
    member: { user: { id: 'target' } }, data: { name: 'ranking' } }), { type: 5 });
  await until(() => events.some((event) => event.url.includes('runtime-ranking') && event.body?.embeds?.[0]?.title.includes('Ranking')));
  const ranking = events.find((event) => event.url.includes('runtime-ranking')).body;
  assert.equal(ranking.embeds[0].description, '**1.** <@target> · **100** puntos');
  assert.deepEqual(ranking.allowed_mentions, { parse: [] });
  assert.deepEqual(await dispatch({ id: '100023', token: 'runtime-votaciones', type: 2,
    member: { user: { id: 'target' } }, data: { name: 'votaciones' } }), { type: 5 });
  await until(() => events.some((event) => event.url.includes('runtime-votaciones') && event.body?.embeds?.[0]?.title.includes('votaciones')));
  const votingHistory = events.find((event) => event.url.includes('runtime-votaciones')).body;
  assert.match(votingHistory.embeds[0].description, /Cancelada/);
  assert.match(votingHistory.embeds[0].description, /Aprobada/);
  assert.match(votingHistory.embeds[0].footer.text, /2 propuestas/);
  assert.deepEqual(votingHistory.allowed_mentions, { parse: [] });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM proposals').first()).n, 2);
  const info = await dispatch({ id: '100022', token: 'runtime-info', type: 2, data: { name: 'info' } });
  assert.ok(info.data.embeds[0].fields.some((field) => field.name.includes('/ranking')));
  assert.ok(info.data.embeds[0].fields.some((field) => field.name.includes('/votaciones')));
  assert.ok(events.some((event) => event.url.includes('/applications/') && event.method === 'PUT' && event.body.some((command) => command.name === 'ranking')));
  const concurrent = { ...aura, data: { ...aura.data, options: aura.data.options.map((option) => option.name === 'motivo' ? { ...option, value: 'Concurrent duplicate' } : option) } };
  const parallel = await Promise.all([
    dispatch({ ...concurrent, id: '100030', token: 'runtime-duplicate-a' }),
    dispatch({ ...concurrent, id: '100031', token: 'runtime-duplicate-b' })
  ]);
  assert.deepEqual(parallel, [{ type: 5 }, { type: 5 }]);
  await until(() => events.some((event) => event.url.includes('runtime-duplicate-') && event.body?.content?.includes('Ya hay una votación abierta')));
  await until(() => messageEdits().some((event) => event.body.embeds[0].description.includes('Concurrent duplicate')));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE reason = ?').bind('Concurrent duplicate').first()).n, 1);
  await db.prepare('DROP TABLE proposals').run();
  assert.deepEqual(await dispatch({ id: '100004', token: 'runtime-failed', type: 2, member: { user: { id: 'voter' } }, data: { name: 'perfil' } }), { type: 5 });
  await until(() => events.some((event) => event.url.includes('runtime-failed') && event.body?.content?.includes('No pude consultar')));
  console.log('PASS: workerd verifies signed PING, rejects invalid signatures, runs proposal/voting/profile/ranking/votaciones on D1 and Durable Objects, and handles concurrent duplicate creation, retries, cancellation and D1 failure. Discord mocked; no remote requests.');
} finally { await runtime.dispose(); }
