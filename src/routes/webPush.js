// ============================================================
// AURA. — Web Push: inscricao do navegador (10/09/2026)
//
// GET  /companies/:id/web-push/public-key    chave VAPID para o navegador inscrever
// POST /companies/:id/web-push/subscribe     { endpoint, keys: { p256dh, auth } }
// POST /companies/:id/web-push/unsubscribe   { endpoint }
// POST /companies/:id/web-push/test          aviso de teste para os navegadores
//                                            DESTE usuario nesta empresa
//
// Qualquer membro inscreve o PROPRIO navegador; nao ha gate de papel. Quem
// recebe o aviso de pedido e a empresa inteira (services/webPush.js).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const webPush = require('../services/webPush');

const SEM_TABELA = 'Aviso no computador ainda nao disponivel. Tente de novo em alguns minutos.';

router.get('/public-key', async (req, res) => {
  try {
    const chaves = await webPush.getVapidKeys();
    res.json({ public_key: chaves.publicKey });
  } catch (err) {
    if (err.code === '42P01') return res.status(503).json({ error: SEM_TABELA });
    console.error('[web-push] public-key:', err.message);
    res.status(500).json({ error: 'Erro ao preparar o aviso no computador' });
  }
});

router.post('/subscribe', async (req, res) => {
  const cid = req.params.id;
  const uid = (req.user && req.user.id) || null;
  const sub = webPush.validarInscricao(req.body);
  if (sub.erro) return res.status(400).json({ error: sub.erro });
  try {
    await db.query(
      `INSERT INTO web_push_subscriptions (company_id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint, company_id) DO UPDATE SET
         user_id    = EXCLUDED.user_id,
         p256dh     = EXCLUDED.p256dh,
         auth       = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         updated_at = NOW()`,
      [cid, uid, sub.endpoint, sub.p256dh, sub.auth, String(req.headers['user-agent'] || '').slice(0, 300) || null]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '42P01') return res.status(503).json({ error: SEM_TABELA });
    console.error('[web-push] subscribe:', err.message);
    res.status(500).json({ error: 'Erro ao ativar o aviso no computador' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  const cid = req.params.id;
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) return res.status(400).json({ error: 'endpoint obrigatorio' });
  try {
    await db.query('DELETE FROM web_push_subscriptions WHERE endpoint = $1 AND company_id = $2', [endpoint, cid]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '42P01') return res.json({ ok: true });
    console.error('[web-push] unsubscribe:', err.message);
    res.status(500).json({ error: 'Erro ao desativar o aviso no computador' });
  }
});

router.post('/test', async (req, res) => {
  const cid = req.params.id;
  const uid = (req.user && req.user.id) || null;
  try {
    const { rows } = await db.query(
      'SELECT id, endpoint, p256dh, auth FROM web_push_subscriptions WHERE company_id = $1 AND user_id = $2',
      [cid, uid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Este navegador ainda nao esta com o aviso ativado.' });
    const resumo = await webPush.enviarParaInscricoes(rows, {
      title: 'Aviso de pedidos ativado',
      body: 'É assim que um pedido novo vai aparecer aqui.',
      url: '/canal?tab=pedidos',
      tag: 'aura-teste',
      type: 'teste',
    });
    res.json(resumo);
  } catch (err) {
    if (err.code === '42P01') return res.status(503).json({ error: SEM_TABELA });
    console.error('[web-push] test:', err.message);
    res.status(500).json({ error: 'Erro ao enviar o aviso de teste' });
  }
});

module.exports = router;
