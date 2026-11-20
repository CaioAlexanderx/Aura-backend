// ============================================================
// AURA. — B2: `lojas` e `estoque_em` do lote (20/11/2026), sem banco
//
// O caminho com banco esta em lojasNoLote.banco.test.js; a paridade sem
// `lojas`, em lojasNoLote.paridade.test.js.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const svc = require('../src/services/produtoNasLojas');

const MATRIZ = '11111111-1111-4111-8111-111111111111';
const FILIAL = '22222222-2222-4222-8222-222222222222';
const OUTRA = '33333333-3333-4333-8333-333333333333';

describe('lerLojasDoLote', () => {
  test('sem lojas (ou null): null — a rota segue como antes', () => {
    expect(svc.lerLojasDoLote({}, MATRIZ)).toBeNull();
    expect(svc.lerLojasDoLote({ lojas: null }, MATRIZ)).toBeNull();
    expect(svc.lerLojasDoLote(undefined, MATRIZ)).toBeNull();
  });

  test('a origem primeiro, repetida some, estoque_em padrao = origem', () => {
    expect(svc.lerLojasDoLote({ lojas: [FILIAL, MATRIZ.toUpperCase(), FILIAL] }, MATRIZ))
      .toEqual({ lojas: [MATRIZ, FILIAL], outras: [FILIAL], estoqueEm: MATRIZ });
    expect(svc.lerLojasDoLote({ lojas: [MATRIZ, FILIAL, OUTRA], estoque_em: OUTRA }, MATRIZ).estoqueEm).toBe(OUTRA);
    // aceita tambem { company_id }
    expect(svc.lerLojasDoLote({ lojas: [{ company_id: MATRIZ }, { company_id: FILIAL }] }, MATRIZ).outras).toEqual([FILIAL]);
  });

  test('sem a origem, estoque_em fora da lista, id invalido, vazia: 400 LOJAS_INVALIDAS', () => {
    for (const body of [
      { lojas: [FILIAL] },
      { lojas: [MATRIZ], estoque_em: FILIAL },
      { lojas: [MATRIZ, 'x'] },
      { lojas: [] },
      { lojas: 'tudo' },
      { lojas: Array.from({ length: 21 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`) },
    ]) {
      expect(() => svc.lerLojasDoLote(body, MATRIZ)).toThrow(expect.objectContaining({ code: 'LOJAS_INVALIDAS', status: 400 }));
    }
  });

  test('Chegou mercadoria: a origem vale sempre e estoque_em e ignorado', () => {
    expect(svc.lerLojasDoLote({ lojas: [FILIAL], estoque_em: FILIAL }, MATRIZ, { origemImplicita: true }))
      .toEqual({ lojas: [MATRIZ, FILIAL], outras: [FILIAL], estoqueEm: MATRIZ });
  });
});

describe('nasceCompartilhado (D12)', () => {
  const conn = (linha) => ({ query: jest.fn(async () => ({ rows: [linha] })) });
  test('grupo de 2+ sem nenhuma separada: sim; separada ou loja sozinha: nao; erro: nao', async () => {
    expect(await svc.nasceCompartilhado(conn({ empresas: 2, separadas: 0 }), MATRIZ)).toBe(true);
    expect(await svc.nasceCompartilhado(conn({ empresas: 2, separadas: 1 }), MATRIZ)).toBe(false);
    expect(await svc.nasceCompartilhado(conn({ empresas: 1, separadas: 0 }), MATRIZ)).toBe(false);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await svc.nasceCompartilhado({ query: async () => { throw new Error('caiu'); } }, MATRIZ)).toBe(false);
    spy.mockRestore();
  });
});
