// ============================================================
// AURA. — D-07: Dental Clinical Images
// D-UNIFY: customer_id (paciente = customer com is_patient=true).
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// Aceita customer_id (novo) ou patient_id (legado, na URL/body)
async function resolveCustomerId(companyId, id) {
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT id FROM customers WHERE id=$1 AND company_id=$2 AND is_patient=true`,
    [id, companyId]
  );
  return rows.length ? rows[0].id : null;
}

// GET /companies/:id/dental/patients/:pid/images
// :pid pode ser customer_id (novo) ou patient_id (legado) — mas hoje os modais
// usam sempre o customer_id, entao filtramos por customer_id direto.
router.get('/patients/:pid/images', requireAuth, async (req, res) => {
  const { image_type, tooth_number } = req.query;
  try {
    const params = [req.params.id, req.params.pid];
    let where = 'WHERE di.company_id=$1 AND di.customer_id=$2';
    if (image_type) { params.push(image_type); where += ` AND di.image_type=$${params.length}::dental_image_type`; }
    if (tooth_number) { params.push(tooth_number); where += ` AND di.tooth_number=$${params.length}`; }

    const { rows } = await db.query(
      `SELECT di.*,
              di.customer_id AS patient_id,
              u.full_name AS uploaded_by_name
       FROM dental_images di
       LEFT JOIN users u ON u.id=di.uploaded_by
       ${where}
       ORDER BY di.created_at DESC`, params
    );
    res.json({ total: rows.length, images: rows });
  } catch (err) {
    console.error('[dentalImages GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar imagens' });
  }
});

// POST /companies/:id/dental/patients/:pid/images
router.post('/patients/:pid/images', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { url, thumbnail_url, tooth_number, image_type, description,
          file_name, file_size, taken_at, appointment_id } = req.body;

  if (!url) return res.status(400).json({ error: 'url e obrigatorio' });

  const customerId = await resolveCustomerId(req.params.id, req.params.pid);
  if (!customerId) return res.status(400).json({ error: 'Paciente invalido ou nao encontrado' });

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_images
         (company_id, customer_id, appointment_id, tooth_number, image_type,
          url, thumbnail_url, file_name, file_size, description, taken_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5::dental_image_type,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *, customer_id AS patient_id`,
      [req.params.id, customerId, appointment_id||null,
       tooth_number||null, image_type||'outro',
       url, thumbnail_url||null, file_name||null, file_size||null,
       description||null, taken_at||null, req.user.id]
    );
    res.status(201).json({ image: rows[0] });
  } catch (err) {
    console.error('[dentalImages POST]', err.message);
    res.status(500).json({ error: 'Erro ao salvar imagem' });
  }
});

// DELETE /companies/:id/dental/images/:imgId
router.delete('/images/:imgId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM dental_images WHERE id=$1 AND company_id=$2 RETURNING id, url',
      [req.params.imgId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Imagem nao encontrada' });
    // TODO: Delete from R2 bucket
    res.json({ message: 'Imagem removida', deleted: rows[0] });
  } catch (err) {
    console.error('[dentalImages DELETE]', err.message);
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

module.exports = router;
