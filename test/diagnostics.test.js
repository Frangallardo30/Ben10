import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import worker, { verified } from '../src/index.js';
import { commands } from '../src/commands.js';
import { OperationalError, reportFailure } from '../src/diagnostics.js';
import { editDeferred } from '../src/deferred.js';
import { LocalD1 } from '../test-support/local-d1.js';

const secret = 'test-secret-that-must-not-be-logged';
const reason = 'private-proposal-reason';
function capture(t) {
  const records = [];
  for (const level of ['warn', 'info', 'error']) t.mock.method(console, level, (...args) => {
    assert.equal(args.length, 1);
    records.push(JSON.parse(args[0]));
  });
  t.after(() => {
    assert.doesNotMatch(JSON.stringify(records), new RegExp(`${secret}|${reason}`));
    for (const record of records) assert.ok(['worker', 'd1', 'discord', 'validation', 'config'].includes(record.area));
  });
  return records;
}

test('health solo publica liveness y no consulta ni revela la configuración', async () => {
  const response = await worker.fetch(new Request('https://worker.test/health'), {
    DB: { prepare() { throw new Error('Health must not access D1'); } },
    DISCORD_BOT_TOKEN: secret, DISCORD_PUBLIC_KEY: secret, DISCORD_APPLICATION_ID: secret
  }, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('el fallo de preparación D1 queda identificado sin SQL, error crudo ni nombre controlado', async (t) => {
  const records = capture(t);
  const raw = new Error(`${secret} SELECT ${reason}`);
  raw.name = secret;
  await worker.scheduled({}, { DB: { prepare() { throw raw; } } });
  assert.ok(records.some((record) => record.event === 'DATABASE_PREPARATION_FAILED' && record.area === 'd1' && record.code === 'D1_FAILURE'));
});

test('el fallo HTTP del registro se distingue de D1 sin publicar el cuerpo de Discord', async (t) => {
  const records = capture(t);
  const DB = new LocalD1();
  t.mock.method(globalThis, 'fetch', async () => new Response(`${secret} ${reason}`, { status: 403 }));
  try {
    await worker.scheduled({}, { DB, DISCORD_BOT_TOKEN: secret, DISCORD_APPLICATION_ID: 'application' });
    assert.ok(records.some((record) => record.event === 'COMMANDS_SYNC_FAILED' && record.area === 'discord' && record.code === 'DISCORD_COMMAND_REGISTER_FAILED' && record.status === 403));
  } finally { DB.close(); }
});

test('un fallo de transporte de Discord no imprime URL, token ni error original', async (t) => {
  const records = capture(t);
  const DB = new LocalD1();
  t.mock.method(globalThis, 'fetch', async () => {
    const error = new Error(`https://discord.com/webhooks/${secret} ${reason}`);
    error.name = secret;
    throw error;
  });
  try {
    await worker.scheduled({}, { DB, DISCORD_BOT_TOKEN: secret });
    assert.ok(records.some((record) => record.area === 'discord' && record.code === 'DISCORD_NETWORK_FAILURE'));
  } finally { DB.close(); }
});

test('registro nuevo, comandos actuales y token ausente dejan resultados operativos distintos', async (t) => {
  const records = capture(t);
  const DB = new LocalD1();
  t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json(options.method === 'GET' ? commands : []));
  try {
    const env = { DB, DISCORD_BOT_TOKEN: secret, DISCORD_APPLICATION_ID: 'application' };
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    await worker.scheduled({}, { DB });
    for (const event of ['COMMANDS_REGISTERED', 'COMMANDS_CURRENT', 'COMMANDS_TOKEN_MISSING']) {
      assert.ok(records.some((record) => record.event === event), event);
    }
  } finally { DB.close(); }
});

test('las firmas faltantes o inválidas tienen códigos de validación sin registrar el cuerpo', async (t) => {
  const records = capture(t);
  assert.equal(await verified(new Request('https://worker.test/interactions', { method: 'POST', body: reason }), secret), null);
  const { publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  assert.equal(await verified(new Request('https://worker.test/interactions', {
    method: 'POST', headers: { 'X-Signature-Ed25519': '00'.repeat(64), 'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000)) }, body: reason
  }), key), null);
  for (const event of ['SIGNATURE_DATA_MISSING', 'SIGNATURE_INVALID']) assert.ok(records.some((record) => record.event === event && record.area === 'validation'));
});

test('los fallos del webhook y de JSON conservan códigos seguros y no el token de interacción', async (t) => {
  const records = capture(t);
  const interaction = { application_id: 'application', token: secret };
  let invalidJSON = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(reason, { status: invalidJSON ? 200 : 401 }));
  await assert.rejects(editDeferred(interaction, {}, { content: reason }), (error) => {
    assert.ok(error instanceof OperationalError);
    assert.equal(error.status, 401);
    reportFailure('INTERACTION_ERROR_DELIVERY_FAILED', error);
    return true;
  });
  invalidJSON = true;
  await assert.rejects(editDeferred(interaction, {}, { content: reason }), (error) => {
    assert.equal(error.code, 'DISCORD_RESPONSE_INVALID');
    reportFailure('INTERACTION_ERROR_DELIVERY_FAILED', error);
    return true;
  });
  assert.equal(records.length, 2);
});
