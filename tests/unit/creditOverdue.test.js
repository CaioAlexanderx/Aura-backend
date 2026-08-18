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
// ============================================================
const {
  classifyInstallment,
  overdueSql,
  toReviewSql,
  resolveGraceDays,
  DEFAULT_GRACE_DAYS,
} = require('../../src/services/credit/overdue');

const HOJE = '2026-08-18T12:00:00-03:00';
const CONFIG = { late_grace_days: 3 };

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

  it('dentro da carência da loja ainda é em dia', () => {
    const r = classifyInstallment(parcela({ due_date: '2026-08-17' }), CONFIG, HOJE);
    expect(r.is_overdue).toBe(false);
    expect(r.days_late).toBe(1);
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

  it('parcela retroativa (cadastrada depois do vencimento) é "a conferir", não atraso', () => {
    const r = classifyInstallment(
      parcela({ due_date: '2026-08-07', created_at: '2026-08-18T09:00:00-03:00' }),
      CONFIG,
      HOJE
    );
    expect(r.is_overdue).toBe(false);
    expect(r.needs_review).toBe(true);
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
    // atraso exige due_date >= created_at; a conferir exige due_date < created_at
    expect(overdueSql({})).toContain('due_date >= (created_at');
    expect(toReviewSql({})).toContain('due_date < (created_at');
  });
});
