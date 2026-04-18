// ============================================================
// AURA. — ODT-05: Repasse por Dentista
// GET  /dental/repasses           — resumo por dentista no mes
// GET  /dental/repasses/:pid      — detalhe de um dentista
// PATCH /dental/repasses/:id/status — marcar como pago
// POST /dental/repasses/calculate  — calcular repasses do mes
// GET  /dental/practitioners       — lista dentistas com config
// PATCH /dental/practitioners/:pid — atualizar repasse_pct
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

router.get('/repasses', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const month = req.query.month || currentMonth();
  try {
    const { rows } = await db.query(
      `SELECT r.*, e.name AS practitioner_name, e.role
       FROM dental_repasse_ledger r
       JOIN employees e ON e.id = r.practitioner_id
       WHERE r.company_id = $1 AND r.reference_month = $2
       ORDER BY r.repasse_amount DESC`, [cid, month]);
    const byPractitioner = {};
    for (const r of rows) {
      if (!byPractitioner[r.practitioner_id]) {
        byPractitioner[r.practitioner_id] = {
          practitioner_id: r.practitioner_id, name: r.practitioner_name, role: r.role,
          total_bruto: 0, total_repasse: 0, total_clinica: 0, procedures: [], repasse_pct: parseFloat(r.repasse_pct),
        };
      }
      const amt = parseFloat(r.amount); const rep = parseFloat(r.repasse_amount);
      byPractitioner[r.practitioner_id].total_bruto += amt;
      byPractitioner[r.practitioner_id].total_repasse += rep;
      byPractitioner[r.practitioner_id].total_clinica += (amt - rep);
      byPractitioner[r.practitioner_id].procedures.push(r);
    }
    const practitioners = Object.values(byPractitioner);
    res.json({
      month, practitioners,
      totals: {
        bruto: practitioners.reduce((s, p) => s + p.total_bruto, 0),
        repasse: practitioners.reduce((s, p) => s + p.total_repasse, 0),
        clinica: practitioners.reduce((s, p) => s + p.total_clinica, 0),
      }
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro repasses' }); }
});

router.get('/repasses/:pid', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const month = req.query.month || currentMonth();
  try {
    const { rows } = await db.query(
      `SELECT r.*, e.name AS practitioner_name FROM dental_repasse_ledger r
       JOIN employees e ON e.id = r.practitioner_id
       WHERE r.company_id = $1 AND r.practitioner_id = $2 AND r.reference_month = $3
       ORDER BY r.created_at`, [cid, req.params.pid, month]);
    if (!rows.length) return res.json({ practitioner_id: req.params.pid, month, procedures: [], total_bruto: 0, total_repasse: 0 });
    const total_bruto = rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    const total_repasse = rows.reduce((s, r) => s + parseFloat(r.repasse_amount), 0);
    res.json({ practitioner_id: req.params.pid, name: rows[0].practitioner_name, month, procedures: rows, total_bruto, total_repasse });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.patch('/repasses/:rid/status', requireAuth, requireRole('client','admin'), async (req, res) => {
  const { status } = req.body;
  if (!['paid','cancelled','pending'].includes(status)) return res.status(400).json({ error: 'Status invalido' });
  try {
    const paid_at = status === 'paid' ? 'NOW()' : 'NULL';
    const { rows } = await db.query(
      `UPDATE dental_repasse_ledger SET status=$1, paid_at=${paid_at}, updated_at=NOW()
       WHERE id=$2 AND company_id=$3 RETURNING *`, [status, req.params.rid, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Repasse nao encontrado' });
    res.json({ repasse: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/repasses/calculate', requireAuth, requireRole('client','admin'), async (req, res) => {
  const cid = req.params.id;
  const { month } = req.body;
  const refMonth = month || currentMonth();
  try {
    // Buscar procedimentos concluidos no mes com practitioner
    const startDate = refMonth + '-01';
    const endDate = new Date(new Date(startDate).setMonth(new Date(startDate).getMonth()+1)).toISOString().slice(0,10);
    const { rows: procs } = await db.query(
      `SELECT ap.id, ap.procedure_name, ap.final_price, a.id AS appointment_id,
             e.id AS practitioner_id, e.name AS practitioner_name, e.repasse_pct
       FROM dental_appointment_procedures ap
       JOIN dental_appointments a ON a.id = ap.appointment_id
       LEFT JOIN employees e ON e.id = a.practitioner_id
       WHERE a.company_id = $1 AND a.status = 'completed'
         AND a.scheduled_at >= $2 AND a.scheduled_at < $3
         AND e.id IS NOT NULL`, [cid, startDate, endDate]);
    // Limpar repasses existentes do mes (recalcular)
    await db.query(
      `DELETE FROM dental_repasse_ledger WHERE company_id=$1 AND reference_month=$2 AND status='pending'`, [cid, refMonth]);
    const results = [];
    for (const p of procs) {
      const amt = parseFloat(p.final_price) || 0;
      const pct = parseFloat(p.repasse_pct) || 50;
      const repAmt = Math.round(amt * pct / 100 * 100) / 100;
      const { rows } = await db.query(
        `INSERT INTO dental_repasse_ledger (company_id, practitioner_id, treatment_plan_id, procedure_name, amount, repasse_pct, repasse_amount, reference_month)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7) RETURNING *`,
        [cid, p.practitioner_id, p.procedure_name, amt, pct, repAmt, refMonth]);
      results.push({ ...rows[0], practitioner_name: p.practitioner_name });
    }
    res.json({
      month: refMonth, calculated: results.length, results,
      totals: {
        bruto: results.reduce((s, r) => s + parseFloat(r.amount), 0),
        repasse: results.reduce((s, r) => s + parseFloat(r.repasse_amount), 0),
      }
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao calcular repasses' }); }
});

router.get('/practitioners', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT id, name, role, commission_rate, repasse_pct, is_active
       FROM employees WHERE company_id = $1 AND is_active = true
       ORDER BY name`, [cid]);
    res.json({ practitioners: rows });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.patch('/practitioners/:pid', requireAuth, requireRole('client','admin'), async (req, res) => {
  const { repasse_pct } = req.body;
  if (repasse_pct === undefined) return res.status(400).json({ error: 'repasse_pct obrigatorio' });
  const pct = parseFloat(repasse_pct);
  if (isNaN(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'repasse_pct deve ser 0-100' });
  try {
    const { rows } = await db.query(
      `UPDATE employees SET repasse_pct = $1, updated_at = NOW()
       WHERE id = $2 AND company_id = $3 AND is_active = true
       RETURNING id, name, repasse_pct`, [pct, req.params.pid, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Profissional nao encontrado' });
    res.json({ practitioner: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

module.exports = router;
