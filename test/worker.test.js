import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../src/index.js';
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
  const response = await worker.fetch(new Request('https://ben10.test/interactions', {
    method: 'POST',
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    body
  }), env, { waitUntil() {} });
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
