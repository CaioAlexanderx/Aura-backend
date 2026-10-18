// ============================================================
// services/receita — MRR normalizado da Aura.
//
// Regra: soma das mensais + soma das anuais ÷ 12. Pagante sem assinatura na
// Asaas conta como pagante, mas o valor dele fica fora do MRR, na linha
// "sem cobrança registrada".
// ============================================================
'use strict';

const db = require('../../src/config/database');
const {
  normalizarMrr, calcularMrr, contratoDeTabela, gravarSnapshot,
} = require('../../src/services/receita');

const ass = (extra) => ({
  company_id: 'c', nome: 'Loja', telefone: null, plan: 'negocio', ciclo: 'monthly',
  valor_contrato: 169, meses_contrato: 1, addons_mensal: 0, tem_cobranca: true, ...extra,
});

afterEach(() => db.query.mockReset());

describe('contratoDeTabela', () => {
  test('mensal vale um mês cheio', () => {
    expect(contratoDeTabela('negocio', 'monthly')).toEqual({ valor_contrato: 169, meses_contrato: 1 });
  });

  test('anual vale 12 parcelas com 2 meses grátis', () => {
    // 169 × 5/6 = 140,83 por parcela → contrato de 1.689,96
    expect(contratoDeTabela('negocio', 'annual')).toEqual({ valor_contrato: 1689.96, meses_contrato: 12 });
  });

  test('plano fora da tabela vale zero em vez de quebrar', () => {
    expect(contratoDeTabela('personalizado', 'monthly').valor_contrato).toBe(0);
  });
});

describe('normalizarMrr', () => {
  test('anual entra dividido por 12, mensal entra cheio', () => {
    const r = normalizarMrr([
      ass({ company_id: 'a' }),
      ass({ company_id: 'b', ciclo: 'annual', valor_contrato: 1689.96, meses_contrato: 12 }),
      ass({ company_id: 'c', plan: 'essencial', ciclo: 'annual', valor_contrato: 890.04, meses_contrato: 12 }),
    ]);
    expect(r.mrr_total).toBe(384); // 169 + 140,83 + 74,17
    expect(r.por_plano.negocio).toEqual({ clientes: 2, mensais: 1, anuais: 1, mrr: 309.83 });
    expect(r.por_plano.essencial).toEqual({ clientes: 1, mensais: 0, anuais: 1, mrr: 74.17 });
    expect(r.por_plano_ciclo).toEqual([
      { plan: 'negocio', ciclo: 'monthly', clientes: 1, mrr: 169 },
      { plan: 'negocio', ciclo: 'annual', clientes: 1, mrr: 140.83 },
      { plan: 'essencial', ciclo: 'annual', clientes: 1, mrr: 74.17 },
    ]);
  });

  test('pagante sem assinatura conta como pagante mas fica fora do MRR', () => {
    const r = normalizarMrr([
      ass({ company_id: 'a' }),
      ass({ company_id: 'b', nome: 'Sem Cobrança', plan: 'expansao', valor_contrato: 269, tem_cobranca: false }),
    ]);
    expect(r.pagantes).toBe(2);
    expect(r.com_cobranca).toBe(1);
    expect(r.mrr_total).toBe(169);
    expect(r.por_plano.expansao).toEqual({ clientes: 1, mensais: 0, anuais: 0, mrr: 0 });
    expect(r.sem_cobranca.clientes).toBe(1);
    expect(r.sem_cobranca.mrr_potencial).toBe(269);
    expect(r.sem_cobranca.lojas.map((l) => l.nome)).toEqual(['Sem Cobrança']);
  });

  test('acesso extra soma no total, separado dos planos', () => {
    const r = normalizarMrr([ass({ addons_mensal: 38 })]);
    expect(r.mrr_planos).toBe(169);
    expect(r.mrr_addons).toBe(38);
    expect(r.mrr_total).toBe(207);
    expect(r.por_plano.negocio.mrr).toBe(169);
  });

  test('lista vazia não quebra', () => {
    expect(normalizarMrr([]).mrr_total).toBe(0);
    expect(normalizarMrr(undefined).pagantes).toBe(0);
  });
});

describe('calcularMrr', () => {
  test('a fonte é trocável: quem monta as assinaturas não é o cálculo', async () => {
    const fonte = jest.fn(async () => [ass({ valor_contrato: 1200, meses_contrato: 12, ciclo: 'annual' })]);
    const r = await calcularMrr({ db, fonte });
    expect(fonte).toHaveBeenCalledWith({ db });
    expect(r.mrr_total).toBe(100);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('fonte padrão: companies ativas + preço de tabela', async () => {
    db.query.mockImplementation(async (sql) => {
      if (sql.includes('extra_seats_granted')) return { rows: [{ id: 'a', extra_seats_granted: 2 }] };
      return {
        rows: [
          { company_id: 'a', nome: 'Mensal', telefone: '11', plan: 'negocio', ciclo: 'monthly', tem_cobranca: true },
          { company_id: 'b', nome: 'Anual', telefone: null, plan: 'essencial', ciclo: 'annual', tem_cobranca: true },
          { company_id: 'c', nome: 'Cortesia', telefone: null, plan: 'expansao', ciclo: 'monthly', tem_cobranca: false },
        ],
      };
    });
    const r = await calcularMrr({ db });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain("c.billing_status = 'active'");
    expect(sql).toContain("NOT ILIKE '%@getaura.com.br'");
    // 169 + 2 acessos (38) + 74,17
    expect(r.mrr_total).toBe(281.17);
    expect(r.mrr_addons).toBe(38);
    expect(r.pagantes).toBe(3);
    expect(r.sem_cobranca.lojas.map((l) => l.nome)).toEqual(['Cortesia']);
  });

  // 13/10/2026 — pedido da Financeiro, validado pelo Caio: teste, filial paga
  // pela matriz e dojô sem assinatura própria não são receita da Aura.
  test('fonte padrão deixa de fora teste, filial paga pela matriz e dojô sem assinatura', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await calcularMrr({ db });
    const sql = db.query.mock.calls[0][0];
    // conta de teste
    expect(sql).toContain('c.is_sandbox IS NOT TRUE');
    // filial: o plano é pago por OUTRA empresa
    expect(sql).toMatch(/NOT \(c\.billing_owner_company_id IS NOT NULL AND c\.billing_owner_company_id <> c\.id\)/);
    // dojô de federação sem assinatura própria; dojô com assinatura continua
    expect(sql).toMatch(/NOT \(c\.asaas_subscription_id IS NULL\s+AND c\.federation_id IS NOT NULL AND c\.federation_id <> c\.id\)/);
  });

  test('os três filtros ficam no mesmo WHERE da fonte, antes do ORDER BY', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await calcularMrr({ db });
    const sql = db.query.mock.calls[0][0];
    const where = sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER BY'));
    expect(where).toContain('is_sandbox');
    expect(where).toContain('billing_owner_company_id');
    expect(where).toContain('federation_id');
  });
});

describe('universo dos blocos do painel', () => {
  test('SEM_INTERNAS tira conta de teste (is_sandbox) além de @getaura.com.br', () => {
    const { SEM_INTERNAS } = require('../../src/services/painelBlocos/_base');
    expect(SEM_INTERNAS).toContain("NOT ILIKE '%@getaura.com.br'");
    expect(SEM_INTERNAS).toContain('c.is_sandbox IS NOT TRUE');
  });
});

describe('gravarSnapshot', () => {
  test('upsert do mês corrente, sem tocar em custos e margem', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const mrr = normalizarMrr([
      ass({ company_id: 'a' }),
      ass({ company_id: 'b', plan: 'essencial', valor_contrato: 89, tem_cobranca: false }),
    ]);
    await gravarSnapshot({ db, hoje: '2026-10-13', mrr });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("date_trunc('month', $1::date)::date");
    expect(sql).toContain('ON CONFLICT (reference_month) DO UPDATE');
    // custos são do lançamento mensal (/admin/painel/custos): o job não os cita
    expect(sql).not.toMatch(/total_costs|gross_margin|notes|custos_detalhe|taxas_asaas|das/);
    // dia, clientes ess/neg/exp/total, mrr ess/neg/exp/addons/total
    expect(params).toEqual(['2026-10-13', 1, 1, 0, 2, 0, 169, 0, 0, 169]);
  });
});
