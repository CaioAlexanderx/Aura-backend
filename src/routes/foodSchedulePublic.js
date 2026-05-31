// ============================================================
// AURA. — Food Service
// Rotas PUBLICAS de cardapio por periodo (sem auth, sem requirePlan)
// ============================================================
// Split de foodSchedule.js: a rota /active e consumida pelo
// storefront publico (cardapio QR) e por isso fica em router
// proprio montado em /food/schedule sem guard.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

function checkMenuActive(menu, schedules) {
  if (menu.always_available) return { active: true, reason: 'always_available' };
  if (!schedules.length)     return { active: false, reason: 'sem_horarios_cadastrados' };

  const now   = new Date();
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dow   = tzNow.getDay();
  const hhmm  = tzNow.getHours() * 60 + tzNow.getMinutes();

  for (const s of schedules) {
    if (!s.is_active) continue;
    const days = s.days_of_week;
    if (days && days.length && !days.includes(dow)) continue;
    const [sh, sm] = s.start_time.split(':').map(Number);
    const [eh, em] = s.end_time.split(':').map(Number);
    const start = sh * 60 + sm;
    const end   = eh * 60 + em;
    const inTime = end >= start
      ? hhmm >= start && hhmm < end
      : hhmm >= start || hhmm < end;
    if (inTime) return { active: true, reason: 'dentro_do_horario', current_schedule: s };
  }
  return { active: false, reason: 'fora_do_horario' };
}

router.get('/active', async (req, res) => {
  const { company_id } = req.query;
  const cid = req.params.id && req.params.id !== ':id' ? req.params.id : company_id;
  if (!cid) return res.status(400).json({ error: 'company_id obrigatorio' });
  try {
    const { rows: menus } = await db.query(
      `SELECT * FROM food_menus WHERE company_id=$1 AND is_active=TRUE`, [cid]
    );
    const { rows: schedules } = await db.query(
      `SELECT * FROM food_menu_schedules WHERE company_id=$1 AND is_active=TRUE`, [cid]
    );
    const active = menus
      .map(menu => ({ ...menu, schedules: schedules.filter(s => s.menu_id === menu.id) }))
      .filter(menu => checkMenuActive(menu, menu.schedules).active);
    res.json(active);
  } catch (e) {
    console.error('[food/schedule/public/active]', e.message);
    res.status(500).json({ error: 'Erro ao buscar cardapios ativos' });
  }
});

module.exports = router;
