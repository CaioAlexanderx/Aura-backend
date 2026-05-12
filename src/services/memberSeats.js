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
//
// 12/05/2026: seatsIncluded e summarizeSeats agora aceitam um
// numero opcional `extraSeats` (default 0). Gestao Aura passa
// companies.extra_seats_granted pra incluir os seats pagos
// manualmente. Sem isso, cliente que pagou R$19 ficava barrado
// no convite porque o plano hardcoded nao previa override.
// ============================================================

const SEATS_PER_PLAN = {
  essencial:     1,
  negocio:       3,
  expansao:      5,
  personalizado: 999,
};

const SEAT_PRICE_BRL = 19;

function seatsIncluded(plan, extraSeats = 0) {
  const key = String(plan || 'essencial').toLowerCase();
  const base = SEATS_PER_PLAN[key] ?? SEATS_PER_PLAN.essencial;
  const extra = Number.isFinite(extraSeats) && extraSeats > 0 ? Math.floor(extraSeats) : 0;
  return base + extra;
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
//
// 12/05/2026: argumento adicional `extraSeats` (default 0) — Gestao Aura
// passa companies.extra_seats_granted pra empresa atual.
function summarizeSeats(plan, unifiedMembers, extraSeats = 0) {
  const included = seatsIncluded(plan, extraSeats);
  const baseFromPlan = seatsIncluded(plan, 0);
  const used     = countSeatsUsed(unifiedMembers);
  // "extras" agora reflete o que EXCEDE o limite total (plano + extras
  // ja contratados). O monthly_cost reflete o que esta sendo cobrado.
  // Os extras ja contratados (extra_seats_granted) entram em
  // extra_seats_granted_count separadamente pra UI exibir.
  const overLimit = Math.max(used - included, 0);
  const granted = Math.max(extraSeats || 0, 0);
  // Cobranca mensal = todos os seats acima do plano base (granted +
  // qualquer excesso nao formalizado, se houver). Padrao: cobramos
  // por TODOS os granted, independente de uso (modelo contratado).
  const monthly  = (granted + overLimit) * SEAT_PRICE_BRL;
  return {
    plan:                 String(plan || 'essencial').toLowerCase(),
    seats_included:       included,
    seats_used:           used,
    seats_remaining:      Math.max(included - used, 0),
    // Compat: continua existindo, mas agora reflete EXCESSO acima do total.
    extra_seats:          overLimit,
    // Novo: quantos seats extras o admin liberou manualmente.
    extra_seats_granted:  granted,
    extra_seat_price:     SEAT_PRICE_BRL,
    monthly_cost:         monthly,
    at_limit:             used >= included,
    over_limit:           used > included,
  };
}

module.exports = {
  SEATS_PER_PLAN,
  SEAT_PRICE_BRL,
  seatsIncluded,
  countSeatsUsed,
  summarizeSeats,
};
