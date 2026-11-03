import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
    import { migrateProposalDates, historyDateExpression } from './src/proposal-dates.js';
    export default { async fetch(request, env) {
      if (request.method === 'POST') await migrateProposalDates(env.DB);
      const date = await historyDateExpression(env.DB);
      const rows = await env.DB.prepare('SELECT id, ' + date + ' AS created_at FROM proposals ORDER BY created_at DESC, id DESC').all();
      return Response.json(rows.results);
    } };
  ` },
  bundle: true, write: false, format: 'esm', platform: 'browser'
});
const runtime = new Miniflare(convertV4MiniflareOptions({ workers: ['first', 'second'].map((name) => ({
  name, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-06-01',
  d1Databases: { DB: 'shared-dates-test' }, outboundService: () => { throw new Error('No remote requests allowed'); }
})) }));
try {
  const db = await runtime.getD1Database('DB', 'first');
  const schema = (await readFile(new URL('../schema.sql', import.meta.url), 'utf8')).replace('  created_at INTEGER,\n', '');
  for (const sql of schema.split(';').map((sql) => sql.trim()).filter((sql) => sql && !sql.includes('proposals_history'))) await db.prepare(sql).run();
  for (const [id, date] of [['older', 100], ['tie-a', 200], ['tie-b', 200]]) {
    await db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, 'guild', 'channel', 'target', 'creator', 100, id, date + 86400, 'approved').run();
  }
  const first = await runtime.getWorker('first');
  const second = await runtime.getWorker('second');
  const before = await (await first.fetch('https://local.test/')).json();
  assert.deepEqual(before, [{ id: 'tie-b', created_at: 200 }, { id: 'tie-a', created_at: 200 }, { id: 'older', created_at: 100 }]);
  const responses = await Promise.all([first.fetch('https://local.test/', { method: 'POST' }), second.fetch('https://local.test/', { method: 'POST' })]);
  for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), before); }
  assert.deepEqual(await (await second.fetch('https://local.test/', { method: 'POST' })).json(), before);
  await db.prepare('UPDATE proposals SET expires_at = 1').run();
  assert.deepEqual(await (await first.fetch('https://local.test/')).json(), before);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM proposals').first()).n, 3);
  console.log('PASS: two workerd instances migrate legacy D1 safely; dates and history order survive retries and expiry changes. Local fixture only; no production access.');
} finally { await runtime.dispose(); }
