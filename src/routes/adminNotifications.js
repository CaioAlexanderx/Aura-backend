// ============================================================
// AURA. — Admin: Notificações Endomarketing
// GET    /admin/notifications/banners               — lista todos os banners
// POST   /admin/notifications/banners               — cria banner
// PATCH  /admin/notifications/banners/:nid          — edita banner
// DELETE /admin/notifications/banners/:nid          — remove banner
//
// Criado: 13/06/2026
// Apenas staff admin pode criar/editar/deletar banners.
// ============================================================
const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const adminOnly = [requireAuth, requireRole('admin')];

// GET — lista todos os banners (ativos e inativos)
router.get('/notifications/banners', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT n.*,
             (SELECT COUNT(*)::int FROM notification_reads r
              WHERE r.notification_id = n.id) AS read_count
      FROM app_notifications n
      ORDER BY n.created_at DESC
      LIMIT 200
    `);
    res.json({ banners: rows });
  } catch (err) {
    console.error('[admin/notifications] list error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar banners' });
  }
});

// POST — cria novo banner
router.post('/notifications/banners', ...adminOnly, async (req, res) => {
  const {
    title, body, html_content, cta_label, cta_url, cta_route,
    target_company_id, target_plan, expires_at, is_active = true,
  } = req.body;

  if (!title) return res.status(400).json({ error: 'title é obrigatório' });

  try {
    const { rows } = await db.query(`
      INSERT INTO app_notifications
        (title, body, html_content, cta_label, cta_url, cta_route,
         target_company_id, target_plan, expires_at, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      title,
      body         || null,
      html_content || null,
      cta_label    || null,
      cta_url      || null,
      cta_route    || null,
      target_company_id || null,
      target_plan       || null,
      expires_at        || null,
      is_active,
    ]);
    res.status(201).json({ banner: rows[0] });
  } catch (err) {
    console.error('[admin/notifications] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar banner' });
  }
});

// PATCH — edita banner existente
router.patch('/notifications/banners/:nid', ...adminOnly, async (req, res) => {
  const { nid } = req.params;
  const FIELDS = ['title','body','html_content','cta_label','cta_url','cta_route',
                  'target_company_id','target_plan','expires_at','is_active'];
  const updates = [];
  const vals    = [];
  let   idx     = 1;

  for (const f of FIELDS) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = $${idx++}`);
      vals.push(req.body[f]);
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
    console.error('[admin/notifications] update error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar banner' });
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
