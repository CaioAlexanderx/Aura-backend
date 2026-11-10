// ============================================================
// AURA. — Servico nao entra na NFC-e; item do grupo acha o NCM (10/11/2026)
//
// Servico = products.unit = 'srv'. O /nfce/emit montava a nota com TODOS os
// itens da venda: um servico sairia como mercadoria (NCM 00000000, CFOP 5102).
// E a busca do NCM/tax_profile filtrava company_id = a loja, entao o item
// compartilhado do grupo (is_group_shared) vendido pela filial saia sem NCM.
//
// Aqui trava:
//   1. REGRA DE OURO: venda sem servico gera o MESMO payload, o MESMO XML
//      (xmlBuilder real), as MESMAS escritas no banco e a MESMA resposta
//      (bytes) que antes da mudanca. As fixtures em
//      __tests__/fixtures/nfceSemServico/golden.json foram gravadas com o
//      codigo de origin/main ANTES da mudanca (NFCE_GOLDEN_RECORD=1).
//   2. venda mista: servico fora da nota, totais so dos produtos e os
//      pagamentos reduzidos na proporcao (soma = total da nota);
//   3. venda so de servico: nada de NFC-e (200, skipped), sem reservar numero;
//   4. item compartilhado do grupo: NCM e tax_profile lidos do produto.
// db mockado (padrao de __tests__/pixSemChave.test.js e
// tests/integration/nfceTrocaCredito.test.js): roda sem Postgres.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const supertest = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const GOLDEN_FILE = path.join(__dirname, 'fixtures', 'nfceSemServico', 'golden.json');
const RECORD = process.env.NFCE_GOLDEN_RECORD === '1';

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-0000000000c1';      // filial que vende
const MATRIZ = '00000000-0000-0000-0000-0000000000a1';   // matriz do grupo
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

const P_CAMISETA = '11111111-1111-4111-8111-111111111111'; // NCM e perfil no cadastro
const P_SEM_NCM  = '22222222-2222-4222-8222-222222222222'; // NCM 00000000 no cadastro
const S_AJUSTE   = '33333333-3333-4333-8333-333333333333'; // servico (unit srv)
const P_GRUPO    = '44444444-4444-4444-8444-444444444444'; // compartilhado da matriz
const S_GRUPO    = '55555555-5555-4555-8555-555555555555'; // servico compartilhado da matriz
const P_OUTRA    = '66666666-6666-4666-8666-666666666666'; // de outra empresa, NAO compartilhado
// Migration 442 (o item escolhe a nota):
const P_CARIMBO  = '77777777-7777-4777-8777-777777777777'; // produto com estoque que sai na NFS-e
const S_NA_NFCE  = '88888888-8888-4888-8888-888888888888'; // servico que o cadastro manda para a NFC-e

const PRODUCTS = [
  { id: P_CAMISETA, company_id: CID, ncm: '61091000', tax_profile: 'simples_st', unit: 'UN', is_group_shared: false },
  { id: P_SEM_NCM,  company_id: CID, ncm: '00000000', tax_profile: null, unit: null, is_group_shared: false },
  { id: S_AJUSTE,   company_id: CID, ncm: null, tax_profile: null, unit: 'srv', is_group_shared: false },
  { id: P_GRUPO,    company_id: MATRIZ, ncm: '33049910', tax_profile: 'simples_outros', unit: 'UN', is_group_shared: true },
  { id: S_GRUPO,    company_id: MATRIZ, ncm: null, tax_profile: null, unit: 'srv', is_group_shared: true },
  { id: P_OUTRA,    company_id: MATRIZ, ncm: '99999999', tax_profile: 'simples_st', unit: 'UN', is_group_shared: false },
  { id: P_CARIMBO,  company_id: CID, ncm: '96110000', tax_profile: null, unit: 'UN', is_group_shared: false, nota_fiscal: 'nfse' },
  { id: S_NA_NFCE,  company_id: CID, ncm: '49111090', tax_profile: null, unit: 'srv', is_group_shared: false, nota_fiscal: 'nfce' },
];

const COMPANY_ROW = {
  id: CID, cnpj: '11222333000181', legal_name: 'Loja Filial LTDA', trade_name: 'Loja Filial',
  address_street: 'Rua A', address_number: '10', address_neighborhood: 'Centro',
  address_city: 'Jacarei', address_state: 'SP', address_zip: '12327000',
  inscricao_estadual: '111222333444', inscricao_municipal: null, ibge_code: '3524402',
  email: 'loja@exemplo.com', phone: '12999990000', tax_regime: 'simples_nacional',
};
const CONFIG_ENGINE = {
  id: 'cfg-1', company_id: CID, provider: 'sefaz_sp', is_active: true,
  ambiente: 'producao', uf: 'SP', serie_nfce: 1, next_number: 500,
  serie_sefaz_sp: 2, next_number_sefaz_sp: 900, csc_id: '1', csc_token_enc: 'x',
  inscricao_estadual: '111222333444',
};
const CONFIG_GATEWAY = { ...CONFIG_ENGINE, provider: 'nuvemfiscal' };
const CONFIG_HOMOLOG = { ...CONFIG_ENGINE, provider: 'nuvemfiscal', ambiente: 'homologacao' };

const ENGINE_OK = {
  status: 'autorizado', chave_acesso: '3'.repeat(44), protocolo: 'P1',
  codigo_status: '100', motivo_status: 'Autorizado', qr_code: 'qr', url_consulta: 'u',
  tp_emis: 1, provider: 'sefaz_sp',
};
const GATEWAY_OK = {
  id: 'nf-1', status: 'autorizado', chave_acesso: '4'.repeat(44), numero_protocolo: 'P2',
  codigo_status: '100', motivo_status: 'Autorizado',
};

// Banco de mentira. A busca de produtos imita o Postgres: so devolve o
// compartilhado do grupo quando a SQL pede a regra de visibilidade.
function makeDb(config) {
  const emission = { id: 'em-1', company_id: CID, status: 'processando', numero: null, serie: null, chave_acesso: null };
  return async (sql, params = []) => {
    if (/SELECT serie_sefaz_sp, next_number_sefaz_sp FROM nfce_config/.test(sql)) return { rows: [] };
    if (/SELECT provider_used, fallback_reason FROM nfce_emissions/.test(sql)) return { rows: [] };
    if (/FROM company_certificates/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/SELECT \* FROM nfce_config/.test(sql)) return { rows: config ? [config] : [] };
    if (/FROM products/.test(sql)) {
      const ids = params[0] || [];
      const visivel = (p) => p.company_id === params[1]
        || (/is_group_shared/.test(sql) && p.is_group_shared); // CID e MATRIZ sao do mesmo grupo
      return { rows: PRODUCTS.filter((p) => ids.includes(p.id) && visivel(p)).map((p) => ({ ...p })) };
    }
    if (/FROM companies WHERE id=/.test(sql)) return { rows: [COMPANY_ROW] };
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
function buildApp(config) {
  jest.resetModules();
  const query = jest.fn(makeDb(config));
  const db = { query, queryRetry: (...a) => query(...a), isTransientConnError: () => false, connect: jest.fn() };
  const xmlBuilder = jest.requireActual('../src/services/sefazSp/xmlBuilder');
  const captured = { payloads: [], xml: [] };
  const sefazSp = {
    emitNfce: jest.fn(async (company, payload) => {
      captured.payloads.push(JSON.parse(JSON.stringify(payload)));
      // XML real, com cNF e data fixos para a comparacao byte a byte.
      const { infNfeXml } = xmlBuilder.buildInfNfe(company, payload, {
        tpAmb: 1, tpEmis: 1, cNF: '12345678', dhEmi: '2026-11-10T10:00:00-03:00',
      });
      captured.xml.push(infNfeXml);
      return { ...ENGINE_OK, xml_signed: infNfeXml };
    }),
  };
  const gw = (async (company, payload) => {
    captured.payloads.push(JSON.parse(JSON.stringify(payload)));
    return { ...GATEWAY_OK };
  });
  const nuvemfiscal = {
    emitNfce: jest.fn(gw), emitNfe: jest.fn(gw), queryNfce: jest.fn(), queryNfe: jest.fn(),
    ufToCodigo: () => 35, isoBR: () => '2026-11-10T10:00:00-03:00',
  };
  jest.doMock('../src/config/database', () => db);
  jest.doMock('../src/services/sefazSp', () => sefazSp);
  jest.doMock('../src/services/nuvemfiscal', () => nuvemfiscal);
  jest.doMock('../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));
  const router = require('../src/routes/nfce');
  const app = express();
  app.use(express.json());
  app.use('/c/:id/nfce', router);
  ctx = { app, db, sefazSp, nuvemfiscal, captured };
  return ctx;
}

function writes() {
  return ctx.db.query.mock.calls
    .filter(([sql]) => /^\s*(INSERT|UPDATE)/i.test(String(sql)))
    .map(([sql, params]) => [String(sql), JSON.parse(JSON.stringify(params || []))]);
}

function emitir(body) {
  return supertest(ctx.app).post(`/c/${CID}/nfce/emit`).set(auth).send(body);
}

const sum2 = (arr) => Math.round(arr.reduce((s, v) => s + v, 0) * 100) / 100;

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

// ── 1. Regra de ouro: venda sem servico, byte a byte ─────────────────────
const GOLDEN_CASES = {
  engine_multipagamento_crediario_desconto: {
    config: CONFIG_ENGINE,
    body: {
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 2, unit_price: 59.9, discount: 9.8, barcode: '7891234567895' },
        { product_id: P_SEM_NCM, product_name: 'Meia', quantity: 3, unit_price: 12.5 },
        { product_name: 'Item avulso', quantity: 1, price: 7, ncm: '96032100', unit: 'PC' },
      ],
      payments: [{ method: 'pix', value: 100 }, { method: 'crediario', value: 54.5 }],
      sale_id: 'venda-1', customer_cpf: '12345678909', customer_name: 'Ana', tipo: 'nfce',
      observacoes: 'Obrigado pela compra',
    },
  },
  engine_dinheiro_com_troco: {
    config: CONFIG_ENGINE,
    body: {
      items: [{ product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 80 }],
      payment_method: 'dinheiro', payment_change: 20, sale_id: 'venda-2', tipo: 'nfce',
    },
  },
  engine_pagamento_com_troco_no_array: {
    config: CONFIG_ENGINE,
    body: {
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 50 },
        { product_id: P_SEM_NCM, product_name: 'Meia', quantity: 1, unit_price: 30 },
      ],
      payments: [{ method: 'pix', value: 40 }, { method: 'dinheiro', value: 40, change: 10 }],
      sale_id: 'venda-3', tipo: 'nfce',
    },
  },
  gateway_cartoes: {
    config: CONFIG_GATEWAY, env: { NUVEM_FISCAL_CLIENT_ID: 'x', NUVEM_FISCAL_CLIENT_SECRET: 'y' },
    body: {
      items: [{ product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 100 }],
      payments: [{ method: 'cartao_credito', value: 60 }, { method: 'debito', value: 40 }],
      sale_id: 'venda-4', tipo: 'nfce',
    },
  },
  homologacao_stub: {
    config: CONFIG_HOMOLOG,
    body: {
      items: [{ product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 10 }],
      payment_method: 'pix', sale_id: 'venda-5', tipo: 'nfce',
    },
  },
  nfe_55_gateway: {
    config: CONFIG_GATEWAY, env: { NUVEM_FISCAL_CLIENT_ID: 'x', NUVEM_FISCAL_CLIENT_SECRET: 'y' },
    body: {
      items: [{ product_id: P_SEM_NCM, product_name: 'Meia', quantity: 10, unit_price: 5 }],
      payment_method: 'boleto', recipient_cnpj: '11444777000161', customer_name: 'Empresa X',
      sale_id: 'venda-6', tipo: 'nfe',
    },
  },
  sem_config: {
    config: null,
    body: {
      items: [{ product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 10 }],
      payment_method: 'pix', sale_id: 'venda-7', tipo: 'nfce',
    },
  },
  pagamentos_nao_batem: {
    config: CONFIG_ENGINE,
    body: {
      items: [{ product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 10 }],
      payments: [{ method: 'pix', value: 9 }], sale_id: 'venda-8', tipo: 'nfce',
    },
  },
};

async function rodarCaso(c) {
  buildApp(c.config);
  for (const [k, v] of Object.entries(c.env || {})) process.env[k] = v;
  const res = await emitir(c.body);
  return {
    status: res.status,
    text: res.text,
    payloads: ctx.captured.payloads,
    xml: ctx.captured.xml,
    writes: writes(),
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const semRelogio = (w) => JSON.parse(JSON.stringify(w), (k, v) => (typeof v === 'string' && ISO.test(v) ? '<agora>' : v));

describe('regra de ouro: venda sem servico sai identica', () => {
  const golden = RECORD ? {} : JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));

  for (const [nome, caso] of Object.entries(GOLDEN_CASES)) {
    test(nome, async () => {
      const got = await rodarCaso(caso);
      if (RECORD) { golden[nome] = got; return; }
      const exp = golden[nome];
      expect(exp).toBeDefined();
      expect(got.status).toBe(exp.status);
      expect(got.text).toBe(exp.text);           // resposta, byte a byte
      expect(got.xml).toEqual(exp.xml);           // XML do xmlBuilder real, byte a byte
      expect(got.payloads).toEqual(exp.payloads); // o que vai pra engine/gateway
      // INSERT/UPDATE: SQL e parametros (authorized_at = new Date() vira marcador)
      expect(semRelogio(got.writes)).toEqual(semRelogio(exp.writes));
    });
  }

  afterAll(() => {
    if (!RECORD) return;
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, JSON.stringify(golden, null, 2) + '\n');
  });
});

// ── 2. Venda mista: servico fora, totais e pagamentos consistentes ───────
describe('venda mista (produto + servico)', () => {
  test('servico do cadastro (unit srv) sai da nota; pagamentos proporcionais fecham no total', async () => {
    buildApp(CONFIG_ENGINE);
    // Venda 80 = camiseta 50 + ajuste 30. Pix 40 + dinheiro 40 (troco 10).
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 50 },
        { product_id: S_AJUSTE, product_name: 'Ajuste de barra', quantity: 1, unit_price: 30 },
      ],
      payments: [{ method: 'pix', value: 40 }, { method: 'dinheiro', value: 40, change: 10 }],
      sale_id: 'mista-1', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const payload = ctx.captured.payloads[0];
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toEqual(expect.objectContaining({ code: P_CAMISETA, ncm: '61091000', csosn: '500' }));
    expect(payload.total_value).toBe(50);
    expect(payload.payments).toEqual([
      expect.objectContaining({ method: '17', value: 25, indPag: 0 }),
      expect.objectContaining({ method: '01', value: 25, change: 10, indPag: 0 }),
    ]);
    // XML: um det so, vNF 50, soma dos vPag 50
    const xml = ctx.captured.xml[0];
    expect(xml.match(/<det nItem=/g)).toHaveLength(1);
    expect(xml).not.toMatch(/Ajuste de barra/);
    expect(xml).toMatch(/<vNF>50\.00<\/vNF>/);
    const vPags = [...xml.matchAll(/<vPag>([\d.]+)<\/vPag>/g)].map((m) => Number(m[1]));
    expect(sum2(vPags)).toBe(50);
    // Registro da nota (DANFE termica le daqui): so o produto, totais e pagamentos da nota
    const insert = writes().find(([sql]) => /INSERT INTO nfce_emissions/.test(sql))[1];
    expect(JSON.parse(insert[8]).map((i) => i.product_id)).toEqual([P_CAMISETA]);
    expect([insert[9], insert[10], insert[11]]).toEqual([50, 0, 50]);
    expect(JSON.parse(insert[12])).toEqual([{ method: 'pix', value: 25 }, { method: 'dinheiro', value: 25, change: 10 }]);
    expect(res.body.servicos_fora_da_nfce).toEqual({ itens: 1, total: 30 });
  });

  test('centavos: crediario a prazo, soma fecha exata pelo maior resto', async () => {
    buildApp(CONFIG_ENGINE);
    // Venda 43,33 = produto 33,33 + servico 10. Pix 20 + crediario 23,33.
    const res = await emitir({
      items: [
        { product_id: P_SEM_NCM, product_name: 'Meia', quantity: 1, unit_price: 33.33 },
        { product_id: S_AJUSTE, product_name: 'Ajuste', quantity: 1, unit_price: 10 },
      ],
      payments: [{ method: 'pix', value: 20 }, { method: 'crediario', value: 23.33 }],
      sale_id: 'mista-2', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const { payments, total_value } = ctx.captured.payloads[0];
    expect(total_value).toBe(33.33);
    expect(sum2(payments.map((p) => p.value))).toBe(33.33);
    expect(payments).toEqual([
      expect.objectContaining({ method: '17', value: 15.38, indPag: 0 }),
      expect.objectContaining({ method: '05', value: 17.95, indPag: 1 }),
    ]);
  });

  test('pagamentos que ja somam so os produtos vao como vieram', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 50 },
        { product_id: S_AJUSTE, product_name: 'Ajuste', quantity: 1, unit_price: 30 },
      ],
      payments: [{ method: 'pix', value: 50 }],
      sale_id: 'mista-3', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    expect(ctx.captured.payloads[0].payments).toEqual([expect.objectContaining({ method: '17', value: 50 })]);
  });

  test('pagamentos que nao batem nem com a nota nem com a venda: 400 com o total da venda', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 50 },
        { product_id: S_AJUSTE, product_name: 'Ajuste', quantity: 1, unit_price: 30 },
      ],
      payments: [{ method: 'pix', value: 70 }],
      sale_id: 'mista-4', tipo: 'nfce',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/R\$ 70\.00.*R\$ 80\.00/);
    expect(ctx.sefazSp.emitNfce).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  test('item avulso com unit srv no corpo tambem sai; pagamento unico vira o total da nota', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 50 },
        { product_name: 'Instalacao', quantity: 1, unit_price: 20, unit: 'srv' },
      ],
      payment_method: 'cartao', sale_id: 'mista-5', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const payload = ctx.captured.payloads[0];
    expect(payload.items.map((i) => i.name)).toEqual(['Camiseta']);
    expect(payload.total_value).toBe(50);
    expect(payload.payments).toBeUndefined();
    expect(ctx.captured.xml[0]).toMatch(/<vPag>50\.00<\/vPag>/);
  });
});

// ── 3. Venda so de servico: sem NFC-e ────────────────────────────────────
describe('venda so de servicos', () => {
  test('200 skipped, sem reservar numero, sem criar emissao, sem transmitir', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [
        { product_id: S_AJUSTE, product_name: 'Ajuste', quantity: 2, unit_price: 15 },
        { product_name: 'Instalacao', quantity: 1, unit_price: 20, unit: 'SRV' },
      ],
      payments: [{ method: 'pix', value: 50 }], sale_id: 'srv-1', tipo: 'nfce',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      skipped: true, reason: 'somente_servicos', nfce: null, tipo: 'nfce',
      servicos_fora_da_nfce: { itens: 2, total: 50 },
    }));
    expect(res.body.error).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(ctx.sefazSp.emitNfce).not.toHaveBeenCalled();
    expect(ctx.nuvemfiscal.emitNfce).not.toHaveBeenCalled();
  });

  test('vale mesmo sem a nota configurada (nao ha o que emitir)', async () => {
    buildApp(null);
    const res = await emitir({
      items: [{ product_id: S_GRUPO, product_name: 'Servico do grupo', quantity: 1, unit_price: 40 }],
      payment_method: 'pix', sale_id: 'srv-2', tipo: 'nfce',
    });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
  });
});

// ── 4. Item compartilhado do grupo acha o NCM ────────────────────────────
describe('item compartilhado do grupo (is_group_shared)', () => {
  test('NCM e tax_profile do produto da matriz chegam na nota da filial', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [
        { product_id: P_GRUPO, product_name: 'Batom do grupo', quantity: 1, unit_price: 30 },
        { product_id: P_OUTRA, product_name: 'Nao compartilhado', quantity: 1, unit_price: 10 },
      ],
      payment_method: 'pix', sale_id: 'grupo-1', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const [grupo, outra] = ctx.captured.payloads[0].items;
    expect(grupo).toEqual(expect.objectContaining({ ncm: '33049910', csosn: '900' })); // simples_outros
    // produto de outra empresa sem compartilhar: continua invisivel (como antes)
    expect(outra).toEqual(expect.objectContaining({ ncm: '00000000', csosn: '102' }));
    expect(ctx.captured.xml[0]).toMatch(/<NCM>33049910<\/NCM>/);
    const sqlProdutos = ctx.db.query.mock.calls.map(([s]) => String(s)).filter((s) => /FROM products/.test(s));
    expect(sqlProdutos).toHaveLength(1);
    expect(sqlProdutos[0]).toMatch(/is_group_shared = true/);
  });

  test('servico compartilhado do grupo tambem fica fora da nota', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [
        { product_id: P_GRUPO, product_name: 'Batom do grupo', quantity: 1, unit_price: 30 },
        { product_id: S_GRUPO, product_name: 'Servico do grupo', quantity: 1, unit_price: 40 },
      ],
      payments: [{ method: 'pix', value: 70 }], sale_id: 'grupo-2', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const payload = ctx.captured.payloads[0];
    expect(payload.items.map((i) => i.code)).toEqual([P_GRUPO]);
    expect(payload.payments).toEqual([expect.objectContaining({ value: 30 })]);
  });

  test('falha na leitura do produto segue o caminho de antes (nota em erro + 502)', async () => {
    buildApp(CONFIG_ENGINE);
    const base = ctx.db.query.getMockImplementation();
    ctx.db.query.mockImplementation(async (sql, params) => {
      if (/FROM products/.test(sql)) throw new Error('invalid input syntax for type uuid');
      return base(sql, params);
    });
    const res = await emitir({
      items: [{ product_id: 'nao-e-uuid', product_name: 'X', quantity: 1, unit_price: 10 }],
      payment_method: 'pix', sale_id: 'erro-1', tipo: 'nfce',
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/invalid input syntax for type uuid/);
    expect(writes().some(([sql]) => /SET status='erro'/.test(sql))).toBe(true);
  });
});

// ── 4b. Migration 442: o cadastro escolhe a nota ─────────────────────────
describe('o item escolhe a nota (products.nota_fiscal, migration 442)', () => {
  test('produto com nota_fiscal nfse sai da NFC-e (vai na NFS-e)', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [
        { product_id: P_CAMISETA, product_name: 'Camiseta', quantity: 1, unit_price: 50 },
        { product_id: P_CARIMBO, product_name: 'Carimbo personalizado', quantity: 1, unit_price: 30 },
      ],
      payments: [{ method: 'pix', value: 80 }], sale_id: 'nota-1', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const payload = ctx.captured.payloads[0];
    expect(payload.items.map((i) => i.code)).toEqual([P_CAMISETA]);
    expect(payload.total_value).toBe(50);
    expect(ctx.captured.xml[0]).not.toMatch(/Carimbo/);
    expect(res.body.servicos_fora_da_nfce).toEqual({ itens: 1, total: 30 });
    const sqlProdutos = ctx.db.query.mock.calls.map(([q]) => String(q)).filter((q) => /FROM products/.test(q));
    expect(sqlProdutos[0]).toMatch(/nota_fiscal/);
  });

  test('venda so do produto NFS-e: nada de NFC-e (skipped)', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [{ product_id: P_CARIMBO, product_name: 'Carimbo', quantity: 2, unit_price: 30 }],
      payment_method: 'pix', sale_id: 'nota-2', tipo: 'nfce',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ skipped: true, reason: 'somente_servicos' }));
    expect(writes()).toEqual([]);
  });

  test('servico com nota_fiscal nfce entra na NFC-e', async () => {
    buildApp(CONFIG_ENGINE);
    const res = await emitir({
      items: [{ product_id: S_NA_NFCE, product_name: 'Impressao', quantity: 1, unit_price: 25 }],
      payment_method: 'pix', sale_id: 'nota-3', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const payload = ctx.captured.payloads[0];
    expect(payload.items).toEqual([expect.objectContaining({ code: S_NA_NFCE, ncm: '49111090' })]);
    expect(res.body.servicos_fora_da_nfce).toBeUndefined();
  });

  test('base sem a coluna (42703): le sem ela e segue a regra de hoje', async () => {
    buildApp(CONFIG_ENGINE);
    const base = ctx.db.query.getMockImplementation();
    ctx.db.query.mockImplementation(async (sql, params) => {
      if (/FROM products/.test(sql) && /nota_fiscal/.test(sql)) {
        throw Object.assign(new Error('column "nota_fiscal" does not exist'), { code: '42703' });
      }
      if (/FROM products/.test(sql)) {
        const r = await base(sql, params);
        return { rows: r.rows.map(({ nota_fiscal, ...p }) => p) }; // eslint-disable-line no-unused-vars
      }
      return base(sql, params);
    });
    const res = await emitir({
      items: [
        { product_id: P_CARIMBO, product_name: 'Carimbo', quantity: 1, unit_price: 30 },
        { product_id: S_AJUSTE, product_name: 'Ajuste', quantity: 1, unit_price: 10 },
      ],
      payments: [{ method: 'pix', value: 40 }], sale_id: 'nota-4', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    // sem a coluna o carimbo e produto (unit UN) e fica; o servico sai
    expect(ctx.captured.payloads[0].items.map((i) => i.code)).toEqual([P_CARIMBO]);
  });
});

// ── 5. Helper puro ───────────────────────────────────────────────────────
describe('services/nfceSemServico', () => {
  const { separarServicos, pagamentosDosProdutos } = jest.requireActual('../src/services/nfceSemServico');

  test('sem servico devolve o proprio array (mesma referencia)', () => {
    const items = [{ product_id: 'a' }, { product_name: 'b' }];
    expect(separarServicos(items, new Map([['a', { unit: 'UN' }]])).produtos).toBe(items);
  });

  test('442: o cadastro vence o tipo; nulo segue o tipo; item avulso usa o corpo', () => {
    const produtos = new Map([
      ['carimbo', { unit: 'UN', nota_fiscal: 'nfse' }],
      ['impressao', { unit: 'srv', nota_fiscal: 'nfce' }],
      ['ajuste', { unit: 'srv', nota_fiscal: null }],
      ['meia', { unit: 'UN', nota_fiscal: null }],
    ]);
    const items = [
      { product_id: 'carimbo' }, { product_id: 'impressao' }, { product_id: 'ajuste' }, { product_id: 'meia' },
      { product_name: 'avulso nfse', nota_fiscal: 'nfse' }, { product_name: 'avulso srv', unit: 'srv' },
      // cadastro achado (com a coluna) vence o corpo
      { product_id: 'meia', nota_fiscal: 'nfse' },
    ];
    const { produtos: p, servicos: s } = separarServicos(items, produtos);
    expect(p.map((i) => i.product_id || i.product_name)).toEqual(['impressao', 'meia', 'meia']);
    expect(s.map((i) => i.product_id || i.product_name)).toEqual(['carimbo', 'ajuste', 'avulso nfse', 'avulso srv']);
  });

  test('pagamentos: forma que arredonda a zero sai; soma sempre fecha no alvo', () => {
    const out = pagamentosDosProdutos([{ method: 'pix', value: 0.01 }, { method: 'dinheiro', value: 99.99 }], 10);
    expect(out).toEqual([{ method: 'dinheiro', value: 10 }]);
    for (const alvo of [0.01, 1, 33.33, 99.99]) {
      const r = pagamentosDosProdutos([{ value: 33.33 }, { value: 33.33 }, { value: 33.34 }], alvo);
      expect(sum2(r.map((p) => p.value))).toBe(alvo);
    }
  });
});
