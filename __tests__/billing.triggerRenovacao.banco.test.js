// ============================================================
// AURA. — Trigger de renovação respeita a data da Asaas
// (Postgres real, cartão ti-03, 18/10/2026)
//
// O CASO REAL: tr_billing_renewal_from_due_date (BEFORE UPDATE em companies)
// fazia, sempre que last_payment_date mudava para não nulo,
//   next_billing_date := OLD.next_billing_date + 1 mês
// e jogava fora a data que o próprio UPDATE gravava. O webhook da Asaas
// grava o próximo vencimento que a Asaas devolve — o trigger descartava.
// Com OLD nulo o resultado era nulo (Luis Henrique, 17/10).
//
// A 393 troca o corpo da função:
//   a) UPDATE informou data nova (não nula, diferente da anterior) → fica
//   b) senão → COALESCE(anterior, data do pagamento) + 1 mês
//   billing_status vira 'active' como antes.
//
// Mesmo padrão dos outros *.banco.test.js: conecta direto no Postgres do CI
// (todas as migrations aplicadas, inclusive a 393), tudo dentro de UMA
// transação revertida no afterAll; cada teste num SAVEPOINT próprio.
// O db mockado do jest.setup é redirecionado para essa conexão, para o
// webhook de verdade falar com o banco de verdade.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const SECRET = 'segredo-de-teste-trigger-393';

let pool;
let client;
let db;
let asaas;
let app;
let ownerId;
let sp = 0;

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  jest.resetModules();
  process.env.ASAAS_WEBHOOK_SECRET = SECRET; // lido no carregamento do módulo
  jest.doMock('../src/services/asaasClient', () => ({ asaas: jest.fn() }));
  jest.doMock('../src/services/digitalOrderNotifications', () => ({
    notifyPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
  }));
  db = require('../src/config/database');
  ({ asaas } = require('../src/services/asaasClient'));
  app = express();
  app.use(express.json());
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));

  ownerId = uuid();
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture 393')`,
    [ownerId, `fixture-393-${ownerId}@example.test`]
  );
});

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  sp += 1;
  await client.query(`SAVEPOINT t393_${sp}`);
});

afterEach(async () => {
  await client.query(`ROLLBACK TO SAVEPOINT t393_${sp}`);
  jest.restoreAllMocks();
});

afterAll(async () => {
  delete process.env.ASAAS_WEBHOOK_SECRET;
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

// ── helpers ──────────────────────────────────────────────────────────────

async function novaEmpresa({ next = null, last = null, status = 'overdue', customer = null, sub = null } = {}) {
  const id = uuid();
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, next_billing_date, last_payment_date,
                            billing_status, asaas_customer_id, asaas_subscription_id)
     VALUES ($1, $2, 'Fixture 393', $3, $4, $5, $6, $7)`,
    [id, ownerId, next, last, status, customer, sub]
  );
  return id;
}

async function ler(id) {
  const { rows } = await client.query(
    `SELECT to_char(next_billing_date, 'YYYY-MM-DD') AS next,
            to_char(last_payment_date, 'YYYY-MM-DD') AS last,
            billing_status::text AS status
       FROM companies WHERE id = $1`,
    [id]
  );
  return rows[0];
}

// Asaas: responde por caminho (assinatura e cobranças pendentes).
function ligarAsaas({ nextDueDate, pendentes = [] }) {
  asaas.mockImplementation(async (metodo, caminho) => {
    if (/\/payments\?/.test(caminho)) {
      return { data: pendentes.map((d, i) => ({ id: 'pay_p' + i, status: 'PENDING', dueDate: d })) };
    }
    if (caminho.startsWith('/subscriptions/')) return { id: 'sub_393', status: 'ACTIVE', nextDueDate };
    return undefined;
  });
}

const webhook = (body) =>
  request(app).post('/webhooks/asaas').set('asaas-access-token', SECRET).send(body);

// ── a função instalada ───────────────────────────────────────────────────

test('a 393 instalou a função nova e o trigger BEFORE UPDATE em companies', async () => {
  const { rows } = await client.query(
    `SELECT pg_get_triggerdef(t.oid) AS def, pg_get_functiondef(t.tgfoid) AS fn
       FROM pg_trigger t
      WHERE t.tgname = 'tr_billing_renewal_from_due_date'
        AND t.tgrelid = 'public.companies'::regclass`
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].def).toMatch(/BEFORE UPDATE ON public\.companies FOR EACH ROW/);
  expect(rows[0].fn).toMatch(/COALESCE\(OLD\.next_billing_date, NEW\.last_payment_date\)/);
});

// ── (a) quem atualiza informa a data: ela fica ───────────────────────────

describe('webhook da Asaas: a data que a Asaas devolve é a que fica', () => {
  test('pagamento recebido grava o próximo vencimento da Asaas, não anterior + 1 mês', async () => {
    // Cobrança de 15/10 paga com atraso em 20/10; na Asaas o próximo é 15/11.
    // Antes: OLD (15/10) + 1 mês = 15/11 — acertava por coincidência. Aqui o
    // vencimento gravado está um ciclo para trás (15/09) e a Asaas manda 15/11:
    // o antigo daria 15/10.
    const id = await novaEmpresa({ next: '2026-09-15', last: '2026-08-15', customer: 'cus_393a', sub: 'sub_393' });
    ligarAsaas({ nextDueDate: '2026-12-15', pendentes: ['2026-11-15'] });

    const res = await webhook({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_393a', customer: 'cus_393a', subscription: 'sub_393', value: 140.83,
        dueDate: '2026-10-15', paymentDate: '2026-10-20', status: 'RECEIVED', externalReference: id,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handled: true, status: 'active', next_billing_date: '2026-11-15' });
    expect(await ler(id)).toEqual({ next: '2026-11-15', last: '2026-10-20', status: 'active' });
  });

  test('primeiro pagamento de empresa sem data: fica a data da Asaas (antes ficava NULL)', async () => {
    const id = await novaEmpresa({ next: null, last: null, status: 'pending', customer: 'cus_393b', sub: 'sub_393' });
    ligarAsaas({ nextDueDate: '2026-11-16' });

    await webhook({
      event: 'PAYMENT_CONFIRMED',
      payment: {
        id: 'pay_393b', customer: 'cus_393b', subscription: 'sub_393', value: 99,
        dueDate: '2026-10-16', paymentDate: '2026-10-17', status: 'CONFIRMED', externalReference: id,
      },
    });

    expect(await ler(id)).toEqual({ next: '2026-11-16', last: '2026-10-17', status: 'active' });
  });

  test('checkout com cartão (billing.js / dojoSaasCheckout.js): fica o nextDueDate da assinatura', async () => {
    // Mesmo UPDATE dos dois checkouts: last_payment_date + next_billing_date juntos.
    const id = await novaEmpresa({ next: '2026-10-25', last: null, status: 'trial' });
    await client.query(
      `UPDATE companies SET billing_status = $1, last_payment_date = $2, next_billing_date = $3, updated_at = NOW()
        WHERE id = $4`,
      ['active', '2026-10-18', '2026-11-18', id]
    );
    // Antes: OLD (25/10, fim do trial) + 1 mês = 25/11.
    expect(await ler(id)).toEqual({ next: '2026-11-18', last: '2026-10-18', status: 'active' });
  });
});

// ── (b) quem atualiza não informa a data: anterior + 1 mês ───────────────

describe('só last_payment_date muda: soma 1 mês', () => {
  test('ao vencimento anterior (comportamento de hoje mantido)', async () => {
    const id = await novaEmpresa({ next: '2026-10-15', last: '2026-09-14' });
    await client.query(`UPDATE companies SET last_payment_date = $1 WHERE id = $2`, ['2026-10-14', id]);
    expect(await ler(id)).toEqual({ next: '2026-11-15', last: '2026-10-14', status: 'active' });
  });

  test('anterior nulo: data do pagamento + 1 mês (antes ficava NULL)', async () => {
    // O caso do Luis Henrique, 17/10.
    const id = await novaEmpresa({ next: null, last: null });
    await client.query(`UPDATE companies SET last_payment_date = $1 WHERE id = $2`, ['2026-10-16', id]);
    expect(await ler(id)).toEqual({ next: '2026-11-16', last: '2026-10-16', status: 'active' });
  });

  test('webhook sem resposta da Asaas (COALESCE mantém a data): soma 1 mês ao anterior', async () => {
    const id = await novaEmpresa({ next: '2026-10-15', last: '2026-09-15', customer: 'cus_393c', sub: 'sub_393' });
    asaas.mockRejectedValue(new Error('Asaas fora do ar'));

    await webhook({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_393c', customer: 'cus_393c', subscription: 'sub_393', value: 140.83,
        dueDate: '2026-10-15', paymentDate: '2026-10-15', status: 'RECEIVED', externalReference: id,
      },
    });

    expect(await ler(id)).toEqual({ next: '2026-11-15', last: '2026-10-15', status: 'active' });
  });

  test('UPDATE mandando next_billing_date NULL explícito não apaga a data: anterior + 1 mês', async () => {
    // billing.js e dojoSaasCheckout.js passam subscription.nextDueDate cru: se a
    // Asaas não devolvesse o campo, o valor seria NULL.
    const id = await novaEmpresa({ next: '2026-10-15', last: '2026-09-15' });
    await client.query(
      `UPDATE companies SET last_payment_date = $1, next_billing_date = $2 WHERE id = $3`,
      ['2026-10-15', null, id]
    );
    expect(await ler(id)).toEqual({ next: '2026-11-15', last: '2026-10-15', status: 'active' });
  });

  test('fim de mês: 31/01 + 1 mês = 28/02 (aritmética do Postgres, igual a hoje)', async () => {
    const id = await novaEmpresa({ next: '2027-01-31', last: '2026-12-31' });
    await client.query(`UPDATE companies SET last_payment_date = $1 WHERE id = $2`, ['2027-01-30', id]);
    expect((await ler(id)).next).toBe('2027-02-28');
  });
});

// ── billing_status e quando o trigger NÃO age ────────────────────────────

describe('billing_status e eventos que não são pagamento novo', () => {
  test.each(['overdue', 'pending', 'trial', 'cancelled'])('%s vira active quando o pagamento entra', async (status) => {
    const id = await novaEmpresa({ next: '2026-10-15', last: '2026-09-15', status });
    await client.query(`UPDATE companies SET last_payment_date = $1 WHERE id = $2`, ['2026-10-15', id]);
    expect((await ler(id)).status).toBe('active');
  });

  test('last_payment_date não muda (reenvio, GREATEST): nada mexe na data nem no status', async () => {
    const id = await novaEmpresa({ next: '2026-11-15', last: '2026-10-15', status: 'overdue' });
    await client.query(
      `UPDATE companies SET last_payment_date = GREATEST($1::date, last_payment_date) WHERE id = $2`,
      ['2026-10-15', id]
    );
    expect(await ler(id)).toEqual({ next: '2026-11-15', last: '2026-10-15', status: 'overdue' });
  });

  test('correção de vencimento sem pagamento (asaasVencimentos.js) grava a data como veio', async () => {
    const id = await novaEmpresa({ next: '2026-09-15', last: '2026-09-15', status: 'active' });
    await client.query(`UPDATE companies SET next_billing_date = $1::date WHERE id = $2`, ['2026-10-15', id]);
    expect(await ler(id)).toEqual({ next: '2026-10-15', last: '2026-09-15', status: 'active' });
  });

  test('last_payment_date indo para NULL: o trigger não age', async () => {
    const id = await novaEmpresa({ next: '2026-11-15', last: '2026-10-15', status: 'active' });
    await client.query(`UPDATE companies SET last_payment_date = NULL, billing_status = 'pending' WHERE id = $1`, [id]);
    expect(await ler(id)).toEqual({ next: '2026-11-15', last: null, status: 'pending' });
  });
});

// ── caso de borda: data informada IGUAL à gravada ───────────────────────

describe('borda: a data informada é a mesma que já estava gravada', () => {
  test('trigger sozinho (caminho 2, troca de plano no cartão no mesmo dia do mês): soma 1 mês', async () => {
    // UPDATE que mexe nas duas colunas ao mesmo tempo, como o checkout com
    // cartão. Igual à gravada é lido como "não informou". Fica documentado.
    const id = await novaEmpresa({ next: '2026-11-18', last: '2026-10-01', status: 'active' });
    await client.query(
      `UPDATE companies SET last_payment_date = $1, next_billing_date = $2 WHERE id = $3`,
      ['2026-10-18', '2026-11-18', id]
    );
    expect((await ler(id)).next).toBe('2026-12-18');
  });

  test('webhook (caminho 1): pagamento atrasado depois da correção de vencimento fica com 15/11, não 15/12', async () => {
    // Cobrança de 15/10 em atraso (OVERDUE, fora da lista de pendentes); a
    // rotina de correção já tinha gravado 15/11 (a próxima pendente). O
    // pagamento atrasado entra em 20/10 e a Asaas devolve 15/11 de novo. O
    // segundo UPDATE do webhook, que não mexe em last_payment_date, faz valer
    // a data da Asaas mesmo quando ela coincide com a gravada.
    const id = await novaEmpresa({ next: '2026-11-15', last: '2026-09-15', customer: 'cus_393d', sub: 'sub_393' });
    ligarAsaas({ nextDueDate: '2026-12-15', pendentes: ['2026-11-15'] });

    const res = await webhook({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_393d', customer: 'cus_393d', subscription: 'sub_393', value: 140.83,
        dueDate: '2026-10-15', paymentDate: '2026-10-20', status: 'RECEIVED', externalReference: id,
      },
    });

    expect(res.body).toMatchObject({ handled: true, status: 'active', next_billing_date: '2026-11-15' });
    expect(await ler(id)).toEqual({ next: '2026-11-15', last: '2026-10-20', status: 'active' });
  });

  test('webhook: o pagamento seguinte, em dia, anda um ciclo só (15/11 → 15/12)', async () => {
    const id = await novaEmpresa({ next: '2026-11-15', last: '2026-10-20', customer: 'cus_393e', sub: 'sub_393' });
    ligarAsaas({ nextDueDate: '2027-01-15', pendentes: ['2026-12-15'] });

    await webhook({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_393e', customer: 'cus_393e', subscription: 'sub_393', value: 140.83,
        dueDate: '2026-11-15', paymentDate: '2026-11-15', status: 'RECEIVED', externalReference: id,
      },
    });

    expect(await ler(id)).toEqual({ next: '2026-12-15', last: '2026-11-15', status: 'active' });
  });
});
