// ============================================================
// AURA. — Rotas Multi-usuário RBAC (BE-09)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  countActiveMembers, listMembers, inviteMember,
  acceptInvite, updateMemberPermissions,
} = require('../services/members');

// GET /companies/:id/members
router.get('/', requireAuth, async (req, res) => {
  try {
    const members = await listMembers(req.params.id);
    const activeCount = members.filter(m => m.status==='active' && m.is_active).length;
    res.json({
      total: members.length,
      active: activeCount,
      pending: members.filter(m => m.status==='pending').length,
      monthly_cost: Math.max(activeCount - 1, 0) * 19,
      members,
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar membros' }); }
});

// POST /companies/:id/members/invite
router.post('/invite', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const result = await inviteMember(req.params.id, req.user.id, req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(err.message.includes('já tem') ? 409 : 400).json({ error: err.message });
  }
});

// POST /members/accept/:token
router.post('/accept/:token', requireAuth, async (req, res) => {
  try {
    const member = await acceptInvite(req.params.token, req.user.id);
    res.json({ message: 'Convite aceito. Bem-vindo à equipe!', member });
  } catch (err) {
    res.status(err.message.includes('inválido') ? 410 : 403).json({ error: err.message });
  }
});

// PATCH /companies/:id/members/:mid
router.patch('/:mid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const member = await updateMemberPermissions(req.params.id, req.params.mid, req.body);
    res.json({ member });
  } catch (err) {
    res.status(err.message.includes('não encontrado') ? 404 : 400).json({ error: err.message });
  }
});

// DELETE /companies/:id/members/:mid
router.delete('/:mid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT user_id FROM company_members WHERE id=$1 AND company_id=$2',
      [req.params.mid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membro não encontrado' });
    if (rows[0].user_id === req.user.id) return res.status(400).json({ error: 'Você não pode remover a si mesmo' });
    await db.query(
      `UPDATE company_members SET status='suspended', is_active=false WHERE id=$1 AND company_id=$2`,
      [req.params.mid, req.params.id]
    );
    res.json({ message: 'Membro suspenso' });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover membro' }); }
});

// GET /companies/:id/members/billing
router.get('/billing', requireAuth, async (req, res) => {
  try {
    const activeCount = await countActiveMembers(req.params.id);
    const billable = Math.max(activeCount - 1, 0);
    res.json({
      active_members: activeCount,
      billable_members: billable,
      price_per_member: 19,
      monthly_total: billable * 19,
      note: 'O titular da conta não é cobrado. R$19/membro adicional ativo/mês.',
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao calcular cobrança' }); }
});

// GET /companies/:id/members/roles
router.get('/roles', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, description, permissions, is_default,
              CASE WHEN company_id IS NULL THEN 'global' ELSE 'custom' END AS type
       FROM role_templates
       WHERE company_id=$1 OR company_id IS NULL
       ORDER BY is_default DESC, name`,
      [req.params.id]
    );
    res.json({ total: rows.length, templates: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar templates' }); }
});

// POST /companies/:id/members/roles
router.post('/roles', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, description, permissions={} } = req.body;
  if (!name) return res.status(400).json({ error: 'name é obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO role_templates (company_id, name, description, permissions)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name, description||null, JSON.stringify(permissions)]
    );
    res.status(201).json({ template: rows[0] });
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Já existe um template com este nome' });
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// PATCH /companies/:id/members/roles/:rid
router.patch('/roles/:rid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { name, description, permissions } = req.body;
  const fields=[], values=[];
  let idx=1;
  if (name        !== undefined) { fields.push(`name=$${idx++}`);        values.push(name); }
  if (description !== undefined) { fields.push(`description=$${idx++}`); values.push(description); }
  if (permissions !== undefined) { fields.push(`permissions=$${idx++}`); values.push(JSON.stringify(permissions)); }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push(`updated_at=NOW()`);
  values.push(req.params.rid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE role_templates SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Template não encontrado ou é global' });
    res.json({ template: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar template' }); }
});

// DELETE /companies/:id/members/roles/:rid
router.delete('/roles/:rid', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM role_templates WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.rid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Template não encontrado ou é global' });
    res.json({ message: 'Template removido' });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover template' }); }
});

module.exports = router;
