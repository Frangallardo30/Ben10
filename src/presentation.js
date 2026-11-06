import { AURA_VOTER_ROLE_ID, VOTES_TO_CLOSE, VOTES_TO_OVERRIDE } from './voting.js';

const label = (amount) => `${amount > 0 ? '+' : ''}${amount}`;

export function display(proposal, votes) {
  if (proposal.status === 'voided') return {
    allowed_mentions: { parse: [] }, embeds: [{ title: '⛔ Propuesta anulada',
      description: 'Esta propuesta fue retirada del historial visible. Sus puntos no cuentan para el aura.',
      color: 0x747f8d }], components: []
  };
  if (proposal.administrative) return {
    allowed_mentions: { parse: [] }, embeds: [{ title: `🛠️ Ajuste administrativo: ${label(proposal.amount)}`,
      description: `<@${proposal.target_id}> · Ajuste aplicado por administración, sin votación.`,
      color: 0x747f8d, fields: [{ name: 'Estado', value: 'Aplicado' }] }], components: []
  };
  const viewVotes = { type: 2, style: 2, label: 'Ver votos', custom_id: `ballot:${proposal.id}:1` };
  const closed = proposal.status !== 'open';
  const normal = proposal.votes_to_close ?? VOTES_TO_CLOSE;
  const override = proposal.votes_to_override ?? VOTES_TO_OVERRIDE;
  const role = proposal.voter_role_id ?? AURA_VOTER_ROLE_ID;
  let result = proposal.status === 'approved' ? '✅ Aprobada' : proposal.status === 'expired' ? '⌛ Vencida sin cambiar el aura' : proposal.status === 'cancelled' ? '⚪ Cancelada sin cambiar el aura' : '❌ Rechazada';
  if (proposal.status === 'approved' || proposal.status === 'rejected') {
    const approved = proposal.status === 'approved';
    const roleVotes = approved ? votes.roleYes : votes.roleNo;
    const total = approved ? votes.yes : votes.no;
    const opposingTotal = approved ? votes.no : votes.yes;
    const direction = approved ? 'a favor' : 'en contra';
    if (roleVotes >= override) {
      result += `\nRegla de ${override} votos del rol ${direction}: decide incluso si va perdiendo en el total general.`;
    } else if (roleVotes >= normal && total >= opposingTotal) {
      result += `\nRegla de ${normal} votos del rol ${direction}: ${total === opposingTotal ? 'empata' : 'lidera'} en el total general.`;
    }
  }
  if (!closed) {
    if (votes.roleYes >= normal && votes.yes < votes.no) {
      result = `👍 del rol va perdiendo: necesita ${override - votes.roleYes} voto(s) más del rol`;
    } else if (votes.roleNo >= normal && votes.no < votes.yes) {
      result = `👎 del rol va perdiendo: necesita ${override - votes.roleNo} voto(s) más del rol`;
    } else {
      result = `Abierta: ${normal} del rol si empata o lidera; ${override} si va perdiendo`;
    }
  }
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Propuesta de aura: ${label(proposal.amount)}`,
      description: `<@${proposal.target_id}>: ${proposal.reason}\n\n🗳️ Todos pueden votar. El rol <@&${role}> puede cerrar la votación.`,
      color: closed ? (proposal.status === 'approved' ? 0x21a675 : proposal.status === 'cancelled' ? 0x747f8d : 0xc84a4a) : 0x5785f2,
      fields: [
        { name: 'Todos los votos', value: `👍 ${votes.yes} · 👎 ${votes.no}`, inline: true },
        { name: 'Votos del rol', value: `👍 ${votes.roleYes} · 👎 ${votes.roleNo}`, inline: true },
        { name: 'Estado', value: closed ? result : `${result}\nVence <t:${proposal.expires_at}:R>.`, inline: false }
      ],
      footer: { text: 'Una persona, un voto. Quien propone y quien recibe no votan.' }
    }],
    components: [{ type: 1, components: closed ? [viewVotes] : [
      { type: 2, style: 3, label: 'Aprobar', emoji: { name: '👍' }, custom_id: `aura:yes:${proposal.id}` },
      { type: 2, style: 4, label: 'Desaprobar', emoji: { name: '👎' }, custom_id: `aura:no:${proposal.id}` },
      { type: 2, style: 2, label: 'Cancelar propuesta', custom_id: `aura:cancel:${proposal.id}` },
      viewVotes
    ] }]
  };
}

