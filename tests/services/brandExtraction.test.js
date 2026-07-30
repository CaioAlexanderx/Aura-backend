// ============================================================
// AURA. -- Testes: extracao de marca (Bloco B2, Fase F0)
// Mock por SQL (mockImplementation por texto), nunca fila posicional.
// resetAllMocks no beforeEach.
// ============================================================
const { brandCandidates, applyBrands, BRAND_APPLY_MAX } = require('../../src/services/brandExtraction');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';

describe('brandCandidates', () => {
  test('agrupa por split_part(btrim(name), \' \', 1) entre produtos sem brand, ordenado por contagem', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { token: 'Modare', product_count: 90 },
        { token: 'Vizzano', product_count: 57 },
      ],
    });
    const result = await brandCandidates(cid, undefined);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/split_part\(btrim\(name\), ' ', 1\)/);
    expect(sql).toMatch(/brand IS NULL/);
    expect(sql).toMatch(/is_active/);
    expect(sql).toMatch(/stock_qty\s*>\s*0/);
    expect(sql).toMatch(/unit\s+IS\s+NULL\s+OR\s+unit\s*<>\s*'srv'/i);
    expect(sql).toMatch(/ORDER BY COUNT\(\*\) DESC/);
    expect(params[1]).toBe(1); // min_count default
    expect(result).toEqual([
      { token: 'Modare', product_count: 90 },
      { token: 'Vizzano', product_count: 57 },
    ]);
  });

  test('?min_count= (default 1) filtra a cauda via HAVING', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await brandCandidates(cid, 5);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/HAVING COUNT\(\*\) >= \$2/);
    expect(params).toEqual([cid, 5]);
  });

  test('min_count invalido (0, negativo, NaN) cai no default 1', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await brandCandidates(cid, 0);
    expect(db.query.mock.calls[0][1][1]).toBe(1);
    await brandCandidates(cid, -3);
    expect(db.query.mock.calls[1][1][1]).toBe(1);
    await brandCandidates(cid, NaN);
    expect(db.query.mock.calls[2][1][1]).toBe(1);
  });

  test('sem normalizacao esperta: nao ha lista de marcas hardcoded nem regex de casamento aproximado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await brandCandidates(cid, 1);
    const [sql] = db.query.mock.calls[0];
    // Puro agrupamento -- so split_part + GROUP BY + HAVING, nada de ILIKE/similarity.
    expect(sql).not.toMatch(/ILIKE/i);
    expect(sql).not.toMatch(/similarity/i);
  });
});

describe('applyBrands', () => {
  test('400 -- assignments vazio ou ausente', async () => {
    const r1 = await applyBrands(cid, []);
    expect(r1.error).toBe(400);
    const r2 = await applyBrands(cid, undefined);
    expect(r2.error).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('400 -- respeita teto de 100 tokens por chamada', async () => {
    const assignments = Array.from({ length: BRAND_APPLY_MAX + 1 }, (_, i) => ({ token: `T${i}`, brand: `Marca ${i}` }));
    const result = await applyBrands(cid, assignments);
    expect(result.error).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('400 -- assignment sem token ou brand nao vazios', async () => {
    const result = await applyBrands(cid, [{ token: '', brand: 'Nike' }]);
    expect(result.error).toBe(400);
  });

  test('grava so na empresa, casamento exato pelo token, marca corrigida pelo lojista', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }, { id: 'p2' }] });
    const result = await applyBrands(cid, [{ token: 'Beira', brand: 'Beira Rio' }]);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE products SET brand = \$1/);
    expect(sql).toMatch(/company_id = \$2/);
    expect(sql).toMatch(/split_part\(btrim\(name\), ' ', 1\) = \$3/);
    expect(params).toEqual(['Beira Rio', cid, 'Beira']);
    expect(result.results[0]).toEqual({ token: 'Beira', brand: 'Beira Rio', updated: 2 });
  });

  test('sem filtro brand IS NULL -- permite corrigir marca ja gravada', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await applyBrands(cid, [{ token: 'Via', brand: 'Via Marte' }]);
    const [sql] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/brand IS NULL/);
  });

  test('idempotente: rodar 2x com o mesmo payload nao muda nada alem de updated_at', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'p1' }] });
    const payload = [{ token: 'Rider', brand: 'Rider' }];
    const r1 = await applyBrands(cid, payload);
    const r2 = await applyBrands(cid, payload);
    expect(r1.results).toEqual(r2.results);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0]).toEqual(db.query.mock.calls[1]);
  });
});
