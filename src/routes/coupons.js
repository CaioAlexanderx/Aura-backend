// ============================================================
// AURA. -- Cupons de desconto CRUD
// Mounted at: /companies/:id/coupons
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// GET /coupons
// Query: ?source=birthday|manual|... pra filtrar por origem
router.get('/', async (req, res) => {
  try {
    const params = [req.params.id];
    let where = `company_id=$1`;
    if (req.query.source) {
      params.push(String(req.query.source));
      where += ` AND source = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT * FROM coupons WHERE ${where} ORDER BY created_at DESC`, params
    );
    res.json({ total: rows.length, coupons: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar cupons' }); }
});

// POST /coupons
router.post('/', async (req, res) => {
  const { code, description, discount_type, discount_value, min_order_value,
          max_uses, expires_at, customer_id, source } = req.body;
  if (!code || !discount_value) return res.status(400).json({ error: 'code e discount_value obrigatorios' });
  const upperCode = String(code).toUpperCase().trim();
  if (upperCode.length < 3 || upperCode.length > 30) return res.status(400).json({ error: 'Codigo deve ter entre 3 e 30 caracteres' });

  // Sanitização do source (se vier do client)
  const allowedSources = ['manual', 'birthday', 'campaign', 'reactivation'];
  const cleanSource = source && allowedSources.includes(source) ? source : 'manual';

  try {
    const { rows } = await db.query(
      `INSERT INTO coupons (company_id, code, description, discount_type, discount_value,
                            min_order_value, max_uses, expires_at, customer_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.id, upperCode, description || null, discount_type || 'percent',
       parseFloat(discount_value), parseFloat(min_order_value || 0),
       max_uses ? parseInt(max_uses) : null, expires_at || null,
       customer_id || null, cleanSource]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Codigo de cupom ja existe' });
    console.error('[coupons] create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar cupom' });
  }
});

// POST /coupons/validate — Validar cupom (usado pelo PDV antes de finalizar)
router.post('/validate', async (req, res) => {
  const { code, order_total } = req.body;
  if (!code) return res.status(400).json({ valid: false, error: 'Codigo obrigatorio' });
  try {
    const { rows } = await db.query(
      `SELECT * FROM coupons WHERE company_id=$1 AND code=$2 AND is_active=true`,
      [req.params.id, String(code).toUpperCase().trim()]
    );
    if (!rows.length) return res.json({ valid: false, error: 'Cupom nao encontrado' });
    const c = rows[0];
    if (c.expires_at && new Date(c.expires_at) < new Date()) return res.json({ valid: false, error: 'Cupom expirado' });
    if (c.max_uses !== null && c.current_uses >= c.max_uses) return res.json({ valid: false, error: 'Cupom esgotado (limite de usos)' });
    const total = parseFloat(order_total || 0);
    if (c.min_order_value > 0 && total < c.min_order_value) {
      return res.json({ valid: false, error: `Valor minimo do pedido: R$ ${Number(c.min_order_value).toFixed(2).replace('.', ',')}` });
    }
    const discount = c.discount_type === 'percent'
      ? Math.round(total * parseFloat(c.discount_value) / 100 * 100) / 100
      : Math.min(parseFloat(c.discount_value), total);
    res.json({
      valid: true,
      coupon_id: c.id,
      code: c.code,
      description: c.description,
      discount_type: c.discount_type,
      discount_value: parseFloat(c.discount_value),
      discount_amount: discount,
      final_total: Math.max(0, total - discount),
      // Cupom de aniversário: front pode personalizar a UX
      source: c.source || 'manual',
      customer_id: c.customer_id,
    });
  } catch (err) { res.status(500).json({ valid: false, error: 'Erro ao validar cupom' }); }
});

// PATCH /coupons/:couponId
router.patch('/:couponId', async (req, res) => {
  const allowed = ['description', 'discount_type', 'discount_value', 'min_order_value', 'max_uses', 'is_active', 'expires_at'];
  const updates = []; const values = []; let idx = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) { updates.push(`${k}=$${idx++}`); values.push(req.body[k]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at=NOW()');
  values.push(req.params.couponId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE coupons SET ${updates.join(',')} WHERE id=$${idx} AND company_id=$${idx+1} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Cupom nao encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar cupom' }); }
});

// DELETE /coupons/:couponId
router.delete('/:couponId', async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM coupons WHERE id=$1 AND company_id=$2', [req.params.couponId, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Cupom nao encontrado' });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao excluir cupom' }); }
});

module.exports = router;
