import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalD1 } from '../test-support/local-d1.js';
import { channelPermissions, canManageGuild, migrateGuildConfig, validateChannel } from '../src/guild-config.js';

const required = 1024n | 2048n | 16384n;
test('los permisos de canal respetan everyone, roles y sobrescritura personal', () => {
  const roles = [{ id: 'guild', permissions: String(required) }, { id: 'bot-role', permissions: '0' }];
  const member = { roles: ['bot-role'] };
  const channel = { permission_overwrites: [
    { type: 0, id: 'guild', deny: '2048', allow: '0' },
    { type: 0, id: 'bot-role', deny: '0', allow: '2048' }
  ] };
  assert.equal(channelPermissions('guild', channel, roles, member, 'bot') & required, required);
  channel.permission_overwrites.push({ type: 1, id: 'bot', deny: '1024', allow: '0' });
  assert.equal(channelPermissions('guild', channel, roles, member, 'bot') & 1024n, 0n);
  assert.ok(channelPermissions('guild', channel, [{ id: 'guild', permissions: '8' }], member, 'bot') & 8n);
});

test('solo Administrar servidor o Administrador autorizan cambios, nunca permisos malformados o DM', () => {
  for (const permissions of ['32', '8']) assert.equal(canManageGuild({ guild_id: 'guild', member: { permissions } }), true);
  for (const permissions of ['0', '16', '-1', 'invalid']) assert.equal(canManageGuild({ guild_id: 'guild', member: { permissions } }), false);
  assert.equal(canManageGuild({ member: { permissions: '32' } }), false);
});

test('la migración conserva reglas heredadas una vez sin configurar servidores futuros', async () => {
  const DB = new LocalD1();
  try {
    DB.db.exec('DROP TABLE proposal_rules; DROP TABLE guild_config_attempts; DROP TABLE guild_config');
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy', 'old-guild', 'old-channel', 'target', 'creator', 100, 'Old', 9999999999);
    await migrateGuildConfig(DB);
    assert.equal(DB.db.prepare("SELECT voter_role_id FROM guild_config WHERE guild_id = 'old-guild'").get().voter_role_id, '1431791263547392121');
    assert.equal(DB.db.prepare("SELECT votes_to_close FROM proposal_rules WHERE proposal_id = 'legacy'").get().votes_to_close, 4);
    DB.db.exec("UPDATE guild_config SET voter_role_id = 'new-role', votes_to_close = 2, votes_to_override = 3 WHERE guild_id = 'old-guild'");
    DB.db.prepare('INSERT INTO proposals(id, guild_id, channel_id, target_id, proposer_id, amount, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('later', 'future-guild', 'channel', 'target', 'creator', 100, 'Later', 9999999999);
    await migrateGuildConfig({ prepare: DB.prepare.bind(DB), batch: DB.batch.bind(DB) });
    assert.equal(DB.db.prepare("SELECT voter_role_id FROM guild_config WHERE guild_id = 'old-guild'").get().voter_role_id, 'new-role');
    assert.equal(DB.db.prepare("SELECT voter_role_id FROM proposal_rules WHERE proposal_id = 'legacy'").get().voter_role_id, '1431791263547392121');
    assert.equal(DB.db.prepare("SELECT * FROM guild_config WHERE guild_id = 'future-guild'").get(), undefined);
  } finally { DB.close(); }
});


test('un canal ajeno o un hilo se rechazan sin consultar miembros ni guardar configuración', async (t) => {
  let channel = { guild_id: 'other-guild', type: 0 };
  let memberCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/channels/')) return Response.json(channel);
    if (url.endsWith('/roles')) return Response.json([{ id: 'guild', permissions: '19456' }]);
    if (url.endsWith('/users/@me')) return Response.json({ id: 'bot' });
    memberCalls++;
    return Response.json({ roles: [] });
  });
  assert.equal(await validateChannel({ DISCORD_BOT_TOKEN: 'test-only' }, 'guild', 'channel'), false);
  channel = { guild_id: 'guild', type: 11 };
  assert.equal(await validateChannel({ DISCORD_BOT_TOKEN: 'test-only' }, 'guild', 'thread'), false);
  assert.equal(memberCalls, 0);
});
