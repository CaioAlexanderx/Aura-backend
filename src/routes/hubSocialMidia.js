// ============================================================
// AURA. — hubSocialMidia.js
// Foto e áudio da conversa ABERTA do WhatsApp (grátis, mensagem de sessão).
// O app manda o arquivo em base64 dentro do JSON (o parser global é de 5 MB:
// o app reduz a foto antes). WebM/Opus do Chrome vira OGG/Opus aqui.
// Montado dentro de hubSocial.js (herda requireAuth + company access).
// ============================================================
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const midia = require('../services/hubWhatsappMidia');

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

// ── POST /hub/conversations/:convId/midia ────────────────────
// { kind: 'foto'|'audio', mime, data: <base64>, caption? }
router.post('/conversations/:convId/midia', async (req, res) => {
  const { kind, mime, data, caption } = req.body || {};
  if (kind !== 'foto' && kind !== 'audio') return res.status(400).json({ error: 'kind inválido (foto, audio)' });
  if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'data (base64) obrigatório' });
  // Aceita base64 puro ou data URL (o tipo pode trazer ";codecs=opus").
  const buffer = Buffer.from(data.replace(/^data:[^,]*;base64,/, ''), 'base64');
  try {
    const r = await midia.enviarMidia({
      companyId: req.params.id, conversationId: req.params.convId,
      userId: req.user && req.user.id, kind, buffer, mime, caption,
    });
    res.json({ ok: true, wamid: r.wamid });
  } catch (e) {
    if (e && e.code && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e && e.meta) {
      return res.status(502).json({ error: 'O WhatsApp recusou o arquivo. Tente de novo em instantes.', code: 'META_RECUSOU' });
    }
    if (isMissingSchema(e)) return res.status(409).json({ error: 'Hub ainda não disponível (migration pendente)' });
    console.error('[HUB] midia error:', e && e.message);
    res.status(500).json({ error: 'Erro ao enviar o arquivo' });
  }
});

module.exports = router;
