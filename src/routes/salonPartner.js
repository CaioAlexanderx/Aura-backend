// ============================================================
// AURA. — Rotas Salão Parceiro (BE-22)
// Lei nº 13.352/2016
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calculateSplit, recordSplit, getMonthlySummary } = require('../services/salonPartner');

// GET /companies/:id/salon-partners
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, cnpj, partner_share, salon_share, pix_key, notes, is_active, created_at
       FROM salon_partners WHERE company_id=$1 ORDER BY name`,
      [req.params.id]
    );
    res.json({ total: rows.length, partners: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar parceiros' }); }
});

// POST /companies/:id/salon-partners
router.post('/', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, cnpj, partner_share, pix_key, notes } = req.body;
  if (!name || !partner_share) return res.status(400).json({ error: 'name e partner_share são obrigatórios' });
  const share = parseFloat(partner_share);
  if (isNaN(share) || share <= 0 || share >= 100) return res.status(400).json({ error: 'partner_share deve ser entre 0 e 100 (exclusivo)' });
  try {
    const { rows } = await db.query(
      `INSERT INTO salon_partners (company_id, name, cnpj, partner_share, pix_key, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, name, cnpj||null, share, pix_key||null, notes||null]
    );
    res.status(201).json({ partner: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao cadastrar parceiro' }); }
});

// PATCH /companies/:id/salon-partners/:pid
router.patch('/:pid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, cnpj, partner_share, pix_key, notes, is_active } = req.body;
  const fields=[], values=[];
  let idx=1;
  if (name          !== undefined) { fields.push(`name=$${idx++}`);          values.push(name); }
  if (cnpj          !== undefined) { fields.push(`cnpj=$${idx++}`);          values.push(cnpj); }
  if (partner_share !== undefined) { fields.push(`partner_share=$${idx++}`); values.push(parseFloat(partner_share)); }
  if (pix_key       !== undefined) { fields.push(`pix_key=$${idx++}`);       values.push(pix_key); }
  if (notes         !== undefined) { fields.push(`notes=$${idx++}`);         values.push(notes); }
  if (is_active     !== undefined) { fields.push(`is_active=$${idx++}`);     values.push(is_active); }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push(`updated_at=NOW()`);
  values.push(req.params.pid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE salon_partners SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Parceiro não encontrado' });
    res.json({ partner: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar parceiro' }); }
});

// DELETE /companies/:id/salon-partners/:pid (soft delete)
router.delete('/:pid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE salon_partners SET is_active=false, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING id`,
      [req.params.pid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Parceiro não encontrado' });
    res.json({ message: 'Parceiro desativado' });
  } catch (err) { res.status(500).json({ error: 'Erro ao desativar parceiro' }); }
});

// POST /companies/:id/salon-partners/split/calculate (preview)
router.post('/split/calculate', requireAuth, async (req, res) => {
  const { partner_id, service_amount } = req.body;
  if (!partner_id || !service_amount) return res.status(400).json({ error: 'partner_id e service_amount são obrigatórios' });
  try {
    const { rows } = await db.query(
      'SELECT name, partner_share FROM salon_partners WHERE id=$1 AND company_id=$2 AND is_active=true',
      [partner_id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Parceiro não encontrado' });
    const split = calculateSplit(service_amount, parseFloat(rows[0].partner_share));
    res.json({ partner_name: rows[0].name, ...split });
  } catch (err) { res.status(500).json({ error: 'Erro ao calcular divisão' }); }
});

// POST /companies/:id/salon-partners/split
router.post('/split', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const result = await recordSplit(req.params.id, req.body);
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes('não encontrado')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: 'Erro ao registrar divisão' });
  }
});

// PATCH /companies/:id/salon-partners/split/:sid/pay
router.patch('/split/:sid/pay', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE salon_partner_splits SET status='paid', paid_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND company_id=$2 AND status='pending' RETURNING *`,
      [req.params.sid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Split não encontrado ou já pago' });
    res.json({ split: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao marcar repasse como pago' }); }
});

// GET /companies/:id/salon-partners/summary?month=
router.get('/summary', requireAuth, async (req, res) => {
  const now = new Date();
  const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  try {
    const data = await getMonthlySummary(req.params.id, month);
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar resumo mensal' }); }
});

// GET /companies/:id/salon-partners/:pid/splits?month=
router.get('/:pid/splits', requireAuth, async (req, res) => {
  const now = new Date();
  const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  try {
    const { rows } = await db.query(
      `SELECT s.*, p.name AS partner_name FROM salon_partner_splits s
       JOIN salon_partners p ON p.id=s.partner_id
       WHERE s.company_id=$1 AND s.partner_id=$2 AND s.reference_month=$3
       ORDER BY s.created_at DESC`,
      [req.params.id, req.params.pid, month]
    );
    const total_pending = rows.filter(r => r.status==='pending').reduce((sum,r) => sum+parseFloat(r.partner_amount), 0);
    res.json({ partner_id: req.params.pid, reference_month: month,
      total_pending: Math.round(total_pending*100)/100, splits: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar splits do parceiro' }); }
});

module.exports = router;
