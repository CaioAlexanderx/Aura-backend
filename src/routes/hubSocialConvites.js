// ============================================================
// AURA. — hubSocialConvites.js
// Conversa FECHADA do WhatsApp: convites prontos (modelos UTILITY aprovados)
// que gastam 1 aviso do mês. Montado dentro de hubSocial.js (herda
// requireAuth + company access).
//
//   GET  /hub/conversations/:convId/convites   convites, estado do modelo,
//                                              campos, saldo de avisos, wa.me
//   POST /hub/conversations/:convId/convites   { key, campos } manda e gasta 1 aviso
//   POST /hub/convites/preparar                cria na Meta os modelos que faltam
//                                              (só dono ou admin da loja)
// ============================================================
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const convites = require('../services/hubConvites');

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

function responderErro(res, e, rotulo) {
  if (e && e.code && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) });
  }
  if (e && e.meta) return res.status(502).json({ error: 'O WhatsApp recusou a mensagem. Tente de novo em instantes.', code: 'META_RECUSOU' });
  if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
  console.error('[HUB] convites %s error:', rotulo, e && e.message);
  return res.status(500).json({ error: 'Erro nos convites' });
}

router.get('/conversations/:convId/convites', async (req, res) => {
  try {
    res.json(await convites.listar({ companyId: req.params.id, conversationId: req.params.convId }));
  } catch (e) {
    responderErro(res, e, 'listar');
  }
});

router.post('/conversations/:convId/convites', async (req, res) => {
  const { key, campos } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key obrigatório' });
  try {
    const r = await convites.enviar({
      companyId: req.params.id, conversationId: req.params.convId,
      userId: req.user && req.user.id, key: String(key), campos: campos && typeof campos === 'object' ? campos : {},
    });
    res.json({ ok: true, outbox_id: r.outbox_id });
  } catch (e) {
    responderErro(res, e, 'enviar');
  }
});

// Pedir à Meta os 4 modelos de convite é decisão do dono ou do admin.
router.post('/convites/preparar', async (req, res) => {
  if (req.companyRole !== 'owner' && req.companyRole !== 'admin') {
    return res.status(403).json({ error: 'Só o dono ou um admin da loja pede os modelos ao WhatsApp', code: 'SO_DONO_OU_ADMIN' });
  }
  try {
    res.json(await convites.preparar({ companyId: req.params.id }));
  } catch (e) {
    responderErro(res, e, 'preparar');
  }
});

module.exports = router;
