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
