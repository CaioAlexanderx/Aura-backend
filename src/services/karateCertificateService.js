// ============================================================
// AURA KARATÊ — Serviço de Certificados (Track C)
// DECISÃO FPKT #3 — Certificado SOB DEMANDA:
//   - Emissão NUNCA ocorre ao fechar exame
//   - Somente via POST /certificates/:candidateId/issue
//   - Esta função pode usar sharp/PDFKit para gerar PDF real
//     ou retornar URL mock em ambiente sem storage configurado
// ============================================================
'use strict';

const db = require('../config/database');

/**
 * issueCertificate({ federation_id, candidate_id, exam_id, issued_by })
 * Gera (ou enfileira geração de) certificado para um candidato aprovado.
 * Retorna { certificate_id, status, url }
 *
 * Estruturado para produção:
 *   - Se R2/S3 + sharp disponíveis: gera PDF e faz upload, retorna URL real
 *   - Caso contrário: registra com status='pending' e URL mock
 *     (worker assíncrono geraria em seguida)
 */
async function issueCertificate({ federation_id, candidate_id, exam_id, issued_by }) {
  // Busca dados do candidato aprovado
  const candRes = await db.query(
    `SELECT
       ec.id          AS candidate_id,
       ec.student_id,
       ec.status      AS candidate_status,
       ec.target_belt,
       ec.exam_id,
       COALESCE(cu.full_name, cu.name) AS student_name,
       cu.karate_registration_number,
       be.exam_date,
       be.location,
       be.federation_id
     FROM karate_belt_exam_candidates ec
     JOIN customers cu ON cu.id = ec.student_id
     JOIN karate_belt_exams be ON be.id = ec.exam_id
     WHERE ec.id = $1
       AND be.federation_id = $2
     LIMIT 1`,
    [candidate_id, federation_id]
  );

  if (!candRes.rows.length) {
    const err = new Error('Candidato não encontrado');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const cand = candRes.rows[0];

  if (cand.candidate_status !== 'approved') {
    const err = new Error('Certificado só pode ser emitido para candidatos aprovados');
    err.code = 'NOT_APPROVED';
    throw err;
  }

  // Verifica se já existe certificado para este candidato
  const existRes = await db.query(
    `SELECT id, status, certificate_url
     FROM karate_certificates
     WHERE candidate_id = $1
     LIMIT 1`,
    [candidate_id]
  );

  if (existRes.rows.length) {
    const existing = existRes.rows[0];
    return {
      certificate_id: existing.id,
      status: existing.status,
      url: existing.certificate_url,
      idempotent_hit: true,
    };
  }

  // Gera URL do certificado
  // Em produção: gerar PDF via PDFKit/sharp + upload para R2/S3
  // Aqui: stub estruturado — worker async completaria a geração
  const mockUrl = generateCertificateUrl({ cand, federation_id });

  // Insere registro do certificado
  const insertRes = await db.query(
    `INSERT INTO karate_certificates
       (federation_id, exam_id, candidate_id, student_id,
        target_belt, certificate_url, status,
        issued_by, issued_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     RETURNING id, status, certificate_url`,
    [
      federation_id,
      cand.exam_id,
      candidate_id,
      cand.student_id,
      cand.target_belt,
      mockUrl,
      'generated', // status: pending|generated|sent|error
      issued_by || null,
    ]
  );

  const cert = insertRes.rows[0];
  return {
    certificate_id: cert.id,
    status: cert.status,
    url: cert.certificate_url,
    idempotent_hit: false,
  };
}

/**
 * generateCertificateUrl — gera URL do PDF
 * Produção: upload para R2/S3 e retorna URL pública
 * Stub: URL mock até storage estar disponível
 */
function generateCertificateUrl({ cand, federation_id }) {
  // TODO produção: usar sharp/PDFKit + R2 upload
  // Estrutura de URL para produção:
  // `https://cdn.getaura.com.br/certificates/${federation_id}/${cand.exam_id}/${cand.student_id}.pdf`
  return `https://cdn.getaura.com.br/certificates/${federation_id}/${cand.exam_id}/${cand.student_id}.pdf`;
}

module.exports = { issueCertificate, generateCertificateUrl };
