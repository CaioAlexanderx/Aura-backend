// ============================================================
// AURA. — Admin: Notificações Endomarketing
// GET    /admin/notifications/banners               — lista todos os banners
// POST   /admin/notifications/banners               — cria banner
// PATCH  /admin/notifications/banners/:nid          — edita banner
// DELETE /admin/notifications/banners/:nid          — remove banner
// GET    /admin/notifications/recipients?company_id — destinatários de e-mail
// POST   /admin/notifications/banners/:nid/email    — manda o banner por e-mail
//
// 18/09/2026 — e-mail de notificação de empresa específica (migration 347,
//   src/services/notificationEmail.js). Só banner com target_company_id;
//   destinatário só do cadastro da empresa; cada envio fica registrado.
//
// Criado: 13/06/2026
// Apenas staff admin pode criar/editar/deletar banners.
//
// 18/08/2026 — expansão para Aura Dojô / Karatê / Studio (migration 285):
//   `target_vertical` diz em QUAL SHELL o banner aparece. NULL = todos os
//   shells (comportamento de todo banner já existente). Os valores aceitos
//   estão em src/services/appNotifications.js (SHELLS) — mesma lista que a
//   rota do app usa para casar com COALESCE(vertical_active, vertical,
//   'negocio'). A criação em si delega para createAppNotification(), que é
//   o mesmo caminho usado quando o BACKEND dispara banner sozinho: uma
//   única implementação de INSERT, um único fallback de schema.
// ============================================================
const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { SHELLS, isValidShell, createAppNotification } = require('../services/appNotifications');

const { listRecipients, sendBannerEmail } = require('../services/notificationEmail');

const adminOnly = [requireAuth, requireRole('admin')];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Migration 347 (app_notification_emails) pode não estar no banco ainda:
// a lista cai no formato antigo, sem o "e-mail enviado".
let _emailLogMissing = false;

const LIST_BASE = `
      SELECT n.*,
             (SELECT COUNT(*)::int FROM notification_reads r
              WHERE r.notification_id = n.id) AS read_count`;
const LIST_EMAIL = `,
             (SELECT MAX(e.created_at) FROM app_notification_emails e
              WHERE e.notification_id = n.id AND e.status = 'sent') AS last_emailed_at,
             (SELECT COUNT(*)::int FROM app_notification_emails e
              WHERE e.notification_id = n.id AND e.status = 'sent') AS email_count`;
const LIST_TAIL = `
      FROM app_notifications n
      ORDER BY n.created_at DESC
      LIMIT 200`;

// GET — lista todos os banners (ativos e inativos)
router.get('/notifications/banners', ...adminOnly, async (req, res) => {
  try {
    let rows;
    if (!_emailLogMissing) {
      try {
        ({ rows } = await db.query(LIST_BASE + LIST_EMAIL + LIST_TAIL));
      } catch (err) {
        if (err.code !== '42P01') throw err;
        _emailLogMissing = true;
        console.error('[admin/notifications] migration 347 ausente: lista sem dados de e-mail');
      }
    }
    if (!rows) ({ rows } = await db.query(LIST_BASE + LIST_TAIL));
    res.json({ banners: rows });
  } catch (err) {
    console.error('[admin/notifications] list error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar banners' });
  }
});

// GET — shells disponíveis para segmentar o banner (alimenta o select da
// Gestão Aura sem hardcode do outro lado).
router.get('/notifications/verticals', ...adminOnly, (req, res) => {
  res.json({ verticals: SHELLS });
});

// POST — cria novo banner
router.post('/notifications/banners', ...adminOnly, async (req, res) => {
  const {
    title, body, html_content, cta_label, cta_url, cta_route,
    target_company_id, target_plan, target_vertical, expires_at, is_active = true,
  } = req.body;

  if (!title) return res.status(400).json({ error: 'title é obrigatório' });
  if (target_vertical != null && target_vertical !== '' && !isValidShell(target_vertical)) {
    return res.status(400).json({
      error: 'target_vertical inválida. Use null para todos os shells ou uma de: ' + SHELLS.join(', '),
      valid_verticals: SHELLS,
    });
  }

  const banner = await createAppNotification({
    title,
    body:            body         || null,
    htmlContent:     html_content || null,
    ctaLabel:        cta_label    || null,
    ctaUrl:          cta_url      || null,
    ctaRoute:        cta_route    || null,
    targetCompanyId: target_company_id || null,
    targetPlan:      target_plan       || null,
    targetVertical:  target_vertical   || null,
    expiresAt:       expires_at        || null,
    isActive:        is_active,
  });

  // createAppNotification nunca lança — null aqui é falha de escrita (ela já
  // logou o motivo) ou migration 285 ausente com banner de shell.
  if (!banner) return res.status(500).json({ error: 'Erro ao criar banner' });
  res.status(201).json({ banner });
});

// PATCH — edita banner existente
router.patch('/notifications/banners/:nid', ...adminOnly, async (req, res) => {
  const { nid } = req.params;
  const FIELDS = ['title','body','html_content','cta_label','cta_url','cta_route',
                  'target_company_id','target_plan','target_vertical','expires_at','is_active'];
  const updates = [];
  const vals    = [];
  let   idx     = 1;

  const tv = req.body.target_vertical;
  if (tv !== undefined && tv !== null && tv !== '' && !isValidShell(tv)) {
    return res.status(400).json({
      error: 'target_vertical inválida. Use null para todos os shells ou uma de: ' + SHELLS.join(', '),
      valid_verticals: SHELLS,
    });
  }

  for (const f of FIELDS) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = $${idx++}`);
      // '' no select da Gestão Aura significa "todos os shells" → NULL.
      vals.push(f === 'target_vertical' && req.body[f] === '' ? null : req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  vals.push(nid);

  try {
    const { rows } = await db.query(
      `UPDATE app_notifications
          SET ${updates.join(', ')}, updated_at = NOW()
        WHERE id = $${idx}
       RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Banner não encontrado' });
    res.json({ banner: rows[0] });
  } catch (err) {
    // Rota de staff: melhor dizer o que falta do que silenciar o campo e
    // deixar o admin achar que segmentou o shell quando não segmentou.
    if (err.code === '42703') {
      console.error('[admin/notifications] update error: migration 285 ausente');
      return res.status(503).json({
        error: 'Coluna target_vertical ainda não existe nesta base. Aplique a migration 285.',
        code: 'MIGRATION_285_PENDENTE',
      });
    }
    console.error('[admin/notifications] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar banner' });
  }
});

// GET — quem pode receber o e-mail de um banner de empresa específica.
// Alimenta o painel (nome da empresa + lista de endereços com a origem).
router.get('/notifications/recipients', ...adminOnly, async (req, res) => {
  const companyId = String(req.query.company_id || '').trim();
  if (!UUID_RE.test(companyId)) return res.status(400).json({ error: 'company_id inválido' });
  try {
    const data = await listRecipients(companyId);
    if (!data) return res.status(404).json({ error: 'Empresa não encontrada' });
    res.json(data);
  } catch (err) {
    console.error('[admin/notifications] recipients error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar destinatários' });
  }
});

// POST — manda por e-mail um banner de empresa específica.
// body: { recipients: string[], subject?: string, pix?: { code, amount?, due_date? } }
// Os endereços precisam estar entre os destinatários da empresa do banner
// (dono, empresa, membros) — a rota não é um disparador de e-mail livre.
router.post('/notifications/banners/:nid/email', ...adminOnly, async (req, res) => {
  if (!Array.isArray(req.body.recipients) || !req.body.recipients.length) {
    return res.status(400).json({ error: 'Escolha ao menos um destinatário' });
  }
  try {
    const r = await sendBannerEmail({
      notificationId: req.params.nid,
      recipients:     req.body.recipients,
      subject:        req.body.subject,
      pix:            req.body.pix,
      sentBy:         req.user && req.user.id,
    });
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error('[admin/notifications] email error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar e-mail' });
  }
});

// DELETE — remove banner (notification_reads removidos via CASCADE)
router.delete('/notifications/banners/:nid', ...adminOnly, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM app_notifications WHERE id = $1`,
      [req.params.nid]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Banner não encontrado' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('[admin/notifications] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao excluir banner' });
  }
});

module.exports = router;
