// ============================================================
// AURA KARATÊ — Banners Promocionais (Migration 198)
//
// ADMIN (auth federação):
//   POST   /federation/:federationId/banners      — upload imagem + cria banner
//   GET    /federation/:federationId/banners      — lista todos os banners
//   PATCH  /federation/:federationId/banners/:id  — edita banner
//   DELETE /federation/:federationId/banners/:id  — remove banner
//
// PÚBLICO (sem auth):
//   GET /public/karate/:slug/banners?placement=hub — banners ativos (hub/inscricao/ambos)
//
// Upload: aceita base64 (campo image_base64 + image_content_type) OU
// multipart/form-data com campo `image` (via multer memoryStorage).
// Mesmo padrão de karateImport.js (multer opcional com fallback).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const crypto = require('crypto');
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { uploadToR2 } = require('../utils/r2Storage');

// ── Multer opcional (espelha karateImport.js) ────────────────
let multer;
try { multer = require('multer'); } catch (_) { multer = null; }

const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
  : null;

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const ALLOWED_FORMATS = ['square', 'story', 'landscape'];
const ALLOWED_PLACEMENTS = ['hub', 'inscricao', 'ambos'];

// ── Helper: extrair buffer da imagem do request ──────────────
// Suporta dois modos:
//   1. Multipart: req.file (multer) → buffer direto
//   2. JSON: req.body.image_base64 (string base64, com ou sem prefixo data:)
function extractImageBuffer(req) {
  if (req.file && req.file.buffer) {
    return { buffer: req.file.buffer, contentType: req.file.mimetype };
  }
  const { image_base64, image_content_type } = req.body || {};
  if (image_base64 && typeof image_base64 === 'string') {
    const cleaned = image_base64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleaned, 'base64');
    return { buffer, contentType: image_content_type || 'image/jpeg' };
  }
  return null;
}

// ── Helper: gerar chave R2 para banner ──────────────────────
function bannerR2Key(federationId, contentType) {
  const ext = contentType === 'image/png' ? 'png'
            : contentType === 'image/webp' ? 'webp'
            : 'jpg';
  const ts = Date.now();
  const rand = crypto.randomBytes(6).toString('hex');
  return `karate/${federationId}/banners/${ts}-${rand}.${ext}`;
}

// ── Helper: validar UUID ─────────────────────────────────────
const isUUID = (v) => /^[0-9a-fA-F-]{36}$/.test(String(v || ''));

// ============================================================
// ADMIN: POST /federation/:federationId/banners
// ============================================================
// Middleware multipart se multer disponível; senão passa direto (base64 via JSON)
const maybeMultipart = upload
  ? upload.single('image')
  : (req, res, next) => next();

router.post(
  '/banners',
  ...guards.staffWrite(),
  maybeMultipart,
  async (req, res) => {
    try {
      const federationId = req.params.federationId || req.params.id;
      const { format, title, event_id, placement, sort_order, active, starts_at, ends_at } = req.body || {};

      // Validar format
      if (!format || !ALLOWED_FORMATS.includes(format)) {
        return res.status(422).json({
          error: `format inválido. Valores aceitos: ${ALLOWED_FORMATS.join(', ')}`,
          code: 'VALIDATION_ERROR',
        });
      }

      // Extrair imagem
      const imageData = extractImageBuffer(req);
      if (!imageData) {
        return res.status(422).json({
          error: 'Imagem obrigatória. Envie multipart/form-data com campo `image` ou JSON com `image_base64`.',
          code: 'VALIDATION_ERROR',
        });
      }

      const { buffer, contentType } = imageData;
      if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
        return res.status(422).json({
          error: `Tipo de imagem não suportado: ${contentType}. Aceitos: ${ALLOWED_IMAGE_TYPES.join(', ')}`,
          code: 'VALIDATION_ERROR',
        });
      }

      const sizeMb = buffer.length / (1024 * 1024);
      if (sizeMb > 10) {
        return res.status(413).json({
          error: `Imagem excede 10 MB (${sizeMb.toFixed(2)} MB)`,
          code: 'FILE_TOO_LARGE',
        });
      }

      // Upload para R2
      const key = bannerR2Key(federationId, contentType);
      const r2Result = await uploadToR2(key, buffer, contentType);
      if (!r2Result || !r2Result.success) {
        return res.status(500).json({
          error: 'Falha ao armazenar imagem',
          detail: r2Result?.error || 'unknown',
        });
      }

      // Normalizar placement
      const normalizedPlacement = ALLOWED_PLACEMENTS.includes(placement) ? placement : 'hub';

      // Inserir registro
      const ins = await db.query(
        `INSERT INTO karate_promo_banners
           (federation_id, title, image_url, format, event_id, placement,
            active, sort_order, starts_at, ends_at, created_by, created_at)
         VALUES ($1, $2, $3, $4,
           $5::uuid,
           $6, $7,
           COALESCE($8::int, 0),
           $9::timestamptz, $10::timestamptz,
           $11::uuid, NOW())
         RETURNING *`,
        [
          federationId,
          title || null,
          r2Result.url,
          format,
          (event_id && isUUID(event_id)) ? event_id : null,
          normalizedPlacement,
          active !== false && active !== 'false',
          sort_order != null ? parseInt(sort_order, 10) : null,
          starts_at || null,
          ends_at || null,
          req.user?.id || null,
        ]
      );

      return res.status(201).json({ banner: ins.rows[0] });
    } catch (err) {
      console.error('[karatePromoBanners] POST error:', err.message);
      return res.status(500).json({ error: 'Erro ao criar banner', detail: err.message });
    }
  }
);

// ============================================================
// ADMIN: GET /federation/:federationId/banners
// ============================================================
router.get('/banners', ...guards.read(), async (req, res) => {
  try {
    const federationId = req.params.federationId || req.params.id;
    const rows = await db.query(
      `SELECT b.*,
              e.name AS event_name
       FROM karate_promo_banners b
       LEFT JOIN karate_events e ON e.id = b.event_id
       WHERE b.federation_id = $1
       ORDER BY b.sort_order ASC, b.created_at DESC`,
      [federationId]
    );
    return res.json({ banners: rows.rows });
  } catch (err) {
    console.error('[karatePromoBanners] GET list error:', err.message);
    return res.status(500).json({ error: 'Erro ao listar banners' });
  }
});

// ============================================================
// ADMIN: PATCH /federation/:federationId/banners/:id
// ============================================================
router.patch('/banners/:bannerId', ...guards.staffWrite(), async (req, res) => {
  try {
    const federationId = req.params.federationId || req.params.id;
    const bannerId = req.params.bannerId;

    // Verificar que o banner pertence a esta federação
    const existing = await db.query(
      `SELECT id FROM karate_promo_banners WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [bannerId, federationId]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Banner não encontrado', code: 'NOT_FOUND' });
    }

    const { title, active, sort_order, format, event_id, placement, starts_at, ends_at } = req.body || {};

    // Construir SET dinâmico (só campos enviados)
    const sets = [];
    const vals = [];
    let idx = 1;

    if (title !== undefined) { sets.push(`title = $${idx++}`); vals.push(title); }
    if (active !== undefined) { sets.push(`active = $${idx++}`); vals.push(active === true || active === 'true'); }
    if (sort_order !== undefined) { sets.push(`sort_order = $${idx++}`); vals.push(parseInt(sort_order, 10)); }
    if (format !== undefined) {
      if (!ALLOWED_FORMATS.includes(format)) {
        return res.status(422).json({ error: `format inválido. Aceitos: ${ALLOWED_FORMATS.join(', ')}` });
      }
      sets.push(`format = $${idx++}`); vals.push(format);
    }
    if (event_id !== undefined) {
      sets.push(`event_id = $${idx++}`);
      vals.push((event_id && isUUID(event_id)) ? event_id : null);
    }
    if (placement !== undefined) {
      if (!ALLOWED_PLACEMENTS.includes(placement)) {
        return res.status(422).json({ error: `placement inválido. Aceitos: ${ALLOWED_PLACEMENTS.join(', ')}` });
      }
      sets.push(`placement = $${idx++}`); vals.push(placement);
    }
    if (starts_at !== undefined) { sets.push(`starts_at = $${idx++}`); vals.push(starts_at || null); }
    if (ends_at !== undefined) { sets.push(`ends_at = $${idx++}`); vals.push(ends_at || null); }

    if (!sets.length) {
      return res.status(422).json({ error: 'Nenhum campo editável enviado' });
    }

    vals.push(bannerId);
    const updated = await db.query(
      `UPDATE karate_promo_banners SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals
    );

    return res.json({ banner: updated.rows[0] });
  } catch (err) {
    console.error('[karatePromoBanners] PATCH error:', err.message);
    return res.status(500).json({ error: 'Erro ao editar banner', detail: err.message });
  }
});

// ============================================================
// ADMIN: DELETE /federation/:federationId/banners/:id
// ============================================================
router.delete('/banners/:bannerId', ...guards.adminOnly(), async (req, res) => {
  try {
    const federationId = req.params.federationId || req.params.id;
    const bannerId = req.params.bannerId;

    const del = await db.query(
      `DELETE FROM karate_promo_banners WHERE id = $1 AND federation_id = $2 RETURNING id`,
      [bannerId, federationId]
    );
    if (!del.rows.length) {
      return res.status(404).json({ error: 'Banner não encontrado', code: 'NOT_FOUND' });
    }
    return res.json({ ok: true, deleted_id: del.rows[0].id });
  } catch (err) {
    console.error('[karatePromoBanners] DELETE error:', err.message);
    return res.status(500).json({ error: 'Erro ao remover banner', detail: err.message });
  }
});

module.exports = router;
