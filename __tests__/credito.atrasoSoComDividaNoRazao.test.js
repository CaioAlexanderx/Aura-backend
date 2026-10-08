// ============================================================
// AURA CRÉDITO — atraso só existe quando há dívida no razão (condição 5)
//
// O CASO REAL (Valen, 08/10/2026): a lista do Crediário passou a mostrar quem
// tem parcela aberta (#791) e três clientes cujo débito tinha sido apagado do
// razão apareceram com R$0,00 (ou saldo negativo) e a pill "Em atraso". A
// regra de atraso só olhava credit_installments. Daqui em diante, parcela
// aberta sem dívida no razão NÃO é atraso: é inconsistência a conferir.
//
// O que este arquivo cobre (sem banco: SQL conferido como texto + JS puro):
//   1. overdueSql carrega a condição 5 — e `ledger: false` a tira
//   2. classifyInstallment com saldo zerado: nem atraso nem "a conferir"
//   3. GET /credit/balances usa a condição 5 e devolve ledger_mismatch
//   4. a régua automática não seleciona parcela sem dívida no razão
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const overdueRule = require('../src/services/credit/overdue');
const collectionAuto = require('../src/services/credit/collectionAuto');

const COMPANY = '628e771b-6b2e-47da-b727-afd50fe35927';
const HOJE = '2026-10-08';

// ── (1) a expressão SQL ─────────────────────────────────────
describe('overdueSql — condição 5 (dívida no razão)', () => {
  test('por padrão exige saldo > 0 no razão, pelo placeholder da empresa', () => {
    const sql = overdueRule.overdueSql({ graceDays: 0, companyParam: '$1' });
    expect(sql).toMatch(/customer_id IN \(\s*SELECT cb_atraso\.customer_id FROM customer_credit_balances/);
    expect(sql).toMatch(/cb_atraso\.company_id = \$1/);
    expect(sql).toMatch(/cb_atraso\.balance > 0\.009/);
  });

  test('sem placeholder cai no EXISTS correlacionado (correto em qualquer consulta)', () => {
    const sql = overdueRule.overdueSql({ alias: 'ci' });
    expect(sql).toMatch(/EXISTS \(\s*SELECT 1 FROM customer_credit_balances cb_atraso/);
    expect(sql).toMatch(/cb_atraso\.customer_id = ci\.customer_id/);
    expect(sql).toMatch(/cb_atraso\.company_id = ci\.company_id/);
  });

  test('ledger: false tira a condição (quem PRECISA ver parcela órfã)', () => {
    expect(overdueRule.overdueSql({ ledger: false })).not.toMatch(/customer_credit_balances/);
  });

  test('"a conferir" (parcela retroativa) não muda', () => {
    expect(overdueRule.toReviewSql({})).not.toMatch(/customer_credit_balances/);
  });
});

// ── (2) a versão JS ─────────────────────────────────────────
describe('classifyInstallment — saldo do razão', () => {
  const vencida = { status: 'overdue', amount_due: 734, covered_amount: 0, due_date: '2026-09-30', created_at: '2026-09-02T12:00:00Z' };

  test('com dívida no razão: atraso de 8 dias', () => {
    const c = overdueRule.classifyInstallment(vencida, null, HOJE + 'T12:00:00-03:00', { ledgerBalance: 734 });
    expect(c.is_overdue).toBe(true);
    expect(c.no_ledger_debt).toBe(false);
    expect(c.days_late).toBe(8);
  });

  test('sem dívida no razão (débito apagado): nem atraso nem "a conferir", mas os dias continuam visíveis', () => {
    for (const saldo of [0, -200, 0.005]) {
      const c = overdueRule.classifyInstallment(vencida, null, HOJE + 'T12:00:00-03:00', { ledgerBalance: saldo });
      expect(c.is_overdue).toBe(false);
      expect(c.needs_review).toBe(false);
      expect(c.no_ledger_debt).toBe(true);
      expect(c.days_late).toBe(8);
      expect(c.remaining).toBe(734);
    }
  });

  test('sem informação do razão (null/omitido): segue só pelas parcelas, como antes', () => {
    expect(overdueRule.classifyInstallment(vencida, null, HOJE + 'T12:00:00-03:00').is_overdue).toBe(true);
    expect(overdueRule.classifyInstallment(vencida, null, HOJE + 'T12:00:00-03:00', { ledgerBalance: null }).is_overdue).toBe(true);
  });

  test('parcela quitada continua quitada, com ou sem saldo', () => {
    const paga = { ...vencida, status: 'paid' };
    expect(overdueRule.classifyInstallment(paga, null, HOJE, { ledgerBalance: 0 })).toMatchObject({ is_overdue: false, no_ledger_debt: false });
  });
});

// ── (3) a lista ─────────────────────────────────────────────
describe('GET /credit/balances — parcela órfã sai como "conferir", não como atraso', () => {
  function app() {
    const a = express();
    a.use('/companies/:id/credit', require('../src/routes/creditBalances'));
    return a;
  }
  const visto = { overdueSql: null };

  beforeEach(() => {
    db.query.mockReset();
    visto.overdueSql = null;
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/crediario_enabled/.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
      if (/late_grace_days/.test(s)) return Promise.resolve({ rows: [{ late_grace_days: 3, late_charges_enabled: false }] });
      if (/FULL JOIN inst/.test(s)) {
        return Promise.resolve({ rows: [
          { id: 'kaio', name: 'kaio roy', phone: null, cpf_cnpj: null, balance: '0.00', total_debited: '0.00', total_paid: '0.00', last_activity_at: null, open_installments: '734.00' },
          { id: 'cardoso', name: 'cardoso', phone: null, cpf_cnpj: null, balance: '6250.00', total_debited: '6800.00', total_paid: '550.00', last_activity_at: null, open_installments: '6250.00' },
        ] });
      }
      if (/MIN\(due_date\) FILTER/.test(s)) {
        visto.overdueSql = s;
        // O que o Postgres devolveria com a condição 5: o órfão não acende.
        return Promise.resolve({ rows: [
          { customer_id: 'kaio',    next_due_date: '2026-09-30', oldest_overdue_date: null,         overdue: false, to_review_count: 0 },
          { customer_id: 'cardoso', next_due_date: '2026-09-07', oldest_overdue_date: '2026-09-07', overdue: true,  to_review_count: 0 },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  test('a consulta de atraso carrega a condição 5 e a linha órfã vem com ledger_mismatch', async () => {
    const res = await request(app()).get(`/companies/${COMPANY}/credit/balances`);
    expect(res.status).toBe(200);
    expect(visto.overdueSql).toMatch(/customer_credit_balances cb_atraso/);
    expect(visto.overdueSql).toMatch(/cb_atraso\.company_id = \$1/);

    const kaio = res.body.customers.find((c) => c.id === 'kaio');
    expect(kaio).toMatchObject({ balance: 0, open_installments: 734, ledger_mismatch: true, overdue: false, oldest_overdue_date: null });
    const cardoso = res.body.customers.find((c) => c.id === 'cardoso');
    expect(cardoso).toMatchObject({ ledger_mismatch: false, overdue: true, oldest_overdue_date: '2026-09-07' });
  });
});

// ── (4) a régua automática ──────────────────────────────────
describe('régua automática — não cobra quem não deve no razão', () => {
  test('a seleção de parcelas do dia exige dívida no razão', async () => {
    db.query.mockReset();
    let sqlVisto = null;
    db.query.mockImplementation((sql) => {
      if (String(sql).includes('-- cred:auto-parcelas')) { sqlVisto = String(sql); }
      return Promise.resolve({ rows: [] });
    });
    await collectionAuto._loadInstallmentsForRule(COMPANY, { today: HOJE, days: 3 });
    expect(sqlVisto).toMatch(/customer_credit_balances cb_atraso/);
    expect(sqlVisto).toMatch(/cb_atraso\.company_id = \$1/);
    expect(sqlVisto).toMatch(/cb_atraso\.balance > 0\.009/);
  });
});
