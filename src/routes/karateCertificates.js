// ============================================================
// AURA KARATÊ — Certificados de Graduação (Track C)
//
// DECISÃO FPKT #3 — Certificado SOB DEMANDA:
//   - Fechar o exame NÃO gera certificados
//   - Federação solicita emissão APÓS dojô enviar aprovação
//   - POST /certificates/:candidateId/issue  — emite certificado
//   - GET  /certificates/:candidateId        — consulta certificado
//
// Status do certificado: pending|generated|sent|error
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { issueCertificate } = require('../services/karateCertificateService');

// ── POST /certificates/:candidateId/issue ──────────────────
// Emite (ou enfileira emissão de) certificado para um candidato aprovado.
// FPKT #3: sob demanda, federação solicita após aprovação do dojô.
router.post('/certificates/:candidateId/issue', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, candidateId } = req.params;

  try {
    const result = await issueCertificate({
      federation_id: federationId,
      candidate_id: candidateId,
      issued_by: req.user?.id || null,
    });

    res.status(201).json({
      certificate_id: result.certificate_id,
      candidate_id: candidateId,
      status: result.status,
      url: result.url,
      idempotent_hit: result.idempotent_hit || false,
      _note: 'Certificado emitido sob demanda (FPKT #3). Não gerado automaticamente ao fechar exame.',
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
    }
    if (err.code === 'NOT_APPROVED') {
      return res.status(409).json({ error: err.message, code: 'NOT_APPROVED' });
    }
    console.error('[karateCertificates] issue error:', err.message);
    res.status(500).json({ error: 'Erro ao emitir certificado', detail: err.message });
  }
});

// ── GET /certificates/:candidateId ─────────────────────────
// Consulta certificado de um candidato aprovado.
router.get('/certificates/:candidateId', ...guards.read(), async (req, res) => {
  const { id: federationId, candidateId } = req.params;

  try {
    const certRes = await db.query(
      `SELECT
         kc.id, kc.federation_id, kc.exam_id, kc.candidate_id,
         kc.student_id, kc.target_belt, kc.certificate_url,
         kc.status, kc.issued_by, kc.issued_at, kc.created_at,
         cu.name AS student_name,
         cu.karate_registration_number,
         be.event_date
       FROM karate_certificates kc
       JOIN customers cu ON cu.id = kc.student_id
       JOIN karate_belt_exams be ON be.id = kc.exam_id
       WHERE kc.candidate_id = $1
         AND kc.federation_id = $2
       LIMIT 1`,
      [candidateId, federationId]
    );

    if (!certRes.rows.length) {
      return res.status(404).json({
        error: 'Certificado não encontrado. Use POST /certificates/:candidateId/issue para emitir.',
        code: 'NOT_FOUND',
      });
    }

    const cert = certRes.rows[0];
    res.json({
      id: cert.id,
      federation_id: cert.federation_id,
      exam_id: cert.exam_id,
      candidate_id: cert.candidate_id,
      student_id: cert.student_id,
      student_name: cert.student_name,
      karate_registration_number: cert.karate_registration_number || null,
      target_belt: cert.target_belt,
      event_date: cert.event_date,
      certificate_url: cert.certificate_url,
      status: cert.status,
      issued_by: cert.issued_by || null,
      issued_at: cert.issued_at,
      created_at: cert.created_at,
    });
  } catch (err) {
    console.error('[karateCertificates] get error:', err.message);
    res.status(500).json({ error: 'Erro ao consultar certificado' });
  }
});

module.exports = router;
