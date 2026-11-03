import { AURA_VOTER_ROLE_ID, VOTES_TO_CLOSE, VOTES_TO_OVERRIDE } from './voting.js';

const label = (amount) => `${amount > 0 ? '+' : ''}${amount}`;

export function display(proposal, votes) {
  const closed = proposal.status !== 'open';
  let result = proposal.status === 'approved' ? '✅ Aprobada' : proposal.status === 'expired' ? '⌛ Vencida sin cambiar el aura' : '❌ Rechazada';
  if (proposal.status === 'approved' || proposal.status === 'rejected') {
    const approved = proposal.status === 'approved';
    const roleVotes = approved ? votes.roleYes : votes.roleNo;
    const total = approved ? votes.yes : votes.no;
    const opposingTotal = approved ? votes.no : votes.yes;
    const direction = approved ? 'a favor' : 'en contra';
    if (roleVotes >= VOTES_TO_OVERRIDE) {
      result += `\nRegla de ${VOTES_TO_OVERRIDE} votos del rol ${direction}: decide incluso si va perdiendo en el total general.`;
    } else if (roleVotes >= VOTES_TO_CLOSE && total >= opposingTotal) {
      result += `\nRegla de ${VOTES_TO_CLOSE} votos del rol ${direction}: ${total === opposingTotal ? 'empata' : 'lidera'} en el total general.`;
    }
  }
  if (!closed) {
    if (votes.roleYes >= VOTES_TO_CLOSE && votes.yes < votes.no) {
      result = `👍 del rol va perdiendo: necesita ${VOTES_TO_OVERRIDE - votes.roleYes} voto(s) más del rol`;
    } else if (votes.roleNo >= VOTES_TO_CLOSE && votes.no < votes.yes) {
      result = `👎 del rol va perdiendo: necesita ${VOTES_TO_OVERRIDE - votes.roleNo} voto(s) más del rol`;
    } else {
      result = 'Abierta: 4 del rol si empata o lidera; 6 si va perdiendo';
    }
  }
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Propuesta de aura: ${label(proposal.amount)}`,
      description: `<@${proposal.target_id}>: ${proposal.reason}\n\n🗳️ Todos pueden votar. El rol <@&${AURA_VOTER_ROLE_ID}> puede cerrar la votación.`,
      color: closed ? (proposal.status === 'approved' ? 0x21a675 : 0xc84a4a) : 0x5785f2,
      fields: [
        { name: 'Todos los votos', value: `👍 ${votes.yes} · 👎 ${votes.no}`, inline: true },
        { name: 'Votos del rol', value: `👍 ${votes.roleYes} · 👎 ${votes.roleNo}`, inline: true },
        { name: 'Estado', value: closed ? result : `${result}\nVence <t:${proposal.expires_at}:R>.`, inline: false }
      ],
      footer: { text: 'Una persona, un voto. Quien propone y quien recibe no votan.' }
    }],
    components: closed ? [] : [{ type: 1, components: [
      { type: 2, style: 3, label: 'Aprobar', emoji: { name: '👍' }, custom_id: `aura:yes:${proposal.id}` },
      { type: 2, style: 4, label: 'Desaprobar', emoji: { name: '👎' }, custom_id: `aura:no:${proposal.id}` }
    ] }]
  };
}

