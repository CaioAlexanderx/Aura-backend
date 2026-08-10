// ============================================================
// AURA DOJÔ — F9.1: O CERTIFICADO PRÓPRIO DO DOJÔ
//
// Pedido do dono do produto (04/08/2026):
//   "Vamos deixar o certificado dentro de eventos, idêntico ao que temos
//    na federação. Dentro de eventos vamos fazer a emissão e impressão em
//    massa e também criar o design. Essa página então será apenas para
//    visualizar o status dos certificados que foram pedidos para a
//    federação. Processo: Dojô faz exame de kyu, emite certificado do
//    Dojô para os aprovados e solicita para a federação o certificado de
//    Kyu da federação, que é o oficial."
//
// DOIS CERTIFICADOS DISTINTOS PARA A MESMA GRADUAÇÃO:
//   • O DA FEDERAÇÃO — OFICIAL. Já existe (karateEventCertificates.js +
//     karate_certificate_templates/karate_issued_certificates, Fase 3) e
//     este PR NÃO toca nele. O pedido físico do certificado de kyu à
//     federação continua sendo karateCertificateService.createOrder
//     (Track J), acionado pelo próprio exame do dojô
//     (karateDojoBeltExamService.requestCertificates) — também intocado.
//   • O DO DOJÔ — NÃO OFICIAL. Este arquivo. O sensei desenha o próprio
//     modelo (mesmo editor da federação: layout A-E, logo, selo, título,
//     corpo, assinatura) e emite em massa para os aprovados de um exame
//     — documento interno do dojô, sem peso jurídico junto à FPKT.
//
// ── POR QUE TABELAS DEDICADAS (migration 271), NÃO
//    karate_certificate_templates COM dojo_id OPCIONAL ────────
// Misturar emissão oficial e não oficial na mesma tabela levaria a um
// WHERE federation_id IS NULL frágil como escopo, e os dois documentos
// têm peso jurídico diferente. Este arquivo espelha os MESMOS conceitos
// da federação (template + emitido, verify_token, snapshots) em tabelas
// PRÓPRIAS, escopadas por dojo_id — nunca por federation_id.
//
// ── ELEGÍVEL = APROVADO NO EXAME DE KYU DO DOJÔ ─────────────
// karate_dojo_belt_exams + karate_dojo_belt_exam_results (migrations
// 264/265, karateDojoBeltExamService.js — NÃO alterado por este PR).
// Emissão em massa a partir de um exame; antiduplicação por
// (exam_id, student_id) com revoked=false.
//
// ⚠️ ALUNO NÃO FEDERADO TAMBÉM RECEBE O CERTIFICADO DO DOJÔ — ancorado
// em karate_dojo_students (student_id), NUNCA em customers/
// practitioner_id. Mesmo motivo pelo qual o resultado do exame (264) foi
// ancorado no aluno do dojô. O certificado da federação (oficial)
// continua exigindo practitioner_id — essa regra não muda e não é deste
// arquivo.
//
// ── COMPATIBILIDADE COM buildCertificateHtml (aura-app) ─────
// O motor de renderização é agnóstico: recebe só {data, template} (ver
// components/karate/certificado/buildCertificateHtml.ts) e é REUSADO SEM
// ALTERAÇÃO. template_snapshot/data_snapshot gravados aqui têm o MESMO
// formato dos da federação (CertTemplate/CertData) — a diferença é que
// `federation_name` carrega o nome do DOJÔ (o campo é agnóstico ao
// emissor; é só o texto pequeno acima do título) e `signatories` vem do
// TEMPLATE do dojô (não de "instrutores do evento" — o exame do dojô não
// tem essa tabela; a assinatura faz parte do modelo, configurada uma vez
// pelo sensei).
//
// ── MONTADO sob /federation/:id (padrão de todo o módulo dojô) ──
// Guard: requireDojoAccess. GETs aceitam Canal A e B; toda ESCRITA exige
// Canal A (403 PORTAL_READ_ONLY) — mesma regra do resto do Aura Dojô.
//
//   GET    /federation/:id/dojo/certificate-templates
//   POST   /federation/:id/dojo/certificate-templates
//   PATCH  /federation/:id/dojo/certificate-templates/:templateId
//   DELETE /federation/:id/dojo/certificate-templates/:templateId
//   POST   /federation/:id/dojo/certificate-assets                          (selo/assinatura → R2)
//   POST   /federation/:id/dojo/graduation-exams/:examId/own-certificates   (emissão em massa)
//   GET    /federation/:id/dojo/graduation-exams/:examId/own-certificates   (emitidos DESTE exame)
//   GET    /federation/:id/dojo/own-certificates                           (status geral — todos os exames)
//
// ⚠️ PREFIXO "own-certificates" (não "certificates") DE PROPÓSITO — mesma
// razão de "own-events"/"graduation-exams": /dojo/cert-orders já existe
// (karateDojoFederativo.js) e significa o PEDIDO OFICIAL À FEDERAÇÃO.
// Reusar "certificates" colocaria os dois documentos, com peso jurídico
// diferente, sob o mesmo path.
//
// SEM gate de conexão: o certificado do dojô é ato INTERNO (o sensei
// emite para o próprio aluno, federado ou não) — mesma razão de
// graduation-exams/own-events. O que É federativo (o pedido oficial) já
// tem seu próprio gate em karateDojoFederativo.js/
// karateDojoBeltExamService.requestCertificates, intocados aqui.
//
// dojo_id e federation_id vêm SEMPRE do token (req.dojoId/req.federationId).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const crypto = require('crypto');
const db = require('../config/database');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const { uploadToR2 } = require('../utils/r2Storage');

const ALLOWED_LAYOUTS = ['A', 'B', 'C', 'D', 'E'];
const ALLOWED_FONTS = ['classica', 'imponente', 'elegante', 'sofisticada', 'tradicional'];
const ALLOWED_IMG = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAX_LIST_PAGE = 200;

// Canal B (portal) é SOMENTE LEITURA. Checado ANTES de qualquer db.query —
// mesma régua do resto do Aura Dojô (karateDojoEvents.js, karateDojoBeltExams.js).
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para gerenciar certificados.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

// ── Mapeamento de erro (mesma régua de karateDojoFederativo.js / karateDojoEvents.js) ──
function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    if (e.errors) body.errors = e.errors;
    return res.status(e.status).json(body);
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.error(`[karateDojoCertificates] ${ctx}: SCHEMA_PENDING (${e.code}):`, e.message);
    return res.status(503).json({
      error: 'Certificado do dojô indisponível no momento (migration 271 pendente)',
      code: 'SCHEMA_PENDING',
      pg_code: '42P01',
    });
  }
  if (e && e.code === '42703') {
    console.error(`[karateDojoCertificates] ${ctx}: 42703 — consulta cita coluna inexistente (SQL divergente do schema):`, e.message);
    return res.status(500).json({
      error: 'Falha ao gravar: uma consulta do servidor não bate com o schema do banco. Nada foi registrado.',
      code: 'SQL_SCHEMA_MISMATCH',
      pg_code: '42703',
      detail: e.message,
    });
  }
  console.error(`[karateDojoCertificates] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR', pg_code: (e && e.code) || null });
}

function handleReadError(res, e, ctx, extra) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.warn(`[karateDojoCertificates] ${ctx}: schema pendente (${e.code}):`, e.message);
    return res.json(Object.assign({ data: [], count: 0, schema_pending: true }, extra || {}));
  }
  if (e && e.code === '42703') {
    console.error(`[karateDojoCertificates] ${ctx}: 42703 — SQL divergente do schema:`, e.message);
    return res.json(Object.assign({ data: [], count: 0, schema_pending: true, pg_code: '42703' }, extra || {}));
  }
  console.error(`[karateDojoCertificates] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

function extractImageBuffer(body) {
  const b = body || {};
  if (b.image_base64 && typeof b.image_base64 === 'string') {
    const cleaned = b.image_base64.replace(/^data:[^;]+;base64,/, '');
    return { buffer: Buffer.from(cleaned, 'base64'), contentType: b.image_content_type || 'image/png' };
  }
  return null;
}

// ── Corpo do template — mesmas regras de tplBody (karateEventCertificates.js) + signatories ──
function tplBody(b) {
  const raw = b || {};
  return {
    name: (raw.name && String(raw.name).trim()) || 'Modelo',
    layout: ALLOWED_LAYOUTS.includes(raw.layout) ? raw.layout : 'A',
    title: (raw.title && String(raw.title).trim()) || 'CERTIFICADO',
    body_mode: raw.body_mode === 'custom' ? 'custom' : 'default',
    body_text: raw.body_text != null ? String(raw.body_text) : null,
    seals: Array.isArray(raw.seals) ? raw.seals.filter((s) => s && (s.label || s.image_url))
      .map((s) => ({ label: String(s.label || ''), image_url: s.image_url || null })) : [],
    signatories: Array.isArray(raw.signatories) ? raw.signatories.filter((s) => s && s.name)
      .map((s) => ({ name: String(s.name), role: s.role ? String(s.role) : null, signature_url: s.signature_url || null })) : [],
    font: ALLOWED_FONTS.includes(raw.font) ? raw.font : 'classica',
    text_scale: (typeof raw.text_scale === 'number' && raw.text_scale > 0) ? Math.max(0.8, Math.min(1.6, raw.text_scale)) : null,
    auto_fit: raw.auto_fit === true || raw.auto_fit === 'true',
    is_default: raw.is_default === true || raw.is_default === 'true',
    active: !(raw.active === false || raw.active === 'false'),
  };
}

function fmtBR(d) {
  try {
    const x = new Date(d);
    return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;
  } catch (_) { return ''; }
}

function actor(req) {
  return {
    id: (req.user && req.user.id) || null,
    name: (req.user && (req.user.name || req.user.email)) || null,
  };
}

// ============================================================
// Templates CRUD
// ============================================================
router.get('/dojo/certificate-templates', requireDojoAccess, async (req, res) => {
  try {
    const { rows } = await db.query(
      `-- f91:list-templates
       SELECT id, name, layout, title, body_mode, body_text, seals, signatories,
              font, text_scale, auto_fit, is_default, active, created_at
         FROM karate_dojo_certificate_templates
        WHERE dojo_id = $1
        ORDER BY is_default DESC, created_at DESC`,
      [req.dojoId]
    );
    res.json({ data: rows, count: rows.length });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/certificate-templates');
  }
});

router.post('/dojo/certificate-templates', requireDojoAccess, requireChannelA, async (req, res) => {
  const b = tplBody(req.body || {});
  try {
    const { rows } = await db.query(
      `-- f91:insert-template
       INSERT INTO karate_dojo_certificate_templates
         (dojo_id, name, layout, title, body_mode, body_text, seals, signatories, font, text_scale, auto_fit, is_default, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
       RETURNING id, name, layout, title, body_mode, body_text, seals, signatories, font, text_scale, auto_fit, is_default, active, created_at`,
      [req.dojoId, b.name, b.layout, b.title, b.body_mode, b.body_text, JSON.stringify(b.seals), JSON.stringify(b.signatories), b.font, b.text_scale, b.auto_fit, b.is_default, b.active]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/certificate-templates');
  }
});

router.patch('/dojo/certificate-templates/:templateId', requireDojoAccess, requireChannelA, async (req, res) => {
  const body = req.body || {};
  const b = tplBody(Object.assign({}, body, { name: body.name || 'x' }));
  const sets = []; const vals = []; let i = 1;
  const fields = {
    name: b.name, layout: b.layout, title: b.title, body_mode: b.body_mode,
    body_text: b.body_text, font: b.font, text_scale: b.text_scale,
    auto_fit: b.auto_fit, is_default: b.is_default, active: b.active,
  };
  for (const k of Object.keys(fields)) {
    if (body[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(fields[k]); }
  }
  if (body.seals !== undefined) { sets.push(`seals = $${i++}::jsonb`); vals.push(JSON.stringify(b.seals)); }
  if (body.signatories !== undefined) { sets.push(`signatories = $${i++}::jsonb`); vals.push(JSON.stringify(b.signatories)); }
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo', code: 'VALIDATION_ERROR' });
  sets.push('updated_at = NOW()');
  vals.push(req.params.templateId, req.dojoId);
  try {
    const { rows } = await db.query(
      `-- f91:update-template
       UPDATE karate_dojo_certificate_templates SET ${sets.join(', ')}
        WHERE id = $${i} AND dojo_id = $${i + 1}
        RETURNING id, name, layout, title, body_mode, body_text, seals, signatories, font, text_scale, auto_fit, is_default, active, created_at`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Modelo não encontrado', code: 'NOT_FOUND' });
    res.json(rows[0]);
  } catch (e) {
    return handleWriteError(res, e, 'PATCH /dojo/certificate-templates/:templateId');
  }
});

router.delete('/dojo/certificate-templates/:templateId', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `-- f91:delete-template
       DELETE FROM karate_dojo_certificate_templates WHERE id = $1 AND dojo_id = $2`,
      [req.params.templateId, req.dojoId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Modelo não encontrado', code: 'NOT_FOUND' });
    res.json({ ok: true });
  } catch (e) {
    return handleWriteError(res, e, 'DELETE /dojo/certificate-templates/:templateId');
  }
});

// ============================================================
// Upload de imagem (selo OU assinatura) → R2
// purpose: 'seal' (default) | 'signature' — só muda o namespace da key.
// ============================================================
router.post('/dojo/certificate-assets', requireDojoAccess, requireChannelA, async (req, res) => {
  const img = extractImageBuffer(req.body);
  if (!img) return res.status(422).json({ error: 'Imagem obrigatória (image_base64).', code: 'VALIDATION_ERROR' });
  if (!ALLOWED_IMG.includes(img.contentType)) {
    return res.status(422).json({ error: `Tipo não suportado: ${img.contentType}`, code: 'VALIDATION_ERROR' });
  }
  if (img.buffer.length / (1024 * 1024) > 5) {
    return res.status(413).json({ error: 'Imagem excede 5 MB', code: 'PAYLOAD_TOO_LARGE' });
  }
  try {
    const purpose = (req.body && req.body.purpose === 'signature') ? 'cert-signatures' : 'cert-seals';
    const ext = img.contentType === 'image/png' ? 'png' : img.contentType === 'image/webp' ? 'webp' : 'jpg';
    const key = `karate/dojo/${req.dojoId}/${purpose}/${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
    const r = await uploadToR2(key, img.buffer, img.contentType);
    if (!r || !r.success) return res.status(500).json({ error: 'Falha ao armazenar imagem', code: 'UPLOAD_FAILED' });
    res.status(201).json({ url: r.url });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/certificate-assets');
  }
});

// ============================================================
// Emissão em massa a partir de um exame do dojô (aprovados)
// POST /dojo/graduation-exams/:examId/own-certificates
// { template_id?, template?, dates_text?, issued_date_text?, location?, student_ids? }
// ============================================================
router.post('/dojo/graduation-exams/:examId/own-certificates', requireDojoAccess, requireChannelA, async (req, res) => {
  const dojoId = req.dojoId, examId = req.params.examId;
  try {
    const ex = await db.query(
      `-- f91:load-exam
       SELECT id, dojo_id, title, exam_date::text AS exam_date, examiner_name
         FROM karate_dojo_belt_exams
        WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
      [examId, dojoId]
    );
    if (!ex.rows.length) return res.status(404).json({ error: 'Exame não encontrado neste dojô', code: 'EXAME_NAO_ENCONTRADO' });
    const exam = ex.rows[0];

    const dj = await db.query(
      `-- f91:load-dojo
       SELECT COALESCE(trade_name, legal_name) AS dojo_name FROM companies WHERE id = $1 LIMIT 1`,
      [dojoId]
    );
    const dojoName = (dj.rows[0] && dj.rows[0].dojo_name) || 'Dojô';

    // Template: do banco (template_id) ou inline (req.body.template) ou default 'A'
    let template = null;
    if (req.body.template_id) {
      const t = await db.query(
        `-- f91:load-template
         SELECT layout, title, body_mode, body_text, seals, signatories, font, text_scale, auto_fit
           FROM karate_dojo_certificate_templates WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
        [req.body.template_id, dojoId]
      );
      template = t.rows[0] || null;
    }
    if (!template && req.body.template) template = tplBody(req.body.template);
    if (!template) template = { layout: 'A', title: 'CERTIFICADO', body_mode: 'default', body_text: null, seals: [], signatories: [] };

    // Assinaturas: do template; se vazio, cai para o examinador do exame.
    const signatories = (Array.isArray(template.signatories) && template.signatories.length)
      ? template.signatories
      : (exam.examiner_name ? [{ name: exam.examiner_name, role: 'Sensei / Examinador', signature_url: null }] : []);
    // Nome CRU do examinador — sem decorar prefixo. O sensei costuma
    // digitar "Sensei Fulano" no próprio campo (é assim que se identifica);
    // concatenar outro "Sensei " aqui duplicava o título no certificado
    // emitido ("Sensei Sensei Fulano"). `signatories` já seguia a
    // convenção certa (nome cru + role em campo separado) — alinhado aqui.
    const instructors_text = exam.examiner_name || '';

    const dates_text = req.body.dates_text || (exam.exam_date ? fmtBR(exam.exam_date) : '');
    const issued_date_text = req.body.issued_date_text || fmtBR(new Date());
    const location = req.body.location != null ? req.body.location : '';
    const tsnap = {
      layout: template.layout, title: template.title, body_mode: template.body_mode,
      body_text: template.body_text, seals: template.seals || [], font: template.font || 'classica',
      text_scale: template.text_scale != null ? template.text_scale : null, auto_fit: template.auto_fit === true,
    };

    // Elegíveis: APROVADOS no exame. student_id (não practitioner_id) — o
    // certificado do dojô é ancorado no aluno do dojô, federado ou não.
    const hasFilter = Array.isArray(req.body.student_ids) && req.body.student_ids.length > 0;
    const cand = await db.query(
      `-- f91:load-approved
       SELECT r.id AS result_id, r.student_id, r.to_belt_name, s.full_name AS student_name
         FROM karate_dojo_belt_exam_results r
         JOIN karate_dojo_students s ON s.id = r.student_id
        WHERE r.exam_id = $1 AND r.dojo_id = $2 AND r.result = 'approved'
          ${hasFilter ? 'AND r.student_id = ANY($3::uuid[])' : ''}`,
      hasFilter ? [examId, dojoId, req.body.student_ids] : [examId, dojoId]
    );

    const actorInfo = actor(req);
    let issued = 0, skipped = 0;
    const ids = [];
    for (const c of cand.rows) {
      const exists = await db.query(
        `-- f91:check-existing
         SELECT 1 FROM karate_dojo_issued_certificates
          WHERE exam_id = $1 AND student_id = $2 AND revoked = false LIMIT 1`,
        [examId, c.student_id]
      );
      if (exists.rows.length) { skipped++; continue; }

      const dsnap = {
        participant_name: c.student_name,
        course_name: `Exame de Graduação de Faixa — ${c.to_belt_name}`,
        hours: null,
        instructors_text,
        dates_text,
        location,
        issued_date_text,
        // Campo agnóstico ao engine (só texto acima do título) — aqui é o
        // nome de quem EMITE: o dojô, não a federação.
        federation_name: dojoName,
        signatories,
      };
      const token = crypto.randomBytes(16).toString('hex');
      const ins = await db.query(
        `-- f91:insert-issued
         INSERT INTO karate_dojo_issued_certificates
           (dojo_id, exam_id, student_id, result_id, verify_token, template_snapshot, data_snapshot, issued_by, issued_by_name)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
         RETURNING id`,
        [dojoId, examId, c.student_id, c.result_id, token, JSON.stringify(tsnap), JSON.stringify(dsnap), actorInfo.id, actorInfo.name]
      );
      ids.push(ins.rows[0].id);
      issued++;
    }
    res.status(201).json({ issued, skipped, eligible: cand.rows.length, ids });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/graduation-exams/:examId/own-certificates');
  }
});

// ── Lista de emitidos DE UM exame ───────────────────────────
router.get('/dojo/graduation-exams/:examId/own-certificates', requireDojoAccess, async (req, res) => {
  try {
    const { rows } = await db.query(
      `-- f91:list-by-exam
       SELECT id, student_id, verify_token, data_snapshot, template_snapshot, revoked, issued_at
         FROM karate_dojo_issued_certificates
        WHERE exam_id = $1 AND dojo_id = $2
        ORDER BY issued_at DESC`,
      [req.params.examId, req.dojoId]
    );
    res.json({ data: rows, count: rows.length });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/graduation-exams/:examId/own-certificates');
  }
});

// ── Status geral — todos os certificados do dojô emitidos ──
router.get('/dojo/own-certificates', requireDojoAccess, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), MAX_LIST_PAGE);
  try {
    const { rows } = await db.query(
      `-- f91:list-all
       SELECT id, exam_id, student_id, verify_token, data_snapshot, revoked, issued_at
         FROM karate_dojo_issued_certificates
        WHERE dojo_id = $1
        ORDER BY issued_at DESC
        LIMIT $2 OFFSET $3`,
      [req.dojoId, pageSize, (page - 1) * pageSize]
    );
    res.json({ data: rows, count: rows.length, page, pageSize });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/own-certificates');
  }
});

module.exports = router;
