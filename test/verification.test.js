import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { verified } from '../src/index.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function signedRequest(body, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  return new Request('https://ben10.test/interactions', {
    method: 'POST',
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    body
  });
}

test('acepta una interacción de Discord con firma válida', async () => {
  assert.deepEqual(await verified(signedRequest('{"type":1}'), publicHex), { type: 1 });
});

test('rechaza un cuerpo modificado y una firma vieja', async () => {
  const request = signedRequest('{"type":1}');
  const headers = new Headers(request.headers);
  assert.equal(await verified(new Request(request.url, { method: 'POST', headers, body: '{"type":2}' }), publicHex), null);
  assert.equal(await verified(signedRequest('{"type":1}', String(Math.floor(Date.now() / 1000) - 3600)), publicHex), null);
});
