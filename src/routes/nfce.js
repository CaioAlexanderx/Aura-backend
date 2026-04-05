// ============================================================
// AURA. — MKT-02: NFC-e (Cupom Fiscal Eletrônico)
// Config, emission, cancellation, status
// Mounted at: /companies/:id/nfce
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');

// GET /config
router.get('/config', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, company_id, serie_nfce, next_number, ambiente, uf, inscricao_estadual, is_active, csc_id FROM nfce_config WHERE company_id=$1',
      [req.params.id]
    );
    res.json({ config: rows[0] || null });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar config NFC-e' }); }
});

router.post('/config', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO nfce_config (company_id, serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id) DO UPDATE SET
         serie_nfce=COALESCE($2, nfce_config.serie_nfce),
         ambiente=COALESCE($3, nfce_config.ambiente),
         uf=COALESCE($4, nfce_config.uf),
         inscricao_estadual=COALESCE($5, nfce_config.inscricao_estadual),
         csc_id=COALESCE($6, nfce_config.csc_id),
         csc_token=COALESCE($7, nfce_config.csc_token),
         updated_at=NOW()
       RETURNING *`,
      [req.params.id, serie_nfce||1, ambiente||'homologacao', uf||'SP', inscricao_estadual||null, csc_id||null, csc_token||null]
    );
    res.json({ config: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar config' }); }
});

// POST /emit — Emit NFC-e
router.post('/emit', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { items, customer_cpf, customer_name, payment_method, payment_change, sale_id, transaction_id } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items obrigatorio' });

  try {
    // Get config + next number
    const { rows: configs } = await db.query(
      'SELECT * FROM nfce_config WHERE company_id=$1', [req.params.id]
    );
    if (!configs.length || !configs[0].is_active) {
      return res.status(400).json({ error: 'NFC-e nao configurada. Configure em Configuracoes > NFC-e' });
    }
    const config = configs[0];

    // Calculate totals
    let totalProducts = 0, totalDiscount = 0;
    for (const item of items) {
      totalProducts += (item.quantity || 1) * (item.unit_price || 0);
      totalDiscount += item.discount || 0;
    }
    const totalNfce = Math.round((totalProducts - totalDiscount) * 100) / 100;

    // Generate access key placeholder (real key comes from SEFAZ)
    const chaveAcesso = `${config.uf}${new Date().toISOString().substring(2, 4)}${new Date().toISOString().substring(5, 7)}${'0'.repeat(14)}55${String(config.serie_nfce).padStart(3, '0')}${String(config.next_number).padStart(9, '0')}1${'0'.repeat(8)}1`;

    const { rows } = await db.query(
      `INSERT INTO nfce_emissions
         (company_id, sale_id, transaction_id, numero, serie, chave_acesso, status,
          customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
          payment_method, payment_change, emitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.params.id, sale_id||null, transaction_id||null, config.next_number,
       config.serie_nfce, chaveAcesso, config.ambiente === 'homologacao' ? 'autorizada' : 'processando',
       customer_cpf||null, customer_name||null, JSON.stringify(items),
       totalProducts, totalDiscount, totalNfce, payment_method||'dinheiro',
       payment_change||0, req.user.id]
    );

    // Increment next number
    await db.query(
      'UPDATE nfce_config SET next_number=next_number+1 WHERE company_id=$1', [req.params.id]
    );

    // In homologacao, auto-authorize
    if (config.ambiente === 'homologacao') {
      await db.query(
        `UPDATE nfce_emissions SET status='autorizada', protocolo='HOMOLOG-' || LPAD(numero::text, 6, '0'), authorized_at=NOW()
         WHERE id=$1`, [rows[0].id]
      );
      rows[0].status = 'autorizada';
    }
    // TODO: In production, send XML to SEFAZ via NFE.io or direct

    logAuditAction(req.user.id, req.params.id, 'nfce_emitted',
      `NFC-e ${config.next_number - 1} emitida - R$ ${totalNfce}`);

    res.status(201).json({ nfce: rows[0] });
  } catch (err) {
    console.error('nfce emit error:', err);
    res.status(500).json({ error: 'Erro ao emitir NFC-e' });
  }
});

// GET / — List emissions
router.get('/', requireAuth, async (req, res) => {
  const { status, start, end } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE company_id=$1';
    if (status) { params.push(status); where += ` AND status=$${params.length}`; }
    if (start) { params.push(start); where += ` AND created_at>=$${params.length}`; }
    if (end) { params.push(end); where += ` AND created_at<=$${params.length}`; }

    const { rows } = await db.query(
      `SELECT id, numero, serie, chave_acesso, protocolo, status, customer_cpf, customer_name,
              total_nfce, payment_method, authorized_at, cancelled_at, created_at
       FROM nfce_emissions ${where} ORDER BY numero DESC LIMIT 100`, params
    );

    const { rows: stats } = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='autorizada')::int AS authorized,
              COUNT(*) FILTER (WHERE status='cancelada')::int AS cancelled,
              COALESCE(SUM(total_nfce) FILTER (WHERE status='autorizada'),0)::numeric AS total_value
       FROM nfce_emissions WHERE company_id=$1`, [req.params.id]
    );

    res.json({ emissions: rows, stats: stats[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar NFC-e' }); }
});

// POST /:nfceId/cancel
router.post('/:nfceId/cancel', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Motivo do cancelamento obrigatorio' });
  try {
    const { rows } = await db.query(
      `UPDATE nfce_emissions SET status='cancelada', cancel_reason=$1, cancelled_at=NOW()
       WHERE id=$2 AND company_id=$3 AND status='autorizada' RETURNING *`,
      [reason, req.params.nfceId, req.params.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'NFC-e nao encontrada ou nao pode ser cancelada' });
    logAuditAction(req.user.id, req.params.id, 'nfce_cancelled', `NFC-e ${rows[0].numero} cancelada: ${reason}`);
    res.json({ nfce: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao cancelar' }); }
});

module.exports = router;
