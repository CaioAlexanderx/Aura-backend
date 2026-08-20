// ============================================================
// AURA KARATÊ — P0 Hub de Campeonatos: engine de PRECIFICAÇÃO da delegação
//
// PURA, sem DB — mesma filosofia de karateBracket.js: toda regra de
// dinheiro do carrinho da delegação vive aqui, unit-testável, e a rota
// só orquestra. A cotação devolvida é SNAPSHOT-ável (vai para
// karate_delegation_orders.quote como o dojô viu e aceitou).
//
// MODELO (karate_competitions.pricing_config, migration 294) — derivado
// dos regulamentos reais (Dossiê Shiai):
//
//   {
//     "individual": {
//       "mode": "per_athlete" | "per_entry",     // default per_entry
//       "bands": [                                // avaliadas NA ORDEM
//         { "max_age": 14, "amount": 150 },       // idade na DATA DO EVENTO
//         { "amount": 180 }                       // banda final sem teto
//       ]
//     },
//     "team": { "per_prova": 125, "bundle_both": 250 },
//     "exemptions": { "officials_per_exemption": 2, "max_exemptions": 3 }
//   }
//
//   • "per_athlete" (regra JKA): taxa ÚNICA por atleta, cobrindo TODAS as
//     provas individuais dele no evento (Kata e/ou Kumite, Principal e/ou
//     Aspirantes). "per_entry" (legado/FPKT-style): cobra por inscrição.
//   • team.bundle_both: preço fechado quando a MESMA equipe disputa 2
//     provas (Kata + Kumite). Com 1 prova, per_prova.
//   • exemptions (contrapartida JKA): a cada N oficiais (árbitros/mesários/
//     staff) declarados pelo clube, 1 inscrição de atleta é isenta, até
//     max_exemptions. A isenção abate as taxas de atleta MAIS BARATAS
//     (decisão conservadora a favor da federação — documentada; se a
//     federação quiser outra regra, é config futura, não fork de código).
//   • pricing_config vazio → modo LEGADO: fee da categoria (override) ou
//     fee_amount da competição, por inscrição — o comportamento que o
//     funil individual já tem hoje.
//
// computeAgeAt: idade completa na data de referência — DATA DO EVENTO
// (regra explícita no regulamento JKA: "data de referência para idade nas
// inscrições: 22/08/2026"). Sem new Date(iso) cru em componentes de data
// (armadilha de fuso do CLAUDE.md): parse por componente.
// ============================================================
'use strict';

function parseDateParts(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

// Idade completa em `refDate` (YYYY-MM-DD). null se faltar dado.
function computeAgeAt(birthDate, refDate) {
  const b = parseDateParts(birthDate);
  const r = parseDateParts(refDate);
  if (!b || !r) return null;
  let age = r.y - b.y;
  if (r.mo < b.mo || (r.mo === b.mo && r.d < b.d)) age--;
  return age >= 0 ? age : null;
}

function toAmount(v) {
  // null/undefined/'' são AUSÊNCIA de valor (Number(null) seria 0 — e um
  // override nulo de categoria engoliria o fee da competição no modo legado).
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

// Banda de preço individual para uma idade. Bandas avaliadas na ordem;
// max_age inclusivo; banda sem max_age = pega tudo. Idade desconhecida cai
// na ÚLTIMA banda (dado faltante é neutro, nunca bloqueia — cobra o teto).
function individualAmountFor(age, bands) {
  const list = Array.isArray(bands) ? bands : [];
  for (const b of list) {
    const amount = toAmount(b && b.amount);
    if (amount === null) continue;
    if (b.max_age == null) return amount;
    if (age != null && age <= Number(b.max_age)) return amount;
  }
  // Nenhuma banda casou (todas com max_age abaixo da idade, ou lista vazia)
  for (let i = list.length - 1; i >= 0; i--) {
    const amount = toAmount(list[i] && list[i].amount);
    if (amount !== null) return amount;
  }
  return 0;
}

/**
 * quoteDelegation(input) → cotação completa, pura.
 *
 * input = {
 *   pricing:   pricing_config da competição ({} = modo legado),
 *   eventDate: 'YYYY-MM-DD' (referência de idade),
 *   legacy:    { competition_fee: number|null },      // fallback sem config
 *   athletes:  [{ student_id, name?, birth_date, entries: [
 *                 { category_id, category_name?, category_fee: number|null } ] }],
 *   teams:     [{ team_key, name?, provas_count, category_ids?: [] }],
 *   officialsCount: number,
 * }
 *
 * → { mode, lines: [{ kind, ref, label, amount, exempted }],
 *     exemptions: { earned, applied, officials_count },
 *     subtotal, discount, total }
 */
function quoteDelegation(input) {
  const {
    pricing = {},
    eventDate = null,
    legacy = {},
    athletes = [],
    teams = [],
    officialsCount = 0,
  } = input || {};

  const hasIndividualConfig = pricing && pricing.individual && Array.isArray(pricing.individual.bands)
    && pricing.individual.bands.length > 0;
  const mode = hasIndividualConfig
    ? (pricing.individual.mode === 'per_athlete' ? 'per_athlete' : 'per_entry')
    : 'legacy';

  const lines = [];

  // ── Linhas de atletas (provas individuais) ────────────────
  for (const a of athletes) {
    const entries = Array.isArray(a.entries) ? a.entries : [];
    if (!entries.length) continue;

    if (mode === 'per_athlete') {
      const age = computeAgeAt(a.birth_date, eventDate);
      const amount = individualAmountFor(age, pricing.individual.bands);
      lines.push({
        kind: 'athlete',
        ref: a.student_id,
        label: `${a.name || 'Atleta'} — taxa única (${entries.length} prova${entries.length > 1 ? 's' : ''})`,
        amount,
        exempted: false,
      });
    } else if (mode === 'per_entry') {
      const age = computeAgeAt(a.birth_date, eventDate);
      const amount = individualAmountFor(age, pricing.individual.bands);
      for (const e of entries) {
        lines.push({
          kind: 'entry',
          ref: `${a.student_id}:${e.category_id}`,
          label: `${a.name || 'Atleta'} — ${e.category_name || 'prova'}`,
          amount,
          exempted: false,
        });
      }
    } else {
      // legado: fee da categoria (override) senão fee da competição
      for (const e of entries) {
        const catFee = toAmount(e.category_fee);
        const compFee = toAmount(legacy.competition_fee);
        lines.push({
          kind: 'entry',
          ref: `${a.student_id}:${e.category_id}`,
          label: `${a.name || 'Atleta'} — ${e.category_name || 'prova'}`,
          amount: catFee !== null ? catFee : (compFee !== null ? compFee : 0),
          exempted: false,
        });
      }
    }
  }

  // ── Linhas de equipes ─────────────────────────────────────
  const teamCfg = pricing && pricing.team ? pricing.team : null;
  for (const t of teams) {
    const provas = Math.max(1, Number(t.provas_count) || 1);
    let amount = 0;
    if (teamCfg) {
      const perProva = toAmount(teamCfg.per_prova);
      const bundle = toAmount(teamCfg.bundle_both);
      if (provas >= 2 && bundle !== null) amount = bundle;
      else if (perProva !== null) amount = Math.round(perProva * provas * 100) / 100;
    } else {
      const compFee = toAmount(legacy.competition_fee);
      amount = compFee !== null ? Math.round(compFee * provas * 100) / 100 : 0;
    }
    lines.push({
      kind: 'team',
      ref: t.team_key,
      label: `Equipe ${t.name || ''} — ${provas} prova${provas > 1 ? 's' : ''}`.trim(),
      amount,
      exempted: false,
    });
  }

  // ── Isenções por contrapartida (só sobre taxas de ATLETA/ENTRY) ──
  const exCfg = pricing && pricing.exemptions ? pricing.exemptions : null;
  const perExemption = exCfg ? Math.max(1, Number(exCfg.officials_per_exemption) || 0) : 0;
  const maxExemptions = exCfg ? Math.max(0, Number(exCfg.max_exemptions) || 0) : 0;
  const officials = Math.max(0, Number(officialsCount) || 0);

  let earned = 0;
  if (exCfg && perExemption > 0) {
    earned = Math.min(Math.floor(officials / perExemption), maxExemptions);
  }

  let applied = 0;
  if (earned > 0) {
    // Abate as taxas de atleta mais BARATAS primeiro (conservador). Equipes
    // nunca são isentas — o regulamento fala em "isenção de inscrição de
    // atleta".
    const candidates = lines
      .filter((l) => (l.kind === 'athlete' || l.kind === 'entry') && l.amount > 0)
      .sort((x, y) => x.amount - y.amount);
    for (const line of candidates.slice(0, earned)) {
      line.exempted = true;
      applied++;
    }
  }

  const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const discount = Math.round(lines.filter((l) => l.exempted).reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const total = Math.round((subtotal - discount) * 100) / 100;

  return {
    mode,
    lines,
    exemptions: { earned, applied, officials_count: officials },
    subtotal,
    discount,
    total,
  };
}

// ── Cotas por clube (rules da divisão, migration 294) ────────
// countsByCategory: { [category_id]: { existing: n, adding: n, is_team: bool } }
// rules: { max_individual_per_dojo_per_category, max_teams_per_dojo_per_category }
// → [{ category_id, limit, existing, adding, over }]  (só os estourados)
function checkClubQuotas(countsByCategory, rules) {
  const out = [];
  const maxInd = rules && Number(rules.max_individual_per_dojo_per_category) > 0
    ? Number(rules.max_individual_per_dojo_per_category) : null;
  const maxTeam = rules && Number(rules.max_teams_per_dojo_per_category) > 0
    ? Number(rules.max_teams_per_dojo_per_category) : null;

  for (const [categoryId, c] of Object.entries(countsByCategory || {})) {
    const limit = c.is_team ? maxTeam : maxInd;
    if (limit == null) continue;
    const totalAfter = (Number(c.existing) || 0) + (Number(c.adding) || 0);
    if (totalAfter > limit) {
      out.push({
        category_id: categoryId,
        limit,
        existing: Number(c.existing) || 0,
        adding: Number(c.adding) || 0,
        over: totalAfter - limit,
      });
    }
  }
  return out;
}

module.exports = { quoteDelegation, checkClubQuotas, computeAgeAt, individualAmountFor };
