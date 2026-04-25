// ============================================================
// AURA. — GAP-01: Receituário + Atestado + Pedido de Exame
// Endpoints sob /dental/documents (Negócio+)
//
// Tipos de documento:
//   receituario_simples | receituario_controlado
//   atestado_comparecimento | atestado_incapacidade
//   pedido_exame | encaminhamento
//
// Fluxo:
//   1. GET /templates          → lista templates disponíveis
//   2. POST /                  → cria documento (renderiza variáveis)
//   3. GET /                   → lista documentos do paciente
//   4. GET /:id                → detalhe + texto renderizado
//   5. PATCH /:id/sign         → marca como assinado
//   6. PATCH /:id/send-whatsapp → registra envio WA
// ============================================================

const express = require('express');
const db      = require('../config/database');

const router = express.Router({ mergeParams: true });

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const DOC_PREFIX = {
  receituario_simples:      'REC-',
  receituario_controlado:   'RCC-',
  atestado_comparecimento:  'ATC-',
  atestado_incapacidade:    'ATI-',
  pedido_exame:             'PEX-',
  encaminhamento:           'ENC-',
};

/** Substitui {{variavel}} pelo valor correspondente no objeto data */
function renderTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = data[key];
    return val !== undefined && val !== null ? String(val) : `[${key}]`;
  });
}

/** Extrai lista de variáveis de um template */
function extractVars(template) {
  const matches = template.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(matches.map(m => m.slice(2, -2)))];
}

// ─────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────

// GET /dental/documents/templates
// Lista templates globais + customizados da empresa
router.get('/templates', async (req, res) => {
  const { companyId } = req;
  const { doc_type } = req.query;

  try {
    let query = `
      SELECT id, company_id, doc_type, name, content, is_active,
             array(SELECT unnest(regexp_matches(content, '\\{\\{(\\w+)\\}\\}', 'g'))) AS variables
        FROM dental_document_templates
       WHERE (company_id IS NULL OR company_id = $1)
         AND is_active = true`;
    const params = [companyId];

    if (doc_type) {
      query += ` AND doc_type = $2`;
      params.push(doc_type);
    }

    query += ` ORDER BY company_id NULLS FIRST, name ASC`;

    const { rows } = await db.query(query, params);

    // Extrai variáveis únicas por template
    const templates = rows.map(r => ({
      ...r,
      variables: extractVars(r.content),
    }));

    res.json({ templates });
  } catch (err) {
    console.error('GET /dental/documents/templates', err);
    res.status(500).json({ error: 'Erro ao buscar templates' });
  }
});

// POST /dental/documents/templates
// Cria template customizado para a empresa
router.post('/templates', async (req, res) => {
  const { companyId } = req;
  const { doc_type, name, content } = req.body;

  if (!doc_type || !name || !content) {
    return res.status(400).json({ error: 'doc_type, name e content obrigatorios' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_document_templates (company_id, doc_type, name, content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [companyId, doc_type, name, content]
    );
    res.status(201).json({ template: { ...rows[0], variables: extractVars(rows[0].content) } });
  } catch (err) {
    console.error('POST /dental/documents/templates', err);
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// ─────────────────────────────────────────────────────────────
// DOCUMENTS
// ─────────────────────────────────────────────────────────────

// GET /dental/documents
// Lista documentos (filtros: customer_id, doc_type, page)
router.get('/', async (req, res) => {
  const { companyId } = req;
  const { customer_id, doc_type, page = 1, limit = 30 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const conditions = ['d.company_id = $1'];
  const params = [companyId];
  let idx = 2;

  if (customer_id) { conditions.push(`d.customer_id = $${idx++}`); params.push(customer_id); }
  if (doc_type)    { conditions.push(`d.doc_type = $${idx++}`);    params.push(doc_type); }

  const where = conditions.join(' AND ');

  try {
    const { rows } = await db.query(
      `SELECT d.*,
              c.name  AS patient_name,
              p.name  AS practitioner_name
         FROM dental_documents d
         LEFT JOIN customers            c ON c.id = d.customer_id
         LEFT JOIN dental_practitioners p ON p.id = d.practitioner_id
        WHERE ${where}
        ORDER BY d.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, Number(limit), offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM dental_documents d WHERE ${where}`,
      params
    );

    res.json({ documents: rows, total: Number(countRows[0].total), page: Number(page) });
  } catch (err) {
    console.error('GET /dental/documents', err);
    res.status(500).json({ error: 'Erro ao buscar documentos' });
  }
});

// POST /dental/documents
// Cria documento: valida template, renderiza variáveis, gera número
router.post('/', async (req, res) => {
  const { companyId } = req;
  const {
    customer_id, practitioner_id, appointment_id,
    template_id, doc_type, content_data,
  } = req.body;

  if (!doc_type || !content_data) {
    return res.status(400).json({ error: 'doc_type e content_data obrigatorios' });
  }

  try {
    // Busca template (customizado da empresa ou global)
    let templateContent = null;
    let resolvedTemplateId = template_id || null;

    if (template_id) {
      const { rows: tRows } = await db.query(
        `SELECT content FROM dental_document_templates
          WHERE id = $1 AND (company_id IS NULL OR company_id = $2) AND is_active = true`,
        [template_id, companyId]
      );
      if (tRows.length) templateContent = tRows[0].content;
    }

    // Se não tem template específico, usa o primeiro global do tipo
    if (!templateContent) {
      const { rows: tRows } = await db.query(
        `SELECT id, content FROM dental_document_templates
          WHERE doc_type = $1 AND company_id IS NULL AND is_active = true
          LIMIT 1`,
        [doc_type]
      );
      if (tRows.length) {
        templateContent = tRows[0].content;
        resolvedTemplateId = tRows[0].id;
      }
    }

    // Renderiza o template com os dados fornecidos
    const rendered = templateContent
      ? renderTemplate(templateContent, content_data)
      : Object.entries(content_data).map(([k, v]) => `${k}: ${v}`).join('\n');

    // Gera número do documento
    const prefix = DOC_PREFIX[doc_type] || 'DOC-';
    const { rows: numRows } = await db.query(
      'SELECT dental_document_next_number($1,$2) AS num',
      [companyId, prefix]
    );
    const doc_number = numRows[0].num;

    const { rows } = await db.query(
      `INSERT INTO dental_documents
         (company_id, customer_id, practitioner_id, appointment_id,
          template_id, doc_type, doc_number, content_data, rendered_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        companyId,
        customer_id || null,
        practitioner_id || null,
        appointment_id || null,
        resolvedTemplateId,
        doc_type,
        doc_number,
        JSON.stringify(content_data),
        rendered,
      ]
    );

    res.status(201).json({ document: rows[0] });
  } catch (err) {
    console.error('POST /dental/documents', err);
    res.status(500).json({ error: 'Erro ao criar documento' });
  }
});

// GET /dental/documents/:docId
router.get('/:docId', async (req, res) => {
  const { companyId } = req;
  const { docId } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT d.*,
              c.name  AS patient_name,
              c.phone AS patient_phone,
              p.name  AS practitioner_name
         FROM dental_documents d
         LEFT JOIN customers            c ON c.id = d.customer_id
         LEFT JOIN dental_practitioners p ON p.id = d.practitioner_id
        WHERE d.id = $1 AND d.company_id = $2`,
      [docId, companyId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Documento nao encontrado' });
    res.json({ document: rows[0] });
  } catch (err) {
    console.error('GET /dental/documents/:docId', err);
    res.status(500).json({ error: 'Erro ao buscar documento' });
  }
});

// PATCH /dental/documents/:docId/sign
// Marca documento como assinado pelo dentista
router.patch('/:docId/sign', async (req, res) => {
  const { companyId } = req;
  const { docId } = req.params;
  const { signed_by_id } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE dental_documents
          SET signed_at    = NOW(),
              signed_by_id = COALESCE($3, signed_by_id),
              signature_hash = encode(sha256(
                (id::text || company_id::text || created_at::text)::bytea
              ), 'hex')
        WHERE id = $1 AND company_id = $2
        RETURNING *`,
      [docId, companyId, signed_by_id || null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Documento nao encontrado' });
    res.json({ document: rows[0] });
  } catch (err) {
    console.error('PATCH /dental/documents/:docId/sign', err);
    res.status(500).json({ error: 'Erro ao assinar documento' });
  }
});

// PATCH /dental/documents/:docId/send-whatsapp
// Registra envio por WhatsApp
router.patch('/:docId/send-whatsapp', async (req, res) => {
  const { companyId } = req;
  const { docId } = req.params;
  const { phone } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE dental_documents
          SET sent_whatsapp_at    = NOW(),
              sent_whatsapp_phone = COALESCE($3, sent_whatsapp_phone)
        WHERE id = $1 AND company_id = $2
        RETURNING *`,
      [docId, companyId, phone || null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Documento nao encontrado' });
    res.json({ document: rows[0] });
  } catch (err) {
    console.error('PATCH /dental/documents/:docId/send-whatsapp', err);
    res.status(500).json({ error: 'Erro ao registrar envio' });
  }
});

module.exports = router;
