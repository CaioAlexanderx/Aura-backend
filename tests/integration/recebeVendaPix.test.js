// ============================================================
// AURA. — Testes: Pix do Caixa pelo Recebe na Aura, com confirmação (RA-10)
// Cobre:
//   cria a cobrança Pix da parte Pix da venda, na subconta, com split e
//     externalReference recebe:venda:<id>; QR (copia-e-cola + imagem) devolvido
//   clique duplo: uma cobrança só (reserva + reaproveitamento)
//   aviso PAYMENT_RECEIVED confirma a venda uma vez (reenvio e
//     PAYMENT_CONFIRMED + PAYMENT_RECEIVED não confirmam duas vezes)
//   cancelamento: cancela na Asaas, não confirma; já pago → 409 e confirma
//   Pix pago depois de cancelar / com a venda cancelada → atenção, sem estorno
//   venda cancelada no Caixa: Pix aguardando é cancelado; pago ganha atenção
//   loja sem subconta aprovada → disponibilidade diz não (Pix de hoje)
//   flag desligada → nada muda (sem banco, sem Asaas)
//   multi-CNPJ: a venda de outra loja não é achada; o aviso de uma subconta
//     não mexe na venda de outra
//
// Banco mockado por SQL (tabelas em memória), Asaas simulada (global.fetch).
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = 'd'.repeat(64); // 32 bytes hex (só teste)
process.env.ASAAS_API_KEY = 'mother-key-test';
delete process.env.ASAAS_ENV;

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, baasCrypto, svc;
const realFetch = global.fetch;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  baasCrypto = require('../../src/services/dojoBaasCrypto');
  svc = require('../../src/services/recebeVendaPix');
});
afterAll(() => { global.fetch = realFetch; });

const SECRET = 'aura-test-secret-2026';
const WALLET = 'carteira-aura-de-teste';
const AVISO_TOKEN = 'whsec_aviso_de_teste_do_caixa_0123456789';
const SUB_KEY_A = '$aact_CHAVE_SUBCONTA_A_TESTE_111';
const SUB_KEY_B = '$aact_CHAVE_SUBCONTA_B_TESTE_222';
const companyA = 'a0000000-0000-4000-8000-00000000000a';
const companyB = 'b0000000-0000-4000-8000-00000000000b';
const ownerA = 'e0000000-0000-4000-8000-0000000000a1';
const ownerB = 'e0000000-0000-4000-8000-0000000000b1';
const venda1 = 'c0000000-0000-4000-8000-0000000000c1';
const venda2 = 'c0000000-0000-4000-8000-0000000000c2';
const vendaB = 'c0000000-0000-4000-8000-0000000000cb';
const cliente = 'f0000000-0000-4000-8000-0000000000f1';
const CNPJ_LOJA = '12345678000199';
const CPF_CLI = '12345678909';

let baas, sales, customers, vpix, events, asaas, calls, seq;

const rowsOf = (r) => Promise.resolve({ rows: r });
const OWNERS = { [companyA]: ownerA, [companyB]: ownerB };

function liveOf(saleId) {
  return vpix.find((r) => r.sale_id === saleId && ['criando', 'aguardando', 'confirmado'].includes(r.status));
}

function fakeQuery(sql, params = []) {
  const s = String(sql);
  if (s.includes("SELECT 'owner' AS role")) {
    return rowsOf(OWNERS[params[0]] === params[1] ? [{ role: 'owner' }] : []);
  }
  // ── recebe_webhook_events (idempotência do aviso) ──
  if (s.includes('recebe_webhook_events')) {
    if (/^\s*INSERT INTO recebe_webhook_events/.test(s)) {
      const [eventId, event, accountId, paymentId, extRef, , , outcome] = params;
      if (events[eventId]) return rowsOf([]);
      const id = `ev-${++seq}`;
      events[eventId] = { id, event, accountId, paymentId, extRef, outcome, company_id: null };
      return rowsOf([{ id }]);
    }
    if (/SET outcome = \$2/.test(s)) {
      const [id, outcome, detail, companyId] = params;
      const ev = Object.values(events).find((e) => e.id === id);
      if (ev) Object.assign(ev, { outcome, detail, company_id: companyId });
      return rowsOf([]);
    }
    return rowsOf([]);
  }
  // ── recebe_venda_pix ──
  if (s.includes('recebe_venda_pix')) {
    if (/^\s*INSERT INTO recebe_venda_pix/.test(s)) {
      const [cid, sid, ref, value, createdBy] = params;
      if (liveOf(sid)) return rowsOf([]); // índice único parcial
      const row = {
        id: `vp-${++seq}`, company_id: cid, sale_id: sid, status: 'criando', asaas_payment_id: null,
        external_reference: ref, value, aura_fee: null, pix_payload: null, pix_expires_at: null,
        confirmed_at: null, cancelled_at: null, atencao: null, created_by: createdBy, created_at: new Date(),
      };
      vpix.push(row);
      return rowsOf([{ id: row.id }]);
    }
    if (/^\s*DELETE FROM recebe_venda_pix/.test(s)) {
      vpix = vpix.filter((r) => !(r.id === params[0] && r.status === 'criando'));
      return rowsOf([]);
    }
    if (/WHERE sale_id = \$1 AND id <> \$2/.test(s)) {
      const r = vpix.find((x) => x.sale_id === params[0] && x.id !== params[1] && ['criando', 'aguardando', 'confirmado'].includes(x.status));
      return rowsOf(r ? [{ id: r.id }] : []);
    }
    if (/SET status = 'aguardando', cancelled_at = NULL/.test(s)) {
      const [id, de] = params;
      const r = vpix.find((x) => x.id === id && x.status === de);
      if (!r || (sales[r.sale_id] && sales[r.sale_id].status === 'cancelled')) return rowsOf([]);
      Object.assign(r, { status: 'aguardando', cancelled_at: null });
      return rowsOf([{ ...r }]);
    }
    if (/SET status = 'expirado'/.test(s)) {
      const r = vpix.find((x) => x.id === params[0] && x.status === 'aguardando');
      if (!r) return rowsOf([]);
      r.status = 'expirado';
      return rowsOf([{ id: r.id }]);
    }
    if (/SET status = 'aguardando'/.test(s)) {
      const [id, pay, fee, payload, exp] = params;
      if (vpix.some((r) => r.asaas_payment_id === pay)) {
        const e = new Error('duplicate key'); e.code = '23505'; return Promise.reject(e);
      }
      const r = vpix.find((x) => x.id === id && x.status === 'criando');
      if (!r) return rowsOf([]);
      Object.assign(r, { status: 'aguardando', asaas_payment_id: pay, aura_fee: fee, pix_payload: payload, pix_expires_at: exp });
      return rowsOf([{ ...r }]);
    }
    if (/SET status = 'confirmado'/.test(s)) {
      const [id, evId, de] = params;
      const r = vpix.find((x) => x.id === id && x.status === de);
      if (!r) return rowsOf([]);
      r.status = 'confirmado';
      r.confirmed_at = new Date();
      r.confirmed_event_id = evId;
      r.confirmacoes = (r.confirmacoes || 0) + 1;
      if (sales[r.sale_id] && sales[r.sale_id].status === 'cancelled') r.atencao = 'pago_com_venda_cancelada';
      return rowsOf([{ ...r }]);
    }
    if (/SET atencao = \$2/.test(s)) {
      const [id, at, only] = params;
      const r = vpix.find((x) => x.id === id && x.status === only && x.atencao !== at);
      if (!r) return rowsOf([]);
      r.atencao = at;
      return rowsOf([{ ...r }]);
    }
    if (/SET status = 'cancelado'/.test(s)) {
      const [id, by, de] = params;
      const r = vpix.find((x) => x.id === id && x.status === (params.length >= 3 ? de : 'aguardando'));
      if (!r) return rowsOf([]);
      Object.assign(r, { status: 'cancelado', cancelled_at: new Date(), cancelled_by: by || null });
      return rowsOf([{ ...r }]);
    }
    if (/WHERE asaas_payment_id = \$1 AND company_id = \$2 AND sale_id = \$3/.test(s)) {
      const r = vpix.find((x) => x.asaas_payment_id === params[0] && x.company_id === params[1] && x.sale_id === params[2]);
      return rowsOf(r ? [{ ...r }] : []);
    }
    if (/WHERE company_id = \$1 AND sale_id = \$2/.test(s)) {
      const mine = vpix.filter((x) => x.company_id === params[0] && x.sale_id === params[1]);
      const live = mine.find((x) => ['criando', 'aguardando', 'confirmado'].includes(x.status));
      const r = live || mine[mine.length - 1];
      return rowsOf(r ? [{ ...r }] : []);
    }
    if (/WHERE company_id = \$1 AND/.test(s)) {
      let list = vpix.filter((x) => x.company_id === params[0]);
      if (/AND status = 'aguardando'/.test(s)) list = list.filter((x) => x.status === 'aguardando');
      else if (/AND atencao IS NOT NULL/.test(s)) list = list.filter((x) => x.atencao);
      else list = list.filter((x) => x.status === 'aguardando' || x.atencao);
      return rowsOf(list.map((x) => ({ ...x })));
    }
    return rowsOf([]);
  }
  // ── company_baas_accounts ──
  if (s.includes('company_baas_accounts')) {
    if (/WHERE asaas_account_id = \$1/.test(s)) {
      const row = Object.values(baas).find((r) => r.asaas_account_id === params[0]);
      return rowsOf(row ? [{ company_id: row.company_id }] : []);
    }
    const row = baas[params[0]];
    return rowsOf(row ? [{ ...row, tem_chave: !!row.api_key_enc }] : []);
  }
  if (/FROM sales s/.test(s) && /pix_amount/.test(s)) {
    const sale = sales[params[0]];
    if (!sale || sale.company_id !== params[1]) return rowsOf([]);
    return rowsOf([{ id: sale.id, status: sale.status, customer_id: sale.customer_id || null, pix_amount: String(sale.pix) }]);
  }
  if (/FROM customers WHERE id = \$1/.test(s)) {
    const c = customers[params[0]];
    return rowsOf(c ? [{ ...c }] : []);
  }
  return rowsOf([]);
}

const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });

function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v3/, '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  const key = opts.headers && opts.headers.access_token;
  calls.push({ method, path, query: Object.fromEntries(u.searchParams), body, key });
  if (asaas.fora) return Promise.resolve(resp(503, { errors: [{ description: 'fora' }] }));
  if (method === 'GET' && path === '/payments') {
    const ref = u.searchParams.get('externalReference');
    return Promise.resolve(resp(200, { data: asaas.payments.filter((p) => p.key === key && p.externalReference === ref && !p.deleted) }));
  }
  if (method === 'GET' && path === '/customers') {
    return Promise.resolve(resp(200, { data: asaas.customers.filter((c) => c.key === key && c.cpfCnpj === u.searchParams.get('cpfCnpj')) }));
  }
  if (method === 'POST' && path === '/customers') {
    const c = { id: `cus_${asaas.customers.length + 1}`, key, ...body };
    asaas.customers.push(c);
    return Promise.resolve(resp(200, c));
  }
  if (method === 'POST' && path === '/payments') {
    const p = { id: `pay_${asaas.payments.length + 1}`, key, status: 'PENDING', ...body };
    asaas.payments.push(p);
    return Promise.resolve(resp(200, p));
  }
  const m = path.match(/^\/payments\/([^/]+)(\/pixQrCode)?$/);
  if (m) {
    const p = asaas.payments.find((x) => x.id === m[1] && x.key === key);
    if (!p) return Promise.resolve(resp(404, { errors: [{ description: 'não encontrada' }] }));
    if (m[2]) return Promise.resolve(resp(200, { payload: `0002-pix-${p.id}`, encodedImage: 'iVBORw0KGgo', expirationDate: '2026-11-26 23:59:59' }));
    if (method === 'GET') return Promise.resolve(resp(200, p));
    if (method === 'DELETE') {
      if (['RECEIVED', 'CONFIRMED'].includes(p.status)) {
        return Promise.resolve(resp(400, { errors: [{ description: 'Não é possível remover cobrança recebida.' }] }));
      }
      p.deleted = true;
      return Promise.resolve(resp(200, { deleted: true, id: p.id }));
    }
  }
  return Promise.resolve(resp(404, { errors: [{ description: 'rota não simulada' }] }));
}

const auth = (userId) => ({
  Authorization: `Bearer ${jwt.sign({ id: userId, email: `${userId}@loja.com.br`, type: 'access' }, SECRET, { expiresIn: '1h' })}`,
});
const base = (cid) => `/api/v1/companies/${cid}/pdv`;
const pixUrl = (cid, sid) => `${base(cid)}/sale/${sid}/recebe-pix`;
const WEBHOOK = '/api/v1/webhooks/asaas-recebe';

function subcontaAprovada(cid, key, accId, extra = {}) {
  baas[cid] = {
    company_id: cid, asaas_account_id: accId, status: 'approved', api_key_enc: baasCrypto.encrypt(key),
    kyc_snapshot: { cpf_cnpj: CNPJ_LOJA, name: 'Loja A' }, ...extra,
  };
}
function venda(id, cid, pix, extra = {}) {
  sales[id] = { id, company_id: cid, status: 'completed', pix, ...extra };
}
const aviso = (id, event, paymentId, saleId, accId = 'acc_A') => ({
  id, event, dateCreated: '2026-11-25 10:00:00',
  account: { id: accId },
  payment: { object: 'payment', id: paymentId, status: event === 'PAYMENT_CONFIRMED' ? 'CONFIRMED' : 'RECEIVED', value: 50, externalReference: `recebe:venda:${saleId}` },
});
// Token POR SUBCONTA: HMAC-SHA256(segredo, company_id da subconta do corpo).
const tokenDe = (master, cid) => require('crypto').createHmac('sha256', master).update(cid).digest('hex');
const postAviso = (body) => {
  const row = Object.values(baas).find((r) => r.asaas_account_id === body.account.id);
  return request(app).post(WEBHOOK).set('asaas-access-token', tokenDe(AVISO_TOKEN, row ? row.company_id : 'x')).send(body);
};
const pagar = (paymentId) => { const p = asaas.payments.find((x) => x.id === paymentId); p.status = 'RECEIVED'; };

let logSpies;
beforeEach(() => {
  baas = {}; sales = {}; customers = {}; vpix = []; events = {}; seq = 0; calls = [];
  asaas = { payments: [], customers: [], fora: false };
  db.query.mockReset();
  db.query.mockImplementation(fakeQuery);
  global.fetch = jest.fn(fakeFetch);
  process.env.RECEBE_AURA_WALLET_ID = WALLET;
  process.env.RECEBE_ASAAS_WEBHOOK_TOKEN = AVISO_TOKEN;
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m));
});
afterEach(() => {
  delete process.env.RECEBE_NA_AURA_ENABLED;
  delete process.env.RECEBE_AURA_WALLET_ID;
  delete process.env.RECEBE_ASAAS_WEBHOOK_TOKEN;
  delete process.env.RECEBE_PIX_CONSUMIDOR_NO_CAIXA;
  logSpies.forEach((sp) => sp.mockRestore());
});
const loggedText = () => logSpies.map((sp) => JSON.stringify(sp.mock.calls)).join('\n');
const recebeQueries = () => db.query.mock.calls.filter(([sql]) => /recebe_venda_pix|company_baas_accounts/.test(String(sql)));

describe('flag desligada: nada muda', () => {
  test('disponibilidade diz não, sem banco nem Asaas', async () => {
    subcontaAprovada(companyA, SUB_KEY_A, 'acc_A');
    const r = await request(app).get(`${base(companyA)}/recebe-pix/disponivel`).set(auth(ownerA));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ disponivel: false, motivo: 'indisponivel' });
    expect(recebeQueries()).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('criar, consultar, cancelar e listar → 404, sem banco nem Asaas', async () => {
    subcontaAprovada(companyA, SUB_KEY_A, 'acc_A');
    venda(venda1, companyA, 50);
    const rs = await Promise.all([
      request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA)),
      request(app).get(pixUrl(companyA, venda1)).set(auth(ownerA)),
      request(app).delete(pixUrl(companyA, venda1)).set(auth(ownerA)),
      request(app).get(`${base(companyA)}/recebe-pix`).set(auth(ownerA)),
    ]);
    for (const r of rs) {
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('RECEBE_INDISPONIVEL');
    }
    expect(recebeQueries()).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('venda cancelada no Caixa: o gancho não toca o banco', async () => {
    await expect(svc.depoisDeCancelarVenda(companyA, venda1)).resolves.toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('flag ligada', () => {
  beforeEach(() => {
    process.env.RECEBE_NA_AURA_ENABLED = 'true';
    process.env.RECEBE_PIX_CONSUMIDOR_NO_CAIXA = 'true';
    subcontaAprovada(companyA, SUB_KEY_A, 'acc_A');
    subcontaAprovada(companyB, SUB_KEY_B, 'acc_B');
  });

  describe('disponibilidade (senão, o Caixa segue com o Pix de hoje)', () => {
    test('loja aprovada → disponível', async () => {
      const r = await request(app).get(`${base(companyA)}/recebe-pix/disponivel`).set(auth(ownerA));
      expect(r.body).toEqual({ disponivel: true, motivo: null });
    });

    test.each([
      ['sem subconta', () => { delete baas[companyA]; }, 'sem_subconta'],
      ['subconta em análise', () => { baas[companyA].status = 'under_review'; }, 'conta_nao_aprovada'],
      ['sem chave', () => { baas[companyA].api_key_enc = null; }, 'em_conferencia'],
      ['sem carteira da Aura', () => { delete process.env.RECEBE_AURA_WALLET_ID; }, 'split_nao_configurado'],
      ['sem token do aviso', () => { delete process.env.RECEBE_ASAAS_WEBHOOK_TOKEN; }, 'aviso_nao_configurado'],
    ])('%s → não disponível (%s)', async (_n, arrumar, motivo) => {
      arrumar();
      const r = await request(app).get(`${base(companyA)}/recebe-pix/disponivel`).set(auth(ownerA));
      expect(r.body).toEqual({ disponivel: false, motivo });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('migration 466 pendente: não oferece; criar → 503 sem chamar a Asaas', async () => {
      db.query.mockImplementation((sql, params) => {
        if (String(sql).includes('recebe_venda_pix')) {
          const e = new Error('relation "recebe_venda_pix" does not exist'); e.code = '42P01';
          return Promise.reject(e);
        }
        return fakeQuery(sql, params);
      });
      venda(venda1, companyA, 50);
      const d = await request(app).get(`${base(companyA)}/recebe-pix/disponivel`).set(auth(ownerA));
      expect(d.body).toEqual({ disponivel: false, motivo: 'schema_pendente' });
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('SCHEMA_PENDING');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('loja sem subconta aprovada: criar recusa sem chamar a Asaas nem deixar linha', async () => {
      baas[companyA].status = 'docs_pending';
      venda(venda1, companyA, 50);
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('RECEBE_CONTA_NAO_APROVADA');
      expect(vpix).toHaveLength(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('criar', () => {
    test('cobrança Pix da parte Pix da venda, na subconta, com split e referência da venda; QR devolvido', async () => {
      venda(venda1, companyA, 50);
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        reused: false, sale_id: venda1, status: 'aguardando', payment_id: 'pay_1', value: 50, aura_fee: 1,
        pix: { payload: '0002-pix-pay_1', encoded_image: 'iVBORw0KGgo', expiration_date: '2026-11-26 23:59:59' },
        confirmed_at: null, atencao: null,
      });
      const post = calls.find((c) => c.method === 'POST' && c.path === '/payments');
      expect(post.body).toMatchObject({
        billingType: 'PIX', value: 50, externalReference: `recebe:venda:${venda1}`,
        split: [{ walletId: WALLET, fixedValue: 1 }],
      });
      for (const c of calls) expect(c.key).toBe(SUB_KEY_A);
      // sem cliente na venda: o pagador é o "Consumidor no Caixa" com o documento da loja
      const cust = calls.find((c) => c.method === 'POST' && c.path === '/customers');
      expect(cust.body).toMatchObject({ name: 'Consumidor no Caixa', cpfCnpj: CNPJ_LOJA, notificationDisabled: true });
      expect(vpix).toHaveLength(1);
      expect(vpix[0]).toMatchObject({ status: 'aguardando', asaas_payment_id: 'pay_1', company_id: companyA, created_by: ownerA });
      const txt = JSON.stringify(r.body) + loggedText();
      expect(txt).not.toContain(SUB_KEY_A);
      expect(txt).not.toContain(CNPJ_LOJA);
    });

    test('cliente da venda com CPF vira o pagador; customer no body vence', async () => {
      customers[cliente] = { name: 'Maria', cpf_cnpj: '123.456.789-09' };
      venda(venda1, companyA, 30, { customer_id: cliente });
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(calls.find((c) => c.method === 'POST' && c.path === '/customers').body).toMatchObject({ name: 'Maria', cpfCnpj: CPF_CLI });

      calls = [];
      venda(venda2, companyA, 20, { customer_id: cliente });
      await request(app).post(pixUrl(companyA, venda2)).set(auth(ownerA))
        .send({ customer: { name: 'João', cpf_cnpj: '529.982.247-25' } });
      expect(calls.find((c) => c.method === 'POST' && c.path === '/customers').body).toMatchObject({ name: 'João', cpfCnpj: '52998224725' });
    });

    test('clique duplo: uma cobrança só; o segundo devolve a mesma, com QR', async () => {
      venda(venda1, companyA, 50);
      const r1 = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      const r2 = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(200);
      expect(r2.body).toMatchObject({ reused: true, payment_id: 'pay_1', pix: { payload: '0002-pix-pay_1' } });
      expect(asaas.payments).toHaveLength(1);
      expect(vpix).toHaveLength(1);
    });

    test('dois cliques ao mesmo tempo: só quem reservou chama a Asaas', async () => {
      venda(venda1, companyA, 50);
      const [r1, r2] = await Promise.all([
        request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA)),
        request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA)),
      ]);
      // um cria (201); o outro devolve a mesma (200) ou espera a reserva (409)
      const st = [r1.status, r2.status].sort();
      expect(st[0] === 201 ? st[1] : st[0]).toBe(st[0] === 201 ? 409 : 200);
      expect(st.filter((x) => x === 201)).toHaveLength(1);
      expect(asaas.payments).toHaveLength(1);
      expect(vpix).toHaveLength(1);
    });

    test('reserva de outra chamada em andamento: 409 em criação, sem chamar a Asaas', async () => {
      venda(venda1, companyA, 50);
      vpix.push({ id: 'vp-r', company_id: companyA, sale_id: venda1, status: 'criando', value: 50, created_at: new Date() });
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('RECEBE_PIX_EM_CRIACAO');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('reserva parada há mais de 2 minutos (processo morreu): é retomada', async () => {
      venda(venda1, companyA, 50);
      vpix.push({ id: 'vp-r', company_id: companyA, sale_id: venda1, status: 'criando', value: 50, created_at: new Date(Date.now() - 3 * 60000) });
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(201);
      expect(vpix.map((x) => x.status)).toEqual(['aguardando']);
    });

    test('Asaas fora: 502 e a reserva sai (a nova tentativa cria)', async () => {
      venda(venda1, companyA, 50);
      asaas.fora = true;
      const r1 = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r1.status).toBe(502);
      expect(vpix).toHaveLength(0);
      asaas.fora = false;
      const r2 = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r2.status).toBe(201);
    });

    test('valor em Pix mudou depois de gerar: 409 pedindo para cancelar e gerar de novo', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      sales[venda1].pix = 40;
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('RECEBE_PIX_VALOR_MUDOU');
      expect(r.body.recebe_pix).toMatchObject({ status: 'aguardando', value: 50 });
      expect(asaas.payments).toHaveLength(1);
    });

    test.each([
      ['venda de outra loja (multi-CNPJ)', () => venda(vendaB, companyB, 50), vendaB, 404, 'VENDA_NAO_ENCONTRADA'],
      ['venda cancelada', () => venda(venda1, companyA, 50, { status: 'cancelled' }), venda1, 409, 'VENDA_CANCELADA'],
      ['venda sem Pix', () => venda(venda1, companyA, 0), venda1, 422, 'VENDA_SEM_PIX'],
    ])('%s → %s %s, sem Asaas', async (_n, arrumar, sid, st, code) => {
      arrumar();
      const r = await request(app).post(pixUrl(companyA, sid)).set(auth(ownerA));
      expect(r.status).toBe(st);
      expect(r.body.code).toBe(code);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('dono da loja A não cria Pix na venda da loja B', async () => {
      venda(vendaB, companyB, 50);
      const r = await request(app).post(pixUrl(companyB, vendaB)).set(auth(ownerA));
      expect(r.status).toBe(403);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('aviso da Asaas confirma a venda', () => {
    async function gerado() {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      pagar('pay_1');
    }

    test('PAYMENT_RECEIVED confirma uma vez; reenvio e PAYMENT_CONFIRMED não confirmam de novo', async () => {
      await gerado();
      const a1 = await postAviso(aviso('evt_1', 'PAYMENT_RECEIVED', 'pay_1', venda1));
      expect(a1.status).toBe(200);
      expect(a1.body).toMatchObject({ handled: true, outcome: 'processed' });
      expect(vpix[0]).toMatchObject({ status: 'confirmado', confirmacoes: 1 });

      const a2 = await postAviso(aviso('evt_1', 'PAYMENT_RECEIVED', 'pay_1', venda1)); // reenvio
      expect(a2.body).toMatchObject({ duplicate: true });
      const a3 = await postAviso(aviso('evt_2', 'PAYMENT_CONFIRMED', 'pay_1', venda1)); // outro evento, mesmo pagamento
      expect(a3.body).toMatchObject({ handled: false, outcome: 'registered' });
      expect(vpix[0].confirmacoes).toBe(1);

      const r = await request(app).get(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.body).toMatchObject({ status: 'confirmado', payment_id: 'pay_1', pix: null, atencao: null });
      expect(r.body.confirmed_at).toBeTruthy();
    });

    test('polling: GET só lê o banco (nunca a Asaas)', async () => {
      await gerado();
      calls = [];
      const r = await request(app).get(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.body).toMatchObject({ status: 'aguardando', pix: { payload: '0002-pix-pay_1' } });
      expect(calls).toHaveLength(0);
    });

    test('aviso de outra subconta (com o token dela) não confirma a venda da loja A (multi-CNPJ)', async () => {
      await gerado();
      const a = await postAviso(aviso('evt_9', 'PAYMENT_RECEIVED', 'pay_1', venda1, 'acc_B'));
      expect(a.status).toBe(200);
      expect(a.body.handled).toBe(false);
      expect(vpix[0].status).toBe('aguardando');
    });

    test('aviso antes de a linha sair de "criando": 500 para a Asaas reenviar', async () => {
      venda(venda1, companyA, 50);
      vpix.push({ id: 'vp-x', company_id: companyA, sale_id: venda1, status: 'criando', asaas_payment_id: null, value: 50, created_at: new Date() });
      const a = await postAviso(aviso('evt_3', 'PAYMENT_RECEIVED', 'pay_77', venda1));
      expect(a.status).toBe(500);
      expect(events.evt_3.outcome).toBe('error');
    });

    test('estorno avisado depois de confirmado: atenção, sem mexer em dinheiro', async () => {
      await gerado();
      await postAviso(aviso('evt_1', 'PAYMENT_RECEIVED', 'pay_1', venda1));
      await postAviso({ ...aviso('evt_4', 'PAYMENT_REFUNDED', 'pay_1', venda1) });
      expect(vpix[0]).toMatchObject({ status: 'confirmado', atencao: 'estornado' });
      expect(calls.some((c) => c.method === 'POST' && /refund/.test(c.path))).toBe(false);
    });
  });

  describe('cancelar (a lojista desistiu)', () => {
    test('cancela na Asaas e não confirma; gerar de novo cria outra cobrança', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      const r = await request(app).delete(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'cancelado', confirmed_at: null, pix: null });
      expect(asaas.payments[0].deleted).toBe(true);
      expect(calls.find((c) => c.method === 'DELETE').key).toBe(SUB_KEY_A);
      expect(sales[venda1].status).toBe('completed'); // a venda não muda

      const again = await request(app).delete(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(again.status).toBe(200); // idempotente

      const novo = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(novo.status).toBe(201);
      expect(novo.body.payment_id).toBe('pay_2');
    });

    test('já pago na Asaas (aviso ainda não chegou): 409 e confirma', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      pagar('pay_1');
      const r = await request(app).delete(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('RECEBE_PIX_JA_PAGO');
      expect(r.body.recebe_pix).toMatchObject({ status: 'confirmado' });
      expect(vpix[0].status).toBe('confirmado');
      // e o aviso que chega depois não confirma de novo
      await postAviso(aviso('evt_5', 'PAYMENT_RECEIVED', 'pay_1', venda1));
      expect(vpix[0].confirmacoes).toBe(1);
    });

    test('Pix pago depois de cancelar: atenção pago_depois_de_cancelar, nada estornado', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      await request(app).delete(pixUrl(companyA, venda1)).set(auth(ownerA));
      const a = await postAviso(aviso('evt_6', 'PAYMENT_RECEIVED', 'pay_1', venda1));
      expect(a.status).toBe(200);
      expect(vpix[0]).toMatchObject({ status: 'cancelado', atencao: 'pago_depois_de_cancelar' });
      const lista = await request(app).get(`${base(companyA)}/recebe-pix?situacao=atencao`).set(auth(ownerA));
      expect(lista.body.items).toEqual([expect.objectContaining({
        sale_id: venda1, atencao: 'pago_depois_de_cancelar', atencao_texto: expect.stringContaining('não devolve nada sozinha'),
      })]);
    });

    test('sem Pix pelo Recebe na venda → 404', async () => {
      venda(venda1, companyA, 50);
      const r = await request(app).delete(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('RECEBE_PIX_NAO_ENCONTRADO');
    });
  });

  describe('venda cancelada no Caixa', () => {
    test('Pix aguardando: cancelado na Asaas', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      sales[venda1].status = 'cancelled';
      const out = await svc.depoisDeCancelarVenda(companyA, venda1, ownerA);
      expect(out).toMatchObject({ status: 'cancelado' });
      expect(asaas.payments[0].deleted).toBe(true);
    });

    test('Pix já confirmado: atenção venda_cancelada_com_pix_pago (sem estorno)', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      pagar('pay_1');
      await postAviso(aviso('evt_7', 'PAYMENT_RECEIVED', 'pay_1', venda1));
      sales[venda1].status = 'cancelled';
      const out = await svc.depoisDeCancelarVenda(companyA, venda1, ownerA);
      expect(out).toMatchObject({ status: 'confirmado', atencao: 'venda_cancelada_com_pix_pago' });
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    test('Pix que cai com a venda já cancelada: atenção pago_com_venda_cancelada', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      sales[venda1].status = 'cancelled';
      asaas.fora = true; // não deu para cancelar na Asaas: fica aguardando
      const out = await svc.depoisDeCancelarVenda(companyA, venda1, ownerA);
      expect(out).toMatchObject({ status: 'aguardando' });
      asaas.fora = false;
      await postAviso(aviso('evt_8', 'PAYMENT_RECEIVED', 'pay_1', venda1));
      expect(vpix[0]).toMatchObject({ status: 'confirmado', atencao: 'pago_com_venda_cancelada' });
    });

    test('venda sem Pix pelo Recebe: null (resposta do cancelamento fica a de sempre)', async () => {
      await expect(svc.depoisDeCancelarVenda(companyA, venda1, ownerA)).resolves.toBeNull();
    });

    // DELETE /pdv/sale/:saleId de verdade (transação simulada no client).
    let ordem;
    function clienteDaTransacao() {
      return {
        release: jest.fn(() => ordem.push('release')),
        query: jest.fn((sql) => {
          const s = String(sql);
          if (/SELECT id, customer_id, employee_id, total_amount, coupon_id, status/.test(s)) {
            const v = sales[venda1];
            return rowsOf([{ id: venda1, customer_id: null, employee_id: null, total_amount: '50.00', coupon_id: null, status: v.status }]);
          }
          if (/UPDATE sales SET status='cancelled'/.test(s)) sales[venda1].status = 'cancelled';
          return rowsOf([]);
        }),
      };
    }

    test('rota: cancelar a venda devolve recebe_pix e cancela o Pix aguardando, depois de devolver a conexão', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      ordem = [];
      const fetchBase = global.fetch.getMockImplementation();
      global.fetch.mockImplementation((url, opts = {}) => { ordem.push(`asaas ${opts.method || 'GET'}`); return fetchBase(url, opts); });
      db.connect.mockImplementation(() => clienteDaTransacao());
      const r = await request(app).delete(`${base(companyA)}/sale/${venda1}`).set(auth(ownerA));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, cancelled: venda1, recebe_pix: { status: 'cancelado' } });
      expect(asaas.payments[0].deleted).toBe(true);
      expect(ordem[0]).toBe('release');
      expect(ordem).toContain('asaas DELETE');
    });

    test('rota de remover o último item do lançamento (a venda é cancelada): mesmo gancho', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      ordem = [];
      const item = 'ab000000-0000-4000-8000-0000000000a9';
      const tx = 'ac000000-0000-4000-8000-0000000000a8';
      db.connect.mockImplementation(() => ({
        release: jest.fn(() => ordem.push('release')),
        query: jest.fn((sql) => {
          const s = String(sql);
          if (/FROM transactions WHERE id = \$1 AND company_id = \$2 FOR UPDATE/.test(s)) {
            return rowsOf([{ id: tx, idempotency_key: `pdv-sale-${venda1}`, amount: '50.00', description: 'Venda PDV' }]);
          }
          if (/FROM sale_items si/.test(s) && /FOR UPDATE OF si, s/.test(s)) {
            return rowsOf([{ id: item, sale_id: venda1, product_id: null, variant_id: null, quantity: '1', total_price: '50.00', product_name_snapshot: 'Camiseta' }]);
          }
          if (/COUNT\(\*\)::int AS n/.test(s)) return rowsOf([{ n: 0, new_total: '0' }]);
          if (/UPDATE sales SET status = 'cancelled'/.test(s)) sales[venda1].status = 'cancelled';
          return rowsOf([]);
        }),
      }));
      const r = await request(app).delete(`/api/v1/companies/${companyA}/transactions/${tx}/sale-items/${item}`).set(auth(ownerA));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, sale_cancelled: true, recebe_pix: { status: 'cancelado' } });
      expect(asaas.payments[0].deleted).toBe(true);
      expect(ordem[0]).toBe('release');
    });

    test('rota POST /sales/:id/cancel: mesmo gancho, depois de devolver a conexão', async () => {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      ordem = [];
      const fetchBase = global.fetch.getMockImplementation();
      global.fetch.mockImplementation((url, opts = {}) => { ordem.push(`asaas ${opts.method || 'GET'}`); return fetchBase(url, opts); });
      db.connect.mockImplementation(() => ({
        release: jest.fn(() => ordem.push('release')),
        query: jest.fn((sql) => {
          const s = String(sql);
          if (/FROM sales WHERE id = \$1 AND company_id = \$2 FOR UPDATE/.test(s)) {
            return rowsOf([{ id: venda1, total_amount: '50.00', status: sales[venda1].status, type: 'sale' }]);
          }
          if (/UPDATE sales SET status = 'cancelled'/.test(s)) sales[venda1].status = 'cancelled';
          return rowsOf([]);
        }),
      }));
      const r = await request(app).post(`/api/v1/companies/${companyA}/sales/${venda1}/cancel`).set(auth(ownerA)).send({});
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, sale_id: venda1, recebe_pix: { status: 'cancelado' } });
      expect(asaas.payments[0].deleted).toBe(true);
      expect(ordem[0]).toBe('release');
    });

    test('rota com a flag desligada: resposta de sempre, sem recebe_pix', async () => {
      delete process.env.RECEBE_NA_AURA_ENABLED;
      venda(venda1, companyA, 50);
      db.connect.mockImplementation(() => clienteDaTransacao());
      const r = await request(app).delete(`${base(companyA)}/sale/${venda1}`).set(auth(ownerA));
      expect(r.status).toBe(200);
      expect(r.body).not.toHaveProperty('recebe_pix');
      expect(recebeQueries()).toHaveLength(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('pagador', () => {
    test('customer só com nome (sem CPF): conta como sem pagador e segue a ordem', async () => {
      customers[cliente] = { name: 'Maria', cpf_cnpj: '123.456.789-09' };
      venda(venda1, companyA, 30, { customer_id: cliente });
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA)).send({ customer: { name: 'Só o nome' } });
      expect(r.status).toBe(201);
      expect(calls.find((c) => c.method === 'POST' && c.path === '/customers').body).toMatchObject({ name: 'Maria', cpfCnpj: CPF_CLI });
    });

    test('"Consumidor no Caixa" desligado (padrão): sem CPF → 422 RECEBE_PIX_PEDE_CPF sem Asaas; disponível continua true', async () => {
      delete process.env.RECEBE_PIX_CONSUMIDOR_NO_CAIXA;
      venda(venda1, companyA, 50);
      const d = await request(app).get(`${base(companyA)}/recebe-pix/disponivel`).set(auth(ownerA));
      expect(d.body).toEqual({ disponivel: true, motivo: null });
      for (const body of [{}, { customer: { name: 'Só o nome' } }]) {
        const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA)).send(body);
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('RECEBE_PIX_PEDE_CPF');
      }
      expect(vpix).toHaveLength(0);
      expect(global.fetch).not.toHaveBeenCalled();
      // com o CPF informado, gera
      const ok = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA)).send({ customer: { cpf_cnpj: '529.982.247-25' } });
      expect(ok.status).toBe(201);
    });
  });

  describe('venda cancelada enquanto o Pix nascia', () => {
    test('ao terminar a criação, cancela a cobrança na Asaas na hora (nenhum QR vivo)', async () => {
      venda(venda1, companyA, 50);
      const fetchBase = global.fetch.getMockImplementation();
      global.fetch.mockImplementation((url, opts = {}) => {
        if ((opts.method || 'GET') === 'POST' && /\/payments$/.test(new URL(url).pathname)) {
          // o cancelamento da venda entra enquanto a Asaas cria a cobrança
          sales[venda1].status = 'cancelled';
          svc.depoisDeCancelarVenda(companyA, venda1, ownerA); // vê 'criando' e não tem o que cancelar
        }
        return fetchBase(url, opts);
      });
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('VENDA_CANCELADA');
      expect(r.body.recebe_pix).toMatchObject({ status: 'cancelado', pix: null });
      expect(asaas.payments[0].deleted).toBe(true);
      expect(vpix[0].status).toBe('cancelado');
    });
  });

  describe('Pix vencido e restaurado', () => {
    async function gerado() {
      venda(venda1, companyA, 50);
      await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
    }

    test('PAYMENT_OVERDUE: expirado, não confirma, some da lista de aguardando', async () => {
      await gerado();
      const a = await postAviso({ ...aviso('evt_o1', 'PAYMENT_OVERDUE', 'pay_1', venda1) });
      expect(a.status).toBe(200);
      expect(vpix[0]).toMatchObject({ status: 'expirado', confirmed_at: null });
      const g = await request(app).get(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(g.body).toMatchObject({ status: 'expirado', pix: null });
      const lista = await request(app).get(`${base(companyA)}/recebe-pix?situacao=aguardando`).set(auth(ownerA));
      expect(lista.body.items).toEqual([]);
    });

    test('PAYMENT_RESTORED com a venda viva: volta a aguardando', async () => {
      await gerado();
      await postAviso(aviso('evt_o1', 'PAYMENT_OVERDUE', 'pay_1', venda1));
      await postAviso(aviso('evt_r1', 'PAYMENT_RESTORED', 'pay_1', venda1));
      expect(vpix[0].status).toBe('aguardando');
    });

    test('PAYMENT_RESTORED com a venda cancelada: fica como está', async () => {
      await gerado();
      await postAviso(aviso('evt_o1', 'PAYMENT_OVERDUE', 'pay_1', venda1));
      sales[venda1].status = 'cancelled';
      await postAviso(aviso('evt_r1', 'PAYMENT_RESTORED', 'pay_1', venda1));
      expect(vpix[0].status).toBe('expirado');
    });

    test('Pix vencido pago: confirma (sem outra cobrança viva para a venda)', async () => {
      await gerado();
      await postAviso(aviso('evt_o1', 'PAYMENT_OVERDUE', 'pay_1', venda1));
      await postAviso(aviso('evt_p1', 'PAYMENT_RECEIVED', 'pay_1', venda1));
      expect(vpix[0]).toMatchObject({ status: 'confirmado', confirmacoes: 1 });
    });

    test('gerar de novo depois de vencer: apaga o vencido na Asaas e cria outro', async () => {
      await gerado();
      await postAviso(aviso('evt_o1', 'PAYMENT_OVERDUE', 'pay_1', venda1));
      const r = await request(app).post(pixUrl(companyA, venda1)).set(auth(ownerA));
      expect(r.status).toBe(201);
      expect(r.body.payment_id).toBe('pay_2');
      expect(asaas.payments[0].deleted).toBe(true);
      expect(vpix.map((x) => x.status)).toEqual(['cancelado', 'aguardando']);
      // o vencido pago depois disso não confirma a venda duas vezes: só atenção
      await postAviso(aviso('evt_p2', 'PAYMENT_RECEIVED', 'pay_1', venda1));
      expect(vpix[0]).toMatchObject({ status: 'cancelado', atencao: 'pago_depois_de_cancelar' });
      expect(vpix[1].status).toBe('aguardando');
    });
  });

  test('referência da venda: só recebe:venda:<uuid>', () => {
    expect(svc.vendaDaReferencia(`recebe:venda:${venda1}`)).toBe(venda1);
    expect(svc.vendaDaReferencia('recebe:pedido:abc')).toBeNull();
    expect(svc.vendaDaReferencia(`recebe:venda:${venda1}:x`)).toBeNull();
  });
});
