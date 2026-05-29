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
 */

'use strict';

let _mode = 'autorizada';

const FAKE_CHAVE_NFCE = '35260529123456789012650010000000011234567890';
const FAKE_CHAVE_NFE  = '35260529123456789012550010000000011234567891';

const _makeTimeoutErr = () =>
  Object.assign(new Error('SEFAZ timeout'), { code: 'ETIMEDOUT' });

const _makeRejectErr = (msg, sefaz_code) =>
  Object.assign(new Error(msg || 'Rejeicao SEFAZ'), {
    code:       'SEFAZ_REJECT',
    status:     422,
    sefaz_code: sefaz_code || '562',
    erros: [{ mensagem: msg || 'Rejeicao SEFAZ', codigo: sefaz_code || '562' }],
  });

// Helpers de controle — chamar nos testes
const __setMode = (mode) => { _mode = mode; };
const __reset   = () => { _mode = 'autorizada'; };
const __getMode = () => _mode;

// Resposta padrao de emissao bem-sucedida (NFC-e)
function _okNfce(payload) {
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
function _okNfe(payload) {
  return {
    id: `nfe_stub_${Date.now()}`,
    status: 'autorizado',
    chave_acesso: FAKE_CHAVE_NFE,
    protocolo: '135260000000002',
    link_pdf: 'https://danfe.nuvemfiscal.com.br/stub_nfe.pdf',
    link_xml: 'https://xml.nuvemfiscal.com.br/stub_nfe.xml',
  };
}

// ----------  emissoes  ----------

const emitNfce = jest.fn(async (company, nfceData) => {
  if (_mode === 'timeout')   throw _makeTimeoutErr();
  if (_mode === 'rejeitada') throw _makeRejectErr('NFC-e rejeitada pelo SEFAZ 562', '562');
  return _okNfce(nfceData);
});

const emitNfe = jest.fn(async (company, nfeData) => {
  if (_mode === 'timeout')   throw _makeTimeoutErr();
  if (_mode === 'rejeitada') throw _makeRejectErr('NF-e rejeitada pelo SEFAZ 562', '562');
  return _okNfe(nfeData);
});

const emitNfeDevolucao = jest.fn(async (company, params) => {
  if (_mode === 'timeout')   throw _makeTimeoutErr();
  if (_mode === 'rejeitada') throw _makeRejectErr('Rejeicao SEFAZ 562 — devolucao invalida', '562');
  return _okNfe(params);
});

// ----------  cancelamentos  ----------

const cancelNfce = jest.fn(async (nfceId, justificativa) => {
  if (_mode === 'timeout')   throw _makeTimeoutErr();
  if (_mode === 'rejeitada') throw _makeRejectErr('NFC-e nao pode ser cancelada', 'CANCEL_REJECT');
  return { success: true, id: nfceId, status: 'cancelado' };
});

const cancelNfe = jest.fn(async (nfeId, justificativa) => {
  if (_mode === 'timeout')   throw _makeTimeoutErr();
  if (_mode === 'rejeitada') throw _makeRejectErr('NF-e nao pode ser cancelada', 'CANCEL_REJECT');
  return { success: true, id: nfeId, status: 'cancelado' };
});

// ----------  consultas  ----------

const queryNfce = jest.fn(async (nfceId) => {
  if (_mode === 'timeout') throw _makeTimeoutErr();
  return { id: nfceId, status: 'autorizado', chave_acesso: FAKE_CHAVE_NFCE };
});

const queryNfe = jest.fn(async (nfeId) => {
  if (_mode === 'timeout') throw _makeTimeoutErr();
  return { id: nfeId, status: 'autorizado', chave_acesso: FAKE_CHAVE_NFE };
});

// ----------  NFS-e (stub passthrough)  ----------

const emitNfse = jest.fn(async () => ({
  id: `nfse_stub_${Date.now()}`, status: 'autorizado',
}));
const queryNfse  = jest.fn(async (id) => ({ id, status: 'autorizado' }));
const cancelNfse = jest.fn(async (id) => ({ success: true, id, status: 'cancelado' }));

// ----------  helpers utilitarios (passthrough dos originais)  ----------
// Exportados para que testes que precisam chamar buildPag, buildDet etc.
// direto possam usar o stub sem implicacoes de rede.

const registerCompany  = jest.fn(async () => ({}));
const uploadCertificate = jest.fn(async () => ({}));
const fetchNuvemEmpresa = jest.fn(async () => null);
const clearEmpresaCache = jest.fn(() => {});

// Helpers puros re-exportados do modulo real para nao duplicar logica.
// Lazy-loaded para evitar side effects de env no import do stub.
let _real = null;
function _getRealNf() {
  if (!_real) {
    // Salva envs para evitar throw em getToken durante o require
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

// Proxies para helpers puros (sem I/O)
const isoBR            = (...a) => _getRealNf().isoBR(...a);
const generateCNF      = (...a) => _getRealNf().generateCNF(...a);
const calcDvChaveAcesso= (...a) => _getRealNf().calcDvChaveAcesso(...a);
const buildAccessKey44 = (...a) => _getRealNf().buildAccessKey44(...a);
const validateTpag     = (...a) => _getRealNf().validateTpag(...a);
const buildDet         = (...a) => _getRealNf().buildDet(...a);
const buildICMSTot     = (...a) => _getRealNf().buildICMSTot(...a);
const buildPag         = (...a) => _getRealNf().buildPag(...a);
const buildInfAdic     = (...a) => _getRealNf().buildInfAdic(...a);
const resolvePagInput  = (...a) => _getRealNf().resolvePagInput(...a);
const extractErros     = (...a) => _getRealNf().extractErros(...a);
const ufToCodigo       = (...a) => _getRealNf().ufToCodigo(...a);
const buildDest        = (...a) => _getRealNf().buildDest(...a);
const mergeCompanyWithNuvem = (...a) => _getRealNf().mergeCompanyWithNuvem(...a);
const safeAddrField    = (...a) => _getRealNf().safeAddrField(...a);

// buildEmit / buildSelfDest / buildIde sao async e dependem de rede —
// no stub retornam estrutura minima sem chamada externa.
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

// getToken e nuvemRequest nunca devem ser chamados no stub (nao ha rede)
const getToken     = jest.fn(async () => 'stub_fake_token');
const nuvemRequest = jest.fn(async () => { throw new Error('nuvemRequest nao deve ser chamado no stub — use emitNfce/emitNfe/etc.'); });

module.exports = {
  // Controle do stub
  __setMode, __reset, __getMode,
  // Constantes de chave fake
  FAKE_CHAVE_NFCE, FAKE_CHAVE_NFE,
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
