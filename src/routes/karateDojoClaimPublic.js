// ============================================================
// AURA KARATÊ — F0 Aura Dojô: claim público da conta do dojô
//
// Montado em /public/karate/dojo-claim (SEM auth de empresa — o sensei
// ainda não tem conta; o segredo é o token do e-mail de convite):
//   POST /public/karate/dojo-claim/verify    {token}
//        → { ok, dojoName, federationName, email (mascarado) }
//   POST /public/karate/dojo-claim/complete  {token, name, password}
//        → 200 (SEM auto-login neste PR — o sensei loga normal depois)
//
// Anti-enumeração (modelo U2 de karateDojoPortalAuthService): token
// desconhecido → 404 genérico; nunca vaza existência de e-mail/convite.
// Sem rate-limit próprio: o repo não tem middleware pronto (pendência
// anotada no PR) — o custo de brute-force é 32 bytes aleatórios.
// ============================================================
'use strict';

const router = require('express').Router();
const claimService = require('../services/karateDojoClaimService');

// POST /public/karate/dojo-claim/verify {token}
router.post('/verify', async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) return res.status(400).json({ error: 'token é obrigatório' });
  try {
    const result = await claimService.verifyToken(token);
    if (!result.ok) {
      return res.status(result.http).json({ error: result.error, code: result.code });
    }
    return res.json({
      ok: true,
      dojoName: result.dojoName,
      federationName: result.federationName,
      email: result.email, // mascarado — nunca o e-mail em claro
    });
  } catch (e) {
    if (e.code === '42P01') {
      // Migration 240 pendente: resposta genérica (não vaza estado interno)
      return res.status(404).json({ error: 'Convite inválido ou expirado' });
    }
    console.error('[karateDojoClaimPublic] verify error:', e);
    return res.status(500).json({ error: 'Erro ao validar convite' });
  }
});

// POST /public/karate/dojo-claim/complete {token, name, password}
router.post('/complete', async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  const name = String((req.body && req.body.name) || '').trim();
  const password = req.body && req.body.password;
  if (!token) return res.status(400).json({ error: 'token é obrigatório' });
  if (!name) return res.status(400).json({ error: 'Informe seu nome' });
  // Mesma regra de senha de auth.js/register
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  }
  try {
    const result = await claimService.completeClaim({ token, name, password });
    if (!result.ok) {
      return res.status(result.http).json({ error: result.error, code: result.code });
    }
    // SEM auto-login neste PR (decisão F0): o sensei loga normal em seguida.
    return res.json({ ok: true, message: 'Conta ativada. Faça login com seu e-mail e a senha definida.' });
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(404).json({ error: 'Convite inválido ou expirado' });
    }
    console.error('[karateDojoClaimPublic] complete error:', e);
    return res.status(500).json({ error: 'Erro ao concluir o cadastro' });
  }
});

module.exports = router;
