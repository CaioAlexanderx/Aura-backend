// ============================================================
// AURA. — Documentos da NF-e modelo 55 (venda e devolução)
// Mounted at: /companies/:id/nfe55   — 14/11/2026, CP3.
//
//   GET  /:emissaoId/danfe.pdf      DANFE A4 (autorizada; cancelada sai com a marca)
//   GET  /:emissaoId/xml            nfeProc (NFe + protNFe), só autorizada
//   POST /:emissaoId/enviar-email   { email? } — DANFE + XML a um cliente
//
// :emissaoId = nfce_emissions.id (tipo 'nfe'), da própria loja.
// Regras e textos em services/nfe55Documentos.js.
// ============================================================
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');
const docs = require('../services/nfe55Documentos');

function responderErro(res, err, rotulo) {
  if (err instanceof docs.DocErro) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`[nfe55Documentos] ${rotulo}:`, err && err.message);
  return res.status(500).json({ error: `Erro ao ${rotulo}` });
}

router.get('/:emissaoId/danfe.pdf', requireAuth, async (req, res) => {
  try {
    const row = await docs.carregarNota(db, req.params.id, req.params.emissaoId);
    const pdf = await docs.danfePdf(row);
    const chave = String(row.chave_acesso || row.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${chave}-danfe.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(pdf);
  } catch (err) {
    return responderErro(res, err, 'gerar o DANFE');
  }
});

router.get('/:emissaoId/xml', requireAuth, async (req, res) => {
  try {
    const row = await docs.carregarNota(db, req.params.id, req.params.emissaoId);
    const proc = docs.nfeProcXml(row);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${proc.chave}-nfe.xml"`);
    res.setHeader('Cache-Control', 'private, no-store');
    // 'reconstruido' = nota autorizada antes do CP3, protNFe remontado (ver sefazSp/nfeProc.js)
    res.setHeader('X-Aura-ProtNFe', proc.protOrigem);
    return res.send(proc.xml);
  } catch (err) {
    return responderErro(res, err, 'baixar o XML');
  }
});

router.post('/:emissaoId/enviar-email', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  try {
    const row = await docs.carregarNota(db, req.params.id, req.params.emissaoId);
    const envio = await docs.enviarPorEmail(db, row, {
      email: (req.body || {}).email,
      userId: req.user && req.user.id,
      sendMail: require('../services/mailer').sendMail,
    });
    logAuditAction(req.user.id, req.params.id, 'nfe55_email_enviado',
      `NF-e nº ${row.numero} enviada por e-mail ao cliente`, { emission_id: row.id });
    return res.json({ enviado: true, para: envio.para, enviado_em: envio.enviado_em });
  } catch (err) {
    return responderErro(res, err, 'enviar a nota por e-mail');
  }
});

module.exports = router;
