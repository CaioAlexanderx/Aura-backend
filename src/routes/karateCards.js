// ============================================================
// AURA KARATÊ — Rotas de Carteirinha Digital (Track D / Fase 3)
// Montado sob /federation/:id  (mergeParams). RBAC via guards.
//
// NÃO gera imagem (decisão Caio 07/06): apenas processa o pedido e
// devolve os DADOS da carteirinha. A renderização é design/frontend.
//
//   POST /practitioners/:practitionerId/issue-card    — emite/renova (staffWrite)
//   GET  /practitioners/:practitionerId/card          — carteirinha atual (read)
//   POST /practitioners/:practitionerId/card/revoke   — revoga (staffWrite)
//   GET  /cards                                       — lista (read)
//   POST /cards/issue-batch                           — lote (adminOnly)
//
// ── Fila de impressão (migration 233 / sisteminha de gestão) ────
//   GET  /cards/queue                    — lista por etapa + contadores (read)
//   POST /cards/queue/mark-printed       — "Imprimir selecionadas" (staffWrite)
//   POST /cards/queue/mark-delivered     — confirmação manual de entrega (staffWrite)
//   POST /cards/queue/return-to-queue    — "não saiu" / reimprimir (staffWrite)
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
    // 17/07/2026: fecha bug pré-existente — este botão manual não bloqueava
    // praticante sem matrícula FPKT (emitia com card_number NULL, só um
    // warning). A validação agora vive em issueCard() (karateCardService),
    // compartilhada pelos 3 call sites; aqui só traduzimos pra 422 claro.
    if (err.code === 'FPKT_NUMBER_REQUIRED') return res.status(422).json({ error: err.message, code: 'FPKT_NUMBER_REQUIRED' });
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

// ── POST /practitioners/:practitionerId/card/revoke ───────
// Revoga a carteirinha atual do praticante (status='revoked'). Idempotente:
// revogar uma já revogada devolve ok. Após revogar, emitir de novo via
// /issue-card gera uma nova carteirinha ativa (a revogada fica no histórico).
router.post('/practitioners/:practitionerId/card/revoke', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, practitionerId } = req.params;
  try {
    const { card, alreadyRevoked } = await cards.revokeCard({
      federation_id: federationId,
      student_id: practitionerId,
      revoked_by: req.user?.id || null,
    });
    res.json({
      ...card,
      revoked: true,
      already_revoked: alreadyRevoked,
      _note: alreadyRevoked
        ? 'Carteirinha já estava revogada.'
        : 'Carteirinha revogada. Emita uma nova via POST /issue-card se necessário.',
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
    console.error('[karateCards] revoke error:', err.message);
    res.status(500).json({ error: 'Erro ao revogar carteirinha', detail: err.message });
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


// ── GET /cards/queue ─────────────────────────────
// Lista cartões ATIVOS de UMA etapa da fila (print_status), com contadores
// da federação inteira (as três etapas) e o breakdown por dojô da etapa
// atual (agrupamento/filtro). Ordenação: mais recente primeiro pelo
// timestamp que fez o cartão entrar nesta etapa.
router.get('/cards/queue', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { print_status, dojo_id, search } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 50));
  try {
    const out = await cards.listPrintQueue({
      federation_id: federationId,
      print_status: print_status || 'to_print',
      dojo_id: dojo_id || null,
      search: search || null,
      page,
      pageSize,
    });
    res.json(out);
  } catch (err) {
    console.error('[karateCards] queue list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar fila de impressão' });
  }
});

// ── POST /cards/queue/mark-printed ────────────────
// "Imprimir selecionadas": move para 'printed' e conta uma via. Disparado
// pelo clique do botão de imprimir no frontend (confirmação inline antes).
router.post('/cards/queue/mark-printed', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { card_ids } = req.body || {};
  try {
    const out = await cards.markPrinted({ federation_id: federationId, card_ids });
    res.json({ ...out, _note: 'Cartões marcados como impressos. Isso NÃO confirma que a impressão física saiu — use "Não saiu / reimprimir" se necessário.' });
  } catch (err) {
    if (err.code === 'NO_IDS') return res.status(400).json({ error: err.message, code: 'NO_IDS' });
    console.error('[karateCards] mark-printed error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar carteirinhas como impressas', detail: err.message });
  }
});

// ── POST /cards/queue/mark-delivered ──────────────
// Confirmação manual da federação — única forma de chegar em 'delivered'.
router.post('/cards/queue/mark-delivered', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { card_ids } = req.body || {};
  try {
    const out = await cards.markDelivered({ federation_id: federationId, card_ids, delivered_by: req.user?.id || null });
    res.json({ ...out, _note: 'Cartões marcados como entregues.' });
  } catch (err) {
    if (err.code === 'NO_IDS') return res.status(400).json({ error: err.message, code: 'NO_IDS' });
    console.error('[karateCards] mark-delivered error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar carteirinhas como entregues', detail: err.message });
  }
});

// ── POST /cards/queue/return-to-queue ─────────────
// "Não saiu / reimprimir" (de 'printed') OU "Reimprimir" por perda, rasgo
// ou graduação (de 'delivered'). Volta para 'to_print' sem alterar
// print_count — só a próxima impressão de fato conta como via nova.
router.post('/cards/queue/return-to-queue', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { card_ids } = req.body || {};
  try {
    const out = await cards.returnToQueue({ federation_id: federationId, card_ids });
    res.json({ ...out, _note: 'Cartões devolvidos para "A imprimir".' });
  } catch (err) {
    if (err.code === 'NO_IDS') return res.status(400).json({ error: err.message, code: 'NO_IDS' });
    console.error('[karateCards] return-to-queue error:', err.message);
    res.status(500).json({ error: 'Erro ao devolver carteirinhas para a fila', detail: err.message });
  }
});

module.exports = router;
