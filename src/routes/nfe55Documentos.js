// ============================================================
// AURA. — Documentos da NF-e modelo 55 (venda e devolução)
// Mounted at: /companies/:id/nfe55   — 14/11/2026, CP3.
//
//   GET  /:emissaoId/danfe.pdf      DANFE A4 (autorizada; cancelada sai com a marca)
//   GET  /:emissaoId/xml            nfeProc (NFe + protNFe), só autorizada
//   POST /:emissaoId/enviar-email   { email? } — DANFE + XML a um cliente
//   GET  /:emissaoId/eventos        prazo de cancelamento e cartas (CP5)
//   POST /:emissaoId/cancelar       { justificativa } — evento 110111 (CP5)
//   POST /:emissaoId/carta-correcao { texto } — evento 110110 (CP5)
//   GET  /:emissaoId/carta-correcao/:seq/xml   procEventoNFe da carta (CP5)
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
const eventos55 = require('../services/nfe55Eventos');

function responderErro(res, err, rotulo) {
  if (err instanceof docs.DocErro) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
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

// ── CP5 (14/11/2026): cancelamento 110111 e carta de correção 110110 ──

router.get('/:emissaoId/eventos', requireAuth, async (req, res) => {
  try {
    const row = await docs.carregarNota(db, req.params.id, req.params.emissaoId);
    return res.json(eventos55.situacao(row));
  } catch (err) {
    return responderErro(res, err, 'consultar os eventos da nota');
  }
});

router.post('/:emissaoId/cancelar', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  try {
    const row = await docs.carregarNota(db, req.params.id, req.params.emissaoId);
    const r = await eventos55.cancelarNfe55(db, row, {
      justificativa: (req.body || {}).justificativa, userId: req.user && req.user.id,
    });
    if (!r.idempotente) {
      logAuditAction(req.user.id, req.params.id, 'nfe55_cancelada',
        `NF-e nº ${row.numero} cancelada na SEFAZ (evento ${r.evento.protocolo || r.evento.cStat})`, { emission_id: row.id });
    }
    const { xml_signed, ...nota } = r.nota; // eslint-disable-line no-unused-vars
    return res.json({ nfe: nota, evento: r.evento, cancelavel_ate: r.prazo.ate, ...(r.idempotente ? { idempotente: true } : {}) });
  } catch (err) {
    return responderErro(res, err, 'cancelar a nota');
  }
});

router.post('/:emissaoId/carta-correcao', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  try {
    const row = await docs.carregarNota(db, req.params.id, req.params.emissaoId);
    const r = await eventos55.cartaCorrecao(db, row, { texto: (req.body || {}).texto, userId: req.user && req.user.id });
    logAuditAction(req.user.id, req.params.id, 'nfe55_carta_correcao',
      `Carta de correção nº ${r.carta.seq} da NF-e nº ${row.numero}`, { emission_id: row.id });
    return res.status(201).json(r);
  } catch (err) {
    return responderErro(res, err, 'enviar a carta de correção');
  }
});

router.get('/:emissaoId/carta-correcao/:seq/xml', requireAuth, async (req, res) => {
  try {
    const row = await docs.carregarNota(db, req.params.id, req.params.emissaoId);
    const xml = eventos55.xmlDaCarta(row, req.params.seq);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${row.chave_acesso}-cce-${Number(req.params.seq)}.xml"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(xml);
  } catch (err) {
    return responderErro(res, err, 'baixar a carta de correção');
  }
});

module.exports = router;
