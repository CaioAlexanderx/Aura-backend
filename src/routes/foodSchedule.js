// ============================================================
// AURA. — Food Service
// Cardápio por período — horários de ativação automática
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
const guard = [requirePlan('negocio', 'expansao')];
const notFound = (res, e='Horário') => res.status(404).json({ error: `${e} não encontrado` });

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

router.get('/', guard, async (req, res) => {
  try {
    const { rows: menus } = await db.query(
      `SELECT * FROM food_menus WHERE company_id=$1 ORDER BY created_at`, [req.params.id]
    );
    const { rows: schedules } = await db.query(
      `SELECT * FROM food_menu_schedules WHERE company_id=$1 ORDER BY menu_id, start_time`, [req.params.id]
    );
    const result = menus.map(menu => {
      const ms = schedules.filter(s => s.menu_id === menu.id);
      return { ...menu, schedules: ms, ...checkMenuActive(menu, ms) };
    });
    res.json(result);
  } catch (e) { console.error('[food/schedule]', e.message); res.status(500).json({ error: 'Erro ao buscar horários' }); }
});

router.get('/active', async (req, res) => {
  const { company_id } = req.query;
  const cid = req.params.id !== ':id' ? req.params.id : company_id;
  if (!cid) return res.status(400).json({ error: 'company_id obrigatório' });
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
  } catch (e) { console.error('[food/schedule/active]', e.message); res.status(500).json({ error: 'Erro ao buscar cardápios ativos' }); }
});

router.post('/', guard, async (req, res) => {
  const { menu_id, label, days_of_week, start_time, end_time } = req.body;
  if (!menu_id || !label || !start_time || !end_time)
    return res.status(400).json({ error: 'menu_id, label, start_time e end_time obrigatórios' });
  const { rows: m } = await db.query(
    `SELECT id FROM food_menus WHERE id=$1 AND company_id=$2`, [menu_id, req.params.id]
  );
  if (!m.length) return notFound(res, 'Cardápio');
  try {
    const { rows } = await db.query(
      `INSERT INTO food_menu_schedules (menu_id, company_id, label, days_of_week, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [menu_id, req.params.id, label, days_of_week||null, start_time, end_time]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error('[food/schedule]', e.message); res.status(500).json({ error: 'Erro ao criar horário' }); }
});

router.patch('/:sid', guard, async (req, res) => {
  const { label, days_of_week, start_time, end_time, is_active } = req.body;
  const updates = [], vals = [];
  let i = 1;
  if (label       !== undefined) { updates.push(`label=$${i++}`);        vals.push(label); }
  if (days_of_week!== undefined) { updates.push(`days_of_week=$${i++}`); vals.push(days_of_week); }
  if (start_time  !== undefined) { updates.push(`start_time=$${i++}`);   vals.push(start_time); }
  if (end_time    !== undefined) { updates.push(`end_time=$${i++}`);      vals.push(end_time); }
  if (is_active   !== undefined) { updates.push(`is_active=$${i++}`);     vals.push(is_active); }
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo' });
  vals.push(req.params.sid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE food_menu_schedules SET ${updates.join(',')} WHERE id=$${i} AND company_id=$${i+1} RETURNING *`, vals
    );
    if (!rows.length) return notFound(res);
    res.json(rows[0]);
  } catch (e) { console.error('[food/schedule]', e.message); res.status(500).json({ error: 'Erro ao atualizar horário' }); }
});

router.delete('/:sid', guard, async (req, res) => {
  try {
    await db.query(`DELETE FROM food_menu_schedules WHERE id=$1 AND company_id=$2`, [req.params.sid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('[food/schedule]', e.message); res.status(500).json({ error: 'Erro ao remover horário' }); }
});

router.patch('/menu/:mid/always-available', guard, async (req, res) => {
  const { always_available } = req.body;
  if (always_available === undefined)
    return res.status(400).json({ error: 'always_available obrigatório' });
  try {
    const { rows } = await db.query(
      `UPDATE food_menus SET always_available=$1, updated_at=NOW()
       WHERE id=$2 AND company_id=$3 RETURNING id, name, always_available`,
      [always_available, req.params.mid, req.params.id]
    );
    if (!rows.length) return notFound(res, 'Cardápio');
    res.json(rows[0]);
  } catch (e) { console.error('[food/schedule]', e.message); res.status(500).json({ error: 'Erro ao atualizar cardápio' }); }
});

module.exports = router;
