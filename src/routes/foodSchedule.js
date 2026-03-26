// ============================================================
// AURA. — Food Service
// Cardápio por período — horários de ativação automática
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');

const guard = [requireAuth, requirePlan(['negocio','expansao'])];
const notFound = (res, e='Horário') => res.status(404).json({ error: `${e} não encontrado` });

// Verifica se um menu está ativo agora com base nos horários
// Retorna: { active: bool, reason: string, current_schedule?: schedule }
function checkMenuActive(menu, schedules) {
  // Se always_available=true, ignora horários
  if (menu.always_available) return { active: true, reason: 'always_available' };
  if (!schedules.length)     return { active: false, reason: 'sem_horarios_cadastrados' };

  const now   = new Date();
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dow   = tzNow.getDay(); // 0=Dom, 1=Seg...
  const hhmm  = tzNow.getHours() * 60 + tzNow.getMinutes();

  for (const s of schedules) {
    if (!s.is_active) continue;
    // Verifica dia da semana
    const days = s.days_of_week;
    if (days && days.length && !days.includes(dow)) continue;
    // Verifica horário
    const [sh, sm] = s.start_time.split(':').map(Number);
    const [eh, em] = s.end_time.split(':').map(Number);
    const start = sh * 60 + sm;
    const end   = eh * 60 + em;
    const inTime = end >= start
      ? hhmm >= start && hhmm < end          // janela normal (ex: 11:00–15:00)
      : hhmm >= start || hhmm < end;         // vira-noite  (ex: 22:00–02:00)
    if (inTime) return { active: true, reason: 'dentro_do_horario', current_schedule: s };
  }
  return { active: false, reason: 'fora_do_horario' };
}

// ── ROTAS ─────────────────────────────────────────────────────

// GET /companies/:id/food/schedule
// Lista todos os cardápios com seus horários + status atual
router.get('/', guard, async (req, res) => {
  try {
    const { rows: menus } = await db.query(
      `SELECT * FROM food_menus WHERE company_id=$1 ORDER BY created_at`, [req.params.id]
    );
    const { rows: schedules } = await db.query(
      `SELECT * FROM food_menu_schedules WHERE company_id=$1 ORDER BY menu_id, start_time`,
      [req.params.id]
    );
    const result = menus.map(menu => {
      const ms = schedules.filter(s => s.menu_id === menu.id);
      return { ...menu, schedules: ms, ...checkMenuActive(menu, ms) };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/food/schedule/active
// Cardápios ativos AGORA — endpoint para o cardápio público
router.get('/active', async (req, res) => {
  // Público: sem auth — usado pelo cardápio digital do cliente
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
      .map(menu => ({
        ...menu,
        schedules: schedules.filter(s => s.menu_id === menu.id),
      }))
      .filter(menu => checkMenuActive(menu, menu.schedules).active);
    res.json(active);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/food/schedule
// Criar horário para um menu
router.post('/', guard, async (req, res) => {
  const { menu_id, label, days_of_week, start_time, end_time } = req.body;
  if (!menu_id || !label || !start_time || !end_time)
    return res.status(400).json({ error: 'menu_id, label, start_time e end_time obrigatórios' });
  // Valida que o menu pertence à empresa
  const { rows: m } = await db.query(
    `SELECT id FROM food_menus WHERE id=$1 AND company_id=$2`, [menu_id, req.params.id]
  );
  if (!m.length) return notFound(res, 'Cardápio');
  try {
    const { rows } = await db.query(
      `INSERT INTO food_menu_schedules
         (menu_id, company_id, label, days_of_week, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [menu_id, req.params.id, label, days_of_week||null, start_time, end_time]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /companies/:id/food/schedule/:sid
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
      `UPDATE food_menu_schedules SET ${updates.join(',')} WHERE id=$${i} AND company_id=$${i+1} RETURNING *`,
      vals
    );
    if (!rows.length) return notFound(res);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /companies/:id/food/schedule/:sid
router.delete('/:sid', guard, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM food_menu_schedules WHERE id=$1 AND company_id=$2`,
      [req.params.sid, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /companies/:id/food/schedule/menu/:mid/always-available
// Toggle rápido: cardápio ativo o tempo todo vs. controlado por horário
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
