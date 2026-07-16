// ============================================================
// AURA KARATÊ — Fase 2: anexos (documentos/imagens) — Dojô e Praticante
//
// Montado DUAS vezes em src/routes/index.js:
//   /federation/:id/dojos           (ao lado de karateDojos)         → owner_type='dojo'
//   /federation/:id/practitioners   (ao lado de karatePractitioners) → owner_type='practitioner'
// Cada montagem expõe:
//   POST   /:ownerId/documents
//   GET    /:ownerId/documents
//   GET    /:ownerId/documents/:docId/download
//   DELETE /:ownerId/documents/:docId
//
// Metadados em karate_documents (migration 207). O binário fica no R2
// (src/utils/r2Storage.js — uploadToR2/getSignedUrl/deleteFromR2).
// A listagem sempre vem da tabela, não de listR2Files, para preservar
// filename/note originais.
//
// Defensivo 42P01/42703: a tabela pode não existir ainda (deploy antes
// da migration ser aplicada) — degrada para lista vazia / 503 claro,
// nunca 500 cru.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { uploadToR2, getSignedUrl, deleteFromR2, generateDocKey } = require('../utils/r2Storage');

// Tamanho máx. do payload base64 (~7MB) → ~5MB binário decodificado.
const MAX_BASE64_LENGTH = 7 * 1024 * 1024;

// owner_type é definido por qual instância deste router está montada.
function ownerTypeFor(req) {
  return req.baseUrl.includes('/dojos') ? 'dojo' : 'practitioner';
}

// Confere que o dono (dojô ou praticante) pertence à federação da rota.
async function assertOwner(federationId, ownerType, ownerId) {
  if (ownerType === 'dojo') {
    const { rows } = await db.query(
      `SELECT id FROM companies
        WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
      [ownerId, federationId]
    );
    return rows.length > 0;
  }
  const { rows } = await db.query(
    `SELECT id FROM customers WHERE id = $1 AND federation_id = $2 LIMIT 1`,
    [ownerId, federationId]
  );
  return rows.length > 0;
}

// Table-missing (42P01) / column-missing (42703) → degrada em vez de 500 cru.
function isMissingTableOrColumn(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

// ── POST /:ownerId/documents ────────────────────────────────
router.post('/:ownerId/documents', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const ownerId = req.params.ownerId;
  const ownerType = ownerTypeFor(req);
  const { content, filename, content_type, note } = req.body;

  if (!content || !filename) {
    return res.status(422).json({ error: 'Campos content e filename são obrigatórios', code: 'VALIDATION_ERROR' });
  }
  if (typeof content === 'string' && content.length > MAX_BASE64_LENGTH) {
    return res.status(413).json({ error: 'Arquivo excede o tamanho máximo permitido (~5MB)', code: 'PAYLOAD_TOO_LARGE' });
  }

  try {
    if (!(await assertOwner(federationId, ownerType, ownerId))) {
      const notFoundMsg = ownerType === 'dojo' ? 'Dojô não encontrado' : 'Praticante não encontrado';
      return res.status(404).json({ error: notFoundMsg, code: 'NOT_FOUND' });
    }

    const key = generateDocKey(federationId, `karate_${ownerType}_${ownerId}`, filename);
    const uploadResult = await uploadToR2(key, content, content_type || 'application/octet-stream');
    if (!uploadResult.success) {
      return res.status(500).json({ error: 'Erro no upload: ' + uploadResult.error });
    }

    let insertRes;
    try {
      insertRes = await db.query(
        `INSERT INTO karate_documents
           (federation_id, owner_type, owner_id, r2_key, filename, content_type, size_bytes, note, uploaded_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING id, federation_id, owner_type, owner_id, r2_key, filename, content_type, size_bytes, note, uploaded_by, created_at`,
        [
          federationId,
          ownerType,
          ownerId,
          uploadResult.key,
          String(filename).trim(),
          content_type || null,
          uploadResult.size || null,
          note || null,
          req.user?.id || null,
        ]
      );
    } catch (err) {
      if (isMissingTableOrColumn(err)) {
        return res.status(503).json({
          error: 'Recurso de documentos ainda não disponível (migration pendente)',
          code: 'MIGRATION_PENDING',
        });
      }
      throw err;
    }

    const doc = insertRes.rows[0];
    const response = {
      id: doc.id,
      federation_id: doc.federation_id,
      owner_type: doc.owner_type,
      owner_id: doc.owner_id,
      r2_key: doc.r2_key,
      filename: doc.filename,
      content_type: doc.content_type || null,
      size_bytes: doc.size_bytes || null,
      note: doc.note || null,
      uploaded_by: doc.uploaded_by || null,
      created_at: doc.created_at,
    };
    if (uploadResult.mock) response.storage_mock = true;

    res.status(201).json(response);
  } catch (err) {
    console.error('[karateDocuments] upload error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar documento', detail: err.message });
  }
});

// ── GET /:ownerId/documents ──────────────────────────────────
router.get('/:ownerId/documents', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const ownerId = req.params.ownerId;
  const ownerType = ownerTypeFor(req);

  try {
    if (!(await assertOwner(federationId, ownerType, ownerId))) {
      const notFoundMsg = ownerType === 'dojo' ? 'Dojô não encontrado' : 'Praticante não encontrado';
      return res.status(404).json({ error: notFoundMsg, code: 'NOT_FOUND' });
    }

    let listRes;
    try {
      listRes = await db.query(
        `SELECT id, federation_id, owner_type, owner_id, r2_key, filename, content_type,
                size_bytes, note, uploaded_by, created_at
         FROM karate_documents
         WHERE federation_id = $1 AND owner_type = $2 AND owner_id = $3
         ORDER BY created_at DESC`,
        [federationId, ownerType, ownerId]
      );
    } catch (err) {
      if (isMissingTableOrColumn(err)) {
        return res.json({ data: [] });
      }
      throw err;
    }

    const data = await Promise.all(listRes.rows.map(async (doc) => ({
      id: doc.id,
      federation_id: doc.federation_id,
      owner_type: doc.owner_type,
      owner_id: doc.owner_id,
      filename: doc.filename,
      content_type: doc.content_type || null,
      size_bytes: doc.size_bytes || null,
      note: doc.note || null,
      uploaded_by: doc.uploaded_by || null,
      created_at: doc.created_at,
      download_url: await getSignedUrl(doc.r2_key),
    })));

    res.json({ data, total: data.length });
  } catch (err) {
    console.error('[karateDocuments] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar documentos' });
  }
});

// ── GET /:ownerId/documents/:docId/download ─────────────────
router.get('/:ownerId/documents/:docId/download', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const ownerId = req.params.ownerId;
  const ownerType = ownerTypeFor(req);
  const { docId } = req.params;

  try {
    let docRes;
    try {
      docRes = await db.query(
        `SELECT id, r2_key, filename, content_type
         FROM karate_documents
         WHERE id = $1 AND federation_id = $2 AND owner_type = $3 AND owner_id = $4
         LIMIT 1`,
        [docId, federationId, ownerType, ownerId]
      );
    } catch (err) {
      if (isMissingTableOrColumn(err)) {
        return res.status(503).json({
          error: 'Recurso de documentos ainda não disponível (migration pendente)',
          code: 'MIGRATION_PENDING',
        });
      }
      throw err;
    }

    if (!docRes.rows.length) {
      return res.status(404).json({ error: 'Documento não encontrado', code: 'NOT_FOUND' });
    }

    const doc = docRes.rows[0];
    const url = await getSignedUrl(doc.r2_key);
    res.json({ url, expires_in: 3600, filename: doc.filename, content_type: doc.content_type || null });
  } catch (err) {
    console.error('[karateDocuments] download error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar link de download' });
  }
});

// ── DELETE /:ownerId/documents/:docId ───────────────────────
router.delete('/:ownerId/documents/:docId', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const ownerId = req.params.ownerId;
  const ownerType = ownerTypeFor(req);
  const { docId } = req.params;

  try {
    let docRes;
    try {
      docRes = await db.query(
        `SELECT id, r2_key
         FROM karate_documents
         WHERE id = $1 AND federation_id = $2 AND owner_type = $3 AND owner_id = $4
         LIMIT 1`,
        [docId, federationId, ownerType, ownerId]
      );
    } catch (err) {
      if (isMissingTableOrColumn(err)) {
        return res.status(503).json({
          error: 'Recurso de documentos ainda não disponível (migration pendente)',
          code: 'MIGRATION_PENDING',
        });
      }
      throw err;
    }

    if (!docRes.rows.length) {
      return res.status(404).json({ error: 'Documento não encontrado', code: 'NOT_FOUND' });
    }

    const doc = docRes.rows[0];

    // Defensivo: se o R2 falhar, ainda remove o metadado (loga o erro).
    try {
      const delResult = await deleteFromR2(doc.r2_key);
      if (!delResult.success) {
        console.error('[karateDocuments] R2 delete failed (proceeding to remove metadata):', delResult.error);
      }
    } catch (err) {
      console.error('[karateDocuments] R2 delete threw (proceeding to remove metadata):', err.message);
    }

    await db.query(`DELETE FROM karate_documents WHERE id = $1`, [docId]);

    res.json({ deleted: true, id: docId });
  } catch (err) {
    console.error('[karateDocuments] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao excluir documento' });
  }
});

module.exports = router;
