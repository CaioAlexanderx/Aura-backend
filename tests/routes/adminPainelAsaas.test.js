// ============================================================
// /admin/painel/asaas — pagamentos sem loja e correção de vencimentos.
//
// Banco e Asaas de mentira (dados inventados). O palpite é só mostrado;
// quem grava é o POST de vincular, com a empresa que a pessoa escolheu.
// ============================================================
'use strict';

jest.mock('../../src/services/asaasClient', () => ({ asaas: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const { asaas } = require('../../src/services/asaasClient');
const router = require('../../src/routes/adminPainelAsaas');

const id = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const log = (n) => `dddddddd-0000-4000-8000-00000000000${n}`;
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const staff = jwt.sign({ id: USER, role: 'admin' }, 'aura-test-secret-2026');
const cliente = jwt.sign({ id: USER, role: 'client', company: id(2) }, 'aura-test-secret-2026');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/painel/asaas', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const api = (metodo, url, token = staff) => request(makeApp())[metodo]('/admin/painel/asaas' + url).set('Authorization', 'Bearer ' + token);

const LOGS = [
  { id: log(3), event: 'PAYMENT_RECEIVED', processed_at: '2026-10-12T13:10:00.000Z', pagamento_id: 'pay_3', cliente_asaas: 'cus_orfao', assinatura: 'sub_orfa', referencia: null, vencimento: '2026-10-12', pago_em: '2026-10-12', forma: 'CREDIT_CARD', valor: '140.83' },
  { id: log(2), event: 'PAYMENT_RECEIVED', processed_at: '2026-10-03T13:10:00.000Z', pagamento_id: 'pay_2', cliente_asaas: 'cus_orfao', assinatura: 'sub_orfa', referencia: null, vencimento: '2026-10-03', pago_em: '2026-10-03', forma: 'CREDIT_CARD', valor: '140.83' },
  { id: log(1), event: 'PAYMENT_RECEIVED', processed_at: '2026-09-29T13:10:00.000Z', pagamento_id: 'pay_1', cliente_asaas: 'cus_sumido', assinatura: null, referencia: id(4), vencimento: '2026-09-29', pago_em: '2026-09-29', forma: 'PIX', valor: '89.00' },
];
const CANDIDATAS = [
  { company_id: id(1), nome: 'Loja Aurora', telefone: '11999900001', status: 'active', asaas_customer_id: null, asaas_subscription_id: null, doc: '12345678000190', email: 'contato@lojaaurora.example', email_dono: 'dona@lojaaurora.example' },
  { company_id: id(2), nome: 'Aurora Filial', telefone: null, status: 'trial', asaas_customer_id: 'cus_outro', asaas_subscription_id: null, doc: '', email: '', email_dono: 'dona@lojaaurora.example' },
  { company_id: id(4), nome: 'Bazar Novo', telefone: null, status: 'active', asaas_customer_id: null, asaas_subscription_id: null, doc: '', email: '', email_dono: '' },
];

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { db.query.mockReset(); asaas.mockReset(); jest.restoreAllMocks(); });

describe('acesso', () => {
  test('sem token → 401; cliente comum → 403; nada é consultado', async () => {
    expect((await request(makeApp()).get('/admin/painel/asaas/orfaos')).status).toBe(401);
    for (const [metodo, url] of [['get', '/orfaos'], ['post', `/orfaos/${log(1)}/vincular`], ['post', '/corrigir-vencimentos']]) {
      expect((await api(metodo, url, cliente)).status).toBe(403);
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(asaas).not.toHaveBeenCalled();
  });
});

describe('GET /orfaos', () => {
  function ligar() {
    db.query.mockImplementation(async (sql) => ({ rows: sql.includes('FROM webhook_logs') ? LOGS : CANDIDATAS }));
    asaas.mockImplementation(async (metodo, caminho) => {
      if (caminho === '/customers/cus_orfao') {
        return { id: 'cus_orfao', name: 'Helena Duarte', email: 'Dona@LojaAurora.example', cpfCnpj: '12.345.678/0001-90', mobilePhone: '11999900001' };
      }
      throw new Error('Asaas error 404');
    });
  }

  test('lista os registros sem empresa com customer, valor, data e o cliente da Asaas', async () => {
    ligar();
    const res = await api('get', '/orfaos');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.orfaos[0]).toMatchObject({
      log_id: log(3), evento: 'PAYMENT_RECEIVED', quando: '2026-10-12T13:10:00.000Z', valor: 140.83,
      vencimento: '2026-10-12', pagamento_id: 'pay_3', cliente_asaas: 'cus_orfao', assinatura: 'sub_orfa',
      cliente: { nome: 'Helena Duarte', email: 'Dona@LojaAurora.example', cpf_cnpj: '12.345.678/0001-90', telefone: '11999900001', referencia: null },
    });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain("provider = 'asaas' AND company_id IS NULL");
    // o pagamento é lido na raiz do payload ou em payload.payment
    expect(sql).toContain("COALESCE(payload->'payment', payload)->>'customer' AS cliente_asaas");
    // cada cliente da Asaas é lido uma vez só
    expect(asaas.mock.calls.map((c) => c[1])).toEqual(['/customers/cus_orfao', '/customers/cus_sumido']);
  });

  test('palpite por CPF/CNPJ e e-mail; quem bate em mais coisas vem primeiro', async () => {
    ligar();
    const res = await api('get', '/orfaos');
    expect(res.body.orfaos[0].palpites).toEqual([
      { company_id: id(1), nome: 'Loja Aurora', telefone: '11999900001', status: 'active', motivos: ['cpf_cnpj', 'email'], asaas_customer_id: null },
      { company_id: id(2), nome: 'Aurora Filial', telefone: null, status: 'trial', motivos: ['email'], asaas_customer_id: 'cus_outro' },
    ]);
    // a busca vai com o documento só em dígitos e o e-mail em minúsculas
    const [docs, emails, refs, assinaturas] = db.query.mock.calls[1][1];
    expect(docs).toEqual(['12345678000190']);
    expect(emails).toEqual(['dona@lojaaurora.example']);
    expect(refs).toEqual([id(4)]);
    expect(assinaturas).toEqual(['sub_orfa']);
  });

  test('cliente que a Asaas não devolve: avisa e ainda palpita pela referência da cobrança', async () => {
    ligar();
    const res = await api('get', '/orfaos');
    expect(res.body.asaas_disponivel).toBe(false);
    expect(res.body.orfaos[2]).toMatchObject({
      cliente_asaas: 'cus_sumido', cliente: null,
      palpites: [{ company_id: id(4), nome: 'Bazar Novo', motivos: ['referencia'] }],
    });
  });

  test('listar não grava nada', async () => {
    ligar();
    await api('get', '/orfaos');
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });

  test('sem órfãos não chama a Asaas', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await api('get', '/orfaos');
    expect(res.body).toEqual({ total: 0, asaas_disponivel: true, orfaos: [] });
    expect(asaas).not.toHaveBeenCalled();
  });
});

describe('POST /orfaos/:logId/vincular', () => {
  // `empresa` e `registro` podem ser null (não encontrados).
  function ligar({ registro = { id: log(3), company_id: null, event: 'PAYMENT_RECEIVED', cliente_asaas: 'cus_orfao' }, empresa = { id: id(1), nome: 'Loja Aurora', asaas_customer_id: null }, logsVinculados = 2 } = {}) {
    const escritas = [];
    db.query.mockImplementation(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id, company_id, event')) return { rows: registro ? [registro] : [] };
      if (s.startsWith('SELECT c.id')) return { rows: empresa ? [empresa] : [] };
      escritas.push({ sql: s, params });
      return { rows: [], rowCount: s.startsWith('UPDATE webhook_logs') ? logsVinculados : 1 };
    });
    return escritas;
  }
  const vincular = (logId, body, token) => api('post', `/orfaos/${logId}/vincular`, token).send(body);

  test('grava o cliente da Asaas na empresa (estava vazio) e a empresa nos registros dele', async () => {
    const escritas = ligar();
    const res = await vincular(log(3), { company_id: id(1) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, log_id: log(3), company_id: id(1), nome: 'Loja Aurora',
      cliente_asaas: 'cus_orfao', cliente_gravado: true, cliente_da_empresa: 'cus_orfao', logs_vinculados: 2,
    });

    const [empresa, logs, auditoria] = escritas;
    expect(empresa.sql).toContain("SET asaas_customer_id = $1, updated_at = NOW() WHERE id = $2 AND (asaas_customer_id IS NULL OR asaas_customer_id = '')");
    expect(empresa.params).toEqual(['cus_orfao', id(1)]);
    // este registro e os outros sem loja do mesmo cliente; nunca um já vinculado
    expect(logs.sql).toContain("WHERE provider = 'asaas' AND company_id IS NULL");
    expect(logs.params).toEqual([id(1), log(3), 'cus_orfao']);
    expect(auditoria.sql).toContain("INSERT INTO admin_audit_log");
    expect(auditoria.params.slice(0, 2)).toEqual([USER, id(1)]);
    expect(JSON.parse(auditoria.params[2])).toMatchObject({ cliente_gravado: true, logs_vinculados: 2 });
    // não mexe em status nem em datas de cobrança
    for (const e of escritas) expect(e.sql).not.toMatch(/billing_status|next_billing_date|last_payment_date/);
  });

  test('empresa que já tem outro cliente da Asaas: vincula o registro e não troca o cliente', async () => {
    const escritas = ligar({ empresa: { id: id(1), nome: 'Loja Aurora', asaas_customer_id: 'cus_antigo' }, logsVinculados: 1 });
    const res = await vincular(log(3), { company_id: id(1) });
    expect(res.body).toMatchObject({ cliente_gravado: false, cliente_da_empresa: 'cus_antigo', logs_vinculados: 1 });
    expect(escritas.some((e) => e.sql.startsWith('UPDATE companies'))).toBe(false);
    expect(escritas.some((e) => e.sql.startsWith('UPDATE webhook_logs'))).toBe(true);
  });

  test('registro já vinculado a outra empresa → 409, sem gravar', async () => {
    const escritas = ligar({ registro: { id: log(3), company_id: id(2), event: 'PAYMENT_RECEIVED', cliente_asaas: 'cus_orfao' } });
    const res = await vincular(log(3), { company_id: id(1) });
    expect(res.status).toBe(409);
    expect(escritas).toHaveLength(0);
  });

  test('registro ou empresa que não existe → 404; company_id ausente ou torto → 400', async () => {
    let escritas = ligar({ registro: null });
    expect((await vincular(log(9), { company_id: id(1) })).status).toBe(404);
    expect(escritas).toHaveLength(0);

    escritas = ligar({ empresa: null });
    expect((await vincular(log(3), { company_id: id(9) })).status).toBe(404);
    expect(escritas).toHaveLength(0);

    db.query.mockReset();
    expect((await vincular(log(3), {})).status).toBe(400);
    expect((await vincular(log(3), { company_id: 'loja aurora' })).status).toBe(400);
    expect((await vincular('nao-e-uuid', { company_id: id(1) })).status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST /corrigir-vencimentos', () => {
  function ligar() {
    const escritas = [];
    db.query.mockImplementation(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT')) {
        return { rows: [{ company_id: id(1), nome: 'Loja Aurora', status: 'active', asaas_subscription_id: 'sub_1', atual: '2026-09-15' }] };
      }
      escritas.push({ sql: s, params });
      return { rows: [], rowCount: 1 };
    });
    asaas.mockImplementation(async (metodo, caminho) => (
      caminho.includes('/payments') ? { data: [] } : { id: 'sub_1', status: 'ACTIVE', nextDueDate: '2026-10-15' }
    ));
    return escritas;
  }

  test('sem { aplicar: true } é dry-run: devolve a tabela e não grava', async () => {
    for (const body of [undefined, {}, { aplicar: 'sim' }, { aplicar: false }]) {
      const escritas = ligar();
      const res = await api('post', '/corrigir-vencimentos').send(body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ aplicado: false, total: 1, corrigir: 1, corrigidos: 0 });
      expect(res.body.linhas[0]).toMatchObject({ nome: 'Loja Aurora', antes: '2026-09-15', depois: '2026-10-15', situacao: 'corrigir' });
      expect(escritas).toHaveLength(0);
    }
  });

  test('com { aplicar: true } grava a data e o audit_log em nome de quem pediu', async () => {
    const escritas = ligar();
    const res = await api('post', '/corrigir-vencimentos').send({ aplicar: true });
    expect(res.body).toMatchObject({ aplicado: true, corrigidos: 1 });
    expect(escritas.map((e) => e.sql.split(' ').slice(0, 3).join(' '))).toEqual(['UPDATE companies SET', 'INSERT INTO audit_log']);
    expect(escritas[1].params.slice(0, 3)).toEqual([USER, id(1), 'billing.next_due_corrected']);
  });
});
