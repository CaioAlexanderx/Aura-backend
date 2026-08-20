// ============================================================
// AURA KARATÊ — P0 Hub de Campeonatos: engine PURA de precificação
// (karateCompetitionPricingService — sem DB, regras do Dossiê Shiai)
//
// Números de referência REAIS (Regulamento XXV Paulista JKA 2026):
//   individual: taxa ÚNICA — até 14 anos R$150 / 15+ R$180 (multi-prova)
//   equipes: R$125 por prova / R$250 nas duas (Kata+Kumite)
//   isenções: a cada 2 oficiais, 1 atleta isento, máx. 3 por dojô
// ============================================================
'use strict';

const {
  quoteDelegation,
  checkClubQuotas,
  computeAgeAt,
  individualAmountFor,
} = require('../src/services/karateCompetitionPricingService');

const JKA_PRICING = {
  individual: {
    mode: 'per_athlete',
    bands: [{ max_age: 14, amount: 150 }, { amount: 180 }],
  },
  team: { per_prova: 125, bundle_both: 250 },
  exemptions: { officials_per_exemption: 2, max_exemptions: 3 },
};

const EVENT_DATE = '2026-08-22'; // data de referência de idade (regulamento)

describe('computeAgeAt — idade na data do evento (parse por componente, sem fuso)', () => {
  it('aniversário DEPOIS do evento não conta', () => {
    expect(computeAgeAt('2012-09-01', EVENT_DATE)).toBe(13);
  });
  it('aniversário NO DIA do evento conta', () => {
    expect(computeAgeAt('2012-08-22', EVENT_DATE)).toBe(14);
  });
  it('dado faltante → null (neutro, nunca bloqueia)', () => {
    expect(computeAgeAt(null, EVENT_DATE)).toBeNull();
    expect(computeAgeAt('2012-01-01', null)).toBeNull();
  });
});

describe('individualAmountFor — bandas por idade', () => {
  const bands = JKA_PRICING.individual.bands;
  it('≤14 cai na primeira banda', () => {
    expect(individualAmountFor(14, bands)).toBe(150);
    expect(individualAmountFor(9, bands)).toBe(150);
  });
  it('15+ cai na banda sem teto', () => {
    expect(individualAmountFor(15, bands)).toBe(180);
    expect(individualAmountFor(61, bands)).toBe(180);
  });
  it('idade desconhecida cobra o teto (última banda) — faltante é neutro', () => {
    expect(individualAmountFor(null, bands)).toBe(180);
  });
});

describe('quoteDelegation — modo per_athlete (taxa única JKA)', () => {
  it('atleta em 2 provas paga UMA taxa; equipe nas 2 provas paga bundle; isenções abatem os mais baratos', () => {
    const quote = quoteDelegation({
      pricing: JKA_PRICING,
      eventDate: EVENT_DATE,
      athletes: [
        // 13 anos → R$150, inscrito em Kata E Kumite (taxa única!)
        { student_id: 'stu-a', name: 'Atleta A', birth_date: '2012-09-01',
          entries: [{ category_id: 'kata' }, { category_id: 'kumite' }] },
        // 18 anos → R$180
        { student_id: 'stu-b', name: 'Atleta B', birth_date: '2008-01-15',
          entries: [{ category_id: 'kata-adulto' }] },
      ],
      teams: [{ team_key: 't1', name: 'Equipe A', provas_count: 2 }],
      officialsCount: 4, // 4 oficiais → 2 isenções (cap 3 não atinge)
    });

    expect(quote.mode).toBe('per_athlete');
    // Linhas: 2 atletas (150 + 180) + 1 equipe bundle (250)
    const athleteLines = quote.lines.filter((l) => l.kind === 'athlete');
    expect(athleteLines).toHaveLength(2);
    expect(athleteLines.map((l) => l.amount).sort((a, b) => a - b)).toEqual([150, 180]);
    const teamLine = quote.lines.find((l) => l.kind === 'team');
    expect(teamLine.amount).toBe(250);

    // Isenções: earned 2, abatendo OS DOIS atletas (equipe nunca é isenta)
    expect(quote.exemptions).toEqual({ earned: 2, applied: 2, officials_count: 4 });
    expect(athleteLines.every((l) => l.exempted)).toBe(true);
    expect(teamLine.exempted).toBe(false);

    expect(quote.subtotal).toBe(580);
    expect(quote.discount).toBe(330);
    expect(quote.total).toBe(250);
  });

  it('cap de isenções: 10 oficiais rendem no máximo 3', () => {
    const quote = quoteDelegation({
      pricing: JKA_PRICING,
      eventDate: EVENT_DATE,
      athletes: [1, 2, 3, 4, 5].map((n) => ({
        student_id: `stu-${n}`, birth_date: '2000-01-01',
        entries: [{ category_id: 'kata' }],
      })),
      teams: [],
      officialsCount: 10,
    });
    expect(quote.exemptions.earned).toBe(3);
    expect(quote.exemptions.applied).toBe(3);
    expect(quote.total).toBe(2 * 180); // 5×180 − 3×180
  });

  it('isenção abate as taxas mais BARATAS primeiro (conservador)', () => {
    const quote = quoteDelegation({
      pricing: JKA_PRICING,
      eventDate: EVENT_DATE,
      athletes: [
        { student_id: 'jovem', birth_date: '2015-01-01', entries: [{ category_id: 'k' }] }, // 150
        { student_id: 'adulto', birth_date: '1990-01-01', entries: [{ category_id: 'k' }] }, // 180
      ],
      teams: [],
      officialsCount: 2, // 1 isenção
    });
    const exempted = quote.lines.filter((l) => l.exempted);
    expect(exempted).toHaveLength(1);
    expect(exempted[0].amount).toBe(150);
    expect(quote.total).toBe(180);
  });
});

describe('quoteDelegation — equipe com 1 prova e modo per_entry', () => {
  it('equipe em 1 prova paga per_prova', () => {
    const quote = quoteDelegation({
      pricing: JKA_PRICING, eventDate: EVENT_DATE,
      athletes: [], teams: [{ team_key: 't1', provas_count: 1 }], officialsCount: 0,
    });
    expect(quote.total).toBe(125);
  });

  it('per_entry cobra POR INSCRIÇÃO (não por atleta)', () => {
    const quote = quoteDelegation({
      pricing: { individual: { mode: 'per_entry', bands: [{ amount: 50 }] } },
      eventDate: EVENT_DATE,
      athletes: [{ student_id: 's', birth_date: '2000-01-01',
        entries: [{ category_id: 'a' }, { category_id: 'b' }] }],
      teams: [], officialsCount: 0,
    });
    expect(quote.lines.filter((l) => l.kind === 'entry')).toHaveLength(2);
    expect(quote.total).toBe(100);
  });
});

describe('quoteDelegation — modo LEGADO (sem pricing_config)', () => {
  it('fee da categoria (override) vence; senão fee da competição', () => {
    const quote = quoteDelegation({
      pricing: {},
      eventDate: EVENT_DATE,
      legacy: { competition_fee: 80 },
      athletes: [{ student_id: 's', birth_date: '2000-01-01',
        entries: [
          { category_id: 'com-override', category_fee: 60 },
          { category_id: 'sem-override', category_fee: null },
        ] }],
      teams: [], officialsCount: 0,
    });
    expect(quote.mode).toBe('legacy');
    expect(quote.total).toBe(140); // 60 + 80
  });

  it('sem config e sem fee nenhum → total 0 (evento gratuito)', () => {
    const quote = quoteDelegation({
      pricing: {}, eventDate: EVENT_DATE, legacy: { competition_fee: null },
      athletes: [{ student_id: 's', birth_date: null, entries: [{ category_id: 'a', category_fee: null }] }],
      teams: [], officialsCount: 0,
    });
    expect(quote.total).toBe(0);
  });
});

describe('checkClubQuotas — cotas por clube por categoria', () => {
  it('estourou → devolve a violação com o excedente', () => {
    const out = checkClubQuotas(
      { 'cat-1': { existing: 5, adding: 3, is_team: false } },
      { max_individual_per_dojo_per_category: 7 }
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category_id: 'cat-1', limit: 7, existing: 5, adding: 3, over: 1 });
  });

  it('dentro do limite / sem regra → sem violações', () => {
    expect(checkClubQuotas(
      { 'cat-1': { existing: 4, adding: 3, is_team: false } },
      { max_individual_per_dojo_per_category: 7 }
    )).toHaveLength(0);
    expect(checkClubQuotas(
      { 'cat-1': { existing: 99, adding: 1, is_team: false } },
      {}
    )).toHaveLength(0);
  });

  it('equipes usam o limite de equipes (1 por clube na regra JKA)', () => {
    const out = checkClubQuotas(
      { 'cat-team': { existing: 1, adding: 1, is_team: true } },
      { max_teams_per_dojo_per_category: 1 }
    );
    expect(out).toHaveLength(1);
    expect(out[0].over).toBe(1);
  });
});
