// ============================================================
// AURA. — nfseAutomaticaRepo (migration 438): SQL defensivo.
//   - item lido pela regra de visibilidade do grupo (multi-CNPJ);
//   - sem as colunas fiscais do item (437 ainda fora do banco) cai no
//     SELECT sem elas e não pergunta de novo;
//   - sem a 438 a config volta null (emissão automática desligada).
// ============================================================
'use strict';

const db = require('../src/config/database');
const repo = require('../src/services/nfseAutomaticaRepo');

const erro = (code) => Object.assign(new Error(`erro ${code}`), { code });

beforeEach(() => {
  db.query.mockReset();
  repo._resetCache();
});

test('itens da venda: visibilidade do grupo e fallback sem products.nfse_*', async () => {
  db.query
    .mockRejectedValueOnce(erro('42703'))
    .mockResolvedValueOnce({ rows: [{ id: 'i1', unit: 'srv' }] })
    .mockResolvedValueOnce({ rows: [] });
  const rows = await repo.itensDaVenda('c1', 's1');
  expect(rows).toEqual([{ id: 'i1', unit: 'srv' }]);
  const [sql1, p1] = db.query.mock.calls[0];
  expect(sql1).toMatch(/p\.nfse_ctribnac/);
  expect(sql1).toMatch(/is_group_shared = true/);
  expect(p1).toEqual(['s1', 'c1']);
  expect(db.query.mock.calls[1][0]).not.toMatch(/nfse_ctribnac/);
  await repo.itensDaOs('c1', 'o1');
  expect(db.query).toHaveBeenCalledTimes(3); // não tenta as colunas de novo
  expect(db.query.mock.calls[2][0]).not.toMatch(/nfse_ctribnac/);
});

test('config sem a migration 438: null', async () => {
  db.query.mockRejectedValueOnce(erro('42703'));
  await expect(repo.carregarConfig('c1')).resolves.toBeNull();
});

test('reivindicar usa o UNIQUE da prestação (ON CONFLICT DO NOTHING) e devolve o existente', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [] }) // INSERT não inseriu
    .mockResolvedValueOnce({ rows: [{ id: 'r1' }] }) // SELECT existente
    .mockResolvedValueOnce({ rows: [{ id: 'r1', status: 'emitida' }] }); // buscarRegistro
  const r = await repo.reivindicar({ companyId: 'c1', origemTipo: 'venda', origemId: 's1', ctribnac: '010501', gatilho: 'pagamento', itens: [], valor: 10 });
  expect(r).toEqual({ row: { id: 'r1', status: 'emitida' }, criado: false });
  expect(db.query.mock.calls[0][0]).toMatch(/ON CONFLICT \(company_id, origem_tipo, origem_id, ctribnac\) DO NOTHING/);
});

describe('sales.nfse_tomador (migration 440)', () => {
  test('buscarVenda lê a coluna; sem a 440 cai no SELECT de sempre e não pergunta de novo', async () => {
    db.query
      .mockRejectedValueOnce(erro('42703'))
      .mockResolvedValueOnce({ rows: [{ id: 's1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 's1' }] });
    await expect(repo.buscarVenda('c1', 's1')).resolves.toEqual({ id: 's1' });
    expect(db.query.mock.calls[0][0]).toMatch(/, nfse_tomador\s+FROM sales/);
    expect(db.query.mock.calls[1][0]).not.toMatch(/nfse_tomador/);
    await repo.buscarVenda('c1', 's1');
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[2][0]).not.toMatch(/nfse_tomador/);
  });

  test('buscarVenda com a 440: devolve o tomador gravado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 's1', nfse_tomador: { doc: '52998224725', nome: null } }] });
    await expect(repo.buscarVenda('c1', 's1')).resolves.toMatchObject({ nfse_tomador: { doc: '52998224725' } });
    expect(db.query.mock.calls[0][1]).toEqual(['s1', 'c1']);
  });

  test('gravarTomadorDaVenda: UPDATE dentro de SAVEPOINT, só doc e nome', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const ok = await repo.gravarTomadorDaVenda(client, { companyId: 'c1', saleId: 's1', tomador: { doc: '52998224725', nome: 'Maria', email: 'x@y.z' } });
    expect(ok).toBe(true);
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toBe('SAVEPOINT nfse_tomador');
    expect(sqls[1]).toBe('UPDATE sales SET nfse_tomador = $1::jsonb WHERE id = $2 AND company_id = $3');
    expect(JSON.parse(client.query.mock.calls[1][1][0])).toEqual({ doc: '52998224725', nome: 'Maria' });
    expect(client.query.mock.calls[1][1].slice(1)).toEqual(['s1', 'c1']);
    expect(sqls[2]).toBe('RELEASE SAVEPOINT nfse_tomador');
  });

  test('gravarTomadorDaVenda sem a 440: volta ao SAVEPOINT, não lança e não tenta de novo', async () => {
    const client = { query: jest.fn(async (sql) => {
      if (/^UPDATE sales/.test(sql)) throw erro('42703');
      return { rows: [] };
    }) };
    await expect(repo.gravarTomadorDaVenda(client, { companyId: 'c1', saleId: 's1', tomador: { doc: '52998224725' } })).resolves.toBe(false);
    expect(client.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK TO SAVEPOINT nfse_tomador');
    client.query.mockClear();
    await expect(repo.gravarTomadorDaVenda(client, { companyId: 'c1', saleId: 's2', tomador: { doc: '52998224725' } })).resolves.toBe(false);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('gravarTomadorDaVenda: outra falha também não lança (a venda segue)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { query: jest.fn(async (sql) => {
      if (/^UPDATE sales/.test(sql)) throw erro('57014');
      return { rows: [] };
    }) };
    await expect(repo.gravarTomadorDaVenda(client, { companyId: 'c1', saleId: 's1', tomador: { doc: '52998224725' } })).resolves.toBe(false);
    expect(client.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK TO SAVEPOINT nfse_tomador');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('sem tomador: nenhuma consulta', async () => {
    const client = { query: jest.fn() };
    await expect(repo.gravarTomadorDaVenda(client, { companyId: 'c1', saleId: 's1', tomador: null })).resolves.toBe(false);
    expect(client.query).not.toHaveBeenCalled();
  });
});
