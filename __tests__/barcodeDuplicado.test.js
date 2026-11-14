// 14/11/2026 — código de barras repetido no cadastro vira 409 com o nome
// do produto que já usa o código (antes: 500 "Erro ao criar produto").
const {
  ehBarcodeDuplicado, mensagemDoBarcodeDuplicado, respostaDeBarcodeDuplicado, CONSTRAINT,
} = require('../src/services/barcodeDuplicado');

const erroDup = () => Object.assign(new Error(`duplicate key value violates unique constraint "${CONSTRAINT}"`), { code: '23505', constraint: CONSTRAINT });

function fakeDb(rows, falha) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); if (falha) throw new Error('db fora'); return { rows }; },
  };
}

describe('ehBarcodeDuplicado', () => {
  test('reconhece o UNIQUE do código de barras (pela constraint ou pela mensagem)', () => {
    expect(ehBarcodeDuplicado(erroDup())).toBe(true);
    expect(ehBarcodeDuplicado({ code: '23505', message: `... "${CONSTRAINT}"` })).toBe(true);
  });
  test('outros erros seguem como antes', () => {
    expect(ehBarcodeDuplicado({ code: '23505', constraint: 'uq_products_master_sku_per_company' })).toBe(false);
    expect(ehBarcodeDuplicado({ code: '42703' })).toBe(false);
    expect(ehBarcodeDuplicado(null)).toBe(false);
  });
});

describe('respostaDeBarcodeDuplicado', () => {
  test('409 com o nome do produto que já tem o código', async () => {
    const db = fakeDb([{ id: 'p1', name: 'Banner 60x90', is_active: true }]);
    const r = await respostaDeBarcodeDuplicado(db, erroDup(), { companyId: 'c1', barcode: '789123' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BARCODE_DUPLICADO');
    expect(r.body.error).toBe('O código de barras 789123 já está no produto "Banner 60x90". Use outro código, deixe o campo vazio ou edite aquele produto.');
    expect(r.body.produto_existente).toEqual({ id: 'p1', name: 'Banner 60x90', arquivado: false });
    expect(db.calls[0].params).toEqual(['c1', '789123', null]);
  });

  test('produto excluído com histórico (arquivado) é explicado', async () => {
    const db = fakeDb([{ id: 'p2', name: 'Caneca', is_active: false }]);
    const r = await respostaDeBarcodeDuplicado(db, erroDup(), { companyId: 'c1', barcode: '111' });
    expect(r.body.error).toContain('foi excluído mas ficou guardado por causa do histórico de vendas');
    expect(r.body.produto_existente.arquivado).toBe(true);
  });

  test('na edição, o próprio produto fica fora da busca', async () => {
    const db = fakeDb([{ id: 'p3', name: 'Outro', is_active: true }]);
    await respostaDeBarcodeDuplicado(db, erroDup(), { companyId: 'c1', barcode: '222', exceptId: 'pX' });
    expect(db.calls[0].params).toEqual(['c1', '222', 'pX']);
  });

  test('busca falhando ainda devolve 409 (sem o nome)', async () => {
    const db = fakeDb([], true);
    const r = await respostaDeBarcodeDuplicado(db, erroDup(), { companyId: 'c1', barcode: '333' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('O código de barras 333 já está em outro produto da loja. Use outro código ou deixe o campo vazio.');
    expect(r.body.produto_existente).toBeUndefined();
  });

  test('erro que não é o código de barras → null (a rota segue com o 500)', async () => {
    const db = fakeDb([]);
    expect(await respostaDeBarcodeDuplicado(db, new Error('boom'), { companyId: 'c1', barcode: '1' })).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  test('mensagem sem código informado', () => {
    expect(mensagemDoBarcodeDuplicado('', null)).toMatch(/^Este código de barras já está em outro produto/);
  });
});
