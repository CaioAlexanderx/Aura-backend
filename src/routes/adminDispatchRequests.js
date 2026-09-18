// ============================================================
// AURA. — Admin: pedidos de disparo preparados para aprovação
// GET  /admin/dispatch-requests               — aguardando + últimos 14 dias
// POST /admin/dispatch-requests/:id/approve   — aprova e executa agora
// POST /admin/dispatch-requests/:id/reject    — recusa
//
// Criado: 18/09/2026 (migration 348, src/services/staffDispatch.js).
// O Claude prepara o pedido; só a equipe logada executa.
// ============================================================
const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { listRequests, approve, reject } = require('../services/staffDispatch');

const adminOnly = [requireAuth, requireRole('admin')];

router.get('/dispatch-requests', ...adminOnly, async (req, res) => {
  try {
    res.json({ requests: await listRequests() });
  } catch (err) {
    // 42P01 = migration 348 ainda não aplicada: nada a aprovar.
    if (err.code === '42P01') return res.json({ requests: [] });
    console.error('[admin/dispatch-requests] list error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
});

router.post('/dispatch-requests/:id/approve', ...adminOnly, async (req, res) => {
  try {
    const r = await approve(req.params.id, req.user);
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error('[admin/dispatch-requests] approve error:', err.message);
    res.status(500).json({ error: 'Erro ao aprovar pedido' });
  }
});

router.post('/dispatch-requests/:id/reject', ...adminOnly, async (req, res) => {
  try {
    const r = await reject(req.params.id, req.user);
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error('[admin/dispatch-requests] reject error:', err.message);
    res.status(500).json({ error: 'Erro ao recusar pedido' });
  }
});

module.exports = router;
