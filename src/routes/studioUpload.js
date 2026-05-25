// ============================================================
// AURA Studio · Upload de mockup pro R2 (item #10 UX overhaul)
// Mount em private.js sob /studio (mesmo prefixo).
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const r2      = require('../utils/r2Storage');

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];
const MAX_SIZE_MB = 15;

// POST /studio/upload-mockup
// body: { content_base64: string, content_type: string, kind?: 'mockup'|'template' }
router.post('/upload-mockup', async function(req, res) {
  const { content_base64, content_type, kind = 'mockup' } = req.body;

  if (!content_base64 || typeof content_base64 !== 'string') {
    return res.status(400).json({ error: 'content_base64 obrigatório' });
  }
  if (!content_type || !ALLOWED_TYPES.includes(content_type)) {
    return res.status(400).json({
      error: 'content_type inválido',
      allowed: ALLOWED_TYPES,
    });
  }

  // Decode base64
  let buf;
  try {
    // Remove prefix "data:image/png;base64," se tiver
    const cleaned = content_base64.replace(/^data:[^;]+;base64,/, '');
    buf = Buffer.from(cleaned, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'base64 inválido' });
  }

  const sizeMb = buf.length / (1024 * 1024);
  if (sizeMb > MAX_SIZE_MB) {
    return res.status(413).json({
      error: `Arquivo excede ${MAX_SIZE_MB} MB`,
      size_mb: sizeMb.toFixed(2),
    });
  }

  const ext = content_type === 'application/pdf' ? 'pdf'
            : content_type === 'image/png'  ? 'png'
            : content_type === 'image/webp' ? 'webp'
            : 'jpg';
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 10);
  const key = `studio/${req.params.id}/${kind}/${ts}-${rand}.${ext}`;

  try {
    const result = await r2.uploadToR2(key, buf, content_type);
    if (!result || !result.success) {
      return res.status(500).json({
        error: 'Falha ao subir pro storage',
        detail: result?.error || 'unknown',
      });
    }
    res.status(201).json({
      url: result.url,
      key: result.key,
      size_mb: parseFloat(sizeMb.toFixed(2)),
      content_type,
    });
  } catch (err) {
    console.error('[studio/upload-mockup]', err.message);
    res.status(500).json({ error: 'Erro ao fazer upload', detail: err.message });
  }
});

module.exports = router;
