// ============================================================
// AURA. — NF-e 55 de VENDA: rotas (CP2b, 14/11/2026)
//   GET/POST /companies/:id/nfe55/venda/:saleId/previa
//   POST     /companies/:id/nfe55/venda/:saleId/emitir
//
// Banco falso com estado (padrão de __tests__/nfceDescontoDaVenda.test.js,
// roda sem Postgres). A engine é a REAL (sefazSp/nfe55Venda monta o XML);
// só o certificado, a assinatura e o SOAP são falsos — o autorizar/consulta
// mockados recebem o XML de verdade. ViaCEP falso (services/ibgePeloCep).
//
// Trava: 201 autorizada; 409 nos dois sentidos (NF-e ↔ NFC-e); 422
// faltantes, regime normal, DIFAL, UF não liberada, certificado; timeout
// ambíguo → consulta pela chave e NUNCA renumera; rejeição 539 pega número
// novo; homologação com o xNome padrão; salvar no cadastro (com e sem a
// migration 450). Dados fictícios.
// ============================================================
'use strict';

const supertest = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-0000000000c1';
const OUTRA_LOJA = '00000000-0000-0000-0000-0000000000c2';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

const P_CIMENTO = '11111111-1111-4111-8111-111111111111';
const P_TINTA = '22222222-2222-4222-8222-222222222222';
const P_SEM_NCM = '33333333-3333-4333-8333-333333333333';
const S_MONTAGEM = '44444444-4444-4444-8444-444444444444';

const C_CNPJ = 'cccccccc-0000-4000-8000-000000000001';
const C_CPF_MG = 'cccccccc-0000-4000-8000-000000000002';
const C_SEM_END = 'cccccccc-0000-4000-8000-000000000003';

const VENDA = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V_OK = VENDA(1);
const V_DIFAL = VENDA(2);
const V_SEM_END = VENDA(3);
const V_COM_NFCE = VENDA(4);
const V_OUTRA_LOJA = VENDA(5);
const V_SEM_NCM = VENDA(6);
const V_SO_SERVICO = VENDA(7);

const VIACEP = {
  12245000: { ibge: '3549904', municipio: 'Sao Jose dos Campos', uf: 'SP', logradouro: 'Avenida Central', bairro: 'Jardim Exemplo', cep: '12245000' },
  30110000: { ibge: '3106200', municipio: 'Belo Horizonte', uf: 'MG', logradouro: 'Rua Dois', bairro: 'Centro', cep: '30110000' },
  12327000: { ibge: '3524402', municipio: 'Jacarei', uf: 'SP', logradouro: '', bairro: '', cep: '12327000' },
};

let state;
function estadoInicial() {
  const linha = (product_id, name, quantity, unit_price, discount = 0) => {
    const bruto = Math.round(quantity * unit_price * 100) / 100;
    return {
      product_id, variant_id: null, quantity: String(quantity), unit_price: String(unit_price),
      discount: String(discount), total_price: String(Math.round((bruto - discount) * 100) / 100),
      product_name_snapshot: name,
    };
  };
  return {
    seq: 0,
    counter: 15,
    company: {
      id: CID, cnpj: '11222333000181', legal_name: 'Loja Exemplo Materiais Ltda', trade_name: 'Loja Exemplo',
      address_street: 'Rua das Palmeiras', address_number: '100', address_neighborhood: 'Centro',
      address_city: 'Jacarei', address_state: 'SP', address_zip: '12327000',
      inscricao_estadual: '110042490114', inscricao_municipal: null, ibge_code: '3524402',
      email: 'loja@exemplo.com', phone: '1239510000', tax_regime: 'simples_nacional',
    },
    config: {
      id: 'cfg-1', company_id: CID, is_active: true, ambiente: 'homologacao', uf: 'SP',
      serie_nfce: 1, next_number: 500, serie_sefaz_sp: 2, next_number_sefaz_sp: 900,
      serie_nfe55: 2, next_number_nfe55: 15, csc_id: '1', csc_token_enc: 'x', inscricao_estadual: '110042490114',
    },
    certNotAfter: new Date(Date.now() + 365 * 864e5).toISOString(),
    customerColsMissing: false,
    products: [
      { id: P_CIMENTO, company_id: CID, ncm: '25232910', tax_profile: null, unit: 'SC', barcode: '7891234567895', cest: null, origem: 0, icms_st_paid: false },
      { id: P_TINTA, company_id: CID, ncm: '32091010', tax_profile: null, unit: 'UN', barcode: null, cest: '2400700', origem: 0, icms_st_paid: true },
      { id: P_SEM_NCM, company_id: CID, ncm: null, tax_profile: null, unit: 'UN', barcode: null, cest: null, origem: 0, icms_st_paid: false },
      { id: S_MONTAGEM, company_id: CID, ncm: null, tax_profile: null, unit: 'srv', barcode: null, cest: null, origem: 0, icms_st_paid: false },
    ],
    customers: {
      [C_CNPJ]: {
        id: C_CNPJ, company_id: CID, name: 'Construtora Exemplo Ltda', cpf_cnpj: '11444777000161',
        email: 'compras@exemplo.com', phone: '12999990000', street: 'Avenida Central', number: '200',
        address_number: null, complement: 'Sala 3', neighborhood: 'Jardim Exemplo', city: 'Sao Jose dos Campos',
        state: 'SP', zip_code: '12245000', postal_code: null,
        ie: '110042490114', ind_ie_dest: 1, codigo_municipio_ibge: null,
      },
      [C_CPF_MG]: {
        id: C_CPF_MG, company_id: CID, name: 'Cliente Teste', cpf_cnpj: '39053344705', email: null, phone: null,
        street: 'Rua Dois', number: '50', address_number: null, complement: null, neighborhood: 'Centro',
        city: 'Belo Horizonte', state: 'MG', zip_code: '30110000', postal_code: null,
        ie: null, ind_ie_dest: null, codigo_municipio_ibge: null,
      },
      [C_SEM_END]: {
        id: C_SEM_END, company_id: CID, name: 'Cliente Sem Endereco', cpf_cnpj: '39053344705', email: null, phone: null,
        street: null, number: null, address_number: null, complement: null, neighborhood: null,
        city: null, state: null, zip_code: null, postal_code: null,
        ie: null, ind_ie_dest: null, codigo_municipio_ibge: null,
      },
    },
    // 10 x 35,90 + 1 x 90 + frete 20 - desconto 15 = 454
    sales: {
      [V_OK]: { id: V_OK, company_id: CID, customer_id: C_CNPJ, type: 'sale', status: 'completed', discount_amount: '15', total_amount: '454', payment_method: 'pix' },
      [V_DIFAL]: { id: V_DIFAL, company_id: CID, customer_id: C_CPF_MG, type: 'sale', status: 'completed', discount_amount: '0', total_amount: '359', payment_method: 'pix' },
      [V_SEM_END]: { id: V_SEM_END, company_id: CID, customer_id: C_SEM_END, type: 'sale', status: 'completed', discount_amount: '0', total_amount: '359', payment_method: 'dinheiro' },
      [V_COM_NFCE]: { id: V_COM_NFCE, company_id: CID, customer_id: C_CNPJ, type: 'sale', status: 'completed', discount_amount: '0', total_amount: '359', payment_method: 'pix' },
      [V_OUTRA_LOJA]: { id: V_OUTRA_LOJA, company_id: OUTRA_LOJA, customer_id: C_CNPJ, type: 'sale', status: 'completed', discount_amount: '0', total_amount: '359', payment_method: 'pix' },
      [V_SEM_NCM]: { id: V_SEM_NCM, company_id: CID, customer_id: C_CNPJ, type: 'sale', status: 'completed', discount_amount: '0', total_amount: '50', payment_method: 'pix' },
      [V_SO_SERVICO]: { id: V_SO_SERVICO, company_id: CID, customer_id: C_CNPJ, type: 'sale', status: 'completed', discount_amount: '0', total_amount: '80', payment_method: 'pix' },
    },
    saleItems: {
      [V_OK]: [linha(P_CIMENTO, 'Cimento CP II 50kg', 10, 35.9), linha(P_TINTA, 'Tinta Acrilica 18L', 1, 90), linha(null, 'Frete', 1, 20)],
      [V_DIFAL]: [linha(P_CIMENTO, 'Cimento CP II 50kg', 10, 35.9)],
      [V_SEM_END]: [linha(P_CIMENTO, 'Cimento CP II 50kg', 10, 35.9)],
      [V_COM_NFCE]: [linha(P_CIMENTO, 'Cimento CP II 50kg', 10, 35.9)],
      [V_OUTRA_LOJA]: [linha(P_CIMENTO, 'Cimento CP II 50kg', 10, 35.9)],
      [V_SEM_NCM]: [linha(P_SEM_NCM, 'Parafuso avulso', 1, 50)],
      [V_SO_SERVICO]: [linha(S_MONTAGEM, 'Montagem', 1, 80)],
    },
    salePayments: {
      [V_OK]: [{ method: 'pix', amount: '254' }, { method: 'crediario', amount: '200' }],
    },
    emissions: [
      { id: 'em-nfce-1', company_id: CID, sale_id: V_COM_NFCE, tipo: 'nfce', finalidade: 1, status: 'autorizada', numero: 900, serie: 2, chave_acesso: '3'.repeat(44), seq: 0 },
    ],
    customerUpdates: [],
    reservas: 0,
  };
}

function rowsDe(list) { return { rows: list.map((r) => ({ ...r })) }; }

async function fakeQuery(sql, params = []) {
  const s = String(sql);
  // ── nfce_emissions ──
  if (/FROM nfce_emissions\s+WHERE company_id = \$1 AND sale_id = \$2/.test(s)) {
    const comFinalidade = /finalidade/.test(s);
    return rowsDe(state.emissions
      .filter((e) => e.company_id === params[0] && e.sale_id === params[1])
      .filter((e) => e.tipo === 'nfce' || (e.tipo === 'nfe' && (!comFinalidade || (e.finalidade || 1) !== 4)))
      .sort((a, b) => b.seq - a.seq));
  }
  if (/FROM nfce_emissions\s+WHERE company_id=\$1 AND sale_id=\$2 AND tipo=\$3/.test(s)) {
    return rowsDe(state.emissions.filter((e) => e.company_id === params[0] && e.sale_id === params[1]
      && e.tipo === params[2] && ['autorizada', 'processando'].includes(e.status)));
  }
  if (/^\s*INSERT INTO nfce_emissions/.test(s)) {
    const row = {
      id: `em-${++state.seq}`, seq: state.seq, company_id: params[0], sale_id: params[1], numero: params[2], serie: params[3],
      chave_acesso: null, tipo: 'nfe', finalidade: /finalidade/.test(s) ? 1 : undefined, status: 'processando',
      customer_cpf: params[4], customer_name: params[5], items: JSON.parse(params[6]),
      total_products: params[7], total_discount: params[8], total_nfce: params[9], payment_method: params[10],
      emitted_by: params[11], metadata: params[12] ? JSON.parse(params[12]) : null,
      protocolo: null, error_message: null, xml_signed: null, rejection_code: null,
    };
    state.emissions.push(row);
    return { rows: [{ ...row }] };
  }
  const emById = (id) => state.emissions.find((e) => e.id === id);
  if (/UPDATE nfce_emissions SET chave_acesso = \$1, xml_signed = \$2 WHERE id = \$3/.test(s)) {
    Object.assign(emById(params[2]), { chave_acesso: params[0], xml_signed: params[1] });
    return { rows: [] };
  }
  if (/UPDATE nfce_emissions\s+SET status = \$1, protocolo/.test(s)) {
    const e = emById(params[3]);
    Object.assign(e, { status: params[0], protocolo: params[1] || e.protocolo, error_message: params[2] });
    return { rows: [] };
  }
  if (/UPDATE nfce_emissions\s+SET rejection_code = \$1/.test(s)) {
    Object.assign(emById(params[2]), { rejection_code: params[0], provider_used: 'sefaz_sp' });
    return { rows: [] };
  }
  if (/UPDATE nfce_emissions SET status = 'processando', error_message = NULL WHERE id = \$1/.test(s)) {
    Object.assign(emById(params[0]), { status: 'processando', error_message: null });
    return { rows: [] };
  }
  if (/SELECT \* FROM nfce_emissions WHERE id = \$1/.test(s)) {
    const e = emById(params[0]);
    return { rows: e ? [{ ...e }] : [] };
  }
  // ── numeração ──
  if (/UPDATE nfce_config\s+SET next_number_nfe55 = next_number_nfe55 \+ 1/.test(s)) {
    state.reservas++;
    const numero = state.counter++;
    return { rows: [{ serie_nfe55: 2, numero }] };
  }
  // ── leituras ──
  if (/SELECT \* FROM sales WHERE id = \$1 AND company_id = \$2/.test(s)) {
    const v = state.sales[params[0]];
    return { rows: v && v.company_id === params[1] ? [{ ...v }] : [] };
  }
  if (/FROM sale_items WHERE sale_id = \$1/.test(s)) return rowsDe(state.saleItems[params[0]] || []);
  if (/FROM sale_payments WHERE sale_id = \$1/.test(s)) return rowsDe(state.salePayments[params[0]] || []);
  if (/SELECT \* FROM nfce_config WHERE company_id = \$1/.test(s)) return { rows: state.config ? [{ ...state.config }] : [] };
  if (/FROM companies WHERE id = \$1/.test(s) && /legal_name/.test(s)) return { rows: [{ ...state.company }] };
  if (/SELECT id FROM companies\s+WHERE owner_id/.test(s)) return { rows: [{ id: CID }] };
  if (/FROM company_certificates/.test(s)) return { rows: [{ not_after: state.certNotAfter, '?column?': 1 }] };
  if (/FROM products/.test(s)) {
    const ids = params[0] || [];
    return rowsDe(state.products.filter((p) => ids.includes(p.id) && p.company_id === params[1]));
  }
  if (/FROM customers WHERE id = \$1/.test(s)) {
    if (state.customerColsMissing && /\bie\b/.test(s)) { const e = new Error('column "ie" does not exist'); e.code = '42703'; throw e; }
    const c = state.customers[params[0]];
    if (!c || !(params[1] || []).includes(c.company_id)) return { rows: [] };
    const row = { ...c };
    if (state.customerColsMissing) { delete row.ie; delete row.ind_ie_dest; delete row.codigo_municipio_ibge; }
    return { rows: [row] };
  }
  if (/^\s*UPDATE customers SET/.test(s)) {
    if (state.customerColsMissing && /\bie = /.test(s)) { const e = new Error('column "ie" does not exist'); e.code = '42703'; throw e; }
    state.customerUpdates.push({ sql: s, params });
    return { rows: [] };
  }
  return { rows: [] };
}

let ctx;
function buildApp() {
  jest.resetModules();
  const query = jest.fn(fakeQuery);
  const db = { query, queryRetry: (...a) => query(...a), isTransientConnError: () => false, connect: jest.fn() };
  const soapReal = jest.requireActual('../src/services/sefazSp/soapClient');
  const soap = { ...soapReal, autorizar: jest.fn(), consultarChave: jest.fn() };
  const ibge = { ibgePeloCep: jest.fn(async (cep) => VIACEP[String(cep).replace(/\D/g, '')] || null), normalizarCep: (c) => c };
  jest.doMock('../src/config/database', () => db);
  jest.doMock('../src/services/sefazSp/soapClient', () => soap);
  jest.doMock('../src/services/sefazSp/certStore', () => ({
    loadCertificate: jest.fn(async () => ({ pfx: Buffer.from('pfx-falso'), password: 'senha' })),
  }));
  jest.doMock('../src/services/sefazSp/pfx', () => ({
    openPfx: jest.fn(() => ({ keyPem: 'KEY', certDerBase64: 'CERT', certPem: 'PEM' })),
    assertValidity: jest.fn(),
  }));
  jest.doMock('../src/services/sefazSp/signer', () => ({
    signInfNfe: jest.fn(() => ({ signatureXml: '<Signature>falsa</Signature>' })),
  }));
  jest.doMock('../src/services/ibgePeloCep', () => ibge);
  jest.doMock('../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));
  jest.doMock('../src/services/nuvemfiscal', () => ({
    emitNfce: jest.fn(), emitNfe: jest.fn(), queryNfce: jest.fn(), queryNfe: jest.fn(),
    ufToCodigo: jest.requireActual('../src/services/sefazSp/nfeHelpers').ufToCodigo,
  }));
  const app = express();
  app.use(express.json());
  app.use('/c/:id/nfe55', require('../src/routes/nfe55Venda'));
  app.use('/c/:id/nfce', require('../src/routes/nfce'));
  ctx = { app, db, soap, ibge };
  return ctx;
}

const emitir = (saleId, body = {}) => supertest(ctx.app).post(`/c/${CID}/nfe55/venda/${saleId}/emitir`).set(auth).send(body);
const previa = (saleId) => supertest(ctx.app).get(`/c/${CID}/nfe55/venda/${saleId}/previa`).set(auth);
const previaPost = (saleId, body) => supertest(ctx.app).post(`/c/${CID}/nfe55/venda/${saleId}/previa`).set(auth).send(body);
const emitirNfce = (saleId) => supertest(ctx.app).post(`/c/${CID}/nfce/emit`).set(auth).send({
  sale_id: saleId, tipo: 'nfce', payments: [{ method: 'pix', value: 359 }],
  items: [{ product_id: P_CIMENTO, product_name: 'Cimento', quantity: 10, unit_price: 35.9 }],
});

const AUTORIZADO = (xml) => ({
  cStat: '100', xMotivo: 'Autorizado o uso da NF-e', protocolo: '135260000000001',
  chNFe: (xml.match(/Id="NFe(\d{44})"/) || [])[1], autorizada: true, rejeitada: false,
});
const REJEITADO = (cStat, xMotivo) => ({ cStat, xMotivo, protocolo: null, autorizada: false, rejeitada: true });
const timeout = () => { const S = jest.requireActual('../src/services/sefazSp/soapClient').SefazTransportError; return new S('SEFAZ inacessível (timeout)', { ambiguous: true }); };
const chaveDoXml = (xml) => (xml.match(/Id="NFe(\d{44})"/) || [])[1];
const nfeRows = () => state.emissions.filter((e) => e.tipo === 'nfe');

const ENV_KEYS = ['NFE55_VENDA_UFS', 'AURA_RESP_TEC_CNPJ', 'NUVEM_FISCAL_CLIENT_ID', 'NUVEM_FISCAL_CLIENT_SECRET'];
const envOriginal = {};
beforeAll(() => { for (const k of ENV_KEYS) envOriginal[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  state = estadoInicial();
  buildApp();
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

// ── Prévia ────────────────────────────────────────────────────
describe('GET /nfe55/venda/:saleId/previa', () => {
  it('pré-preenche do cadastro, acha o IBGE pelo CEP, CFOP por item, desconto e frete rateados, pagamentos reais', async () => {
    const r = await previa(V_OK);
    expect(r.status).toBe(200);
    expect(r.body.pode_emitir).toBe(true);
    expect(r.body.faltantes).toEqual([]);
    expect(r.body.bloqueio).toBeNull();
    expect(r.body.ambiente).toBe('homologacao');
    expect(r.body.destinatario).toMatchObject({
      documento: '11444777000161', nome: 'Construtora Exemplo Ltda', ie: '110042490114', ind_ie_dest: 1,
      endereco: { cep: '12245000', logradouro: 'Avenida Central', numero: '200', bairro: 'Jardim Exemplo',
        municipio: 'Sao Jose dos Campos', uf: 'SP', codigo_municipio_ibge: '3549904' },
      origem: { cadastro: true, ibge: 'viacep' }, customer_id: C_CNPJ,
    });
    expect(r.body.operacao).toMatchObject({ id_dest: 1, ind_final: 0, ind_ie_dest: 1, uf_emitente: 'SP', uf_destino: 'SP' });
    // Frete saiu dos produtos (2 itens), desconto 15 rateado (12 + 3), frete 20 rateado (15,99 + 4,01).
    expect(r.body.itens.map((i) => i.cfop)).toEqual(['5102', '5405']);
    expect(r.body.itens.map((i) => i.desconto)).toEqual([12, 3]);
    expect(r.body.itens.map((i) => i.frete)).toEqual([15.99, 4.01]);
    expect(r.body.itens[1]).toMatchObject({ csosn: '500', cest: '2400700' });
    expect(r.body.totais).toEqual({ produtos: 449, desconto: 15, frete: 20, nota: 454 });
    expect(r.body.pagamentos).toEqual([
      { forma: 'pix', tPag: '17', valor: 254, a_prazo: false },
      { forma: 'crediario', tPag: '05', valor: 200, a_prazo: true },
    ]);
    expect(r.body.frete.modalidade).toBe(0);
    expect(nfeRows()).toHaveLength(0);
    expect(state.reservas).toBe(0);
  });

  it('venda de outra loja: 404', async () => {
    const r = await previa(V_OUTRA_LOJA);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('VENDA_NAO_ENCONTRADA');
  });

  it('venda que já tem NFC-e: mostra a nota existente e não deixa emitir', async () => {
    const r = await previa(V_COM_NFCE);
    expect(r.status).toBe(200);
    expect(r.body.pode_emitir).toBe(false);
    expect(r.body.nota_existente).toMatchObject({ tipo: 'nfce', status: 'autorizada' });
  });

  it('POST /previa com o corpo do wizard completa o que faltava', async () => {
    const semCorpo = await previa(V_SEM_END);
    expect(semCorpo.body.pode_emitir).toBe(false);
    const r = await previaPost(V_SEM_END, {
      destinatario: { endereco: { cep: '12327-000', logradouro: 'Rua Um', numero: '10', bairro: 'Vila Teste' } },
    });
    expect(r.status).toBe(200);
    expect(r.body.faltantes).toEqual([]);
    expect(r.body.pode_emitir).toBe(true);
    expect(r.body.destinatario.endereco).toMatchObject({ municipio: 'Jacarei', uf: 'SP', codigo_municipio_ibge: '3524402' });
    expect(r.body.operacao).toMatchObject({ ind_ie_dest: 9, ind_final: 1 });
  });
});

// ── Emissão ───────────────────────────────────────────────────
describe('POST /nfe55/venda/:saleId/emitir', () => {
  it('201 autorizada (homologação): tipo nfe + finalidade 1, contador da 55, chave gravada antes do envio, xNome padrão', async () => {
    let chaveNoBancoAntes = null;
    ctx.soap.autorizar.mockImplementation(async ({ signedNfeXml }) => {
      chaveNoBancoAntes = nfeRows()[0].chave_acesso;
      return AUTORIZADO(signedNfeXml);
    });
    const r = await emitir(V_OK, { observacoes: 'Pedido 123' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'autorizada', numero: 15, serie: 2, protocolo: '135260000000001', ambiente: 'homologacao' });
    expect(r.body.chave_acesso).toHaveLength(44);
    expect(r.body.nfe.xml_signed).toBeUndefined();

    const xml = ctx.soap.autorizar.mock.calls[0][0].signedNfeXml;
    expect(chaveNoBancoAntes).toBe(chaveDoXml(xml));
    expect(xml).toContain('<mod>55</mod>');
    expect(xml).toContain('<tpAmb>2</tpAmb>');
    expect(xml).toContain('<xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>');
    expect(xml).toContain('<CFOP>5102</CFOP>');
    expect(xml).toContain('<CFOP>5405</CFOP>');
    expect(xml).toContain('<vFrete>20.00</vFrete>');
    expect(xml).toContain('<vNF>454.00</vNF>');
    expect(xml).toContain('<modFrete>0</modFrete>');
    expect(xml).toContain('<tPag>05</tPag><vPag>200.00</vPag>');
    expect(xml).toContain('Pedido 123');
    expect(ctx.soap.autorizar.mock.calls[0][0].endpoints.autorizacao).toContain('homologacao.nfe.fazenda.sp.gov.br');

    const [row] = nfeRows();
    expect(row).toMatchObject({ tipo: 'nfe', finalidade: 1, status: 'autorizada', numero: 15, serie: 2, customer_cpf: '11444777000161' });
    expect(row.metadata.nfe55_venda.totais.nota).toBe(454);
    expect(state.reservas).toBe(1);
  });

  it('409 nos dois sentidos: NF-e de novo, NFC-e depois da NF-e e NF-e depois da NFC-e', async () => {
    ctx.soap.autorizar.mockImplementation(async ({ signedNfeXml }) => AUTORIZADO(signedNfeXml));
    expect((await emitir(V_OK)).status).toBe(201);

    const deNovo = await emitir(V_OK);
    expect(deNovo.status).toBe(409);
    expect(deNovo.body).toMatchObject({ code: 'NOTA_DE_PRODUTOS_JA_EXISTE', nota: { tipo: 'nfe', numero: 15, status: 'autorizada' } });

    const nfce = await emitirNfce(V_OK);
    expect(nfce.status).toBe(409);
    expect(nfce.body.code).toBe('NOTA_DE_PRODUTOS_JA_EXISTE');
    expect(nfce.body.nota).toMatchObject({ tipo: 'nfe', numero: 15 });

    const depoisDaNfce = await emitir(V_COM_NFCE);
    expect(depoisDaNfce.status).toBe(409);
    expect(depoisDaNfce.body).toMatchObject({ code: 'NOTA_DE_PRODUTOS_JA_EXISTE', nota: { tipo: 'nfce', status: 'autorizada' } });

    expect(ctx.soap.autorizar).toHaveBeenCalledTimes(1);
    expect(state.reservas).toBe(1);
  });

  it('devolução 55 (finalidade 4) e NF-e cancelada/rejeitada não travam a NFC-e', async () => {
    state.emissions.push(
      { id: 'em-dev', company_id: CID, sale_id: V_OK, tipo: 'nfe', finalidade: 4, status: 'autorizada', numero: 3, serie: 2, seq: 0 },
      { id: 'em-canc', company_id: CID, sale_id: V_OK, tipo: 'nfe', finalidade: 1, status: 'cancelada', numero: 4, serie: 2, seq: 0 },
    );
    const nfce = await emitirNfce(V_OK);
    expect(nfce.status).not.toBe(409);
  });

  it('422 com a lista de faltantes em linguagem humana, sem reservar número', async () => {
    const r = await emitir(V_SEM_END);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NFE_DADOS_FALTANTES');
    const campos = r.body.faltantes.map((f) => f.campo);
    expect(campos).toEqual(expect.arrayContaining([
      'destinatario.endereco.logradouro', 'destinatario.endereco.bairro', 'destinatario.endereco.cep',
      'destinatario.endereco.uf', 'destinatario.endereco.municipio', 'destinatario.endereco.codigo_municipio_ibge',
    ]));
    for (const f of r.body.faltantes) expect(typeof f.mensagem).toBe('string');
    expect(state.reservas).toBe(0);
    expect(nfeRows()).toHaveLength(0);
    expect(ctx.soap.autorizar).not.toHaveBeenCalled();
  });

  it('422 quando o CEP não acha o município (não inventa código)', async () => {
    const r = await emitir(V_SEM_END, {
      destinatario: { endereco: { cep: '99999999', logradouro: 'Rua Um', bairro: 'Vila Teste', municipio: 'Cidade', uf: 'SP' } },
    });
    expect(r.status).toBe(422);
    expect(r.body.faltantes).toEqual([
      expect.objectContaining({ campo: 'destinatario.endereco.codigo_municipio_ibge', tipo: 'faltando' }),
    ]);
  });

  it('422 quando o produto não tem NCM, IE inválida e CPF/CNPJ errado', async () => {
    const semNcm = await emitir(V_SEM_NCM);
    expect(semNcm.status).toBe(422);
    expect(semNcm.body.faltantes).toEqual([expect.objectContaining({ campo: 'itens[0].ncm', product_id: P_SEM_NCM })]);

    const ieRuim = await emitir(V_OK, { destinatario: { ie: '110042490115' } });
    expect(ieRuim.status).toBe(422);
    expect(ieRuim.body.faltantes).toEqual([expect.objectContaining({ campo: 'destinatario.ie', tipo: 'invalido' })]);

    const docRuim = await emitir(V_OK, { destinatario: { documento: '11444777000162' } });
    expect(docRuim.status).toBe(422);
    expect(docRuim.body.faltantes).toEqual([expect.objectContaining({ campo: 'destinatario.documento', tipo: 'invalido' })]);
    expect(state.reservas).toBe(0);
  });

  it('422 regime normal (mensagem gentil, sem crash)', async () => {
    state.company.tax_regime = 'lucro_presumido';
    const r = await emitir(V_OK);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NFE_REGIME_NORMAL_FORA_DO_V1');
    expect(r.body.error).toMatch(/ainda não emitimos NF-e/i);
    const p = await previa(V_OK);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ pode_emitir: false, bloqueio: { code: 'NFE_REGIME_NORMAL_FORA_DO_V1' } });
  });

  it('422 DIFAL: consumidor final de outra UF sem IE', async () => {
    const r = await emitir(V_DIFAL);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NFE_DIFAL_FORA_DO_V1');
    expect(r.body.error).toMatch(/NFC-e/);
    expect(state.reservas).toBe(0);
  });

  it('outra UF com cliente contribuinte sai 6102', async () => {
    ctx.soap.autorizar.mockImplementation(async ({ signedNfeXml }) => AUTORIZADO(signedNfeXml));
    const r = await emitir(V_DIFAL, { destinatario: { documento: '11444777000161', nome: 'Construtora Exemplo', ie: '0623079040081' } });
    expect(r.status).toBe(201);
    const xml = ctx.soap.autorizar.mock.calls[0][0].signedNfeXml;
    expect(xml).toContain('<idDest>2</idDest>');
    expect(xml).toContain('<CFOP>6102</CFOP>');
  });

  it('422 venda só de serviço, UF não liberada e certificado vencido', async () => {
    expect((await emitir(V_SO_SERVICO)).body.code).toBe('NFE_SEM_PRODUTOS');

    state.company.address_state = 'RJ'; state.config.uf = 'RJ';
    const rj = await emitir(V_OK);
    expect(rj.status).toBe(422);
    expect(rj.body.code).toBe('NFE55_UF_NAO_HABILITADA');
    process.env.NFE55_VENDA_UFS = 'SP,RJ';
    const rjLiberado = await previa(V_OK);
    expect(rjLiberado.body.bloqueio).toBeNull();
    expect(rjLiberado.body.operacao.id_dest).toBe(2); // cliente de SP, loja do RJ

    state.company.address_state = 'SP'; state.config.uf = 'SP';
    state.certNotAfter = new Date(Date.now() - 864e5).toISOString();
    const cert = await emitir(V_OK);
    expect(cert.status).toBe(422);
    expect(cert.body.code).toBe('NFE_CERTIFICADO');
    expect(state.reservas).toBe(0);
  });

  it('produção: xNome real do cliente e endpoint de produção', async () => {
    state.config.ambiente = 'producao';
    ctx.soap.autorizar.mockImplementation(async ({ signedNfeXml }) => AUTORIZADO(signedNfeXml));
    const r = await emitir(V_OK);
    expect(r.status).toBe(201);
    const { signedNfeXml, endpoints, tpAmb } = ctx.soap.autorizar.mock.calls[0][0];
    expect(tpAmb).toBe(1);
    expect(endpoints.autorizacao).toBe('https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx');
    expect(signedNfeXml).toContain('<xNome>Construtora Exemplo Ltda</xNome>');
    expect(signedNfeXml).not.toContain('<IBSCBS>');
  });
});

// ── Timeout ambíguo: nunca renumera ──────────────────────────
describe('timeout ambíguo', () => {
  it('consulta diz "não consta" → 202 e a nova tentativa reenvia o MESMO número e a MESMA chave', async () => {
    ctx.soap.autorizar.mockRejectedValueOnce(timeout());
    ctx.soap.consultarChave.mockResolvedValueOnce({ cStat: '217', xMotivo: 'NF-e nao consta na base', autorizada: false, naoConsta: true });
    const r1 = await emitir(V_OK);
    expect(r1.status).toBe(202);
    expect(r1.body.code).toBe('NFE_AGUARDANDO_SEFAZ');
    const chave1 = r1.body.chave_acesso;
    expect(ctx.soap.consultarChave.mock.calls[0][0].chave).toBe(chave1);
    expect(nfeRows()[0]).toMatchObject({ status: 'erro', numero: 15, chave_acesso: chave1 });

    ctx.soap.autorizar.mockImplementationOnce(async ({ signedNfeXml }) => AUTORIZADO(signedNfeXml));
    const r2 = await emitir(V_OK);
    expect(r2.status).toBe(201);
    expect(r2.body.numero).toBe(15);
    expect(r2.body.chave_acesso).toBe(chave1); // mesmo cNF, mesmo mês → mesma chave (sem 539)
    expect(state.reservas).toBe(1);
  });

  it('nem a consulta responde → 202 processando, trava a NFC-e; depois a consulta acha autorizada e NÃO reenvia', async () => {
    ctx.soap.autorizar.mockRejectedValueOnce(timeout());
    ctx.soap.consultarChave.mockRejectedValueOnce(new Error('rede caiu'));
    const r1 = await emitir(V_OK);
    expect(r1.status).toBe(202);
    expect(nfeRows()[0].status).toBe('processando');

    expect((await emitirNfce(V_OK)).status).toBe(409);

    ctx.soap.consultarChave.mockRejectedValueOnce(new Error('ainda fora'));
    const r2 = await emitir(V_OK);
    expect(r2.status).toBe(503);
    expect(r2.body.code).toBe('NFE_SEFAZ_SEM_RESPOSTA');

    ctx.soap.consultarChave.mockResolvedValueOnce({ cStat: '100', xMotivo: 'Autorizado', autorizada: true, protocolo: '135260000000009' });
    const r3 = await emitir(V_OK);
    expect(r3.status).toBe(201);
    expect(r3.body).toMatchObject({ recuperada: true, status: 'autorizada', numero: 15, protocolo: '135260000000009', chave_acesso: r1.body.chave_acesso });
    expect(ctx.soap.autorizar).toHaveBeenCalledTimes(1);
    expect(state.reservas).toBe(1);
    expect(nfeRows()).toHaveLength(1);
  });
});

// ── Rejeição ──────────────────────────────────────────────────
describe('rejeição', () => {
  it('rejeição comum (778): 422 com texto amigável; a próxima tentativa reaproveita o número', async () => {
    ctx.soap.autorizar.mockResolvedValueOnce(REJEITADO('778', 'Rejeicao: Informado NCM inexistente'));
    const r1 = await emitir(V_OK);
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('NFE_REJEITADA');
    expect(r1.body.rejeicao_amigavel).toMatchObject({ cStat: '778', conhecida: true });
    expect(nfeRows()[0]).toMatchObject({ status: 'rejeitada', rejection_code: '778' });

    ctx.soap.autorizar.mockImplementationOnce(async ({ signedNfeXml }) => AUTORIZADO(signedNfeXml));
    const r2 = await emitir(V_OK);
    expect(r2.status).toBe(201);
    expect(r2.body.numero).toBe(15);
    expect(state.reservas).toBe(1);
  });

  it('rejeição por número já usado (539): a próxima tentativa pega número novo', async () => {
    ctx.soap.autorizar.mockResolvedValueOnce(REJEITADO('539', 'Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso'));
    const r1 = await emitir(V_OK);
    expect(r1.status).toBe(422);
    expect(r1.body.rejeicao_amigavel.cStat).toBe('539');

    ctx.soap.autorizar.mockImplementationOnce(async ({ signedNfeXml }) => AUTORIZADO(signedNfeXml));
    const r2 = await emitir(V_OK);
    expect(r2.status).toBe(201);
    expect(r2.body.numero).toBe(16);
    expect(state.reservas).toBe(2);
  });

  it('IE do destinatário recusada pela SEFAZ tem texto humano no catálogo', async () => {
    ctx.soap.autorizar.mockResolvedValueOnce(REJEITADO('233', 'Rejeicao: IE do destinatario nao cadastrada'));
    const r = await emitir(V_OK);
    expect(r.body.rejeicao_amigavel).toMatchObject({ cStat: '233', conhecida: true, quem: 'lojista' });
  });
});

// ── Cadastro do cliente ──────────────────────────────────────
describe('salvar_no_cadastro', () => {
  it('grava IE, indicador, IBGE e endereço no cliente', async () => {
    ctx.soap.autorizar.mockImplementation(async ({ signedNfeXml }) => AUTORIZADO(signedNfeXml));
    const r = await emitir(V_OK, { salvar_no_cadastro: true });
    expect(r.status).toBe(201);
    expect(r.body.cadastro).toEqual({ salvo: true });
    const [upd] = state.customerUpdates;
    expect(upd.sql).toMatch(/ie = /);
    expect(upd.sql).toMatch(/ind_ie_dest = /);
    expect(upd.sql).toMatch(/codigo_municipio_ibge = /);
    expect(upd.params).toEqual(expect.arrayContaining([C_CNPJ, '110042490114', 1, '3549904', '12245000']));
  });

  it('sem a migration 450: lê e grava sem as colunas novas (ignored_fields), sem crash', async () => {
    state.customerColsMissing = true;
    ctx.soap.autorizar.mockImplementation(async ({ signedNfeXml }) => AUTORIZADO(signedNfeXml));
    const p = await previa(V_OK);
    expect(p.status).toBe(200);
    // sem a coluna ie, o cliente vira não contribuinte (9) até informar a IE
    expect(p.body.destinatario.ind_ie_dest).toBe(9);
    const r = await emitir(V_OK, { salvar_no_cadastro: true, destinatario: { ie: '110042490114' } });
    expect(r.status).toBe(201);
    expect(r.body.cadastro).toEqual({ salvo: true, ignored_fields: ['ie', 'ind_ie_dest', 'codigo_municipio_ibge'] });
    expect(state.customerUpdates[0].sql).not.toMatch(/\bie = /);
  });
});
