'use strict';
// Fase 3 — certificados de evento (documento). Templates + selos (PNG) + emissão
// em lote + verificação pública. Montado sob /federation/:id.
const router = require('express').Router({ mergeParams: true });
const crypto = require('crypto');
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { uploadToR2 } = require('../utils/r2Storage');

const ALLOWED_LAYOUTS = ['A', 'B', 'C', 'D', 'E'];
const ALLOWED_IMG = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

function extractImageBuffer(req) {
  if (req.file && req.file.buffer) return { buffer: req.file.buffer, contentType: req.file.mimetype };
  const { image_base64, image_content_type } = req.body || {};
  if (image_base64 && typeof image_base64 === 'string') {
    const cleaned = image_base64.replace(/^data:[^;]+;base64,/, '');
    return { buffer: Buffer.from(cleaned, 'base64'), contentType: image_content_type || 'image/png' };
  }
  return null;
}
function tplBody(b) {
  return {
    name: (b.name && String(b.name).trim()) || 'Modelo',
    layout: ALLOWED_LAYOUTS.includes(b.layout) ? b.layout : 'A',
    title: (b.title && String(b.title).trim()) || 'CERTIFICADO',
    body_mode: b.body_mode === 'custom' ? 'custom' : 'default',
    body_text: b.body_text != null ? String(b.body_text) : null,
    seals: Array.isArray(b.seals) ? b.seals.filter(s => s && (s.label || s.image_url))
      .map(s => ({ label: String(s.label || ''), image_url: s.image_url || null })) : [],
    is_default: b.is_default === true || b.is_default === 'true',
    active: !(b.active === false || b.active === 'false'),
  };
}

// ── Templates CRUD ──────────────────────────────────────────
router.get('/certificate-templates', ...guards.read(), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, layout, title, body_mode, body_text, seals, is_default, active, created_at
       FROM karate_certificate_templates WHERE federation_id = $1 ORDER BY is_default DESC, created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    console.error('[certs] templates list', e.message); res.status(500).json({ error: 'Erro ao listar modelos' });
  }
});

router.post('/certificate-templates', ...guards.staffWrite(), async (req, res) => {
  const b = tplBody(req.body || {});
  try {
    const { rows } = await db.query(
      `INSERT INTO karate_certificate_templates
         (federation_id, name, layout, title, body_mode, body_text, seals, is_default, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       RETURNING id, name, layout, title, body_mode, body_text, seals, is_default, active, created_at`,
      [req.params.id, b.name, b.layout, b.title, b.body_mode, b.body_text, JSON.stringify(b.seals), b.is_default, b.active]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error('[certs] template create', e.message); res.status(500).json({ error: 'Erro ao criar modelo', detail: e.message }); }
});

router.patch('/certificate-templates/:templateId', ...guards.staffWrite(), async (req, res) => {
  const b = tplBody({ ...req.body, name: req.body.name ?? 'x' });
  const sets = [], vals = []; let i = 1;
  const fields = { name: b.name, layout: b.layout, title: b.title, body_mode: b.body_mode, body_text: b.body_text, is_default: b.is_default, active: b.active };
  for (const k of Object.keys(fields)) {
    if (req.body[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(fields[k]); }
  }
  if (req.body.seals !== undefined) { sets.push(`seals = $${i++}::jsonb`); vals.push(JSON.stringify(b.seals)); }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo' });
  sets.push('updated_at = NOW()');
  vals.push(req.params.templateId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE karate_certificate_templates SET ${sets.join(', ')}
       WHERE id = $${i} AND federation_id = $${i + 1}
       RETURNING id, name, layout, title, body_mode, body_text, seals, is_default, active, created_at`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Modelo não encontrado' });
    res.json(rows[0]);
  } catch (e) { console.error('[certs] template patch', e.message); res.status(500).json({ error: 'Erro ao atualizar modelo' }); }
});

router.delete('/certificate-templates/:templateId', ...guards.staffWrite(), async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM karate_certificate_templates WHERE id = $1 AND federation_id = $2`,
      [req.params.templateId, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Modelo não encontrado' });
    res.json({ ok: true });
  } catch (e) { console.error('[certs] template delete', e.message); res.status(500).json({ error: 'Erro ao remover modelo' }); }
});

// ── Upload de selo (PNG) → R2 ───────────────────────────────
router.post('/certificate-seals', ...guards.staffWrite(), async (req, res) => {
  const img = extractImageBuffer(req);
  if (!img) return res.status(422).json({ error: 'Imagem obrigatória (image_base64).', code: 'VALIDATION_ERROR' });
  if (!ALLOWED_IMG.includes(img.contentType)) return res.status(422).json({ error: `Tipo não suportado: ${img.contentType}` });
  if (img.buffer.length / (1024 * 1024) > 5) return res.status(413).json({ error: 'Imagem excede 5 MB' });
  try {
    const ext = img.contentType === 'image/png' ? 'png' : img.contentType === 'image/webp' ? 'webp' : 'jpg';
    const key = `karate/${req.params.id}/cert-seals/${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
    const r = await uploadToR2(key, img.buffer, img.contentType);
    if (!r || !r.success) return res.status(500).json({ error: 'Falha ao armazenar imagem' });
    res.status(201).json({ url: r.url });
  } catch (e) { console.error('[certs] seal upload', e.message); res.status(500).json({ error: 'Erro ao subir selo', detail: e.message }); }
});

// ── Helpers de emissão ──────────────────────────────────────
function joinNames(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1];
}

// ── Emissão em lote ─────────────────────────────────────────
// POST /belt-exams/:examId/certificates { template_id?, template?, dates_text?, issued_date_text?, location?, student_ids? }
router.post('/belt-exams/:examId/certificates', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id, examId = req.params.examId;
  try {
    const ev = await db.query(
      `SELECT be.id, be.name, be.exam_type, be.event_date, be.location, be.hours,
              COALESCE(c.trade_name, c.legal_name) AS federation_name
       FROM karate_belt_exams be JOIN companies c ON c.id = be.federation_id
       WHERE be.id = $1 AND be.federation_id = $2 LIMIT 1`, [examId, federationId]);
    if (!ev.rows.length) return res.status(404).json({ error: 'Evento não encontrado', code: 'NOT_FOUND' });
    const event = ev.rows[0];

    // Template: do banco (template_id) ou inline (req.body.template) ou default 'A'
    let template = null;
    if (req.body.template_id) {
      const t = await db.query(`SELECT layout,title,body_mode,body_text,seals FROM karate_certificate_templates WHERE id=$1 AND federation_id=$2 LIMIT 1`, [req.body.template_id, federationId]);
      template = t.rows[0] || null;
    }
    if (!template && req.body.template) template = tplBody(req.body.template);
    if (!template) template = { layout: 'A', title: 'CERTIFICADO', body_mode: 'default', body_text: null, seals: [] };

    // Ministrantes → assinaturas + texto
    const instr = await db.query(
      `SELECT name, role, signature_url FROM karate_event_instructors WHERE event_id = $1 ORDER BY sort_order ASC, created_at ASC`, [examId]);
    const signatories = instr.rows.map(r => ({ name: r.name, role: r.role || null, signature_url: r.signature_url || null }));
    const instructors_text = joinNames(instr.rows.map(r => (r.name ? (`Sensei ${r.name}`) : '')).filter(Boolean));

    // Elegíveis: curso → não ausente/rejeitado; exame → aprovado; OU certificate_eligible
    const isCurso = event.exam_type === 'curso';
    const cand = await db.query(
      `SELECT ec.student_id, cu.name AS student_name
       FROM karate_belt_exam_candidates ec JOIN customers cu ON cu.id = ec.student_id
       WHERE ec.exam_id = $1
         AND ( ec.certificate_eligible = true
            OR ($2 AND ec.status NOT IN ('absent','rejected'))
            OR (NOT $2 AND ec.status = 'approved') )
         ${Array.isArray(req.body.student_ids) && req.body.student_ids.length ? 'AND ec.student_id = ANY($3::uuid[])' : ''}`,
      Array.isArray(req.body.student_ids) && req.body.student_ids.length
        ? [examId, isCurso, req.body.student_ids] : [examId, isCurso]);

    const fmtBR = (d) => { try { const x = new Date(d); return `${String(x.getUTCDate()).padStart(2,'0')}/${String(x.getUTCMonth()+1).padStart(2,'0')}/${x.getUTCFullYear()}`; } catch { return ''; } };
    const dates_text = req.body.dates_text || (event.event_date ? fmtBR(event.event_date) : '');
    const issued_date_text = req.body.issued_date_text || fmtBR(new Date());
    const location = req.body.location != null ? req.body.location : (event.location || '');
    const tsnap = { layout: template.layout, title: template.title, body_mode: template.body_mode, body_text: template.body_text, seals: template.seals || [] };

    let issued = 0, skipped = 0;
    for (const c of cand.rows) {
      const exists = await db.query(`SELECT 1 FROM karate_issued_certificates WHERE event_id=$1 AND student_id=$2 AND revoked=false LIMIT 1`, [examId, c.student_id]);
      if (exists.rows.length) { skipped++; continue; }
      const dsnap = {
        participant_name: c.student_name, course_name: event.name || '', hours: event.hours ?? null,
        instructors_text, dates_text, location, issued_date_text,
        federation_name: event.federation_name || '', signatories,
      };
      const token = crypto.randomBytes(16).toString('hex');
      await db.query(
        `INSERT INTO karate_issued_certificates (federation_id, event_id, student_id, verify_token, template_snapshot, data_snapshot)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [federationId, examId, c.student_id, token, JSON.stringify(tsnap), JSON.stringify(dsnap)]);
      issued++;
    }
    res.status(201).json({ issued, skipped, eligible: cand.rows.length });
  } catch (e) { console.error('[certs] emit', e.message); res.status(500).json({ error: 'Erro ao emitir certificados', detail: e.message }); }
});

// ── Lista de emitidos do evento ─────────────────────────────
router.get('/belt-exams/:examId/certificates', ...guards.read(), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, student_id, verify_token, data_snapshot, template_snapshot, revoked, issued_at
       FROM karate_issued_certificates WHERE event_id=$1 AND federation_id=$2 ORDER BY issued_at DESC`,
      [req.params.examId, req.params.id]);
    res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    console.error('[certs] list', e.message); res.status(500).json({ error: 'Erro ao listar certificados' });
  }
});

module.exports = router;
