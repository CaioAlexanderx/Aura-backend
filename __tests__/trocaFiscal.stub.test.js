/**
 * Smoke tests para os branches fiscais da troca.
 *
 * Objetivo: verificar que a infraestrutura do stub funciona corretamente
 * e serve como esqueleto para os testes da Fase 1 (troca nao revertida
 * em caso de falha fiscal).
 *
 * Os blocos marcados TODO serao preenchidos pela Fase 1 quando o
 * trocaV2.handle receber o novo parametro de modo fiscal.
 */

'use strict';

const nfStub = require('../__mocks__/nuvemfiscal');
const { setupFiscalStub, withFiscalMode, getFiscalStub } = require('./helpers/fiscalStubHelper');

describe('trocaFiscal — infraestrutura do stub', () => {
  setupFiscalStub();

  // ----------------------------------------------------------------
  // Controles basicos do stub
  // ----------------------------------------------------------------
  describe('__setMode / __reset', () => {
    it('modo default apos __reset eh autorizada', () => {
      nfStub.__setMode('rejeitada');
      nfStub.__reset();
      expect(nfStub.__getMode()).toBe('autorizada');
    });

    it('__setMode altera o modo corretamente', () => {
      nfStub.__setMode('timeout');
      expect(nfStub.__getMode()).toBe('timeout');
      nfStub.__setMode('rejeitada');
      expect(nfStub.__getMode()).toBe('rejeitada');
    });

    it('getFiscalStub retorna o mesmo objeto que o require direto', () => {
      expect(getFiscalStub()).toBe(nfStub);
    });
  });

  // ----------------------------------------------------------------
  // Modo: autorizada
  // ----------------------------------------------------------------
  describe('modo autorizada', () => {
    it('emitNfeDevolucao resolve com chave_acesso', async () => {
      nfStub.__setMode('autorizada');
      const result = await nfStub.emitNfeDevolucao(
        { cnpj: '12345678000199', tax_regime: 'simples' },
        {
          originalChave: '35260529123456789012650010000000011234567890',
          items: [{ code: 'SKU1', name: 'Produto', quantity: 1, price: 100, ncm: '00000000' }],
          serie: 1, numero: 1,
        }
      );
      expect(result).toHaveProperty('chave_acesso');
      expect(result.status).toBe('autorizado');
    });

    it('emitNfce resolve com chave_acesso', async () => {
      nfStub.__setMode('autorizada');
      const result = await nfStub.emitNfce(
        { cnpj: '12345678000199' },
        { items: [], serie: 1, numero: 1 }
      );
      expect(result).toHaveProperty('chave_acesso');
    });

    it('cancelNfce resolve com status cancelado', async () => {
      nfStub.__setMode('autorizada');
      const result = await nfStub.cancelNfce('nfce_001', 'Cancelamento teste');
      expect(result.status).toBe('cancelado');
    });
  });

  // ----------------------------------------------------------------
  // Modo: rejeitada
  // ----------------------------------------------------------------
  describe('modo rejeitada', () => {
    withFiscalMode('rejeitada');

    it('emitNfeDevolucao lanca erro com code SEFAZ_REJECT', async () => {
      await expect(
        nfStub.emitNfeDevolucao(
          { cnpj: '12345678000199', tax_regime: 'simples' },
          {
            originalChave: '35260529123456789012650010000000011234567890',
            items: [{ code: 'SKU1', name: 'Produto', quantity: 1, price: 100, ncm: '00000000' }],
          }
        )
      ).rejects.toMatchObject({ code: 'SEFAZ_REJECT', status: 422 });
    });

    it('emitNfce lanca erro com code SEFAZ_REJECT', async () => {
      await expect(
        nfStub.emitNfce({ cnpj: '12345678000199' }, { items: [] })
      ).rejects.toMatchObject({ code: 'SEFAZ_REJECT' });
    });

    it('cancelNfce lanca erro com code SEFAZ_REJECT', async () => {
      await expect(
        nfStub.cancelNfce('nfce_001')
      ).rejects.toMatchObject({ code: 'SEFAZ_REJECT' });
    });

    // TODO (Fase 1): chamar trocaV2.handle em modo rejeitada e verificar que
    //   - a troca (tabela sales type=troca) foi persistida
    //   - fiscal.per_origin[0].status === 'falha'
    //   - nao houve rollback da transacao de estoque
  });

  // ----------------------------------------------------------------
  // Modo: timeout
  // ----------------------------------------------------------------
  describe('modo timeout', () => {
    withFiscalMode('timeout');

    it('emitNfeDevolucao lanca erro com code ETIMEDOUT', async () => {
      await expect(
        nfStub.emitNfeDevolucao(
          { cnpj: '12345678000199', tax_regime: 'simples' },
          {
            originalChave: '35260529123456789012650010000000011234567890',
            items: [{ code: 'SKU1', name: 'Produto', quantity: 1, price: 100, ncm: '00000000' }],
          }
        )
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });

    it('emitNfce lanca erro com code ETIMEDOUT', async () => {
      await expect(
        nfStub.emitNfce({ cnpj: '12345678000199' }, { items: [] })
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });

    it('emitNfe lanca erro com code ETIMEDOUT', async () => {
      await expect(
        nfStub.emitNfe({ cnpj: '12345678000199' }, { selfDest: true, items: [] })
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });

    // TODO (Fase 1): chamar trocaV2.handle em modo timeout e verificar que
    //   - a troca foi persistida
    //   - fiscal.per_origin[0].status === 'pendente'
    //   - job de retentativa fiscal foi agendado (se existir)
  });

  // ----------------------------------------------------------------
  // withFiscalMode: garantir que o reset entre describes funciona
  // ----------------------------------------------------------------
  describe('isolamento entre describes', () => {
    it('modo volta para autorizada apos bloco rejeitada', () => {
      // Este describe roda apos o bloco 'rejeitada';
      // setupFiscalStub garante __reset() em beforeEach.
      expect(nfStub.__getMode()).toBe('autorizada');
    });
  });

  // ----------------------------------------------------------------
  // Verificacao dos mocks jest — contadores sao resetados
  // ----------------------------------------------------------------
  describe('resetAllMocks entre testes', () => {
    it('emitNfce.mock.calls esta vazio no inicio de cada teste', async () => {
      // setupFiscalStub chama jest.resetAllMocks() em beforeEach
      expect(nfStub.emitNfce.mock.calls).toHaveLength(0);
      await nfStub.emitNfce({ cnpj: '12345678000199' }, { items: [] });
      expect(nfStub.emitNfce.mock.calls).toHaveLength(1);
    });

    it('no proximo teste, emitNfce.mock.calls volta a zero', async () => {
      // resetAllMocks garante que o contador foi zerado
      expect(nfStub.emitNfce.mock.calls).toHaveLength(0);
    });
  });
});
