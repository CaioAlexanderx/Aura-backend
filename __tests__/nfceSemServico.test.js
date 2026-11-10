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

const PRODUCTS = [
  { id: P_CAMISETA, company_id: CID, ncm: '61091000', tax_profile: 'simples_st', unit: 'UN', is_group_shared: false },
  { id: P_SEM_NCM,  company_id: CID, ncm: '00000000', tax_profile: null, unit: null, is_group_shared: false },
  { id: S_AJUSTE,   company_id: CID, ncm: null, tax_profile: null, unit: 'srv', is_group_shared: false },
  { id: P_GRUPO,    company_id: MATRIZ, ncm: '33049910', tax_profile: 'simples_outros', unit: 'UN', is_group_shared: true },
  { id: S_GRUPO,    company_id: MATRIZ, ncm: null, tax_profile: null, unit: 'srv', is_group_shared: true },
  { id: P_OUTRA,    company_id: MATRIZ, ncm: '99999999', tax_profile: 'simples_st', unit: 'UN', is_group_shared: false },
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
      expect(got.writes).toEqual(exp.writes);     // INSERT/UPDATE: SQL e parametros
    });
  }

  afterAll(() => {
    if (!RECORD) return;
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, JSON.stringify(golden, null, 2) + '\n');
  });
});
