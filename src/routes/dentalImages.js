// ============================================================
// AURA. — D-07: Dental Clinical Images
// CRUD for clinical images linked to patients
// Mounted inside dental.js via router.use
// Actual file upload goes to Cloudflare R2 (placeholder URL for now)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /companies/:id/dental/patients/:pid/images
router.get('/patients/:pid/images', requireAuth, async (req, res) => {
  const { image_type, tooth_number } = req.query;
  try {
    const params = [req.params.id, req.params.pid];
    let where = 'WHERE di.company_id=$1 AND di.patient_id=$2';
    if (image_type) { params.push(image_type); where += ` AND di.image_type=$${params.length}::dental_image_type`; }
    if (tooth_number) { params.push(tooth_number); where += ` AND di.tooth_number=$${params.length}`; }

    const { rows } = await db.query(
      `SELECT di.*, u.name AS uploaded_by_name
       FROM dental_images di
       LEFT JOIN users u ON u.id=di.uploaded_by
       ${where}
       ORDER BY di.created_at DESC`, params
    );
    res.json({ total: rows.length, images: rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar imagens' });
  }
});

// POST /companies/:id/dental/patients/:pid/images
// For now: accepts a URL (R2 pre-signed upload happens client-side)
// In production: implement multipart upload -> R2 -> store URL
router.post('/patients/:pid/images', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { url, thumbnail_url, tooth_number, image_type, description,
          file_name, file_size, taken_at, appointment_id } = req.body;

  if (!url) return res.status(400).json({ error: 'url e obrigatorio' });

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_images
         (company_id, patient_id, appointment_id, tooth_number, image_type,
          url, thumbnail_url, file_name, file_size, description, taken_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5::dental_image_type,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [req.params.id, req.params.pid, appointment_id||null,
       tooth_number||null, image_type||'outro',
       url, thumbnail_url||null, file_name||null, file_size||null,
       description||null, taken_at||null, req.user.id]
    );
    res.status(201).json({ image: rows[0] });
  } catch (err) {
    console.error('dental image upload error:', err);
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
    res.status(500).json({ error: 'Erro ao remover imagem' });
  }
});

module.exports = router;
