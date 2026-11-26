// ============================================================
// AURA. — Pedido do balcao x pecas fora da loja (C17, R3): sem banco
// livre = estoque - reservado - com clientes - para resolver, so com a trava.
// ============================================================
'use strict';

const { conferirSaldo, fraseDaFalta } = require('../src/services/pedidoBalcao');

const P = '11111111-2222-3333-4444-555555555555';
const V = '66666666-7777-8888-9999-000000000000';
const EMP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Cliente falso: reconhece cada consulta pelo texto do SQL.
function clienteFalso({ reservas = [], fora = [], resolver = [], quebraFora = false } = {}) {
  const sqls = [];
  return {
    sqls,
    async query(sql) {
      sqls.push(sql);
      if (/SAVEPOINT/.test(sql)) return { rows: [] };
      if (/voltou_defeito/.test(sql)) return { rows: resolver };
      if (/condicional_itens/.test(sql)) {
        if (quebraFora) throw Object.assign(new Error('relation "condicional_itens" does not exist'), { code: '42P01' });
        return { rows: fora };
      }
      return { rows: reservas };
    },
  };
}

const item = (extra = {}) => ({ product_id: P, variant_id: null, nome: 'Saia Íris', quantity: 1, estoque: 3, ...extra });
const tocouCondicional = (c) => c.sqls.some((s) => /condicional_itens|SAVEPOINT/.test(s));

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe('conferirSaldo com a trava da condicional', () => {
  test('desligada: nenhuma consulta nova e peca com cliente nao pesa', async () => {
    const c = clienteFalso({ fora: [{ product_id: P, variant_id: null, qtd: '2' }] });
    const faltas = await conferirSaldo(c, EMP, [item({ quantity: 3 })]);
    expect(faltas).toEqual([]);
    expect(tocouCondicional(c)).toBe(false);
  });

  test('ligada: 3 no estoque, 2 com clientes -> so 1 livre', async () => {
    const c = clienteFalso({ fora: [{ product_id: P, variant_id: null, qtd: '2' }] });
    const faltas = await conferirSaldo(c, EMP, [item({ quantity: 2 })], { comCondicional: true });
    expect(faltas).toHaveLength(1);
    expect(faltas[0]).toMatchObject({ livre: 1, com_clientes: 2, reservado: 0, para_resolver: 0 });
    expect(fraseDaFalta(faltas[0])).toBe('"Saia Íris": só 1 livre (2 com clientes).');
  });

  test('ligada: 1 livre basta para 1 peca', async () => {
    const c = clienteFalso({ fora: [{ product_id: P, variant_id: null, qtd: '2' }] });
    expect(await conferirSaldo(c, EMP, [item()], { comCondicional: true })).toEqual([]);
  });

  test('para resolver tambem tira do livre', async () => {
    const c = clienteFalso({ resolver: [{ product_id: P, variant_id: null, qtd: '1' }] });
    const faltas = await conferirSaldo(c, EMP, [item({ estoque: 1 })], { comCondicional: true });
    expect(faltas[0]).toMatchObject({ livre: 0, para_resolver: 1 });
    expect(fraseDaFalta(faltas[0])).toBe('"Saia Íris": só 0 livres (1 para resolver).');
  });

  test('reservado + com clientes + para resolver numa frase so', async () => {
    const c = clienteFalso({
      reservas: [{ product_id: P, variant_id: null, qtd: '1' }],
      fora: [{ product_id: P, variant_id: null, qtd: '1' }],
      resolver: [{ product_id: P, variant_id: null, qtd: '1' }],
    });
    const faltas = await conferirSaldo(c, EMP, [item({ estoque: 4, quantity: 2 })], { comCondicional: true });
    expect(faltas[0]).toMatchObject({ livre: 1, reservado: 1, com_clientes: 1, para_resolver: 1 });
    expect(fraseDaFalta(faltas[0])).toBe('"Saia Íris": só 1 livre (1 com clientes, 1 já separada em outro pedido, 1 para resolver).');
  });

  test('por variante: so a variante pedida perde', async () => {
    const outra = '99999999-7777-8888-9999-000000000000';
    const c = clienteFalso({ fora: [
      { product_id: P, variant_id: V, qtd: '2' },
      { product_id: P, variant_id: outra, qtd: '5' },
    ] });
    const faltas = await conferirSaldo(c, EMP, [item({ variant_id: V, variant_label: 'M', estoque: 2 })], { comCondicional: true });
    expect(faltas[0]).toMatchObject({ variant_id: V, livre: 0, com_clientes: 2 });
    expect(fraseDaFalta(faltas[0])).toBe('"Saia Íris (M)": só 0 livres (2 com clientes).');
    const livre = await conferirSaldo(clienteFalso({ fora: [{ product_id: P, variant_id: outra, qtd: '5' }] }), EMP,
      [item({ variant_id: V, estoque: 2 })], { comCondicional: true });
    expect(livre).toEqual([]);
  });

  test('a consulta falha (42P01): conta 0, ROLLBACK TO SAVEPOINT e o pedido segue', async () => {
    const c = clienteFalso({ quebraFora: true });
    const faltas = await conferirSaldo(c, EMP, [item({ quantity: 3 })], { comCondicional: true });
    expect(faltas).toEqual([]);
    expect(c.sqls.some((s) => /ROLLBACK TO SAVEPOINT/.test(s))).toBe(true);
  });
});

describe('fraseDaFalta sem peca fora (texto de sempre)', () => {
  test('so reservado e so estoque', () => {
    expect(fraseDaFalta({ nome: 'X', livre: 1, reservado: 2, estoque: 3 })).toBe('"X": só 1 livre (2 já separadas em outro pedido).');
    expect(fraseDaFalta({ nome: 'X', livre: 0, reservado: 0, estoque: 0 })).toBe('"X": só 0 no estoque.');
  });
});
