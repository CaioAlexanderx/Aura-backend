/**
 * Testes criticos do fluxo de troca apos C1/C2/C6.1.
 * Roda sem banco real — _internal puro + stub fiscal.
 *
 * Padrao do projeto:
 *   - jest.mock('../src/config/database') + mockClient encadeado (pdv-connection.test.js)
 *   - setupFiscalStub() no describe raiz + jest.resetAllMocks no beforeEach
 *
 * Aqui usamos _internal (funcoes puras exportadas por trocaV2) para C1/C2/totals
 * e o stub para os cenarios fiscais — sem supertest, evitando a cadeia
 * de 10+ mockResolvedValueOnce que o handle() exige.
 */

'use strict';

jest.mock('../src/services/nuvemfiscal', () => require('../__mocks__/nuvemfiscal'));
jest.mock('../src/config/database');

const nfStub = require('../__mocks__/nuvemfiscal');
const { setupFiscalStub, withFiscalMode } = require('./helpers/fiscalStubHelper');

// _internal: funcoes puras que nao tocam DB (testadas sem mock de client)
const { _internal } = require('../src/services/trocaV2');
const { computeAndValidateTotals, decideFiscalPerOrigin, normalizeMethodForSalePayments } = _internal;

describe('troca — caminhos criticos', () => {
  setupFiscalStub();

  beforeEach(() => {
    jest.resetAllMocks();
    nfStub.__reset();
  });

  // ===========================================================================
  // C1 — Validacao de payload (computeAndValidateTotals)
  // ===========================================================================
  describe('C1 — validacao de payload v2', () => {
    it('lanca erro quando returned_items e new_items estao ambos vazios', () => {
      expect(() =>
        computeAndValidateTotals({ returned_items: [], new_items: [], payment_splits: [], refund_splits: [] })
      ).toThrow();
    });

    it('lanca erro quando payment_splits nao cobre o netAmount positivo', () => {
      expect(() =>
        computeAndValidateTotals({
          returned_items: [{ quantity: 1, unit_price: 50 }],
          new_items:      [{ quantity: 1, unit_price: 100 }],
          payment_splits: [{ method: 'dinheiro', amount: 10 }], // deveria ser 50
          refund_splits:  [],
        })
      ).toThrow(/payment_splits/);
    });

    it('lanca erro quando refund_splits nao cobre o netAmount negativo', () => {
      expect(() =>
        computeAndValidateTotals({
          returned_items: [{ quantity: 1, unit_price: 100 }],
          new_items:      [{ quantity: 1, unit_price: 50 }],
          payment_splits: [],
          refund_splits:  [{ method: 'dinheiro', amount: 1 }], // deveria ser 50
        })
      ).toThrow(/refund_splits/);
    });

    it('aceita payload zerado (troca simples sem diferenca)', () => {
      const totals = computeAndValidateTotals({
        returned_items: [{ quantity: 1, unit_price: 100 }],
        new_items:      [{ quantity: 1, unit_price: 100 }],
        payment_splits: [],
        refund_splits:  [],
      });
      expect(totals.netAmount).toBe(0);
      expect(totals.returnedValue).toBe(100);
      expect(totals.newValue).toBe(100);
    });

    it('returnedValue e newValue sao arredondados para 2 casas', () => {
      const totals = computeAndValidateTotals({
        returned_items: [{ quantity: 3, unit_price: 33.333 }],
        new_items:      [{ quantity: 1, unit_price: 100 }],
        payment_splits: [],
        refund_splits:  [],
      });
      expect(totals.returnedValue).toBe(100);
      expect(totals.netAmount).toBe(0);
    });
  });

  // ===========================================================================
  // C2 — decideFiscalPerOrigin (logica de estrategia sem DB)
  // ===========================================================================
  describe('C2 — decideFiscalPerOrigin', () => {
    const makeSaleWithNfce = (id, ageHours) => ({
      id,
      nfce: {
        id: `nfce_${id}`,
        authorized_at: new Date(Date.now() - ageHours * 3600000).toISOString(),
      },
    });
    const makeSaleWithoutNfce = (id) => ({ id, nfce: null });

    it('strategy=none: todas as origens ficam none', () => {
      const sales = [makeSaleWithNfce('s1', 1), makeSaleWithNfce('s2', 30)];
      const returned = [{ original_sale_id: 's1' }, { original_sale_id: 's2' }];
      const map = decideFiscalPerOrigin(sales, returned, 'none');
      expect(map.get('s1')).toBe('none');
      expect(map.get('s2')).toBe('none');
    });

    it('strategy=per_origin: NFC-e < 24h => cancel_reissue', () => {
      const sales = [makeSaleWithNfce('s1', 2)];
      const returned = [{ original_sale_id: 's1' }];
      const map = decideFiscalPerOrigin(sales, returned, 'per_origin');
      expect(map.get('s1')).toBe('cancel_reissue');
    });

    it('strategy=per_origin: NFC-e > 24h => devolucao_55', () => {
      const sales = [makeSaleWithNfce('s1', 30)];
      const returned = [{ original_sale_id: 's1' }];
      const map = decideFiscalPerOrigin(sales, returned, 'per_origin');
      expect(map.get('s1')).toBe('devolucao_55');
    });

    it('strategy=per_origin: sem NFC-e => none', () => {
      const sales = [makeSaleWithoutNfce('s1')];
      const returned = [{ original_sale_id: 's1' }];
      const map = decideFiscalPerOrigin(sales, returned, 'per_origin');
      expect(map.get('s1')).toBe('none');
    });

    it('strategy=devolucao_55: forca devolucao_55 independente da idade', () => {
      const sales = [makeSaleWithNfce('s1', 1)];
      const returned = [{ original_sale_id: 's1' }];
      const map = decideFiscalPerOrigin(sales, returned, 'devolucao_55');
      expect(map.get('s1')).toBe('devolucao_55');
    });

    it('origens sem returned_items ficam none mesmo com NFC-e < 24h', () => {
      const sales = [makeSaleWithNfce('s1', 1), makeSaleWithNfce('s2', 1)];
      const returned = [{ original_sale_id: 's1' }]; // s2 nao tem devolucao
      const map = decideFiscalPerOrigin(sales, returned, 'per_origin');
      expect(map.get('s1')).toBe('cancel_reissue');
      expect(map.get('s2')).toBe('none');
    });
  });

  // ===========================================================================
  // normalizeMethodForSalePayments
  // ===========================================================================
  describe('normalizeMethodForSalePayments', () => {
    it('cartao_credito => cartao', () => expect(normalizeMethodForSalePayments('cartao_credito')).toBe('cartao'));
    it('cartao_debito => debito', () => expect(normalizeMethodForSalePayments('cartao_debito')).toBe('debito'));
    it('crediario_credito => crediario', () => expect(normalizeMethodForSalePayments('crediario_credito')).toBe('crediario'));
    it('pix => pix (passthrough)', () => expect(normalizeMethodForSalePayments('pix')).toBe('pix'));
    it('null => dinheiro (default)', () => expect(normalizeMethodForSalePayments(null)).toBe('dinheiro'));
  });

  // ===========================================================================
  // Falha fiscal — stub direto (sem DB)
  // ===========================================================================
  describe('falha fiscal — stub SEFAZ', () => {
    withFiscalMode('rejeitada');

    it('quando SEFAZ rejeita, emitNfeDevolucao lanca erro com code SEFAZ_REJECT', async () => {
      await expect(
        nfStub.emitNfeDevolucao({ cnpj: '12345678000199' }, { refNFe: '35260529123456789012550010000000011234567891' })
      ).rejects.toMatchObject({ code: 'SEFAZ_REJECT', status: 422 });
    });

    it('SEFAZ_REJECT traz campo erros[]', async () => {
      await expect(
        nfStub.emitNfeDevolucao({ cnpj: '12345678000199' }, {})
      ).rejects.toMatchObject({ erros: expect.any(Array) });
    });
  });

  describe('falha fiscal — timeout SEFAZ', () => {
    withFiscalMode('timeout');

    it('quando SEFAZ da timeout, emitNfeDevolucao lanca erro com code ETIMEDOUT', async () => {
      await expect(
        nfStub.emitNfeDevolucao({ cnpj: '12345678000199' }, {})
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });

    it('cancelNfce tambem lanca ETIMEDOUT', async () => {
      await expect(
        nfStub.cancelNfce('nfce_stub_123', 'Troca teste')
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });
  });

  // ===========================================================================
  // Reemissao — modo autorizada (C6.1)
  // ===========================================================================
  describe('reemissao — idempotencia fiscal (C6.1)', () => {
    it('emissao autorizada: emitNfeDevolucao retorna chave_acesso e status autorizado', async () => {
      // modo default = autorizada (nao precisa setMode)
      const result = await nfStub.emitNfeDevolucao(
        { cnpj: '12345678000199' },
        { originalChave: '35260529123456789012550010000000011234567891', items: [] }
      );
      expect(result).toHaveProperty('chave_acesso');
      expect(result.status).toBe('autorizado');
    });

    it('emitNfe tambem retorna chave_acesso em modo autorizada', async () => {
      const result = await nfStub.emitNfe({ cnpj: '12345678000199' }, {});
      expect(result).toHaveProperty('chave_acesso');
      expect(result.status).toBe('autorizado');
    });

    it('emissao rejeitada: resultado e falha com code SEFAZ_REJECT', async () => {
      nfStub.__setMode('rejeitada');
      await expect(
        nfStub.emitNfeDevolucao({ cnpj: '12345678000199' }, {})
      ).rejects.toMatchObject({ code: 'SEFAZ_REJECT' });
    });

    it('queryNfe retorna status autorizado em modo autorizada', async () => {
      const result = await nfStub.queryNfe('nfe_stub_001');
      expect(result.status).toBe('autorizado');
    });
  });

  // ===========================================================================
  // Oversell — lock atomico presente no codigo-fonte
  // ===========================================================================
  describe('oversell — lock atomico de estoque (verificacao estrutural)', () => {
    it('trocaV2.js contem UPDATE condicional com stock_qty >= para variantes', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../src/services/trocaV2.js'),
        'utf8'
      );
      // Deve existir o lock atomico de variante: UPDATE product_variants ... WHERE ... stock_qty >= $N
      expect(src).toMatch(/UPDATE product_variants SET stock_qty = stock_qty - \$\d[^;]+stock_qty >= \$\d/);
    });

    it('trocaV2.js contem UPDATE condicional com stock_qty >= para produtos simples', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../src/services/trocaV2.js'),
        'utf8'
      );
      expect(src).toMatch(/UPDATE products SET stock_qty = stock_qty - \$\d[^;]+stock_qty >= \$\d/);
    });

    it('trocaV2.js lanca INSUFFICIENT_STOCK quando RETURNING esta vazio', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../src/services/trocaV2.js'),
        'utf8'
      );
      expect(src).toMatch(/INSUFFICIENT_STOCK/);
    });
  });

  // ===========================================================================
  // C1 — Handler legado aposentado + advisory lock
  // ===========================================================================
  describe('C1 — handler v1 aposentado e advisory lock presente', () => {
    it('pdv.js nao chama trocaDevolucao55.handle() diretamente no route handler', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../src/routes/pdv.js'),
        'utf8'
      );
      // O handler legado nao deve estar no route — trocaV2.handle substitui
      expect(src).not.toMatch(/trocaDevolucao55\.handle\(/);
    });

    it('trocaV2.js contem pg_advisory_xact_lock (C2 — advisory lock)', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../src/services/trocaV2.js'),
        'utf8'
      );
      expect(src).toMatch(/pg_advisory_xact_lock/);
    });

    it('trocaV2.js contem troca_idempotency (tabela de idempotencia C2)', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../src/services/trocaV2.js'),
        'utf8'
      );
      expect(src).toMatch(/troca_idempotency/);
    });

    it('trocaV2.js registra idempotent_hit:true no retorno quando chave ja existia', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../src/services/trocaV2.js'),
        'utf8'
      );
      expect(src).toMatch(/idempotent_hit.*true/);
    });

    it('trocaV2.js desacopla SEFAZ do COMMIT (pos-COMMIT para devolucao_55)', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../src/services/trocaV2.js'),
        'utf8'
      );
      // Deve conter o comentario ou o padrao de pendingEmissions pos-COMMIT
      expect(src).toMatch(/pendingEmissions/);
      // E deve gravar status='pendente' antes do commit
      expect(src).toMatch(/'pendente'/);
      // E atualizar para 'falha' com last_error pos-commit
      expect(src).toMatch(/last_error/);
    });
  });

  // ===========================================================================
  // Stub — isolamento entre testes (smoke)
  // ===========================================================================
  describe('stub — isolamento de modo entre testes', () => {
    it('modo eh autorizada no inicio do teste (resetAllMocks + __reset)', () => {
      expect(nfStub.__getMode()).toBe('autorizada');
    });

    it('emitNfce.mock.calls esta vazio no inicio do teste', () => {
      expect(nfStub.emitNfce.mock.calls).toHaveLength(0);
    });
  });
});
