// ============================================================
// AURA. — NFC-e com o desconto da venda (13/11/2026)
//
// Defeito (revisao de 12/11): a NFC-e emitida pelo Caixa ignorava o desconto
// da venda (cupom + desconto manual, sales.discount_amount). O app mandava os
// itens pelo preco cheio e o /nfce/emit somava so os itens: com pagamento
// unico a nota saia pelo bruto (o cliente pagou menos); com pagamento
// dividido a soma dos pagamentos nao fechava e o /emit devolvia 400.
//
// Agora a venda gravada e a fonte da verdade (services/descontoDaVendaNaNfce):
// com sale_id e desconto gravado, o backend le os itens da venda e rateia o
// desconto entre as linhas de produto (vDesc por item, centavos inteiros,
// sobra para a maior linha). Frete nao recebe desconto.
//
// Aqui trava:
//   1. REGRA DE OURO: venda SEM desconto sai com o MESMO payload, o MESMO XML
//      (xmlBuilder real, SP, AP, MG e RJ), as MESMAS escritas e a MESMA
//      resposta. __tests__/fixtures/nfceDescontoDaVenda/golden.json foi
//      gravado com o codigo de origin/main ANTES da mudanca
//      (NFCE_GOLDEN_RECORD=1, so o describe da regra de ouro);
//   2. rateio: 2 itens, 3 itens com centavos, frete + desconto, cupom +
//      manual, lapis + desconto da venda (sem descontar duas vezes);
//   3. pagamento dividido fecha (antes: 400);
//   4. desconto que zera a nota: recusa gentil antes de reservar numero.
// db mockado (padrao de __tests__/nfceSemServico.test.js): roda sem Postgres.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const supertest = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const GOLDEN_FILE = path.join(__dirname, 'fixtures', 'nfceDescontoDaVenda', 'golden.json');
const RECORD = process.env.NFCE_GOLDEN_RECORD === '1';

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-0000000000c1';
const OUTRA_LOJA = '00000000-0000-0000-0000-0000000000c2';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

const P_CAMISETA = '11111111-1111-4111-8111-111111111111';
const P_MEIA     = '22222222-2222-4222-8222-222222222222';
const P_BONE     = '33333333-3333-4333-8333-333333333333';
const S_AJUSTE   = '44444444-4444-4444-8444-444444444444'; // servico (unit srv)

const PRODUCTS = [
  { id: P_CAMISETA, company_id: CID, ncm: '61091000', tax_profile: 'simples_st', unit: 'UN' },
  { id: P_MEIA,     company_id: CID, ncm: '61159500', tax_profile: null, unit: 'UN' },
  { id: P_BONE,     company_id: CID, ncm: '65050000', tax_profile: null, unit: 'UN' },
  { id: S_AJUSTE,   company_id: CID, ncm: null, tax_profile: null, unit: 'srv' },
];

// Vendas gravadas (sales + sale_items), no formato do POST /pdv/sale:
// unit_price = preco de tabela, discount = lapis (total da linha),
// total_price = bruto - lapis; discount_amount = cupom + manual.
const VENDA = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SALES = {};
const SALE_ITEMS = {};
function gravarVenda(id, { company_id = CID, discount_amount = 0, type = 'sale', itens }) {
  const linhas = itens.map((it, idx) => {
    const bruto = Math.round(it.quantity * it.unit_price * 100) / 100;
    const discount = it.discount || 0;
    return {
      id: `bbbbbbbb-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      product_id: it.product_id || null, variant_id: null,
      quantity: String(it.quantity), unit_price: String(it.unit_price),
      discount: String(discount), total_price: String(Math.round((bruto - discount) * 100) / 100),
      product_name_snapshot: it.name,
    };
  });
  const soma = linhas.reduce((s, l) => s + Number(l.total_price), 0);
  SALES[id] = {
    id, company_id, type, status: 'completed',
    discount_amount: String(discount_amount),
    total_amount: String(Math.round((soma - discount_amount) * 100) / 100),
  };
  SALE_ITEMS[id] = linhas;
}

// ── vendas SEM desconto (regra de ouro) ──
gravarVenda(VENDA(1), { itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 2, unit_price: 59.9, discount: 9.8 },
  { product_id: P_MEIA, name: 'Meia', quantity: 3, unit_price: 12.5 },
] });
gravarVenda(VENDA(2), { itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 80, discount: 5 },
  { product_id: null, name: 'Frete', quantity: 1, unit_price: 15 },
] });

// ── vendas COM desconto ──
// 2 itens: 100 + 50, desconto 15 (manual) -> 10 + 5.
gravarVenda(VENDA(10), { discount_amount: 15, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 100 },
  { product_id: P_MEIA, name: 'Meia', quantity: 2, unit_price: 25 },
] });
// 3 itens com centavos: 10 + 10 + 10, desconto 1,00 -> 0,33 x3 + 0,01 de sobra.
gravarVenda(VENDA(11), { discount_amount: 1, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 10 },
  { product_id: P_MEIA, name: 'Meia', quantity: 1, unit_price: 10 },
  { product_id: P_BONE, name: 'Bone', quantity: 1, unit_price: 10 },
] });
// 3 itens desiguais: 33,33 + 21,47 + 9,99 (= 64,79), desconto 7,77.
gravarVenda(VENDA(12), { discount_amount: 7.77, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 33.33 },
  { product_id: P_MEIA, name: 'Meia', quantity: 1, unit_price: 21.47 },
  { product_id: P_BONE, name: 'Bone', quantity: 1, unit_price: 9.99 },
] });
// frete + desconto: produtos 60 + 40, frete 20, desconto 10 (so nos produtos).
gravarVenda(VENDA(13), { discount_amount: 10, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 60 },
  { product_id: P_MEIA, name: 'Meia', quantity: 1, unit_price: 40 },
  { product_id: null, name: 'Frete', quantity: 1, unit_price: 20 },
] });
// cupom (10% de 89,90 = 8,99) + manual 5 = 13,99; lapis de 9,80 na camiseta.
gravarVenda(VENDA(14), { discount_amount: 13.99, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 2, unit_price: 29.9, discount: 9.8 },
  { product_id: P_MEIA, name: 'Meia', quantity: 3, unit_price: 13.3 },
] });
// desconto = soma das linhas: nota de valor zero.
gravarVenda(VENDA(15), { discount_amount: 50, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 30 },
  { product_id: P_MEIA, name: 'Meia', quantity: 1, unit_price: 20 },
] });
// venda mista com desconto: camiseta 80 + ajuste (servico) 20, desconto 10.
gravarVenda(VENDA(16), { discount_amount: 10, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 80 },
  { product_id: S_AJUSTE, name: 'Ajuste', quantity: 1, unit_price: 20 },
] });
// venda de outra loja (multi-CNPJ): nao e lida por esta.
gravarVenda(VENDA(17), { company_id: OUTRA_LOJA, discount_amount: 10, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 100 },
] });
// desconto maior que os produtos (frete pago em parte): produtos 10, frete 5, desconto 12.
gravarVenda(VENDA(18), { discount_amount: 12, itens: [
  { product_id: P_CAMISETA, name: 'Camiseta', quantity: 1, unit_price: 10 },
  { product_id: null, name: 'Frete', quantity: 1, unit_price: 5 },
] });

const UFS = {
  SP: { ibge: '3524402', city: 'Jacarei', zip: '12327000' },
  AP: { ibge: '1600303', city: 'Macapa', zip: '68900000' },
  MG: { ibge: '3106200', city: 'Belo Horizonte', zip: '30110000' },
  RJ: { ibge: '3304557', city: 'Rio de Janeiro', zip: '20010000' },
};
const companyRow = (uf) => ({
  id: CID, cnpj: '11222333000181', legal_name: 'Loja Teste LTDA', trade_name: 'Loja Teste',
  address_street: 'Rua A', address_number: '10', address_neighborhood: 'Centro',
  address_city: UFS[uf].city, address_state: uf, address_zip: UFS[uf].zip,
  inscricao_estadual: '111222333444', inscricao_municipal: null, ibge_code: UFS[uf].ibge,
  email: 'loja@exemplo.com', phone: '12999990000', tax_regime: 'simples_nacional',
});
const configEngine = (uf) => ({
  id: 'cfg-1', company_id: CID, provider: 'sefaz_sp', is_active: true,
  ambiente: 'producao', uf, serie_nfce: 1, next_number: 500,
  serie_sefaz_sp: 2, next_number_sefaz_sp: 900, csc_id: '1', csc_token_enc: 'x',
  inscricao_estadual: '111222333444',
});
// Responsavel tecnico de mentira (MG pede infRespTec): dados de teste.
const RESP_TEC = { cnpj: '00000000000191', xContato: 'Suporte Teste', email: 'suporte@exemplo.com', fone: '1130000000' };

const ENGINE_OK = {
  status: 'autorizado', chave_acesso: '3'.repeat(44), protocolo: 'P1',
  codigo_status: '100', motivo_status: 'Autorizado', qr_code: 'qr', url_consulta: 'u',
  tp_emis: 1, provider: 'sefaz_sp',
};

function makeDb(config, uf) {
  const emission = { id: 'em-1', company_id: CID, status: 'processando', numero: null, serie: null, chave_acesso: null };
  return async (sql, params = []) => {
    if (/SELECT serie_sefaz_sp, next_number_sefaz_sp FROM nfce_config/.test(sql)) return { rows: [] };
    if (/SELECT provider_used, fallback_reason FROM nfce_emissions/.test(sql)) return { rows: [] };
    if (/FROM company_certificates/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/SELECT \* FROM nfce_config/.test(sql)) return { rows: config ? [config] : [] };
    if (/FROM sale_items/.test(sql)) return { rows: (SALE_ITEMS[params[0]] || []).map((r) => ({ ...r })) };
    if (/FROM sales\b/.test(sql) && /WHERE id\s*=\s*\$1/.test(sql)) {
      const s = SALES[params[0]];
      return { rows: s && s.company_id === params[1] ? [{ ...s }] : [] };
    }
    if (/FROM products/.test(sql)) {
      const ids = params[0] || [];
      return { rows: PRODUCTS.filter((p) => ids.includes(p.id) && p.company_id === params[1]).map((p) => ({ ...p })) };
    }
    if (/FROM companies WHERE id=/.test(sql)) return { rows: [companyRow(uf)] };
    if (/UPDATE nfce_config SET next_number_sefaz_sp/.test(sql)) return { rows: [{ numero: 900 }] };
    if (/UPDATE nfce_config SET next_number =/.test(sql)) return { rows: [{ numero: 500 }] };
    if (/INSERT INTO nfce_emissions/.test(sql)) {
      return { rows: [{ ...emission, numero: params[3], serie: params[4], chave_acesso: params[5], items: params[8], total_nfce: params[11] }] };
    }
    if (/SELECT \* FROM nfce_emissions WHERE id=/.test(sql)) return { rows: [{ ...emission, status: 'autorizada', numero: 900 }] };
    return { rows: [] };
  };
}

let ctx;
function buildApp(uf = 'SP') {
  jest.resetModules();
  const config = configEngine(uf);
  const query = jest.fn(makeDb(config, uf));
  const db = { query, queryRetry: (...a) => query(...a), isTransientConnError: () => false, connect: jest.fn() };
  const xmlBuilder = jest.requireActual('../src/services/sefazSp/xmlBuilder');
  const { getEndpoints } = jest.requireActual('../src/services/sefazSp/endpoints');
  const captured = { payloads: [], xml: [] };
  const sefazSp = {
    emitNfce: jest.fn(async (company, payload, engineCtx) => {
      captured.payloads.push(JSON.parse(JSON.stringify(payload)));
      // Como a engine faz (sefazSp/index.js): respTec so na UF que pede.
      const respTec = getEndpoints(engineCtx.config.uf, 1).infRespTec ? RESP_TEC : null;
      const { infNfeXml } = xmlBuilder.buildInfNfe(company, payload, {
        tpAmb: 1, tpEmis: 1, cNF: '12345678', dhEmi: '2026-11-13T10:00:00-03:00', respTec,
      });
      captured.xml.push(infNfeXml);
      return { ...ENGINE_OK, xml_signed: infNfeXml };
    }),
  };
  const nuvemfiscal = {
    emitNfce: jest.fn(), emitNfe: jest.fn(), queryNfce: jest.fn(), queryNfe: jest.fn(),
    ufToCodigo: jest.requireActual('../src/services/sefazSp/nfeHelpers').ufToCodigo,
    isoBR: () => '2026-11-13T10:00:00-03:00',
  };
  jest.doMock('../src/config/database', () => db);
  jest.doMock('../src/services/sefazSp', () => sefazSp);
  jest.doMock('../src/services/nuvemfiscal', () => nuvemfiscal);
  jest.doMock('../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));
  const router = require('../src/routes/nfce');
  const app = express();
  app.use(express.json());
  app.use('/c/:id/nfce', router);
  ctx = { app, db, sefazSp, captured };
  return ctx;
}

function writes() {
  return ctx.db.query.mock.calls
    .filter(([sql]) => /^\s*(INSERT|UPDATE)/i.test(String(sql)))
    .map(([sql, params]) => [String(sql), JSON.parse(JSON.stringify(params || []))]);
}
const emitir = (body) => supertest(ctx.app).post(`/c/${CID}/nfce/emit`).set(auth).send(body);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const semRelogio = (w) => JSON.parse(JSON.stringify(w), (k, v) => (typeof v === 'string' && ISO.test(v) ? '<agora>' : v));
const sum2 = (arr) => Math.round(arr.reduce((s, v) => s + v, 0) * 100) / 100;
const vDescs = (xml) => [...xml.matchAll(/<det nItem="\d+">.*?<\/det>/g)]
  .map((m) => { const d = m[0].match(/<prod>.*?<vDesc>([\d.]+)<\/vDesc>/); return d ? d[1] : null; });
const tagTotal = (xml, t) => (xml.match(new RegExp(`<ICMSTot>.*<${t}>([\\d.]+)</${t}>.*</ICMSTot>`)) || [])[1];

const ENV_KEYS = ['NUVEM_FISCAL_CLIENT_ID', 'NUVEM_FISCAL_CLIENT_SECRET', 'NUVEM_FISCAL_FORCE'];
const envOriginal = {};
beforeAll(() => { for (const k of ENV_KEYS) envOriginal[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (envOriginal[k] === undefined) delete process.env[k]; else process.env[k] = envOriginal[k];
  }
});

// ── 1. Regra de ouro: venda sem desconto, byte a byte, nas 4 UFs ─────────
const CASOS_SEM_DESCONTO = {
  // Tela de Vendas (2a via): itens da venda gravada, lapis no discount, dividido.
  vendas_lapis_dividido: {
    items: [
      { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 2, unit_price: 59.9, discount: 9.8 },
      { product_id: P_MEIA, product_name: 'Meia', quantity: 3, unit_price: 12.5 },
    ],
    payments: [{ method: 'pix', value: 100 }, { method: 'crediario', value: 47.5 }],
    sale_id: VENDA(1), customer_cpf: '12345678909', customer_name: 'Cliente Teste', tipo: 'nfce',
  },
  // Caixa (SaleComplete): preco ja com o lapis, frete como linha, dinheiro com troco.
  caixa_frete_dinheiro: {
    items: [
      { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 75 },
      { product_id: 'frete', product_name: 'Frete', quantity: 1, unit_price: 15 },
    ],
    payment_method: 'dinheiro', payment_change: 10, sale_id: VENDA(2), tipo: 'nfce',
  },
  // Sem venda gravada (sale_id que nao existe): os itens do corpo, como sempre.
  sem_venda_gravada: {
    items: [{ product_id: P_BONE, product_name: 'Bone', quantity: 1, unit_price: 39.9 }],
    payments: [{ method: 'debito', value: 39.9 }], sale_id: VENDA(999), tipo: 'nfce',
  },
};

describe('regra de ouro: venda sem desconto sai identica (SP, AP, MG, RJ)', () => {
  const golden = RECORD ? {} : JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));

  for (const uf of Object.keys(UFS)) {
    for (const [nome, body] of Object.entries(CASOS_SEM_DESCONTO)) {
      const chave = `${uf}_${nome}`;
      test(chave, async () => {
        buildApp(uf);
        const res = await emitir(body);
        const got = { status: res.status, text: res.text, payloads: ctx.captured.payloads, xml: ctx.captured.xml, writes: semRelogio(writes()) };
        if (RECORD) { golden[chave] = got; return; }
        const exp = golden[chave];
        expect(exp).toBeDefined();
        expect(got.status).toBe(exp.status);
        expect(got.text).toBe(exp.text);
        expect(got.xml).toEqual(exp.xml);
        expect(got.payloads).toEqual(exp.payloads);
        expect(got.writes).toEqual(exp.writes);
      });
    }
  }

  afterAll(() => {
    if (!RECORD) return;
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, JSON.stringify(golden, null, 2) + '\n');
  });
});

// ── 2. Rateio (funcoes puras) ────────────────────────────────────────────
describe('ratearDesconto', () => {
  const { ratearDesconto } = jest.requireActual('../src/services/descontoDaVendaNaNfce');
  const todas = (n) => Array(n).fill(true);

  test('2 itens: proporcional ao valor da linha', () => {
    expect(ratearDesconto([10000, 5000], 1500, todas(2))).toEqual([1000, 500]);
  });
  test('3 itens iguais: sobra do centavo vai para a maior linha (empate: a primeira)', () => {
    expect(ratearDesconto([1000, 1000, 1000], 100, todas(3))).toEqual([34, 33, 33]);
  });
  test('3 itens com centavos: toda a sobra na maior linha', () => {
    const p = ratearDesconto([3333, 2147, 999], 777, todas(3));
    expect(p).toEqual([401, 257, 119]);
    expect(p.reduce((s, v) => s + v, 0)).toBe(777);
  });
  test('maior linha sem folga: a sobra segue para a proxima maior, nenhuma passa da base', () => {
    expect(ratearDesconto([2, 2, 2], 5, todas(3))).toEqual([2, 2, 1]);
  });
  test('linha fora do rateio (frete) fica com zero', () => {
    expect(ratearDesconto([6000, 4000, 2000], 1000, [true, true, false])).toEqual([600, 400, 0]);
  });
  test('valores grandes nao perdem centavo (sem estouro de float)', () => {
    const p = ratearDesconto([999999999, 333333333], 123456789, todas(2));
    expect(p.reduce((s, v) => s + v, 0)).toBe(123456789);
  });
});

// ── 3. Rateio na nota (rota + xmlBuilder real) ───────────────────────────
const nfeInsert = () => writes().find(([sql]) => /INSERT INTO nfce_emissions/.test(sql))[1];
const vPagsDe = (xml) => [...xml.matchAll(/<vPag>([\d.]+)<\/vPag>/g)].map((m) => Number(m[1]));
const lerVendaFalha = () => {
  const base = ctx.db.query.getMockImplementation();
  ctx.db.query.mockImplementation(async (sql, params) => {
    if (/FROM sales\b/.test(sql) && /WHERE id\s*=\s*\$1/.test(sql)) throw new Error('connection reset');
    return base(sql, params);
  });
};

describe('desconto da venda na NFC-e', () => {
  // Corpo como o Caixa (SaleComplete) manda hoje: preco ja com o lapis, sem desconto.
  const caixaVenda10 = {
    items: [
      { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 100 },
      { product_id: P_MEIA, product_name: 'Meia', quantity: 2, unit_price: 25 },
    ],
    payment_method: 'pix', sale_id: VENDA(10), tipo: 'nfce',
  };

  test('2 itens, pagamento unico: a nota sai pelo total da venda, nao pelo bruto', async () => {
    buildApp('SP');
    const res = await emitir(caixaVenda10);
    expect(res.status).toBe(201);
    const payload = ctx.captured.payloads[0];
    expect(payload.items.map((i) => [i.code, i.price, i.discount])).toEqual([
      [P_CAMISETA, 100, 10], [P_MEIA, 25, 5],
    ]);
    expect(payload.total_value).toBe(135);
    const xml = ctx.captured.xml[0];
    expect(vDescs(xml)).toEqual(['10.00', '5.00']);
    expect(tagTotal(xml, 'vProd')).toBe('150.00');
    expect(tagTotal(xml, 'vDesc')).toBe('15.00');
    expect(tagTotal(xml, 'vNF')).toBe('135.00');
    expect(vPagsDe(xml)).toEqual([135]);
    const ins = nfeInsert();
    expect([ins[9], ins[10], ins[11]]).toEqual([150, 15, 135]); // total_products, total_discount, total_nfce
  });

  test('pagamento dividido fecha (antes: 400 "Soma dos pagamentos nao bate")', async () => {
    buildApp('SP');
    const { payment_method, ...semMetodo } = caixaVenda10;
    const res = await emitir({ ...semMetodo, payments: [{ method: 'pix', value: 100 }, { method: 'debito', value: 35 }] });
    expect(res.status).toBe(201);
    const xml = ctx.captured.xml[0];
    expect(tagTotal(xml, 'vNF')).toBe('135.00');
    expect(sum2(vPagsDe(xml))).toBe(135);
  });

  test('3 itens com centavos: 0,34 + 0,33 + 0,33', async () => {
    buildApp('SP');
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 10 },
        { product_id: P_MEIA, product_name: 'Meia', quantity: 1, unit_price: 10 },
        { product_id: P_BONE, product_name: 'Bone', quantity: 1, unit_price: 10 },
      ],
      payments: [{ method: 'pix', value: 15 }, { method: 'dinheiro', value: 14 }],
      sale_id: VENDA(11), tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const xml = ctx.captured.xml[0];
    expect(vDescs(xml)).toEqual(['0.34', '0.33', '0.33']);
    expect(tagTotal(xml, 'vNF')).toBe('29.00');
    expect(sum2(vPagsDe(xml))).toBe(29);
  });

  test('3 itens desiguais: soma(vProd) - soma(vDesc) = total da venda', async () => {
    buildApp('SP');
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 33.33 },
        { product_id: P_MEIA, product_name: 'Meia', quantity: 1, unit_price: 21.47 },
        { product_id: P_BONE, product_name: 'Bone', quantity: 1, unit_price: 9.99 },
      ],
      payments: [{ method: 'credito', value: 57.02 }], sale_id: VENDA(12), tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const xml = ctx.captured.xml[0];
    expect(vDescs(xml)).toEqual(['4.01', '2.57', '1.19']);
    expect(tagTotal(xml, 'vProd')).toBe('64.79');
    expect(tagTotal(xml, 'vDesc')).toBe('7.77');
    expect(tagTotal(xml, 'vNF')).toBe('57.02');
    expect(SALES[VENDA(12)].total_amount).toBe('57.02');
  });

  test('frete + desconto: o frete fica inteiro, o desconto sai so dos produtos', async () => {
    buildApp('SP');
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 60 },
        { product_id: P_MEIA, product_name: 'Meia', quantity: 1, unit_price: 40 },
        { product_id: 'frete', product_name: 'Frete', quantity: 1, unit_price: 20 },
      ],
      payments: [{ method: 'pix', value: 60 }, { method: 'dinheiro', value: 50 }],
      sale_id: VENDA(13), tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const payload = ctx.captured.payloads[0];
    expect(payload.items.map((i) => [i.name, i.price, i.discount])).toEqual([
      ['Camiseta', 60, 6], ['Meia', 40, 4], ['Frete', 20, 0],
    ]);
    const xml = ctx.captured.xml[0];
    expect(vDescs(xml)).toEqual(['6.00', '4.00', null]);
    // Frete segue como linha da nota (como hoje): vFrete do total continua 0.00.
    expect(tagTotal(xml, 'vFrete')).toBe('0.00');
    expect(tagTotal(xml, 'vNF')).toBe('110.00');
    expect(sum2(vPagsDe(xml))).toBe(110);
  });

  test('cupom + manual com lapis: o lapis entra uma vez so e o rateio usa a linha ja com o lapis', async () => {
    buildApp('SP');
    // Caixa: camiseta a 25,00 (tabela 29,90, lapis 4,90 x2), meia 13,30.
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 2, unit_price: 25 },
        { product_id: P_MEIA, product_name: 'Meia', quantity: 3, unit_price: 13.3 },
      ],
      payments: [{ method: 'pix', value: 50 }, { method: 'crediario', value: 25.91 }],
      sale_id: VENDA(14), tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const payload = ctx.captured.payloads[0];
    // Camiseta: bruto 59,80, lapis 9,80, parte do desconto 7,79 -> vDesc 17,59.
    expect(payload.items.map((i) => [i.price, i.discount])).toEqual([[29.9, 17.59], [13.3, 6.2]]);
    const xml = ctx.captured.xml[0];
    expect(tagTotal(xml, 'vProd')).toBe('99.70');
    expect(tagTotal(xml, 'vDesc')).toBe('23.79');
    expect(tagTotal(xml, 'vNF')).toBe('75.91'); // 89,90 - 13,99: nada descontado duas vezes
    expect(sum2(vPagsDe(xml))).toBe(75.91);
    expect(payload.payments.map((p) => [p.method, p.indPag])).toEqual([['17', 0], ['05', 1]]);
  });

  test('2a via pela tela de Vendas (itens gravados com o lapis no discount) da a mesma nota', async () => {
    buildApp('SP');
    const res = await emitir({
      items: SALE_ITEMS[VENDA(14)].map((r) => ({
        product_id: r.product_id, product_name: r.product_name_snapshot,
        quantity: Number(r.quantity), unit_price: Number(r.unit_price), discount: Number(r.discount),
      })),
      payment_method: 'dinheiro', sale_id: VENDA(14), tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    expect(tagTotal(ctx.captured.xml[0], 'vNF')).toBe('75.91');
    expect(ctx.captured.payloads[0].items.map((i) => i.discount)).toEqual([17.59, 6.2]);
  });

  test('venda mista com desconto: servico fora da nota, pagamentos na proporcao fecham', async () => {
    buildApp('SP');
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 80 },
        { product_id: S_AJUSTE, product_name: 'Ajuste', quantity: 1, unit_price: 20 },
      ],
      payments: [{ method: 'pix', value: 90 }], sale_id: VENDA(16), tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const xml = ctx.captured.xml[0];
    expect(xml.match(/<det nItem=/g)).toHaveLength(1);
    expect(vDescs(xml)).toEqual(['8.00']);
    expect(tagTotal(xml, 'vNF')).toBe('72.00');
    expect(vPagsDe(xml)).toEqual([72]);
    expect(res.body.servicos_fora_da_nfce).toEqual({ itens: 1, total: 18 });
  });

  test('NCM revisado no corpo (reemissao pela tela de Notas) continua valendo', async () => {
    buildApp('SP');
    const res = await emitir({
      ...caixaVenda10,
      items: [{ ...caixaVenda10.items[0], ncm: '61099000' }, caixaVenda10.items[1]],
    });
    expect(res.status).toBe(201);
    expect(ctx.captured.payloads[0].items.map((i) => i.ncm)).toEqual(['61099000', '61159500']);
    expect(ctx.captured.payloads[0].items.map((i) => i.discount)).toEqual([10, 5]);
  });

  test('o corpo nao manda na venda gravada: preco e desconto do corpo sao ignorados', async () => {
    buildApp('SP');
    const res = await emitir({
      ...caixaVenda10,
      items: [{ ...caixaVenda10.items[0], unit_price: 1, discount: 0.5 }, caixaVenda10.items[1]],
      discount_amount: 99,
    });
    expect(res.status).toBe(201);
    expect(tagTotal(ctx.captured.xml[0], 'vNF')).toBe('135.00');
  });

  for (const uf of ['AP', 'MG', 'RJ']) {
    test(`${uf}: mesmo rateio`, async () => {
      buildApp(uf);
      const res = await emitir(caixaVenda10);
      expect(res.status).toBe(201);
      const xml = ctx.captured.xml[0];
      expect(vDescs(xml)).toEqual(['10.00', '5.00']);
      expect(tagTotal(xml, 'vNF')).toBe('135.00');
    });
  }

  test('desconto = soma das linhas: nota de valor zero e recusada com mensagem gentil, sem reservar numero', async () => {
    buildApp('SP');
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 30 },
        { product_id: P_MEIA, product_name: 'Meia', quantity: 1, unit_price: 20 },
      ],
      payment_method: 'dinheiro', sale_id: VENDA(15), tipo: 'nfce',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NFCE_DESCONTO_TOTAL');
    expect(res.body.error).toMatch(/cobre todo o valor dos produtos/);
    expect(res.body.error).toMatch(/A venda continua registrada/);
    expect(writes()).toEqual([]);
    expect(ctx.sefazSp.emitNfce).not.toHaveBeenCalled();
  });

  test('desconto maior que os produtos (frete pago em parte): recusa, o frete nao recebe desconto', async () => {
    buildApp('SP');
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 10 },
        { product_id: 'frete', product_name: 'Frete', quantity: 1, unit_price: 5 },
      ],
      payment_method: 'pix', sale_id: VENDA(18), tipo: 'nfce',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NFCE_DESCONTO_TOTAL');
    expect(writes()).toEqual([]);
  });

  test('multi-CNPJ: venda de outra loja nao e lida; sem desconto no corpo, nada muda', async () => {
    buildApp('SP');
    const res = await emitir({
      items: [{ product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 100 }],
      payment_method: 'pix', sale_id: VENDA(17), tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    expect(tagTotal(ctx.captured.xml[0], 'vNF')).toBe('100.00');
    expect(vDescs(ctx.captured.xml[0])).toEqual([null]);
  });

  test('sem venda gravada para conferir: vale o discount_amount do corpo, rateado nos itens do corpo', async () => {
    buildApp('SP');
    lerVendaFalha();
    const { payment_method, ...semMetodo } = caixaVenda10;
    const res = await emitir({ ...semMetodo, discount_amount: 15, payments: [{ method: 'pix', value: 135 }] });
    expect(res.status).toBe(201);
    const xml = ctx.captured.xml[0];
    expect(vDescs(xml)).toEqual(['10.00', '5.00']);
    expect(tagTotal(xml, 'vNF')).toBe('135.00');
  });

  test('leitura da venda falhou e o corpo nao traz desconto: segue o corpo, como antes', async () => {
    buildApp('SP');
    lerVendaFalha();
    const res = await emitir(caixaVenda10);
    expect(res.status).toBe(201);
    expect(tagTotal(ctx.captured.xml[0], 'vNF')).toBe('150.00');
  });

  test('frete do Caixa (product_id "frete") nao vai para a busca de produtos', async () => {
    buildApp('SP');
    await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 75 },
        { product_id: 'frete', product_name: 'Frete', quantity: 1, unit_price: 15 },
      ],
      payment_method: 'dinheiro', sale_id: VENDA(2), tipo: 'nfce',
    });
    const busca = ctx.db.query.mock.calls.find(([sql]) => /FROM products/.test(sql));
    expect(busca[1][0]).toEqual([P_CAMISETA]);
  });
});
