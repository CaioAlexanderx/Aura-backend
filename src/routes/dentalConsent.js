// ============================================================
// AURA. — W2-04: TCLE templates + documents (autenticadas)
//
// Fluxo:
// 1. GET    /dental/consent/templates                  lista (system + custom)
// 2. POST   /dental/consent/templates                  cria custom
// 3. PUT    /dental/consent/templates/:tplId           edita custom
// 4. DELETE /dental/consent/templates/:tplId           desativa custom
// 5. POST   /dental/consent/documents                  cria documento (gera token)
// 6. GET    /dental/consent/documents                  lista por paciente
// 7. GET    /dental/consent/documents/:docId           detalhe
// 8. POST   /dental/consent/documents/:docId/void      cancela token (status=void)
//
// Pagina publica de assinatura e o status sao em rotas separadas
// (dentalConsentPublic.js) sem auth, baseadas no token.
//
// Reuso: mesmo padrao de WS de assinatura do W1-04, mas com tabela
// propria (dental_consent_documents). dentalWsConsent.js handler
// novo, nao mexer em dentalWs.js (que continua especifico de
// appointments).
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const crypto = require('crypto');

// ──────────────────────────────────────────────────────────
// 1. TEMPLATES — listar
// ──────────────────────────────────────────────────────────
// Retorna system templates + customs da clinica.
// Filtros: ?category=cirurgia, ?source=system|custom

router.get('/consent/templates', requireAuth, async (req, res) => {
  const { category, source } = req.query;
  const cid = req.params.id;

  try {
    const params = [cid];
    let where = `WHERE is_active = true AND (
      is_system = true OR (is_system = false AND company_id = $1)
    )`;

    if (category) {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }

    if (source === 'system') where += ` AND is_system = true`;
    else if (source === 'custom') where += ` AND is_system = false`;

    const { rows } = await db.query(
      `SELECT id, code, title, category, body_md, placeholders,
              is_system, created_at, updated_at
       FROM dental_consent_templates
       ${where}
       ORDER BY is_system DESC, category ASC, title ASC`,
      params
    );

    res.json({ total: rows.length, templates: rows });
  } catch (err) {
    console.error('[consent templates GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar templates' });
  }
});

// ──────────────────────────────────────────────────────────
// 2. TEMPLATES — criar custom
// ──────────────────────────────────────────────────────────

router.post('/consent/templates', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { code, title, category, body_md, placeholders } = req.body;
  const cid = req.params.id;

  if (!code || !title || !category || !body_md) {
    return res.status(400).json({ error: 'code, title, category e body_md sao obrigatorios' });
  }

  const validCategories = ['cirurgia','endodontia','implante','ortodontia',
    'estetica','periodontia','protese','generico','lgpd'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: `category deve ser um de: ${validCategories.join(', ')}` });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO dental_consent_templates
         (company_id, code, title, category, body_md, placeholders, is_system)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING *`,
      [cid, code, title, category, body_md, placeholders || []]
    );
    res.status(201).json({ template: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ja existe um template com este codigo' });
    }
    console.error('[consent templates POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// ──────────────────────────────────────────────────────────
// 3. TEMPLATES — editar custom
// ──────────────────────────────────────────────────────────

router.put('/consent/templates/:tplId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { title, body_md, placeholders, is_active } = req.body;
  const cid = req.params.id;
  const tplId = req.params.tplId;

  // Bloqueia edicao de templates system
  const { rows: check } = await db.query(
    `SELECT is_system FROM dental_consent_templates
     WHERE id = $1 AND (company_id = $2 OR is_system = true)`,
    [tplId, cid]
  );

  if (!check.length) return res.status(404).json({ error: 'Template nao encontrado' });
  if (check[0].is_system) {
    return res.status(403).json({ error: 'Templates Aura nao podem ser editados. Crie um custom baseado neste.' });
  }

  const fields = [];
  const values = [];
  let idx = 1;

  if (title !== undefined)         { fields.push(`title=$${idx++}`);        values.push(title); }
  if (body_md !== undefined)       { fields.push(`body_md=$${idx++}`);      values.push(body_md); }
  if (placeholders !== undefined)  { fields.push(`placeholders=$${idx++}`); values.push(placeholders); }
  if (is_active !== undefined)     { fields.push(`is_active=$${idx++}`);    values.push(is_active); }

  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  values.push(tplId, cid);

  try {
    const { rows } = await db.query(
      `UPDATE dental_consent_templates
       SET ${fields.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx} AND is_system = false
       RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Template nao encontrado' });
    res.json({ template: rows[0] });
  } catch (err) {
    console.error('[consent templates PUT]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar template' });
  }
});

// ──────────────────────────────────────────────────────────
// 4. TEMPLATES — desativar custom (soft delete)
// ──────────────────────────────────────────────────────────

router.delete('/consent/templates/:tplId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const cid = req.params.id;
  const tplId = req.params.tplId;

  try {
    const { rows } = await db.query(
      `UPDATE dental_consent_templates
       SET is_active = false
       WHERE id = $1 AND company_id = $2 AND is_system = false
       RETURNING id`,
      [tplId, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Template nao encontrado ou nao pode ser excluido' });
    res.json({ ok: true, deleted: rows[0].id });
  } catch (err) {
    console.error('[consent templates DELETE]', err.message);
    res.status(500).json({ error: 'Erro ao desativar template' });
  }
});

// ──────────────────────────────────────────────────────────
// 5. DOCUMENTS — criar (gera token, renderiza markdown)
// ──────────────────────────────────────────────────────────
// Body:
//   template_id (obrigatorio)
//   customer_id (obrigatorio)
//   placeholders_filled jsonb (obrigatorio — chaves do template)
//   appointment_id? (opcional, vincula ao atendimento)
//   practitioner_id? (opcional)
//   treatment_plan_id? (opcional)

router.post('/consent/documents', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { template_id, customer_id, placeholders_filled = {},
          appointment_id, practitioner_id, treatment_plan_id } = req.body;
  const cid = req.params.id;

  if (!template_id || !customer_id) {
    return res.status(400).json({ error: 'template_id e customer_id sao obrigatorios' });
  }

  try {
    // Carrega template (system ou custom da clinica)
    const { rows: tpl } = await db.query(
      `SELECT id, code, title, category, body_md, placeholders
       FROM dental_consent_templates
       WHERE id = $1 AND is_active = true
         AND (is_system = true OR company_id = $2)`,
      [template_id, cid]
    );
    if (!tpl.length) return res.status(404).json({ error: 'Template nao encontrado' });

    // Valida customer
    const { rows: cust } = await db.query(
      `SELECT id, name FROM customers
       WHERE id = $1 AND company_id = $2 AND is_patient = true`,
      [customer_id, cid]
    );
    if (!cust.length) return res.status(404).json({ error: 'Paciente nao encontrado' });

    // Renderiza body_md substituindo {{placeholders}}
    let rendered = tpl[0].body_md;
    const filled = { ...placeholders_filled };

    // Auto-fill: se nome_paciente nao foi preenchido, usar do customer
    if (!filled.nome_paciente) filled.nome_paciente = cust[0].name;
    // Auto-fill: data se nao foi preenchida
    if (!filled.data) {
      const d = new Date();
      filled.data = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    }

    // Substitui {{key}} -> value (regex global)
    for (const [key, value] of Object.entries(filled)) {
      const re = new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\}\\}`, 'g');
      rendered = rendered.replace(re, String(value || ''));
    }

    // Gera token (32 bytes hex)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10min

    const { rows } = await db.query(
      `INSERT INTO dental_consent_documents
         (company_id, customer_id, template_id, appointment_id, treatment_plan_id,
          practitioner_id, title, category, rendered_md, placeholders_filled,
          status, token, token_expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending', $11, $12, $13)
       RETURNING id, token, token_expires_at, title, category, status, created_at`,
      [cid, customer_id, template_id, appointment_id || null, treatment_plan_id || null,
       practitioner_id || null, tpl[0].title, tpl[0].category, rendered,
       JSON.stringify(filled), token, expiresAt, req.user?.id || null]
    );

    const baseUrl = process.env.APP_URL || 'https://app.getaura.com.br';

    res.status(201).json({
      document: rows[0],
      token: rows[0].token,
      expires_at: rows[0].token_expires_at,
      expires_in: 600,
      qr_payload: `${baseUrl}/dental/consent/sign/${rows[0].token}`,
    });
  } catch (err) {
    console.error('[consent documents POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar documento' });
  }
});

// ──────────────────────────────────────────────────────────
// 6. DOCUMENTS — listar por paciente
// ──────────────────────────────────────────────────────────

router.get('/consent/documents', requireAuth, async (req, res) => {
  const { customer_id, status } = req.query;
  const cid = req.params.id;

  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id e obrigatorio' });
  }

  try {
    const params = [cid, customer_id];
    let where = 'WHERE company_id = $1 AND customer_id = $2';
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT id, template_id, appointment_id, title, category, status,
              created_at, signed_at, token_expires_at, signature_url
       FROM dental_consent_documents
       ${where}
       ORDER BY created_at DESC
       LIMIT 100`,
      params
    );

    res.json({ total: rows.length, documents: rows });
  } catch (err) {
    console.error('[consent documents GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar documentos' });
  }
});

// ──────────────────────────────────────────────────────────
// 7. DOCUMENTS — detalhe (com rendered_md)
// ──────────────────────────────────────────────────────────

router.get('/consent/documents/:docId', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const docId = req.params.docId;

  try {
    const { rows } = await db.query(
      `SELECT d.*,
              t.code AS template_code,
              c.name AS patient_name,
              p.name AS practitioner_name
       FROM dental_consent_documents d
       LEFT JOIN dental_consent_templates t ON t.id = d.template_id
       LEFT JOIN customers c ON c.id = d.customer_id
       LEFT JOIN dental_practitioners p ON p.id = d.practitioner_id
       WHERE d.id = $1 AND d.company_id = $2`,
      [docId, cid]
    );

    if (!rows.length) return res.status(404).json({ error: 'Documento nao encontrado' });
    res.json({ document: rows[0] });
  } catch (err) {
    console.error('[consent documents GET detail]', err.message);
    res.status(500).json({ error: 'Erro ao buscar documento' });
  }
});

// ──────────────────────────────────────────────────────────
// 8. DOCUMENTS — cancelar (void) antes de assinar
// ──────────────────────────────────────────────────────────

router.post('/consent/documents/:docId/void', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const cid = req.params.id;
  const docId = req.params.docId;

  try {
    const { rows } = await db.query(
      `UPDATE dental_consent_documents
       SET status = 'void'
       WHERE id = $1 AND company_id = $2 AND status = 'pending'
       RETURNING id, status`,
      [docId, cid]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Documento nao encontrado ou ja assinado' });
    }
    res.json({ document: rows[0] });
  } catch (err) {
    console.error('[consent documents void]', err.message);
    res.status(500).json({ error: 'Erro ao cancelar documento' });
  }
});

module.exports = router;
