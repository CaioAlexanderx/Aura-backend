/**
 * Stub controlavel do Nuvem Fiscal para testes.
 *
 * Uso:
 *   jest.mock('../src/services/nuvemfiscal', () => require('./__mocks__/nuvemfiscal'));
 *   // ou via jest.config moduleNameMapper
 *
 *   const nfStub = require('./__mocks__/nuvemfiscal');
 *   nfStub.__setMode('autorizada');  // ou 'rejeitada' ou 'timeout'
 *   nfStub.__reset();
 *
 * Modos disponiveis:
 *   'autorizada' (default) — todas as emissoes retornam sucesso
 *   'rejeitada'            — emissoes lancam erro SEFAZ_REJECT (422)
 *   'timeout'              — emissoes lancam ETIMEDOUT
 *
 * IMPORTANTE: __reset() re-anexa as implementations via mockImplementation()
 * para sobreviver a jest.resetAllMocks() chamado em setupFiscalStub().
 */

'use strict';

let _mode = 'autorizada';

const FAKE_CHAVE_NFCE = '35260529123456789012650010000000011234567890';
const FAKE_CHAVE_NFE  = '35260529123456789012550010000000011234567891';

// Alias simples usado nos testes que so checam chave_acesso generica
const FAKE_CHAVE = FAKE_CHAVE_NFE;

const _makeTimeoutErr = () =>
  Object.assign(new Error('SEFAZ timeout'), { code: 'ETIMEDOUT' });

const _makeRejectErr = (msg, sefaz_code) =>
  Object.assign(new Error(msg || 'Rejeicao SEFAZ'), {
    code:       'SEFAZ_REJECT',
    status:     422,
    sefaz_code: sefaz_code || '562',
    erros: [{ mensagem: msg || 'Rejeicao SEFAZ', codigo: sefaz_code || '562' }],
  });

// Resposta padrao de emissao bem-sucedida (NFC-e)
function _okNfce() {
  return {
    id: `nfce_stub_${Date.now()}`,
    status: 'autorizado',
    chave_acesso: FAKE_CHAVE_NFCE,
    protocolo: '135260000000001',
    link_pdf: 'https://danfe.nuvemfiscal.com.br/stub.pdf',
    link_xml: 'https://xml.nuvemfiscal.com.br/stub.xml',
  };
}

// Resposta padrao de emissao bem-sucedida (NF-e / devolucao)
function _okNfe() {
  return {
    id: `nfe_stub_${Date.now()}`,
    status: 'autorizado',
    chave_acesso: FAKE_CHAVE_NFE,
    protocolo: '135260000000002',
    link_pdf: 'https://danfe.nuvemfiscal.com.br/stub_nfe.pdf',
    link_xml: 'https://xml.nuvemfiscal.com.br/stub_nfe.xml',
  };
}

// ----------  implementations separadas das jest.fn() ----------
// Estas funcoes sobrevivem ao jest.resetAllMocks() pois sao closures
// normais. __reset() re-anexa cada uma via mockImplementation().

function _implEmitNfce(company, nfceData) {
  if (_mode === 'timeout')   return Promise.reject(_makeTimeoutErr());
  if (_mode === 'rejeitada') return Promise.reject(_makeRejectErr('NFC-e rejeitada pelo SEFAZ 562', '562'));
  return Promise.resolve(_okNfce());
}

function _implEmitNfe(company, nfeData) {
  if (_mode === 'timeout')   return Promise.reject(_makeTimeoutErr());
  if (_mode === 'rejeitada') return Promise.reject(_makeRejectErr('NF-e rejeitada pelo SEFAZ 562', '562'));
  return Promise.resolve(_okNfe());
}

function _implEmitNfeDevolucao(company, params) {
  if (_mode === 'timeout')   return Promise.reject(_makeTimeoutErr());
  if (_mode === 'rejeitada') return Promise.reject(_makeRejectErr('Rejeicao SEFAZ 562 — devolucao invalida', '562'));
  return Promise.resolve(_okNfe());
}

function _implCancelNfce(nfceId, justificativa) {
  if (_mode === 'timeout')   return Promise.reject(_makeTimeoutErr());
  if (_mode === 'rejeitada') return Promise.reject(_makeRejectErr('NFC-e nao pode ser cancelada', 'CANCEL_REJECT'));
  return Promise.resolve({ success: true, id: nfceId, status: 'cancelado' });
}

function _implCancelNfe(nfeId, justificativa) {
  if (_mode === 'timeout')   return Promise.reject(_makeTimeoutErr());
  if (_mode === 'rejeitada') return Promise.reject(_makeRejectErr('NF-e nao pode ser cancelada', 'CANCEL_REJECT'));
  return Promise.resolve({ success: true, id: nfeId, status: 'cancelado' });
}

function _implQueryNfce(nfceId) {
  if (_mode === 'timeout') return Promise.reject(_makeTimeoutErr());
  return Promise.resolve({ id: nfceId, status: 'autorizado', chave_acesso: FAKE_CHAVE_NFCE });
}

function _implQueryNfe(nfeId) {
  if (_mode === 'timeout') return Promise.reject(_makeTimeoutErr());
  return Promise.resolve({ id: nfeId, status: 'autorizado', chave_acesso: FAKE_CHAVE_NFE });
}

// ----------  jest.fn() — call history gerenciada pelo jest  ----------

const emitNfce         = jest.fn();
const emitNfe          = jest.fn();
const emitNfeDevolucao = jest.fn();
const cancelNfce       = jest.fn();
const cancelNfe        = jest.fn();
const queryNfce        = jest.fn();
const queryNfe         = jest.fn();

// ----------  NFS-e (stub passthrough)  ----------

const emitNfse  = jest.fn(async () => ({ id: `nfse_stub_${Date.now()}`, status: 'autorizado' }));
const queryNfse = jest.fn(async (id) => ({ id, status: 'autorizado' }));
const cancelNfse = jest.fn(async (id) => ({ success: true, id, status: 'cancelado' }));

// ----------  helpers utilitarios (passthrough dos originais)  ----------

const registerCompany   = jest.fn(async () => ({}));
const uploadCertificate = jest.fn(async () => ({}));
const fetchNuvemEmpresa = jest.fn(async () => null);
const clearEmpresaCache = jest.fn(() => {});

// Helpers puros re-exportados do modulo real para nao duplicar logica.
// Lazy-loaded para evitar side effects de env no import do stub.
let _real = null;
function _getRealNf() {
  if (!_real) {
    const prevId  = process.env.NUVEM_FISCAL_CLIENT_ID;
    const prevSec = process.env.NUVEM_FISCAL_CLIENT_SECRET;
    process.env.NUVEM_FISCAL_CLIENT_ID     = process.env.NUVEM_FISCAL_CLIENT_ID     || 'stub_id';
    process.env.NUVEM_FISCAL_CLIENT_SECRET = process.env.NUVEM_FISCAL_CLIENT_SECRET || 'stub_secret';
    _real = require('../src/services/nuvemfiscal');
    if (!prevId)  delete process.env.NUVEM_FISCAL_CLIENT_ID;
    if (!prevSec) delete process.env.NUVEM_FISCAL_CLIENT_SECRET;
  }
  return _real;
}

const isoBR             = (...a) => _getRealNf().isoBR(...a);
const generateCNF       = (...a) => _getRealNf().generateCNF(...a);
const calcDvChaveAcesso = (...a) => _getRealNf().calcDvChaveAcesso(...a);
const buildAccessKey44  = (...a) => _getRealNf().buildAccessKey44(...a);
const validateTpag      = (...a) => _getRealNf().validateTpag(...a);
const buildDet          = (...a) => _getRealNf().buildDet(...a);
const buildICMSTot      = (...a) => _getRealNf().buildICMSTot(...a);
const buildPag          = (...a) => _getRealNf().buildPag(...a);
const buildInfAdic      = (...a) => _getRealNf().buildInfAdic(...a);
const resolvePagInput   = (...a) => _getRealNf().resolvePagInput(...a);
const extractErros      = (...a) => _getRealNf().extractErros(...a);
const ufToCodigo        = (...a) => _getRealNf().ufToCodigo(...a);
const buildDest         = (...a) => _getRealNf().buildDest(...a);
const mergeCompanyWithNuvem = (...a) => _getRealNf().mergeCompanyWithNuvem(...a);
const safeAddrField     = (...a) => _getRealNf().safeAddrField(...a);

const buildEmit = jest.fn(async (company) => ({
  CNPJ: String(company.cnpj || '').replace(/\D/g, '').padEnd(14, '0').slice(0, 14),
  xNome: company.legal_name || company.trade_name || 'Emitente Stub',
  CRT: 1,
  enderEmit: {
    xLgr: company.address_street || 'Rua Stub',
    nro:  company.address_number || '1',
    xBairro: company.address_neighborhood || 'Centro',
    cMun: company.ibge_code || '3550308',
    xMun: company.address_city || 'Sao Paulo',
    UF: (company.address_state || 'SP').toUpperCase(),
    CEP: String(company.address_zip || '01310100').replace(/\D/g, ''),
    cPais: '1058',
    xPais: 'Brasil',
  },
}));

const buildSelfDest = jest.fn(async (company) => {
  const emit = await buildEmit(company);
  return {
    CNPJ: emit.CNPJ,
    xNome: emit.xNome,
    indIEDest: 9,
    IE: undefined,
    enderDest: { ...emit.enderEmit },
  };
});

const buildIde = jest.fn((opts) => _getRealNf().buildIde(opts));

const getToken     = jest.fn(async () => 'stub_fake_token');
const nuvemRequest = jest.fn(async () => { throw new Error('nuvemRequest nao deve ser chamado no stub — use emitNfce/emitNfe/etc.'); });

// ----------  Controle do stub  ----------

const __setMode = (mode) => { _mode = mode; };
const __getMode = () => _mode;

/**
 * __reset: restaura _mode para 'autorizada' E re-anexa as implementations
 * em cada jest.fn(). Deve ser chamado DEPOIS de jest.resetAllMocks() no
 * beforeEach (ver setupFiscalStub em fiscalStubHelper).
 */
const __reset = () => {
  _mode = 'autorizada';
  emitNfce.mockImplementation(_implEmitNfce);
  emitNfe.mockImplementation(_implEmitNfe);
  emitNfeDevolucao.mockImplementation(_implEmitNfeDevolucao);
  cancelNfce.mockImplementation(_implCancelNfce);
  cancelNfe.mockImplementation(_implCancelNfe);
  queryNfce.mockImplementation(_implQueryNfce);
  queryNfe.mockImplementation(_implQueryNfe);
};

// Inicializar implementations imediatamente (antes do primeiro beforeEach)
__reset();

module.exports = {
  // Controle do stub
  __setMode, __reset, __getMode,
  // Constantes de chave fake
  FAKE_CHAVE, FAKE_CHAVE_NFCE, FAKE_CHAVE_NFE,
  // Emissao
  emitNfce, emitNfe, emitNfeDevolucao,
  // Cancelamento
  cancelNfce, cancelNfe,
  // Consulta
  queryNfce, queryNfe,
  // NFS-e
  emitNfse, queryNfse, cancelNfse,
  // Cadastro empresa
  registerCompany, uploadCertificate, fetchNuvemEmpresa, clearEmpresaCache,
  // Builders (mocks que delegam ao real)
  buildEmit, buildSelfDest, buildIde,
  // Helpers puros (delegam ao real sem I/O)
  isoBR, generateCNF, calcDvChaveAcesso, buildAccessKey44, validateTpag,
  buildDet, buildICMSTot, buildPag, buildInfAdic, resolvePagInput,
  extractErros, ufToCodigo, buildDest, mergeCompanyWithNuvem, safeAddrField,
  // Acesso de rede (stub — nao usa rede)
  getToken, nuvemRequest,
};
