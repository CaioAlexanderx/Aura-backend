// ============================================================
// AURA. -- Cobranca do saldo da encomenda, INDEPENDENTE do crediario
//
// POST /studio/orders/:oid/cobrar-saldo
//
// O Studio nao tem crediario -- nao existe fiado no mercado de
// personalizados. As rotas de /credit ficam atras de
// assertCrediarioEnabled, entao cobrar por la exigiria a lojista ligar um
// produto que ela nao usa so pra receber uma encomenda que JA vendeu.
//
// O que estes testes travam:
//   1. cobrar funciona SEM crediario_enabled -- o ponto da separacao
//   2. a parcela e resolvida a partir do PEDIDO, nunca de um id solto
//      (senao a rota vira porta lateral pro ledger de credito inteiro)
//   3. escopo por empresa em todas as pontas
//   4. so parcela em aberto; quitada/paga/cancelada da 404
//   5. o texto usa vocabulario de ENCOMENDA -- e o cliente final que le
//   6. a extracao do motor nao mudou a rota de crediario existente
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const oid = 'sale-encomenda-1';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

let db;
let app;

const PARCELA = {
  id: 'inst-1', customer_id: 'cust-1', sale_id: oid, company_id: cid,
  amount_due: '140.00', covered_amount: '0', due_date: '2026-08-24',
  installment_number: 1, total_installments: 1, status: 'pending',
  customer_name: 'Maria Sheid', phone: '11988887777', store_name: 'Sheid Mania',
};

function buildApp() {
  jest.resetModules();
  process.env.JWT_SECRET = SECRET;
  db = require('../../src/config/database');
  const studioRouter = require('../../src/routes/studioKdsApproval');
  const a = express();
  a.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/studio', studioRouter);
  a.use('/api/v1/companies/:id', scoped);
  return a;
}

function mockDb({ parcela = PARCELA, hasTable = true } = {}) {
  const client = {
    query: jest.fn().mockImplementation((sql) => {
      const s = String(sql || '');
      if (/FROM credit_installments/i.test(s)) {
        return Promise.resolve({ rows: parcela ? [parcela] : [] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  db.connect.mockResolvedValue(client);
  db.query.mockImplementation((sql) => {
    if (/to_regclass/i.test(String(sql))) {
      return Promise.resolve({ rows: [{ t: hasTable ? 'credit_installments' : null }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return client;
}

const cobrar = (body) => request(app)
  .post(`/api/v1/companies/${cid}/studio/orders/${oid}/cobrar-saldo`)
  .set(adminAuth).send(body || {});

const sqlsOf = (client) => client.query.mock.calls.map((c) => String(c[0] || ''));

beforeEach(() => {
  jest.resetAllMocks();
  app = buildApp();
});

describe('POST /studio/orders/:oid/cobrar-saldo — sem crediário', () => {
  // O ponto da separação: nenhuma consulta a crediario_enabled em lugar
  // nenhum do caminho. Se alguém montar esta rota atrás do gate, quebra aqui.
  test('cobra sem exigir crediario_enabled', async () => {
    const client = mockDb();

    const res = await cobrar();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const todos = [...sqlsOf(client), ...db.query.mock.calls.map((c) => String(c[0] || ''))];
    expect(todos.join(' ')).not.toMatch(/crediario_enabled/i);
  });

  test('devolve mensagem, telefone e Pix pro app abrir o WhatsApp', async () => {
    mockDb();
    const res = await cobrar();

    expect(res.body).toMatchObject({ phone: '11988887777', installment_id: 'inst-1' });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('pix_copia_cola');
  });
});

describe('a parcela sai do PEDIDO, não de um id solto', () => {
  test('resolve pela venda e filtra por empresa, status e saldo restante', async () => {
    const client = mockDb();
    await cobrar();

    const sel = sqlsOf(client).find((s) => /FROM credit_installments/i.test(s));
    expect(sel).toMatch(/ci\.sale_id\s*=\s*\$2/i);        // vem do :oid
    expect(sel).toMatch(/ci\.company_id\s*=\s*\$1/i);     // escopo por empresa
    expect(sel).toMatch(/NOT IN \('paid', 'cancelled'\)/i);
    expect(sel).toMatch(/>\s*0\.005/);                    // só saldo real

    const params = client.query.mock.calls.find((c) => /FROM credit_installments/i.test(String(c[0])))[1];
    expect(params).toEqual([cid, oid]);
  });

  // Se aceitasse installment_id do body, esta rota seria uma porta lateral
  // pro ledger de crédito inteiro, sem o gate que protege o resto.
  test('ignora installment_id mandado no body', async () => {
    const client = mockDb();
    await cobrar({ installment_id: 'inst-de-outra-empresa' });

    const params = client.query.mock.calls.find((c) => /FROM credit_installments/i.test(String(c[0])))[1];
    expect(params).not.toContain('inst-de-outra-empresa');
  });

  test('404 quando a encomenda não tem saldo em aberto', async () => {
    mockDb({ parcela: null });

    const res = await cobrar();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_OPEN_BALANCE');
  });

  test('409 quando o ambiente não tem a tabela de parcelas', async () => {
    mockDb({ hasTable: false });

    const res = await cobrar();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BALANCE_UNAVAILABLE');
  });

  test('401 sem token', async () => {
    mockDb();
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/studio/orders/${oid}/cobrar-saldo`).send({});
    expect(res.status).toBe(401);
  });
});

// O texto vai pro CLIENTE FINAL. "parcela 1/1" é vocabulário de fiado
// vazando numa conversa sobre uma camisa personalizada.
describe('vocabulário da mensagem', () => {
  const { buildMessage } = require('../../src/services/credit/collectionNotice');
  const base = {
    customerName: 'Maria', storeName: 'Sheid Mania', amount: '140,00',
    dueDate: '24/08/2026', installmentNum: 1, totalInstallments: 1,
    pixLink: '00020126BR', daysLate: '0',
  };

  test('template "encomenda" fala de encomenda e saldo, nunca de parcela', () => {
    const msg = buildMessage('encomenda', { ...base, daysLateNum: -3 });
    expect(msg).toMatch(/encomenda/i);
    expect(msg).toMatch(/saldo/i);
    expect(msg).not.toMatch(/parcela/i);
    expect(msg).not.toMatch(/credi[áa]rio/i);
    expect(msg).toContain('Sheid Mania');
    expect(msg).toContain('140,00');
    expect(msg).toContain('00020126BR');
  });

  test('o tom acompanha a data, sem trocar de template', () => {
    expect(buildMessage('encomenda', { ...base, daysLateNum: -3 })).toMatch(/vence em/i);
    expect(buildMessage('encomenda', { ...base, daysLateNum: 0 })).toMatch(/vence \*hoje\*/i);
    expect(buildMessage('encomenda', { ...base, daysLateNum: 5 })).toMatch(/venceu em/i);
  });

  test('sem Pix configurado, a mensagem sai mesmo assim', () => {
    const msg = buildMessage('encomenda', { ...base, pixLink: '', daysLateNum: 0 });
    expect(msg).toMatch(/saldo/i);
    expect(msg).not.toMatch(/Pix copia-e-cola/i);
  });

  // Extração não pode ter mudado o crediário do Negócio.
  test('templates do crediário seguem intactos', () => {
    expect(buildMessage('atraso_1', { ...base, daysLate: '5' })).toMatch(/parcela 1\/1.*5 dias.*em atraso/i);
    expect(buildMessage('lembrete', base)).toMatch(/Lembrete: a parcela 1\/1/i);
    expect(buildMessage('vencimento', base)).toMatch(/vence \*hoje\*/i);
    // template desconhecido continua caindo em lembrete
    expect(buildMessage('inexistente', base)).toMatch(/Lembrete/i);
  });
});
