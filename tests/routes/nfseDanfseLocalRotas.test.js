// ============================================================
// As duas rotas que servem o DANFSe da NFS-e nacional, com o serviço de
// verdade (só o banco, o cofre do A1, o ADN e a situação da origem são
// simulados):
//   GET /companies/:id/nfse/:nid/pdf
//   GET /companies/:id/nfse/automatica/origem/:tipo/:origemId/segunda-via?formato=pdf&nfse_id=
// ADN 200 → o PDF do ADN; ADN 503 → o DANFSe gerado pela Aura do XML
// autorizado (application/pdf, o app abre igual); nota de outro emissor →
// 409 como hoje, sem chamar o ADN.
// ============================================================
'use strict';

jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'u1', role: 'client' }; next(); },
  requireRole: () => (req, res, next) => next(),
}));

jest.mock('../../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(),
  getCertificateInfo: jest.fn(),
  saveCertificate: jest.fn(),
}));

jest.mock('../../src/services/nfseNacional/repo', () => {
  const state = { notas: [], company: null };
  const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  return {
    __state: state,
    buscarPorId: jest.fn(async (db, companyId, id) => clone(state.notas.find((n) => n.company_id === companyId && n.id === id)) || null),
    carregarContexto: jest.fn(async () => ({ config: null, company: clone(state.company), certInfo: null })),
  };
});

jest.mock('../../src/services/nfseNacional/client', () => {
  const real = jest.requireActual('../../src/services/nfseNacional/client');
  return { ...real, baixarDanfse: jest.fn() };
});

jest.mock('../../src/services/nfseAutomatica', () => ({
  TIPOS: new Set(['venda', 'os']),
  ligadaNoServidor: () => true,
  situacaoDaOrigem: jest.fn(),
}));

jest.mock('../../src/services/nfseAutomaticaRepo', () => ({ schemaAusente: () => false }));

const express = require('express');
const request = require('supertest');
const db = require('../../src/config/database');
const repo = require('../../src/services/nfseNacional/repo');
const client = require('../../src/services/nfseNacional/client');
const certStore = require('../../src/services/sefazSp/certStore');
const auto = require('../../src/services/nfseAutomatica');
const { NfseNacionalTransportError } = require('../../src/services/nfseNacional/errors');
const { gerarA1 } = require('../helpers/certA1Teste');
const { textoDoPdf } = require('../helpers/textoDoPdf');
const fx = require('../fixtures/nfseDanfseLocal');
const incidente = require('../fixtures/nfseDpsNumeroJaUsado');

const CID = '11111111-1111-4111-8111-111111111111';
const VENDA = '22222222-2222-4222-8222-222222222222';
const NID = 'nfse-danfse-1';
const PDF_DO_ADN = Buffer.from('%PDF-1.7 pdf do ADN');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id/nfse/automatica', require('../../src/routes/nfseAutomatica'));
  a.use('/companies/:id/nfse', require('../../src/routes/nfse'));
  return a;
}

const binario = (res, cb) => {
  const partes = [];
  res.on('data', (c) => partes.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(partes)));
};
const getPdf = (url) => request(app()).get(url).buffer(true).parse(binario);

const adn503 = () => client.baixarDanfse.mockRejectedValue(new NfseNacionalTransportError('DANFSe: HTTP 503', { httpStatus: 503 }));

let a1;
beforeAll(() => { a1 = gerarA1({ cnpj: fx.CNPJ }); });

beforeEach(() => {
  process.env.NFSE_NACIONAL_ENABLED = 'true';
  process.env.NFSE_NACIONAL_PRODUCAO = 'true';
  db.query.mockReset();
  repo.__state.notas = [fx.linhaAutorizada({ company_id: CID })];
  repo.__state.company = { id: CID, cnpj: fx.CNPJ, nome: 'Empresa Ficticia' };
  certStore.loadCertificate.mockReset();
  certStore.loadCertificate.mockResolvedValue({ pfx: a1.pfx, password: a1.senha });
  client.baixarDanfse.mockReset();
  auto.situacaoDaOrigem.mockReset();
  auto.situacaoDaOrigem.mockResolvedValue({
    estado: 'emitida',
    notas: [{ estado: 'emitida', nfse_id: NID, nfse_number: '15', chave_acesso: fx.CHAVE }],
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.NFSE_NACIONAL_PRODUCAO;
});

function esperarDanfseDaAura(res) {
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/pdf/);
  expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(res.body.equals(PDF_DO_ADN)).toBe(false);
  const texto = textoDoPdf(res.body);
  expect(texto).toContain(fx.CHAVE);
  expect(texto).toContain('NFS-e nº 15');
  expect(texto).toContain('R$ 150,00');
  expect(texto).toContain('EMPRESA FICTICIA DE SERVICOS LTDA');
}

describe('GET /companies/:id/nfse/:nid/pdf', () => {
  const URL = `/companies/${CID}/nfse/${NID}/pdf`;
  beforeEach(() => db.query.mockResolvedValue({ rows: [{ pdf_url: null, provider: 'nacional' }] }));

  test('ADN 200 → o PDF do ADN', async () => {
    client.baixarDanfse.mockResolvedValue(PDF_DO_ADN);
    const res = await getPdf(URL);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.equals(PDF_DO_ADN)).toBe(true);
  });

  test('ADN 503 → DANFSe gerado pela Aura do XML autorizado', async () => {
    adn503();
    esperarDanfseDaAura(await getPdf(URL));
    expect(client.baixarDanfse).toHaveBeenCalled();
  });

  test('NFS-e de outro emissor → 409 NOTA_NAO_CONFERIDA, sem ADN', async () => {
    repo.__state.notas = [{ ...incidente.linhaAdotada(), id: NID, company_id: CID }];
    adn503();
    const res = await request(app()).get(URL);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTA_NAO_CONFERIDA');
    expect(client.baixarDanfse).not.toHaveBeenCalled();
  });
});

describe('GET .../nfse/automatica/origem/:tipo/:origemId/segunda-via?formato=pdf', () => {
  const URL = `/companies/${CID}/nfse/automatica/origem/venda/${VENDA}/segunda-via?formato=pdf&nfse_id=${NID}`;

  test('ADN 200 → o PDF do ADN', async () => {
    client.baixarDanfse.mockResolvedValue(PDF_DO_ADN);
    const res = await getPdf(URL);
    expect(res.status).toBe(200);
    expect(res.body.equals(PDF_DO_ADN)).toBe(true);
  });

  test('ADN 503 → DANFSe gerado pela Aura do XML autorizado', async () => {
    adn503();
    esperarDanfseDaAura(await getPdf(URL));
  });

  test('NFS-e de outro emissor → 409 NOTA_NAO_CONFERIDA, sem ADN', async () => {
    repo.__state.notas = [{ ...incidente.linhaAdotada(), id: NID, company_id: CID }];
    adn503();
    const res = await request(app()).get(URL);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTA_NAO_CONFERIDA');
    expect(client.baixarDanfse).not.toHaveBeenCalled();
  });
});
