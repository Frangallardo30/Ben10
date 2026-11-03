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
  const db = await runtime.getD1Database('DB');
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const sql of schema.split(';').map((sql) => sql.trim()).filter(Boolean)) await db.prepare(sql).run();
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
  await db.prepare('DROP TABLE proposals').run();
  assert.deepEqual(await dispatch({ id: '100004', token: 'runtime-failed', type: 2, member: { user: { id: 'voter' } }, data: { name: 'perfil' } }), { type: 5 });
  await until(() => events.some((event) => event.url.includes('runtime-failed') && event.body?.content?.includes('No pude consultar')));
  console.log('PASS: workerd defers commands/buttons, completes webhooks, deduplicates proposals/votes, cancels only an open proposal and reports D1 failure. Discord mocked; no remote requests.');
} finally { await runtime.dispose(); }
