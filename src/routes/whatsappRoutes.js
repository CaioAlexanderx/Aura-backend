// ============================================================
// AURA — WhatsApp (LEGADO): envio avulso e histórico
//
// CONSOLIDAÇÃO (25/08/2026): connect/disconnect/status/templates
// mudaram para src/routes/whatsappCloud.js (fonte única, montado em
// /companies/:id SEM gate de plano — o gate certo é o addon de
// lembretes). Aqui ficaram só /send e /messages, com o
// requirePlan('negocio','expansao') aplicado ROTA A ROTA — nunca no
// prefixo do mount, que barraria por prefixo e derrubaria as rotas do
// whatsappCloud (achado no QA de 27/08). Novas features de WhatsApp
// vão no whatsappCloud.js.
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
// O gate de plano vale SÓ para estas rotas legadas — nunca no prefixo
// /whatsapp do mount (ver private.js): lá ele barrava por prefixo e
// derrubava as rotas consolidadas do whatsappCloud para dojôs essencial.
const { requirePlan } = require('../middleware/auth');
const legacyGate = requirePlan('negocio', 'expansao');

// ── POST /whatsapp/send — DESATIVADO (27/11/2026) ───────────
// Mandava direto para a Graph API: template pago sem saldo (472), sem
// opt-out, sem teto do dia/contato e sem template aprovado — o único
// caminho pelo qual um modelo saía sem controle, pago pela Aura. O app não
// usa (services/messaging.ts cai no wa.me). Todo envio passa pela fila
// (waOutbox: saldo, guardas e despacho único) ou pelas mensagens de sessão
// do hub (janela de 24 h aberta, sem custo).
router.post('/send', legacyGate, (req, res) => res.status(410).json({
  error: 'O envio direto pelo WhatsApp foi desativado. As mensagens saem pela fila da Aura, com saldo e regras de envio.',
  code: 'ENVIO_DIRETO_DESATIVADO',
}));

// ── GET /whatsapp/messages — Message history ────────────
router.get('/messages', legacyGate, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT id, direction, to_phone, from_phone, template_name, content, status, created_at
       FROM wa_messages WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.params.id, parseInt(limit), parseInt(offset)]
    );
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) FROM wa_messages WHERE company_id=$1', [req.params.id]
    );
    res.json({ total: parseInt(countRows[0].count), messages: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar mensagens' }); }
});

module.exports = router;
