// ============================================================
// AURA. — Member seats por plano
// Define quantos acessos sao inclusos no plano antes de cobrar.
// O titular conta como 1 acesso. Convites pendentes contam como
// acesso (reservam vaga). Multi-CNPJ: contagem e por usuario unico,
// nao por entrada — mesmo usuario em 3 CNPJs = 1 acesso.
//
// Plano:
//   Essencial   = 1 acesso (so o titular, sem equipe)
//   Negocio     = 3 acessos (titular + 2)
//   Expansao    = 5 acessos (titular + 4)
//   Personalizado = ilimitado (999 na pratica)
//
// Acima do limite cobramos R$19/mes por acesso adicional.
// ============================================================

const SEATS_PER_PLAN = {
  essencial:     1,
  negocio:       3,
  expansao:      5,
  personalizado: 999,
};

const SEAT_PRICE_BRL = 19;

function seatsIncluded(plan) {
  const key = String(plan || 'essencial').toLowerCase();
  return SEATS_PER_PLAN[key] ?? SEATS_PER_PLAN.essencial;
}

// Conta acessos efetivos: membros ativos + convites pendentes, sem duplicar
// o mesmo usuario que aparece em multiplos CNPJs irmaos.
// Recebe a lista ja unificada (listMembersUnified retorna 1 entrada por user).
function countSeatsUsed(unifiedMembers) {
  if (!Array.isArray(unifiedMembers)) return 0;
  return unifiedMembers.filter(m =>
    (m.status === 'active' && m.is_active) || m.status === 'pending'
  ).length;
}

// Resumo pra UI: quantos sao inclusos, quantos foram usados, quantos
// extras (cobrados), valor mensal, e flag at_limit.
function summarizeSeats(plan, unifiedMembers) {
  const included = seatsIncluded(plan);
  const used     = countSeatsUsed(unifiedMembers);
  const extra    = Math.max(used - included, 0);
  const monthly  = extra * SEAT_PRICE_BRL;
  return {
    plan:                String(plan || 'essencial').toLowerCase(),
    seats_included:      included,
    seats_used:          used,
    seats_remaining:     Math.max(included - used, 0),
    extra_seats:         extra,
    extra_seat_price:    SEAT_PRICE_BRL,
    monthly_cost:        monthly,
    at_limit:            used >= included,
    over_limit:          used > included,
  };
}

module.exports = {
  SEATS_PER_PLAN,
  SEAT_PRICE_BRL,
  seatsIncluded,
  countSeatsUsed,
  summarizeSeats,
};
