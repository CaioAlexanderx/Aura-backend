// ============================================================
// AURA. -- Rotas: migracao de categorias + extracao de marca
// Bloco B2, Fase F0. Sem gate de plano (categoria e infraestrutura de
// estoque -- nao entra em MODULE_PLAN_MAP nem module_overrides).
//
// Este arquivo NAO edita src/routes/private.js (arquivo do B1). A linha
// de mount exata esta declarada no corpo do PR.
//
// GET /catalog/health NAO e desta rota -- e inventario do contrato, mas
// atribuicao do Bloco E. Nao implementado aqui.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const migration = require('../services/categoryMigration');
const brand = require('../services/brandExtraction');

// ── POST /categories/migration/analyze ──────────────────
router.post('/categories/migration/analyze', async (req, res) => {
  const cid = req.params.id;
  try {
    await migration.analyze(cid);
    const status = await migration.getStatus(cid);
    res.json({ analyzed: true, status });
  } catch (err) {
    console.error('[categoryMigration] analyze error:', err.message);
    res.status(500).json({ error: 'Erro ao analisar categorias' });
  }
});

// ── GET /categories/migration/proposal ───────────────────
router.get('/categories/migration/proposal', async (req, res) => {
  const cid = req.params.id;
  try {
    const { items, orphan } = await migration.getProposal(cid);
    res.json({ items, orphan });
  } catch (err) {
    console.error('[categoryMigration] proposal error:', err.message);
    res.status(500).json({ error: 'Erro ao listar proposta de migracao' });
  }
});

// ── PATCH /categories/migration/items/:itemId ────────────
router.patch('/categories/migration/items/:itemId', async (req, res) => {
  const cid = req.params.id;
  const { itemId } = req.params;
  try {
    const result = await migration.patchItem(cid, itemId, req.body);
    if (result.error) return res.status(result.error).json({ error: result.message });
    res.json(result.item);
  } catch (err) {
    console.error('[categoryMigration] patch item error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar item de migracao' });
  }
});

// ── POST /categories/migration/apply ─────────────────────
router.post('/categories/migration/apply', async (req, res) => {
  const cid = req.params.id;
  try {
    const result = await migration.apply(cid);
    res.json(result);
  } catch (err) {
    console.error('[categoryMigration] apply error:', err.message);
    res.status(500).json({ error: 'Erro ao aplicar migracao de categorias' });
  }
});

// ── GET /categories/migration/status ─────────────────────
router.get('/categories/migration/status', async (req, res) => {
  const cid = req.params.id;
  try {
    const status = await migration.getStatus(cid);
    res.json(status);
  } catch (err) {
    console.error('[categoryMigration] status error:', err.message);
    res.status(500).json({ error: 'Erro ao obter status da migracao' });
  }
});

// ── GET /products/brand-candidates ───────────────────────
// Rota ESTATICA sob /products -- precisa ficar montada antes de
// require('./products') (GET/PATCH/DELETE /:pid). Ver linha de mount
// declarada no corpo do PR.
router.get('/products/brand-candidates', async (req, res) => {
  const cid = req.params.id;
  const minCount = req.query.min_count !== undefined ? parseInt(req.query.min_count, 10) : 1;
  try {
    const candidates = await brand.brandCandidates(cid, minCount);
    res.json({ candidates });
  } catch (err) {
    console.error('[categoryMigration] brand-candidates error:', err.message);
    res.status(500).json({ error: 'Erro ao listar candidatos de marca' });
  }
});

// ── POST /products/brand/apply ───────────────────────────
router.post('/products/brand/apply', async (req, res) => {
  const cid = req.params.id;
  try {
    const result = await brand.applyBrands(cid, req.body?.assignments);
    if (result.error) return res.status(result.error).json({ error: result.message });
    res.json(result);
  } catch (err) {
    console.error('[categoryMigration] brand apply error:', err.message);
    res.status(500).json({ error: 'Erro ao aplicar marcas' });
  }
});

module.exports = router;
