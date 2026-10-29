// ============================================================
// tq-39 (29/10/2026) — NFC-e da troca com valor a pagar.
//
// O wizard da troca mandava os itens novos pelo valor cheio e so o liquido
// (novo - devolvido) nos pagamentos: validatePayments recusava com 400. Agora
// o app manda o credito da devolucao como forma de pagamento "credito_troca"
// (e o desconto real no `discount` do item). Aqui trava o lado do backend:
//   1. troca com credito: soma fecha -> emite; credito vira tPag 05 a vista
//      (indPag 0), pix vira 17; desconto do item vai pro vDesc;
//   2. o corpo antigo (so o liquido) continua 400 — a recusa e do dado, nao
//      do backend;
//   3. cartao_credito/cartao_debito (nomes do wizard) nao caem mais em
//      Dinheiro (01).
// Monta so o router nfce num app minimo (padrao de sefazSpFallback.test.js).
// ============================================================
const supertest = require('supertest');
const app0 = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../../src/services/sefazSp', () => ({ emitNfce: jest.fn() }));
jest.mock('../../src/services/nuvemfiscal', () => ({
  emitNfce: jest.fn(), emitNfe: jest.fn(), queryNfce: jest.fn(), queryNfe: jest.fn(),
  ufToCodigo: () => 35, isoBR: () => '2026-10-29T10:00:00-03:00',
}));
jest.mock('../../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));

const sefazSp = require('../../src/services/sefazSp');
const nuvemfiscal = require('../../src/services/nuvemfiscal');
const engineBreaker = require('../../src/services/sefazSp/engineBreaker');

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-000000000001';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

const COMPANY_ROW = {
  id: CID, cnpj: '11222333000181', legal_name: 'Loja', trade_name: 'Loja',
  address_street: 'R', address_number: '1', address_neighborhood: 'C',
  address_city: 'Jacarei', address_state: 'SP', address_zip: '12327000',
  inscricao_estadual: '111222333444', inscricao_municipal: null, ibge_code: '3524402',
  email: 'x@y.com', phone: '1', tax_regime: 'simples_nacional',
};
const CONFIG_ROW = {
  id: 'cfg-1', company_id: CID, provider: 'sefaz_sp', is_active: true,
  ambiente: 'producao', uf: 'SP', serie_nfce: 1, next_number: 500,
  serie_sefaz_sp: 2, next_number_sefaz_sp: 900, csc_id: '1', csc_token_enc: 'x',
  inscricao_estadual: '111222333444',
};
const OK_RESULT = {
  status: 'autorizado', chave_acesso: '3'.repeat(44), protocolo: 'P1',
  codigo_status: '100', motivo_status: 'Autorizado', qr_code: 'qr', url_consulta: 'u',
  xml_signed: '<xml/>', tp_emis: 1, provider: 'sefaz_sp',
};

function makeDb() {
  const emission = { id: 'em-1', company_id: CID, status: 'processando', numero: null, serie: null, chave_acesso: null };
  const query = jest.fn(async (sql, params = []) => {
    if (/SELECT serie_sefaz_sp, next_number_sefaz_sp FROM nfce_config/.test(sql)) return { rows: [] };
    if (/SELECT provider_used, fallback_reason FROM nfce_emissions/.test(sql)) return { rows: [] };
    if (/SELECT \* FROM nfce_config/.test(sql)) return { rows: [CONFIG_ROW] };
    if (/FROM companies WHERE id=/.test(sql)) return { rows: [COMPANY_ROW] };
    if (/UPDATE nfce_config SET next_number_sefaz_sp/.test(sql)) return { rows: [{ numero: 900 }] };
    if (/UPDATE nfce_config SET next_number =/.test(sql)) return { rows: [{ numero: 500 }] };
    if (/INSERT INTO nfce_emissions/.test(sql)) return { rows: [{ ...emission, numero: params[3], serie: params[4] }] };
    if (/SELECT \* FROM nfce_emissions WHERE id=/.test(sql)) return { rows: [{ ...emission, status: 'autorizada' }] };
    return { rows: [] };
  });
  return { query, connect: jest.fn() };
}

function buildApp(dbMock) {
  jest.resetModules();
  jest.doMock('../../src/config/database', () => dbMock);
  jest.doMock('../../src/services/sefazSp', () => sefazSp);
  jest.doMock('../../src/services/nuvemfiscal', () => nuvemfiscal);
  jest.doMock('../../src/services/sefazSp/engineBreaker', () => engineBreaker);
  jest.doMock('../../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));
  const router = require('../../src/routes/nfce');
  const a = app0();
  a.use(app0.json());
  a.use('/c/:id/nfce', router);
  return a;
}

// Troca: devolveu R$ 189,90; leva tenis de 339,99 com 20,00 de desconto no
// item + 10,00 de desconto da troca rateado (= 30,00 no item). Nota: 309,99.
// Cliente paga 120,09 no pix; o credito da devolucao cobre 189,90.
const ITENS_DA_TROCA = [{ product_id: 'p9', product_name: 'Tenis novo', quantity: 1, unit_price: 339.99, discount: 30 }];

beforeEach(() => {
  jest.clearAllMocks();
  engineBreaker.reset();
});

describe('NFC-e da troca com valor a pagar (tq-39)', () => {
  test('credito da devolucao como Credito Loja a vista fecha a soma e a nota sai', async () => {
    sefazSp.emitNfce.mockResolvedValueOnce(OK_RESULT);
    const a = buildApp(makeDb());
    const res = await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send({
      items: ITENS_DA_TROCA,
      payments: [{ method: 'pix', value: 120.09 }, { method: 'credito_troca', value: 189.9 }],
      sale_id: 'troca-1', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const payload = sefazSp.emitNfce.mock.calls[0][1];
    expect(payload.total_value).toBe(309.99);
    expect(payload.items[0]).toEqual(expect.objectContaining({ price: 339.99, discount: 30 }));
    expect(payload.payments).toEqual([
      expect.objectContaining({ method: '17', value: 120.09, indPag: 0 }),
      expect.objectContaining({ method: '05', value: 189.9, indPag: 0 }),
    ]);
  });

  test('corpo antigo (so o liquido nos pagamentos) continua recusado com 400', async () => {
    const a = buildApp(makeDb());
    const res = await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send({
      items: [{ product_id: 'p9', product_name: 'Tenis novo', quantity: 1, unit_price: 339.99 }],
      payments: [{ method: 'pix', value: 150.09 }],
      sale_id: 'troca-1', tipo: 'nfce',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Soma dos pagamentos/);
    expect(sefazSp.emitNfce).not.toHaveBeenCalled();
  });

  test('cartao_credito e cartao_debito do wizard viram 03 e 04 (nao Dinheiro)', async () => {
    sefazSp.emitNfce.mockResolvedValueOnce(OK_RESULT);
    const a = buildApp(makeDb());
    const res = await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send({
      items: [{ product_id: 'p9', product_name: 'Tenis novo', quantity: 1, unit_price: 100 }],
      payments: [{ method: 'cartao_credito', value: 30 }, { method: 'cartao_debito', value: 20 }, { method: 'credito_troca', value: 50 }],
      sale_id: 'troca-2', tipo: 'nfce',
    });
    expect(res.status).toBe(201);
    const pagos = sefazSp.emitNfce.mock.calls[0][1].payments.map((p) => [p.method, p.indPag]);
    expect(pagos).toEqual([['03', 0], ['04', 0], ['05', 0]]);
  });

  test('crediario segue a prazo (indPag 1), sem mudanca', async () => {
    sefazSp.emitNfce.mockResolvedValueOnce(OK_RESULT);
    const a = buildApp(makeDb());
    await supertest(a).post(`/c/${CID}/nfce/emit`).set(auth).send({
      items: [{ product_id: 'p1', product_name: 'Item', quantity: 1, unit_price: 10 }],
      payments: [{ method: 'crediario', value: 10 }],
      sale_id: 'venda-3', tipo: 'nfce',
    });
    expect(sefazSp.emitNfce.mock.calls[0][1].payments).toEqual([expect.objectContaining({ method: '05', indPag: 1 })]);
  });
});
