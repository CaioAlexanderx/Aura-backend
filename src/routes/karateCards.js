// ============================================================
// AURA KARATÊ — Rotas de Carteirinha Digital (Track D / Fase 3)
// Montado sob /federation/:id  (mergeParams). RBAC via guards.
//
// NÃO gera imagem (decisão Caio 07/06): apenas processa o pedido e
// devolve os DADOS da carteirinha. A renderização é design/frontend.
//
//   POST /practitioners/:practitionerId/issue-card  — emite/renova (staffWrite)
//   GET  /practitioners/:practitionerId/card        — carteirinha atual (read)
//   GET  /cards                                     — lista (read)
//   POST /cards/issue-batch                         — lote (adminOnly)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { guards } = require('../config/karateRoles');
const cards = require('../services/karateCardService');

// ── POST /practitioners/:practitionerId/issue-card ──────────
router.post('/practitioners/:practitionerId/issue-card', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  const { validity_months } = req.body || {};
  try {
    const result = await cards.issueCard({
      federation_id: federationId,
      student_id: practitionerId,
      issued_by: req.user?.id || null,
      validity_months,
    });
    res.status(201).json({
      ...result.card,
      renewed: result.renewed,
      warnings: result.warnings,
      _note: 'Carteirinha processada (somente dados). A arte/QR é renderizada na camada de design/frontend.',
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
    console.error('[karateCards] issue error:', err.message);
    res.status(500).json({ error: 'Erro ao emitir carteirinha', detail: err.message });
  }
});

// ── GET /practitioners/:practitionerId/card ───────────────
router.get('/practitioners/:practitionerId/card', ...guards.read(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  try {
    const card = await cards.getCurrentCard({ federation_id: federationId, student_id: practitionerId });
    if (!card) {
      return res.status(404).json({
        error: 'Praticante sem carteirinha. Emita via POST /issue-card.',
        code: 'NOT_FOUND',
      });
    }
    res.json(card);
  } catch (err) {
    console.error('[karateCards] get error:', err.message);
    res.status(500).json({ error: 'Erro ao consultar carteirinha' });
  }
});

// ── GET /cards ─────────────────────────────────
router.get('/cards', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { status } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
  try {
    const out = await cards.listCards({ federation_id: federationId, status, page, pageSize });
    res.json(out);
  } catch (err) {
    console.error('[karateCards] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar carteirinhas' });
  }
});

// ── POST /cards/issue-batch ────────────────────────
router.post('/cards/issue-batch', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { only_missing = true } = req.body || {};
  try {
    const out = await cards.issueBatch({
      federation_id: federationId,
      issued_by: req.user?.id || null,
      only_missing,
    });
    res.status(201).json({
      ...out,
      _note: 'Emissão em lote (somente dados). Pendências por praticante vêm em errors[].',
    });
  } catch (err) {
    console.error('[karateCards] batch error:', err.message);
    res.status(500).json({ error: 'Erro na emissão em lote', detail: err.message });
  }
});

module.exports = router;
