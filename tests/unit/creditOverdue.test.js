// ============================================================
// AURA. — Crediário · regra ÚNICA de atraso (services/credit/overdue.js)
//
// Casos ancorados no relato da Valen (18/08/2026):
//   - "livia aline": ficha dizia "Em atraso" e os dois carnês "Em dia",
//     porque 23 parcelas com vencimento em 2027 ainda carregavam
//     status='overdue' congelado. Atraso NUNCA pode sair do status.
//   - 11 de 24 parcelas vencidas eram carnê histórico cadastrado depois
//     do vencimento ("nasceu vencida") → a conferir, não inadimplência.
//   - "viviane": 74 dias de atraso por R$1,50 de resíduo de arredondamento.
//
// Relato Valen (21/08/2026) — o oposto, falso NEGATIVO:
//   - carência de 3 dias era aplicada com o motor de encargos DESLIGADO
//     (39 parcelas / 35 clientes / R$14.560 em "Em dia" sem cobrar mora);
//   - parcela retroativa ficava "A conferir" para sempre — havia parcela com
//     77 dias de atraso em âmbar (8 parcelas / 6 clientes / R$1.057).
// ============================================================
const {
  classifyInstallment,
  overdueSql,
  toReviewSql,
  resolveGraceDays,
  signalGraceDays,
  DEFAULT_GRACE_DAYS,
  REVIEW_WINDOW_DAYS,
} = require('../../src/services/credit/overdue');

const HOJE = '2026-08-18T12:00:00-03:00';
/** Loja que COBRA encargos: a carência da mora também segura o sinal. */
const CONFIG = { late_grace_days: 3, late_charges_enabled: true };
/** Loja sem encargos (100% da base hoje): sinal a partir do dia 1. */
const CONFIG_SEM_ENCARGOS = { late_grace_days: 3, late_charges_enabled: false };

/** Parcela base: aberta, com resíduo, cadastrada bem antes do vencimento. */
function parcela(over) {
  return Object.assign(
    {
      status: 'pending',
      amount_due: 100,
      covered_amount: 0,
      due_date: '2026-09-30',
      created_at: '2026-08-01T10:00:00-03:00',
    },
    over
  );
}

describe('classifyInstallment — regra única de atraso', () => {
  it('NÃO usa o status persistido: overdue congelado com vencimento futuro = em dia', () => {
    // Exatamente o caso livia aline.
    const r = classifyInstallment(
      parcela({ status: 'overdue', due_date: '2027-06-05' }),
      CONFIG,
      HOJE
    );
    expect(r.is_overdue).toBe(false);
    expect(r.needs_review).toBe(false);
  });

  it('parcela vencida além da carência é atraso', () => {
    const r = classifyInstallment(
      parcela({ due_date: '2026-07-05', created_at: '2026-06-01T10:00:00-03:00' }),
      CONFIG,
      HOJE
    );
    expect(r.is_overdue).toBe(true);
    expect(r.days_late).toBe(44);
  });

  it('dentro da carência da loja QUE COBRA ENCARGOS ainda é em dia', () => {
    const r = classifyInstallment(parcela({ due_date: '2026-08-17' }), CONFIG, HOJE);
    expect(r.is_overdue).toBe(false);
    expect(r.days_late).toBe(1);
  });

  it('sem encargos ligados, 1 dia de atraso JÁ acende (relato 21/08)', () => {
    // A carência existe para não cobrar mora em dia de cortesia. Se a loja não
    // cobra mora nenhuma, não há cortesia a respeitar — e o cliente sumia da
    // régua de cobrança por 3 dias.
    const r = classifyInstallment(parcela({ due_date: '2026-08-17' }), CONFIG_SEM_ENCARGOS, HOJE);
    expect(r.is_overdue).toBe(true);
    expect(r.days_late).toBe(1);
  });

  it('config ausente é tratada como loja sem encargos', () => {
    expect(classifyInstallment(parcela({ due_date: '2026-08-17' }), null, HOJE).is_overdue).toBe(true);
  });

  it('primeiro dia após a carência vira atraso', () => {
    const r = classifyInstallment(parcela({ due_date: '2026-08-14' }), CONFIG, HOJE);
    expect(r.is_overdue).toBe(true);
    expect(r.days_late).toBe(4);
  });

  it('resíduo de centavos não é atraso', () => {
    // viviane: parcela de 101,50 com 100,00 pago.
    const r = classifyInstallment(
      parcela({ amount_due: 101.5, covered_amount: 100, due_date: '2026-06-05' }),
      CONFIG,
      HOJE
    );
    expect(r.is_overdue).toBe(false);
    expect(r.remaining).toBe(1.5);
  });

  it('resíduo acima da tolerância continua sendo atraso', () => {
    const r = classifyInstallment(
      parcela({ amount_due: 184, covered_amount: 150, due_date: '2026-08-07' }),
      CONFIG,
      HOJE
    );
    expect(r.is_overdue).toBe(true);
    expect(r.remaining).toBe(34);
  });

  it('parcela retroativa recém-cadastrada é "a conferir", não atraso', () => {
    const r = classifyInstallment(
      parcela({ due_date: '2026-08-07', created_at: '2026-08-18T09:00:00-03:00' }),
      CONFIG,
      HOJE
    );
    expect(r.is_overdue).toBe(false);
    expect(r.needs_review).toBe(true);
  });

  it('retroativa passada a janela de conferência vira atraso (relato 21/08)', () => {
    // "viviane": vencimento 05/06, cadastrada em 05/08, 77 dias de atraso —
    // ficava em âmbar para sempre porque a exceção nunca expirava.
    const r = classifyInstallment(
      parcela({ due_date: '2026-06-05', created_at: '2026-08-05T09:00:00-03:00' }),
      CONFIG,
      '2026-08-21T12:00:00-03:00'
    );
    expect(r.needs_review).toBe(false);
    expect(r.is_overdue).toBe(true);
    expect(r.days_late).toBe(77);
  });

  it('a janela de conferência é contada do cadastro, não do vencimento', () => {
    const base = { due_date: '2026-08-01' };
    // Último dia da janela: ainda a conferir.
    const dentro = classifyInstallment(
      parcela({ ...base, created_at: '2026-08-11T09:00:00-03:00' }), // hoje-7
      CONFIG,
      HOJE
    );
    expect(dentro.needs_review).toBe(true);
    expect(dentro.is_overdue).toBe(false);
    // Um dia depois da janela: atraso.
    const fora = classifyInstallment(
      parcela({ ...base, created_at: '2026-08-10T09:00:00-03:00' }), // hoje-8
      CONFIG,
      HOJE
    );
    expect(fora.needs_review).toBe(false);
    expect(fora.is_overdue).toBe(true);
  });

  it('parcela paga ou cancelada nunca é atraso', () => {
    for (const status of ['paid', 'cancelled']) {
      const r = classifyInstallment(parcela({ status, due_date: '2026-01-01' }), CONFIG, HOJE);
      expect(r.is_overdue).toBe(false);
      expect(r.needs_review).toBe(false);
    }
  });

  it('é defensivo: entrada inválida devolve zeros sem lançar', () => {
    expect(() => classifyInstallment(null, null, HOJE)).not.toThrow();
    expect(classifyInstallment({ status: 'pending', due_date: 'xx' }, null, HOJE).is_overdue).toBe(false);
  });
});

describe('signalGraceDays', () => {
  it('respeita a carência da loja apenas quando ela cobra encargos', () => {
    expect(signalGraceDays({ late_grace_days: 7, late_charges_enabled: true })).toBe(7);
  });
  it('é zero quando a loja não cobra encargos', () => {
    expect(signalGraceDays({ late_grace_days: 7, late_charges_enabled: false })).toBe(0);
    expect(signalGraceDays({ late_grace_days: 7 })).toBe(0);
    expect(signalGraceDays(null)).toBe(0);
  });
  it('cai no default da mora quando a loja cobra mas não configurou a carência', () => {
    expect(signalGraceDays({ late_charges_enabled: true })).toBe(DEFAULT_GRACE_DAYS);
  });
});

describe('resolveGraceDays', () => {
  it('usa a carência da loja quando configurada', () => {
    expect(resolveGraceDays({ late_grace_days: 7 })).toBe(7);
    expect(resolveGraceDays({ late_grace_days: 0 })).toBe(0);
  });
  it('cai no default quando ausente ou inválida', () => {
    expect(resolveGraceDays(null)).toBe(DEFAULT_GRACE_DAYS);
    expect(resolveGraceDays({ late_grace_days: 'abc' })).toBe(DEFAULT_GRACE_DAYS);
    expect(resolveGraceDays({ late_grace_days: -1 })).toBe(DEFAULT_GRACE_DAYS);
  });
});

describe('overdueSql / toReviewSql', () => {
  it('respeita o alias da tabela', () => {
    const sql = overdueSql({ alias: 'ci', graceDays: 3 });
    expect(sql).toContain('ci.status');
    expect(sql).toContain('ci.due_date');
    expect(sql).toContain('ci.created_at');
  });
  it('aplica carência e tolerância na expressão', () => {
    const sql = overdueSql({ graceDays: 5, tolerance: 1 });
    expect(sql).toContain('- 5)');
    expect(sql).toContain('> 1');
  });
  it('as duas expressões são mutuamente exclusivas por construção', () => {
    // atraso: due_date >= created_at OU cadastro fora da janela;
    // a conferir: due_date < created_at E cadastro dentro da janela.
    expect(overdueSql({})).toContain('due_date >= (created_at');
    expect(toReviewSql({})).toContain('due_date < (created_at');
  });
  it('a janela de conferência entra nas duas expressões', () => {
    expect(overdueSql({ reviewDays: 7 })).toContain(`- 7)`);
    expect(toReviewSql({ reviewDays: 7 })).toContain(`- 7)`);
    expect(overdueSql({})).toContain(`- ${REVIEW_WINDOW_DAYS}`);
  });
});
