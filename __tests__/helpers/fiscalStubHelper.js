/**
 * Helper para configurar o stub do Nuvem Fiscal em testes.
 *
 * Uso basico:
 *   const { setupFiscalStub, withFiscalMode } = require('./helpers/fiscalStubHelper');
 *
 *   describe('minha suite', () => {
 *     setupFiscalStub();
 *
 *     describe('quando SEFAZ autoriza', () => {
 *       // modo 'autorizada' eh o default, nao precisa chamar withFiscalMode
 *       it('emite NF-e', async () => { ... });
 *     });
 *
 *     describe('quando SEFAZ rejeita', () => {
 *       withFiscalMode('rejeitada');
 *       it('troca persiste com status falha', async () => { ... });
 *     });
 *
 *     describe('quando SEFAZ da timeout', () => {
 *       withFiscalMode('timeout');
 *       it('troca persiste com status pendente', async () => { ... });
 *     });
 *   });
 *
 * Modos:
 *   'autorizada' — emissoes retornam { status: 'autorizado', chave_acesso: ... }
 *   'rejeitada'  — emissoes lancam { code: 'SEFAZ_REJECT', status: 422 }
 *   'timeout'    — emissoes lancam { code: 'ETIMEDOUT' }
 */

'use strict';

const nfStub = require('../../__mocks__/nuvemfiscal');

/**
 * Setup padrao: resetar stub e chamar jest.resetAllMocks antes de cada
 * teste. Usar no describe raiz de qualquer suite que envolva fiscal.
 *
 * NOTA: usa resetAllMocks (nao clearAllMocks) para garantir que contadores
 * de chamada e retornos mockados sejam limpos entre testes.
 */
function setupFiscalStub() {
  beforeEach(() => {
    jest.resetAllMocks();
    nfStub.__reset();
  });
}

/**
 * Configura o modo fiscal para o bloco de describe em que e chamado.
 * Garante reset automatico apos cada teste do bloco.
 *
 * @param {'autorizada'|'rejeitada'|'timeout'} mode
 */
function withFiscalMode(mode) {
  beforeEach(() => nfStub.__setMode(mode));
  afterEach(()  => nfStub.__reset());
}

/**
 * Retorna o stub importado diretamente (util para asserts de call count).
 * Exemplo: expect(getFiscalStub().emitNfeDevolucao).toHaveBeenCalledTimes(1);
 */
function getFiscalStub() {
  return nfStub;
}

module.exports = { setupFiscalStub, withFiscalMode, getFiscalStub };
