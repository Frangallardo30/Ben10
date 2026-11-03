export function isAdministrator(interaction) {
  try {
    const permissions = BigInt(interaction.member?.permissions ?? '0');
    return Boolean(interaction.guild_id && interaction.member?.user?.id && permissions >= 0n && permissions & 8n);
  } catch { return false; }
}
