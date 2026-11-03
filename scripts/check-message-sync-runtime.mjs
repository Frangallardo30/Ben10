import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { QUEUE_MESSAGE_SYNC_SQL } from '../src/message-sync.js';
import { CLOSE_PROPOSAL_SQL, UPSERT_ROLE_VOTE_SQL, UPSERT_VOTE_SQL } from '../src/voting.js';

// Use the runtime bundled with the lockfile's Wrangler, without downloading tools.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Response, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser'
});
let startFirst;
let releaseFirst;
const started = new Promise((resolve) => { startFirst = resolve; });
const released = new Promise((resolve) => { releaseFirst = resolve; });
const edits = [];
let active = 0;
let maxActive = 0;
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2025-06-01',
  d1Databases: ['DB'],
  durableObjects: { MESSAGE_SYNC: { className: 'ProposalMessageSync', useSQLite: true } },
  bindings: { DISCORD_BOT_TOKEN: 'local-test-only' },
  outboundService: async (request) => {
    assert.equal(request.method, 'PATCH');
    assert.equal(new URL(request.url).hostname, 'discord.com');
    active++;
    maxActive = Math.max(maxActive, active);
    const body = await request.json();
    if (edits.length === 0) {
      startFirst();
      await released;
    }
    edits.push(body);
    active--;
    return Response.json({ id: '123' });
  }
}));
try {
  const db = await runtime.getD1Database('DB');
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const sql of schema.split(';').map((sql) => sql.trim()).filter(Boolean)) await db.prepare(sql).run();
  await db.prepare('INSERT INTO proposals(id, guild_id, channel_id, message_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('proposal', 'guild', 'channel', '123', 'target', 'proposer', 100, 'Runtime concurrency', Math.floor(Date.now() / 1000) + 3600).run();
  for (let i = 0; i < 3; i++) {
    await db.prepare('INSERT INTO votes VALUES (?, ?, ?)').bind('proposal', `voter-${i}`, 'yes').run();
    await db.prepare('INSERT INTO role_votes VALUES (?, ?, ?)').bind('proposal', `voter-${i}`, 'yes').run();
  }
  await db.prepare(QUEUE_MESSAGE_SYNC_SQL).bind('proposal').run();
  const namespace = await runtime.getDurableObjectNamespace('MESSAGE_SYNC');
  const stub = namespace.get(namespace.idFromName('proposal'));
  const synchronize = () => stub.fetch('https://message-sync.internal/', { method: 'POST', body: JSON.stringify({ id: 'proposal' }) });
  const oldEdit = synchronize();
  await Promise.race([started, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('First PATCH did not start')), 10000);
    timer.unref();
  })]);
  const decisiveVote = () => db.batch([
    db.prepare(UPSERT_VOTE_SQL).bind('proposal', 'last', 'yes', 'proposal', null),
    db.prepare(UPSERT_ROLE_VOTE_SQL).bind('proposal', 'last', 'yes', 'proposal', null),
    db.prepare(CLOSE_PROPOSAL_SQL).bind('proposal', 'proposal', 'proposal', 'proposal', 'proposal'),
    db.prepare(QUEUE_MESSAGE_SYNC_SQL).bind('proposal')
  ]);
  await Promise.all([decisiveVote(), decisiveVote()]);
  const persisted = await db.prepare('SELECT COUNT(*) AS n FROM votes WHERE proposal_id = ?').bind('proposal').first();
  assert.equal(persisted.n, 4);
  const newEdit = synchronize();
  releaseFirst();
  const results = await Promise.all([newEdit, oldEdit]);
  for (const response of results) assert.equal(response.status, 200);
  assert.equal(maxActive, 1);
  assert.equal(edits.length, 2);
  assert.notDeepEqual(edits[0].components, []);
  assert.deepEqual(edits[1].components, []);
  assert.equal(edits[1].embeds[0].fields[0].value, '👍 4 · 👎 0');
  assert.match(edits[1].embeds[0].fields[2].value, /Aprobada/);
  const state = await db.prepare('SELECT revision, synced_revision FROM proposal_message_sync').first();
  assert.equal(state.revision, state.synced_revision);
  console.log('PASS: workerd + D1 + Durable Object serialize delayed edits and preserve the final closure. Discord mocked; no remote requests.');
} finally {
  releaseFirst();
  await runtime.dispose();
}
