// ============================================================
// AURA. — MKT-04: Document Storage Routes
// Upload/download/list documents from R2
// Mounted at: /companies/:id/storage
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  uploadToR2, getSignedUrl, deleteFromR2, listR2Files,
  generateNfeKey, generateDanfeKey, generateImageKey, generateDocKey,
} = require('../utils/r2Storage');

// POST /upload — Upload a document to R2
router.post('/upload', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { content, filename, category, content_type, patient_id, chave_acesso, nfce_numero } = req.body;
  if (!content || !category) return res.status(400).json({ error: 'content e category obrigatorios' });

  let key;
  switch (category) {
    case 'nfe':
      key = generateNfeKey(req.params.id, chave_acesso || filename, 'nfe');
      break;
    case 'nfce':
      key = generateDanfeKey(req.params.id, nfce_numero || filename, 'nfce');
      break;
    case 'clinical':
      if (!patient_id) return res.status(400).json({ error: 'patient_id obrigatorio para imagens clinicas' });
      key = generateImageKey(req.params.id, patient_id, filename || 'image.jpg');
      break;
    default:
      key = generateDocKey(req.params.id, category, filename || 'document.pdf');
  }

  try {
    const result = await uploadToR2(key, content, content_type || 'application/octet-stream');
    if (!result.success) return res.status(500).json({ error: 'Erro no upload: ' + result.error });

    res.status(201).json({
      key: result.key,
      url: result.url,
      size: result.size,
      category,
      retention_years: category === 'nfe' || category === 'nfce' ? 5 : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fazer upload' });
  }
});

// GET /download/:key — Get signed download URL
router.get('/download/*', requireAuth, async (req, res) => {
  const key = req.params[0];
  if (!key) return res.status(400).json({ error: 'key obrigatoria' });

  // Security: ensure key belongs to this company
  if (!key.startsWith(req.params.id)) {
    return res.status(403).json({ error: 'Acesso negado a este arquivo' });
  }

  try {
    const url = await getSignedUrl(key);
    res.json({ url, expires_in: 3600 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar link' });
  }
});

// GET /list/:category — List documents by category
router.get('/list/:category', requireAuth, async (req, res) => {
  const { year, month } = req.query;
  const prefix = year
    ? `${req.params.id}/${req.params.category}/${year}/${month || ''}`
    : `${req.params.id}/${req.params.category}/`;

  try {
    const result = await listR2Files(prefix);
    res.json({ prefix, files: result.files, total: result.files.length });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar documentos' });
  }
});

// DELETE /:key — Delete a document (with retention check for NF-e)
router.delete('/*', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const key = req.params[0];
  if (!key) return res.status(400).json({ error: 'key obrigatoria' });
  if (!key.startsWith(req.params.id)) return res.status(403).json({ error: 'Acesso negado' });

  // Retention check: NF-e XMLs cannot be deleted before 5 years
  if (key.includes('/nfe/') || key.includes('/nfce/')) {
    const parts = key.split('/');
    const yearIdx = parts.findIndex(p => /^\d{4}$/.test(p));
    if (yearIdx >= 0) {
      const fileYear = parseInt(parts[yearIdx]);
      const cutoffYear = new Date().getFullYear() - 5;
      if (fileYear > cutoffYear) {
        return res.status(403).json({
          error: `XML fiscal nao pode ser excluido antes de 5 anos (Art. 174 CTN). Ano do arquivo: ${fileYear}, permitido excluir a partir de: ${fileYear + 5}`,
        });
      }
    }
  }

  try {
    await deleteFromR2(key);
    res.json({ deleted: true, key });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir documento' });
  }
});

module.exports = router;
