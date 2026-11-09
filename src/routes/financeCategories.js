// ============================================================
// AURA. — Rotas: categorias e subcategorias do Financeiro (migration 434)
//
//   GET    /companies/:id/finance-categories?kind=&include_archived=1
//   POST   /companies/:id/finance-categories
//   PATCH  /companies/:id/finance-categories/:catId
//   POST   /companies/:id/finance-categories/:catId/merge   { target_id }
//
// Regras em src/services/financeCategories.js. Sem gate de plano: categoria
// e infraestrutura do Financeiro (mesmo acesso de /transactions, que tambem
// nao tem gate). Nada e apagado: arquivar some da escolha e mantem os
// lancamentos onde estao.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const svc = require('../services/financeCategories');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function responderErro(res, err, rotulo) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code_negocio || undefined });
  }
  // Migration 434 ainda nao aplicada: o app cai na lista fixa de antes.
  if (err && (err.code === '42P01' || err.code === '42703' || err.code === '42883')) {
    return res.status(503).json({ error: 'Categorias ainda indisponíveis', code: 'FINANCE_CATEGORIES_UNAVAILABLE' });
  }
  console.error('[financeCategories] ' + rotulo + ':', err && err.message);
  return res.status(500).json({ error: 'Erro ao ' + rotulo });
}

router.get('/', async function (req, res) {
  try {
    const out = await svc.listar(req.params.id, {
      kind: req.query.kind,
      incluirArquivadas: req.query.include_archived === '1' || req.query.include_archived === 'true',
      semContagem: req.query.counts === '0',
    });
    out.pode_todas_as_lojas = out.lojas > 1 && (req.companyRole === 'owner' || req.companyRole === 'admin');
    res.json(out);
  } catch (err) { responderErro(res, err, 'listar as categorias'); }
});

router.post('/', async function (req, res) {
  const body = req.body || {};
  if (body.parent_id && !UUID_RE.test(String(body.parent_id))) return res.status(400).json({ error: 'parent_id inválido' });
  try {
    const out = await svc.criar(req.params.id, body, { role: req.companyRole });
    res.status(201).json(out);
  } catch (err) { responderErro(res, err, 'criar a categoria'); }
});

router.patch('/:catId', async function (req, res) {
  if (!UUID_RE.test(String(req.params.catId))) return res.status(400).json({ error: 'id inválido' });
  try {
    const out = await svc.atualizar(req.params.id, req.params.catId, req.body || {});
    res.json(out);
  } catch (err) { responderErro(res, err, 'atualizar a categoria'); }
});

router.post('/:catId/merge', async function (req, res) {
  const target = (req.body || {}).target_id;
  if (!UUID_RE.test(String(req.params.catId)) || !UUID_RE.test(String(target || ''))) {
    return res.status(400).json({ error: 'Escolha com qual categoria juntar' });
  }
  try {
    const out = await svc.juntar(req.params.id, req.params.catId, target);
    res.json(out);
  } catch (err) { responderErro(res, err, 'juntar as categorias'); }
});

module.exports = router;
