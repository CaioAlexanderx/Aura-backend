// ============================================================
// Crediário — juntar carnês (10/10/2026)
//
// A lojista marca 2+ carnês em aberto e parcela tudo de uma vez. O que estes
// testes travam, de ponta a ponta (rota -> motor -> o que fica no banco):
//   1. preview === apply, e o preview não grava nada;
//   2. nasce o carnê destino; as parcelas abertas das origens são canceladas;
//      as pagas migram; a paga em parte é encurtada e migra; os débitos (os
//      produtos) passam ao destino; as origens fecham apontando para ele;
//   3. o saldo do cliente não muda quando o total não muda; desconto vira
//      'refund' e acréscimo vira 'debit' no razão, no carnê destino;
//   4. o grupo sem carnê entra como origem — e o recebimento livre NÃO migra;
//   5. idempotência: mesma chave ou clique duplo devolve o primeiro resultado;
//   6. recusas com erro claro e nada gravado;
//   7. sem a migration 369 a junção funciona e a origem sai da ficha;
//   8. depois da junção, a ficha (GET /credit/customer/:cid) mostra UM carnê
//      com os campos novos, e a impressão (?account=<destino>) lista os
//      produtos de TODAS as origens, com Comprou/Já pagou/Falta fechando.
//
// Banco: um fake em memória que despacha por CONTEÚDO DO SQL e aplica os
// UPDATE/INSERT da junção — assim a ficha e a impressão leem o estado que a
// junção deixou, em vez de um cenário montado à mão.
// ============================================================

jest.mock('../src/config/database');
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

const LOJA    = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const CLIENTE = '8fbde0b9-2ec0-4bc9-be58-f86c31465fa6';
const CARNE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'; // Compra de 13/09: 300 em 3x, 1 paga, 1 paga em parte (40)
const CARNE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // Compra de 14/09: 250 em 1x, em aberto
const CARNE_C = 'cccccccc-3333-4333-8333-cccccccccccc'; // outro carnê aberto, fora da junção
const ALHEIO  = 'dddddddd-4444-4444-8444-dddddddddddd'; // carnê de outro cliente
const SALE_A  = '5a1e0000-0000-4000-8000-00000000000a';
const SALE_B  = '5a1e0000-0000-4000-8000-00000000000b';

const clone = (x) => JSON.parse(JSON.stringify(x));
const uuid = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const br = (ymd) => { const [y, m, d] = String(ymd).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };

function cenario() {
  const inst = (id, account_id, n, total, amount, covered, status, due, extra = {}) => ({
    id, account_id, sale_id: null, installment_number: n, total_installments: total,
    amount_due: amount.toFixed(2), covered_amount: covered.toFixed(2), status,
    due_date: due, due_date_br: br(due), past_due: false, paid_at: null,
    created_at: '2026-09-13T15:00:00Z', updated_at: '2026-10-05T14:00:00Z', ...extra,
  });
  return {
    accounts: [
      { id: CARNE_A, name: 'Compra de 13/09', status: 'open', terms_snapshot: null, created_at: '2026-09-13T15:00:00Z' },
      { id: CARNE_B, name: 'Compra de 14/09', status: 'open', terms_snapshot: null, created_at: '2026-09-14T15:00:00Z' },
      { id: CARNE_C, name: 'Compra de 01/10', status: 'open', terms_snapshot: null, created_at: '2026-10-01T15:00:00Z' },
    ],
    installments: [
      inst(uuid(1), CARNE_A, 1, 3, 100, 100, 'paid', '2026-10-13', { paid_at: '2026-10-05T14:00:00Z' }),
      inst(uuid(2), CARNE_A, 2, 3, 100, 40, 'pending', '2026-11-13'),
      inst(uuid(3), CARNE_A, 3, 3, 100, 0, 'pending', '2026-12-13'),
      inst(uuid(4), CARNE_B, 1, 1, 250, 0, 'pending', '2026-10-14'),
      inst(uuid(5), CARNE_C, 1, 1, 80, 0, 'pending', '2026-11-01'),
      // Sem carnê: 1 paga (histórico) e 1 aberta de 90 com 50 abatidos.
      inst(uuid(6), null, 1, 2, 90, 90, 'paid', '2026-08-01', { paid_at: '2026-08-01T14:00:00Z' }),
      inst(uuid(7), null, 2, 2, 90, 50, 'pending', '2026-09-01'),
    ],
    // Razão. Os 140 recebidos de A + 140 do grupo sem carnê entraram como
    // RECEBIMENTO LIVRE (account_id nulo) — o uso dominante.
    txs: [
      { id: uuid(101), type: 'debit', account_id: null, sale_id: null, amount: '500.00', notes: 'Caderno antigo quitado', created_at: '2025-03-01T15:00:00Z' },
      { id: uuid(102), type: 'payment', account_id: null, sale_id: null, amount: '500.00', notes: null, created_at: '2025-04-01T15:00:00Z' },
      { id: uuid(103), type: 'debit', account_id: null, sale_id: null, amount: '180.00', notes: 'Saldo do caderno', created_at: '2026-07-01T15:00:00Z' },
      { id: uuid(104), type: 'debit', account_id: CARNE_A, sale_id: SALE_A, amount: '300.00', notes: 'Venda no crediario', created_at: '2026-09-13T15:00:00Z' },
      { id: uuid(105), type: 'debit', account_id: CARNE_B, sale_id: SALE_B, amount: '250.00', notes: 'Venda no crediario', created_at: '2026-09-14T15:00:00Z' },
      { id: uuid(106), type: 'debit', account_id: CARNE_C, sale_id: null, amount: '80.00', notes: 'Lancamento manual', created_at: '2026-10-01T15:00:00Z' },
      { id: uuid(107), type: 'payment', account_id: null, sale_id: null, amount: '280.00', notes: null, created_at: '2026-10-05T14:00:00Z' },
    ],
    items: [
      { sale_id: SALE_A, product_name: 'Vans Hylane 40/41', quantity: '1', unit_price: '220.00', total_price: '220.00' },
      { sale_id: SALE_A, product_name: 'Meia cano alto', quantity: '2', unit_price: '40.00', total_price: '80.00' },
      { sale_id: SALE_B, product_name: 'Bota Chelsea', quantity: '1', unit_price: '250.00', total_price: '250.00' },
    ],
    receipts: [],
    seq: 500,
  };
}

// ---------- fake em memória ----------
function fakeDb(state, { colunasDaMigration = true, clienteExiste = true } = {}) {
  const saldo = () => state.txs.reduce((s, t) => s + (t.type === 'debit' ? 1 : -1) * parseFloat(t.amount), 0);
  let snapshot = null;
  const log = [];

  const responder = (sql, p = []) => {
    const s = String(sql || '');
    log.push(s);
    const ok = (rows = []) => Promise.resolve({ rows });

    if (s === 'BEGIN') { snapshot = clone(state); return ok(); }
    if (s === 'ROLLBACK') { if (snapshot) { Object.assign(state, clone(snapshot)); snapshot = null; } return ok(); }
    if (s === 'COMMIT') { snapshot = null; return ok(); }
    if (/SAVEPOINT|pg_advisory_xact_lock/i.test(s)) return ok();

    // --- leituras fixas ---
    if (/crediario_enabled/i.test(s)) return ok([{ enabled: 'true' }]);
    if (/information_schema\.columns/i.test(s) && /credit_accounts/i.test(s)) return ok(colunasDaMigration ? [{ '?column?': 1 }] : []);
    if (/FROM customers WHERE id/i.test(s)) {
      return ok(clienteExiste ? [{ id: CLIENTE, name: 'Alexander Olivier', phone: null, cpf_cnpj: null, company_id: LOJA }] : []);
    }
    if (/FROM companies WHERE id = \$1/i.test(s)) {
      return ok([{ display_name: 'Loja', trade_name: 'Loja', legal_name: 'Loja LTDA', cnpj: null, phone: null, logo_url: null, address: null }]);
    }
    if (/FROM credit_plan_configs/i.test(s)) return ok([{ period_unit: 'month', period_count: 1 }]);
    if (/FROM sale_items/i.test(s)) return ok(state.items.filter(i => p[0].includes(i.sale_id)).map(clone));

    // --- recibos de idempotência ---
    if (/FROM credit_reschedule_receipts/i.test(s)) {
      const r = /idempotency_key = \$2/i.test(s)
        ? state.receipts.find(x => x.key === p[1])
        : state.receipts.find(x => x.fingerprint === p[2]);
      return ok(r ? [{ result: clone(r.result) }] : []);
    }
    if (/INSERT INTO credit_reschedule_receipts/i.test(s)) {
      if (state.receipts.some(x => x.key === p[3])) return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }));
      state.receipts.push({ account_id: p[2], key: p[3], fingerprint: p[4], result: JSON.parse(p[5]) });
      return ok();
    }

    // --- carnês ---
    if (/INSERT INTO credit_accounts/i.test(s)) {
      const acc = { id: uuid(++state.seq), name: p[2], status: 'open', terms_snapshot: null, created_at: '2026-10-10T15:00:00Z' };
      state.accounts.push(acc);
      return ok([{ id: acc.id, name: acc.name }]);
    }
    if (/UPDATE credit_accounts/i.test(s)) {
      for (const a of state.accounts) {
        if (!p[0].includes(a.id)) continue;
        if (/merged_into_account_id = \$3/i.test(s)) { a.status = 'closed'; a.merged_into_account_id = p[2]; a.merged_at = '2026-10-10T15:00:00Z'; }
        else if (/status = 'merged'/i.test(s)) a.status = 'merged';
      }
      return ok();
    }
    if (/FROM credit_accounts/i.test(s)) return ok(state.accounts.map(clone));

    // --- parcelas ---
    if (/INSERT INTO credit_installments/i.test(s)) {
      const row = {
        id: uuid(++state.seq), account_id: p[6], sale_id: null,
        installment_number: p[2], total_installments: p[3],
        amount_due: Number(p[4]).toFixed(2), covered_amount: '0.00', status: 'pending',
        due_date: p[5], due_date_br: br(p[5]), past_due: false, paid_at: null,
        created_at: '2026-10-10T15:00:00Z', updated_at: '2026-10-10T15:00:00Z',
      };
      state.installments.push(row);
      return ok([{ id: row.id }]);
    }
    if (/UPDATE credit_installments/i.test(s)) {
      for (const i of state.installments) {
        if (!p[0].includes(i.id)) continue;
        if (/SET status = 'cancelled', covered_amount = 0/i.test(s)) { i.status = 'cancelled'; i.covered_amount = '0.00'; }
        else if (/SET amount_due = covered_amount/i.test(s)) {
          i.amount_due = i.covered_amount; i.status = 'paid';
          i.paid_at = i.paid_at || i.updated_at; i.account_id = p[2];
        } else if (/SET account_id = \$3/i.test(s)) i.account_id = p[2];
      }
      return ok();
    }
    if (/FROM credit_installments/i.test(s)) {
      if (/GROUP BY account_id/i.test(s)) {
        const porCarne = {};
        for (const i of state.installments.filter(x => ['pending', 'overdue'].includes(x.status))) {
          const k = i.account_id || 'null';
          porCarne[k] = porCarne[k] || { account_id: i.account_id, open_count: 0, next_due_date: i.due_date, overdue: false, to_review_count: 0 };
          porCarne[k].open_count += 1;
          if (i.due_date < porCarne[k].next_due_date) porCarne[k].next_due_date = i.due_date;
        }
        return ok(Object.values(porCarne));
      }
      if (/status IN \('pending', ?'overdue'\)/i.test(s)) return ok(state.installments.filter(i => ['pending', 'overdue'].includes(i.status)).map(clone));
      if (/status <> 'cancelled'/i.test(s)) return ok(state.installments.filter(i => i.status !== 'cancelled').map(clone));
      return ok(state.installments.map(clone));
    }

    // --- razão ---
    if (/INSERT INTO customer_credit_transactions/i.test(s)) {
      // insertLedger (reschedule.js): [company, customer, type, amount, method, notes, createdBy, accountId]
      state.txs.push({ id: uuid(++state.seq), type: p[2], amount: Number(p[3]).toFixed(2), payment_method: p[4], notes: p[5], account_id: p[7], sale_id: null, created_at: '2026-10-10T15:00:00Z' });
      return ok();
    }
    if (/UPDATE customer_credit_transactions/i.test(s)) {
      for (const t of state.txs) {
        if (/account_id = ANY\(\$3/i.test(s) && p[2].includes(t.account_id)) t.account_id = p[3];
        else if (/id = ANY\(\$3/i.test(s) && p[2].includes(t.id) && t.account_id == null && t.type === 'debit') t.account_id = p[3];
      }
      return ok();
    }
    if (/FROM customer_credit_transactions/i.test(s)) {
      if (/GROUP BY account_id/i.test(s) && /type = 'refund'/i.test(s)) {
        const m = {};
        for (const t of state.txs.filter(x => x.type === 'refund')) m[t.account_id || 'null'] = { account_id: t.account_id, total: ((m[t.account_id || 'null']?.total || 0) + parseFloat(t.amount)) };
        return ok(Object.values(m));
      }
      if (/GROUP BY account_id/i.test(s)) {
        const m = {};
        for (const t of state.txs) {
          const k = t.account_id || 'null';
          m[k] = m[k] || { account_id: t.account_id, balance: 0 };
          m[k].balance += (t.type === 'debit' ? 1 : -1) * parseFloat(t.amount);
        }
        return ok(Object.values(m));
      }
      if (/type = 'debit'/i.test(s)) {
        return ok(state.txs.filter(t => t.type === 'debit').sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(clone));
      }
      return ok(state.txs.map(clone));
    }

    // --- saldo (view) ---
    // Por último de propósito: a regra de atraso embute a view como subconsulta
    // dentro das consultas de parcela, que precisam casar antes.
    if (/cb\.company_id <> \$2/i.test(s)) return ok([]); // group_open (outras lojas)
    if (/FROM customer_credit_balances/i.test(s)) {
      const debitado = state.txs.filter(t => t.type === 'debit').reduce((a, t) => a + parseFloat(t.amount), 0);
      return ok([{ balance: saldo().toFixed(2), total_debited: debitado.toFixed(2), total_paid: (debitado - saldo()).toFixed(2) }]);
    }

    return ok();
  };
  return { responder, log, saldo };
}

// App novo a cada teste: os módulos guardam caches (coluna da migration,
// tabela de recibos) que não podem vazar de um teste para o outro.
function montar(state, opts) {
  jest.resetModules();
  const db = require('../src/config/database');
  const fake = fakeDb(state, opts);
  const client = { query: jest.fn().mockImplementation(fake.responder), release: jest.fn() };
  db.query.mockImplementation(fake.responder);
  db.connect = jest.fn().mockResolvedValue(client);

  const app = express();
  app.use(express.json());
  app.use('/companies/:id/credit', require('../src/routes/creditMerge'));
  app.use('/companies/:id/credit', require('../src/routes/credit'));
  app.use('/companies/:id/print', require('../src/routes/print'));
  return { app, fake, client };
}

const BASE = `/companies/${LOJA}/credit/customers/${CLIENTE}/accounts/merge`;
const CORPO = { account_ids: [CARNE_A, CARNE_B], installments: 3, first_due_date: '2026-11-10' };
const sem = (state) => { const c = clone(state); delete c.seq; return c; };

let info;
beforeEach(() => { info = jest.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => info.mockRestore());

describe('GET .../accounts/merge/preview', () => {
  test('devolve o plano e não grava nada', async () => {
    const state = cenario();
    const antes = sem(state);
    const { app } = montar(state);

    const res = await request(app).get(`${BASE}/preview`).query({
      account_ids: `${CARNE_A},${CARNE_B}`, installments: 3, first_due_date: '2026-11-10',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'Compras de 13/09 e 14/09',
      origins: [
        { account_id: CARNE_A, name: 'Compra de 13/09', open_remaining: 160, unscheduled: 0, remaining: 160 },
        { account_id: CARNE_B, name: 'Compra de 14/09', open_remaining: 250, unscheduled: 0, remaining: 250 },
      ],
      open_remaining: 410,
      target_total: 410,
      delta: 0,
      installments_count: 3,
      schedule: [
        { number: 1, amount_due: 136.66, due_date: '2026-11-10' },
        { number: 2, amount_due: 136.66, due_date: '2026-12-10' },
        { number: 3, amount_due: 136.68, due_date: '2027-01-10' },
      ],
    });
    expect(sem(state)).toEqual(antes);
  });

  test('preview === apply: o cronograma gravado é o que a tela mostrou', async () => {
    const s1 = cenario();
    const prev = await request(montar(s1).app).get(`${BASE}/preview`).query({
      account_ids: `${CARNE_A},${CARNE_B}`, installments: 4, first_due_date: '2026-11-10', total: 400,
    });
    const s2 = cenario();
    const apl = await request(montar(s2).app).post(BASE).send({ ...CORPO, installments: 4, total: 400 });
    expect(apl.status).toBe(200);
    for (const k of ['name', 'origins', 'open_remaining', 'target_total', 'delta', 'installments_count', 'schedule']) {
      expect(apl.body[k]).toEqual(prev.body[k]);
    }
  });

  test('as mesmas recusas do apply', async () => {
    const { app } = montar(cenario());
    const um = await request(app).get(`${BASE}/preview`).query({ account_ids: CARNE_A, installments: 2 });
    expect(um.status).toBe(400);
    expect(um.body.code).toBe('MERGE_NEEDS_TWO');
    const alheio = await request(app).get(`${BASE}/preview`).query({ account_ids: `${CARNE_A},${ALHEIO}`, installments: 2 });
    expect(alheio.status).toBe(404);
    expect(alheio.body.code).toBe('CREDIT_ACCOUNT_NOT_FOUND');
  });
});

describe('POST .../accounts/merge — o que fica no banco', () => {
  test('carnê destino, parcelas, débitos e origens', async () => {
    const state = cenario();
    const { app, fake } = montar(state);
    const saldoAntes = fake.saldo();

    const res = await request(app).post(BASE).set('Idempotency-Key', 'k-1').send(CORPO);
    expect(res.status).toBe(200);

    const destino = res.body.account.id;
    expect(res.body.account.name).toBe('Compras de 13/09 e 14/09');
    expect(res.body.merged_account_ids).toEqual([CARNE_A, CARNE_B]);
    expect(res.body.included_general).toBe(false);
    expect(res.body.adjustment).toBeNull();

    const porId = Object.fromEntries(state.installments.map(i => [i.id, i]));
    // Paga da origem: migra inteira.
    expect(porId[uuid(1)]).toMatchObject({ account_id: destino, status: 'paid', amount_due: '100.00' });
    // Paga em parte (40 de 100): encurta para o que foi pago e migra como paga.
    expect(porId[uuid(2)]).toMatchObject({ account_id: destino, status: 'paid', amount_due: '40.00', covered_amount: '40.00' });
    expect(porId[uuid(2)].paid_at).toBeTruthy();
    // Abertas sem nada pago: canceladas, ficam na origem.
    expect(porId[uuid(3)]).toMatchObject({ account_id: CARNE_A, status: 'cancelled' });
    expect(porId[uuid(4)]).toMatchObject({ account_id: CARNE_B, status: 'cancelled' });
    expect(res.body.cancelled_installment_ids).toEqual([uuid(3), uuid(4)]);
    expect(res.body.shortened_installment_ids).toEqual([uuid(2)]);
    expect(res.body.moved_paid_installment_ids).toEqual([uuid(1)]);
    // Carnê de fora da junção e o grupo sem carnê: intocados.
    expect(porId[uuid(5)]).toMatchObject({ account_id: CARNE_C, status: 'pending' });
    expect(porId[uuid(7)]).toMatchObject({ account_id: null, status: 'pending', covered_amount: '50.00' });

    // Cronograma novo no destino.
    const novas = state.installments.filter(i => res.body.applied_installment_ids.includes(i.id));
    expect(novas.map(i => [i.account_id, i.installment_number, i.total_installments, i.amount_due, i.due_date, i.status])).toEqual([
      [destino, 1, 3, '136.66', '2026-11-10', 'pending'],
      [destino, 2, 3, '136.66', '2026-12-10', 'pending'],
      [destino, 3, 3, '136.68', '2027-01-10', 'pending'],
    ]);

    // Débitos (os produtos) das duas origens passam ao destino.
    const tx = Object.fromEntries(state.txs.map(t => [t.id, t]));
    expect(tx[uuid(104)].account_id).toBe(destino);
    expect(tx[uuid(105)].account_id).toBe(destino);
    expect(tx[uuid(106)].account_id).toBe(CARNE_C);
    expect(tx[uuid(107)].account_id).toBeNull(); // recebimento livre continua livre
    expect(state.txs).toHaveLength(7);           // total não mudou: nada novo no razão

    // Origens fechadas, apontando para o destino.
    const acc = Object.fromEntries(state.accounts.map(a => [a.id, a]));
    expect(acc[CARNE_A]).toMatchObject({ status: 'closed', merged_into_account_id: destino });
    expect(acc[CARNE_B]).toMatchObject({ status: 'closed', merged_into_account_id: destino });
    expect(acc[CARNE_C].status).toBe('open');
    expect(acc[destino].status).toBe('open');

    // Juntar sem mudar o total não muda quanto a cliente deve.
    expect(fake.saldo()).toBeCloseTo(saldoAntes, 2);
    expect(res.body.new_balance).toBeCloseTo(saldoAntes, 2);

    // O que as parcelas do destino dizem: comprou 550 = pagou 140 + falta 410.
    const doDestino = state.installments.filter(i => i.account_id === destino);
    const comprou = doDestino.reduce((s, i) => s + parseFloat(i.amount_due), 0);
    const falta = doDestino.filter(i => i.status !== 'paid').reduce((s, i) => s + parseFloat(i.amount_due) - parseFloat(i.covered_amount), 0);
    expect(comprou).toBeCloseTo(550, 2);
    expect(falta).toBeCloseTo(410, 2);

    // Tudo dentro de UMA transação, travando o cliente como a renegociação.
    expect(fake.log.filter(s => s === 'BEGIN')).toHaveLength(1);
    expect(fake.log.filter(s => s === 'COMMIT')).toHaveLength(1);
    expect(fake.log.some(s => /pg_advisory_xact_lock/.test(s))).toBe(true);
    expect(fake.log.some(s => /FROM credit_installments[\s\S]*FOR UPDATE/.test(s))).toBe(true);
  });

  test('total menor = desconto: refund no razão, no carnê destino, e o saldo cai', async () => {
    const state = cenario();
    const { app, fake } = montar(state);
    const saldoAntes = fake.saldo();

    const res = await request(app).post(BASE).send({ ...CORPO, total: 360, installments: 2 });
    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(-50);
    expect(res.body.adjustment).toEqual({ type: 'discount', amount: 50 });
    expect(res.body.schedule.map(s => s.amount_due)).toEqual([180, 180]);

    const ajuste = state.txs[state.txs.length - 1];
    expect(ajuste).toMatchObject({ type: 'refund', amount: '50.00', account_id: res.body.account.id, payment_method: 'crediario_ajuste' });
    expect(fake.saldo()).toBeCloseTo(saldoAntes - 50, 2);
  });

  test('total maior = acréscimo: debit no razão e o saldo sobe', async () => {
    const state = cenario();
    const { app, fake } = montar(state);
    const saldoAntes = fake.saldo();

    const res = await request(app).post(BASE).send({ ...CORPO, total: 450 });
    expect(res.status).toBe(200);
    expect(res.body.adjustment).toEqual({ type: 'surcharge', amount: 40 });
    expect(state.txs[state.txs.length - 1]).toMatchObject({ type: 'debit', amount: '40.00', account_id: res.body.account.id });
    expect(fake.saldo()).toBeCloseTo(saldoAntes + 40, 2);
  });

  test('nome informado e intervalo quinzenal', async () => {
    const state = cenario();
    const res = await request(montar(state).app).post(BASE).send({
      ...CORPO, installments: 2, first_due_date: '2026-11-02', period_unit: 'week', period_count: 2, name: 'Parcelamento de outubro',
    });
    expect(res.status).toBe(200);
    expect(res.body.account.name).toBe('Parcelamento de outubro');
    expect(res.body.schedule.map(s => s.due_date)).toEqual(['2026-11-02', '2026-11-16']);
  });
});

describe('POST .../accounts/merge — grupo sem carnê como origem', () => {
  test("'general': a parcela aberta sem carnê sai, o débito que ela cobra migra e o recebimento livre fica", async () => {
    const state = cenario();
    const { app, fake } = montar(state);
    const saldoAntes = fake.saldo();

    const res = await request(app).post(BASE).send({ account_ids: [CARNE_B, 'general'], installments: 2, first_due_date: '2026-11-10' });
    expect(res.status).toBe(200);
    const destino = res.body.account.id;

    expect(res.body.included_general).toBe(true);
    expect(res.body.merged_account_ids).toEqual([CARNE_B]);
    expect(res.body.name).toBe('Compras de 14/09 e anteriores');
    // 250 do carnê B + 40 que faltam da parcela sem carnê. O razão do cliente
    // fecha com as parcelas (450 = 160 + 250 + 80 - 40... ver cenário), então
    // não há saldo sem parcela a repartir.
    expect(res.body.origins).toEqual([
      { account_id: CARNE_B, name: 'Compra de 14/09', open_remaining: 250, unscheduled: 0, remaining: 250 },
      { account_id: null, name: 'Compras anteriores', open_remaining: 40, unscheduled: 0, remaining: 40 },
    ]);
    expect(res.body.target_total).toBe(290);

    const porId = Object.fromEntries(state.installments.map(i => [i.id, i]));
    // A aberta sem carnê tinha 50 pagos: encurta e migra.
    expect(porId[uuid(7)]).toMatchObject({ account_id: destino, status: 'paid', amount_due: '50.00' });
    // A PAGA sem carnê é histórico do grupo: fica onde está.
    expect(porId[uuid(6)]).toMatchObject({ account_id: null, status: 'paid' });

    const tx = Object.fromEntries(state.txs.map(t => [t.id, t]));
    // Só o débito mais novo sem carnê (o que a parcela ainda cobra) migra.
    expect(tx[uuid(103)].account_id).toBe(destino);
    expect(res.body.moved_general_debit_ids).toEqual([uuid(103)]);
    // O caderno antigo já quitado e os recebimentos livres NÃO migram.
    expect(tx[uuid(101)].account_id).toBeNull();
    expect(tx[uuid(102)].account_id).toBeNull();
    expect(tx[uuid(107)].account_id).toBeNull();

    expect(fake.saldo()).toBeCloseTo(saldoAntes, 2);
  });
});

describe('POST .../accounts/merge — idempotência', () => {
  test('mesma Idempotency-Key: a segunda devolve o resultado da primeira e não junta de novo', async () => {
    const state = cenario();
    const { app } = montar(state);

    const r1 = await request(app).post(BASE).set('Idempotency-Key', 'merge-abc').send(CORPO);
    const depois = sem(state);
    const r2 = await request(app).post(BASE).set('Idempotency-Key', 'merge-abc').send(CORPO);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.replayed).toBe(true);
    expect(r2.body.account).toEqual(r1.body.account);
    expect(r2.body.applied_installment_ids).toEqual(r1.body.applied_installment_ids);
    expect(sem(state)).toEqual(depois);
    expect(state.accounts.filter(a => a.name.startsWith('Compras de'))).toHaveLength(1);
  });

  test('clique duplo com chave NOVA a cada clique: a impressão digital do pedido segura', async () => {
    const state = cenario();
    const { app } = montar(state);

    const r1 = await request(app).post(BASE).set('Idempotency-Key', 'clique-1').send(CORPO);
    const r2 = await request(app).post(BASE).set('Idempotency-Key', 'clique-2').send({ ...CORPO, account_ids: [CARNE_B, CARNE_A] });

    expect(r2.status).toBe(200);
    expect(r2.body.replayed).toBe(true);
    expect(r2.body.account.id).toBe(r1.body.account.id);
    expect(state.receipts).toHaveLength(1);
  });

  test('sem recibo (tabela ausente) a segunda tentativa não duplica: as origens já fecharam', async () => {
    const state = cenario();
    const { app, client } = montar(state);
    const original = client.query.getMockImplementation();
    const semRecibos = (sql, p) => (/credit_reschedule_receipts/i.test(String(sql))
      ? Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }))
      : original(sql, p));
    client.query.mockImplementation(semRecibos);
    require('../src/config/database').query.mockImplementation(semRecibos);

    const r1 = await request(app).post(BASE).send(CORPO);
    expect(r1.status).toBe(200);
    const depois = sem(state);
    const r2 = await request(app).post(BASE).send(CORPO);
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('CREDIT_ACCOUNT_CLOSED');
    expect(sem(state)).toEqual(depois);
  });
});

describe('POST .../accounts/merge — recusas com erro claro, nada gravado', () => {
  const casos = [
    ['uma origem só', { account_ids: [CARNE_A] }, 400, 'MERGE_NEEDS_TWO'],
    ['a mesma origem duas vezes', { account_ids: [CARNE_A, CARNE_A] }, 400, 'MERGE_NEEDS_TWO'],
    ['carnê de outro cliente/empresa', { account_ids: [CARNE_A, ALHEIO] }, 404, 'CREDIT_ACCOUNT_NOT_FOUND'],
    ['id que não é carnê', { account_ids: [CARNE_A, 'abc'] }, 404, 'CREDIT_ACCOUNT_NOT_FOUND'],
    ['parcelas zeradas', { installments: 0 }, 400, 'INVALID_INSTALLMENTS'],
    ['total zero', { total: 0 }, 400, 'INVALID_TOTAL'],
    ['data torta', { first_due_date: '10/11/2026' }, 400, 'INVALID_FIRST_DUE_DATE'],
  ];
  test.each(casos)('%s', async (_nome, over, status, code) => {
    const state = cenario();
    const antes = sem(state);
    const res = await request(montar(state).app).post(BASE).send({ ...CORPO, ...over });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(res.body.error).toBeTruthy();
    expect(sem(state)).toEqual(antes);
  });

  test('carnê já fechado: 409, com o nome do carnê na mensagem', async () => {
    const state = cenario();
    state.accounts[1].status = 'closed';
    const antes = sem(state);
    const res = await request(montar(state).app).post(BASE).send(CORPO);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CREDIT_ACCOUNT_CLOSED');
    expect(res.body.error).toContain('Compra de 14/09');
    expect(sem(state)).toEqual(antes);
  });

  test('nada em aberto: 422 NOTHING_OPEN', async () => {
    const state = cenario();
    for (const i of state.installments) {
      if ([CARNE_A, CARNE_B].includes(i.account_id)) { i.status = 'paid'; i.covered_amount = i.amount_due; }
    }
    state.txs.push({ id: uuid(190), type: 'payment', account_id: null, sale_id: null, amount: '410.00', notes: null, created_at: '2026-10-08T14:00:00Z' });
    const antes = sem(state);
    const res = await request(montar(state).app).post(BASE).send(CORPO);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NOTHING_OPEN');
    expect(sem(state)).toEqual(antes);
  });

  test('cliente que não é desta empresa nem do dono: 404 CUSTOMER_NOT_FOUND', async () => {
    const state = cenario();
    const res = await request(montar(state, { clienteExiste: false }).app).post(BASE).send(CORPO);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });
});

describe('sem a migration 369', () => {
  test("a junção funciona; a origem vira 'merged' e sai da ficha do mesmo jeito", async () => {
    const state = cenario();
    const { app } = montar(state, { colunasDaMigration: false });

    const res = await request(app).post(BASE).send(CORPO);
    expect(res.status).toBe(200);
    const acc = Object.fromEntries(state.accounts.map(a => [a.id, a]));
    expect(acc[CARNE_A].status).toBe('merged');
    expect(acc[CARNE_A].merged_into_account_id).toBeUndefined();

    const ficha = await request(app).get(`/companies/${LOJA}/credit/customer/${CLIENTE}`);
    expect(ficha.status).toBe(200);
    const ids = ficha.body.accounts.map(a => a.id);
    expect(ids).not.toContain(CARNE_A);
    expect(ids).not.toContain(CARNE_B);
    expect(ids).toContain(res.body.account.id);
  });
});

describe('depois da junção — ficha e impressão', () => {
  async function juntar() {
    const state = cenario();
    const ctx = montar(state);
    const res = await request(ctx.app).post(BASE).send(CORPO);
    expect(res.status).toBe(200);
    return { ...ctx, state, destino: res.body.account.id };
  }

  test('GET /credit/customer/:cid: um cartão para o carnê novo, com os campos da ficha', async () => {
    const { app, destino } = await juntar();
    const res = await request(app).get(`/companies/${LOJA}/credit/customer/${CLIENTE}`);
    expect(res.status).toBe(200);

    const ids = res.body.accounts.map(a => a.id);
    expect(ids).toEqual([null, CARNE_C, destino]); // origens fora; Conta geral, o carnê C e o novo
    const novo = res.body.accounts.find(a => a.id === destino);

    // Campos antigos continuam lá.
    expect(novo).toMatchObject({ name: 'Compras de 13/09 e 14/09', status: 'open', open_count: 3, next_due_date: '2026-11-10', overdue: false });
    // Campos novos.
    expect(novo.merged_from).toEqual([{ id: CARNE_A, name: 'Compra de 13/09' }, { id: CARNE_B, name: 'Compra de 14/09' }]);
    expect(novo.purchases.map(l => [l.description, l.quantity, l.amount])).toEqual([
      ['Vans Hylane 40/41', 1, 220],
      ['Meia cano alto', 2, 80],
      ['Bota Chelsea', 1, 250],
    ]);
    expect(novo.purchases_total).toBe(550);
    expect(novo.total_amount).toBe(550);
    expect(novo.total_count).toBe(5);  // 2 pagas (uma encurtada) + 3 novas
    expect(novo.paid_count).toBe(2);
    expect(novo.paid_installments.map(p => [p.installment_number, p.due_date, p.amount])).toEqual([
      [1, '2026-10-13', 100],
      [2, '2026-11-13', 40],
    ]);
    expect(novo.paid_installments[0].paid_at).toBe('2026-10-05T14:00:00Z');
    expect(novo.open_remaining).toBe(410);
    expect(novo.remaining).toBe(410);

    // As parcelas a pagar continuam em open_installments, com o account_id do carnê.
    expect(res.body.open_installments.filter(i => i.account_id === destino)).toHaveLength(3);

    // O grupo sem carnê ganha os mesmos campos.
    const geral = res.body.accounts.find(a => a.id === null);
    expect(geral).toMatchObject({ total_count: 2, paid_count: 1, open_remaining: 40, remaining: 40, merged_from: [] });
    expect(geral.purchases.map(l => l.description)).toEqual(['Saldo do caderno']);
  });

  test('GET /print/credit/:cid/carne?account=<destino>&format=a4: produtos de TODAS as origens e resumo fechando', async () => {
    const { app, destino } = await juntar();
    const res = await request(app).get(`/companies/${LOJA}/print/credit/${CLIENTE}/carne`).query({ account: destino, format: 'a4', autoprint: 0 });
    expect(res.status).toBe(200);
    const html = res.text;

    expect(html).toContain('Compras de 13/09 e 14/09');
    for (const produto of ['Vans Hylane 40/41', 'Meia cano alto', 'Bota Chelsea']) expect(html).toContain(produto);
    // Nada do carnê que ficou de fora nem do grupo sem carnê.
    expect(html).not.toContain('Saldo do caderno');
    expect(html).not.toContain('Lancamento manual');
    // Comprou 550 = Já pagou 140 + Falta pagar 410.
    expect(html).toContain('550,00');
    expect(html).toContain('140,00');
    expect(html).toContain('410,00');
    // As três parcelas novas viram cupom; as canceladas das origens não aparecem.
    for (const valor of ['136,66', '136,68']) expect(html).toContain(valor);
    for (const vencimento of ['13/12/2026', '14/10/2026']) expect(html).not.toContain(vencimento);
  });

  test('a térmica do carnê novo também lista os produtos das duas compras', async () => {
    const { app, destino } = await juntar();
    const res = await request(app).get(`/companies/${LOJA}/print/credit/${CLIENTE}/carne`).query({ account: destino });
    expect(res.status).toBe(200);
    for (const produto of ['Vans Hylane 40/41', 'Meia cano alto', 'Bota Chelsea']) expect(res.text).toContain(produto);
  });

  test('carnê de origem deixa de ter o que imprimir (as parcelas dele saíram)', async () => {
    const { app } = await juntar();
    const res = await request(app).get(`/companies/${LOJA}/print/credit/${CLIENTE}/carne`).query({ account: CARNE_B, format: 'a4', autoprint: 0 });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Bota Chelsea');
  });
});

describe('ficha antes de juntar — um cartão por carnê', () => {
  test('cada carnê traz itens, N de M pagas, parcelas pagas e quanto falta', async () => {
    const { app } = montar(cenario());
    const res = await request(app).get(`/companies/${LOJA}/credit/customer/${CLIENTE}`);
    expect(res.status).toBe(200);

    const a = res.body.accounts.find(x => x.id === CARNE_A);
    expect(a).toMatchObject({
      name: 'Compra de 13/09', total_count: 3, paid_count: 1,
      open_remaining: 160, unscheduled: 0, remaining: 160,
      total_amount: 300, purchases_total: 300, refunded_total: 0,
      created_at: '2026-09-13T15:00:00Z', merged_from: [],
    });
    expect(a.purchases.map(l => l.description)).toEqual(['Vans Hylane 40/41', 'Meia cano alto']);
    expect(a.paid_installments).toEqual([{
      id: uuid(1), installment_number: 1, total_installments: 3,
      due_date: '2026-10-13', paid_at: '2026-10-05T14:00:00Z', amount: 100,
    }]);
    // `balance` continua sendo o razão por carnê (300: o pagamento foi livre) —
    // por isso a ficha deve usar `remaining`.
    expect(a.balance).toBe(300);

    const c = res.body.accounts.find(x => x.id === CARNE_C);
    expect(c.purchases).toEqual([expect.objectContaining({ description: 'Lancamento manual', amount: 80, manual: true })]);
  });

  test('falha ao montar o detalhe não derruba a ficha: campos novos zerados', async () => {
    const state = cenario();
    const { app } = montar(state);
    const db = require('../src/config/database');
    const original = db.query.getMockImplementation();
    db.query.mockImplementation((sql, p) => (/SELECT \* FROM credit_accounts/i.test(String(sql))
      ? Promise.reject(new Error('statement timeout'))
      : original(sql, p)));
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/companies/${LOJA}/credit/customer/${CLIENTE}`);
    erro.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.accounts.length).toBeGreaterThan(0);
    for (const acc of res.body.accounts) {
      expect(acc).toMatchObject({ purchases: [], total_count: 0, paid_count: 0, paid_installments: [], remaining: 0, merged_from: [] });
    }
  });
});
