// ============================================================
// AURA. — Marketplace Auth Routes (Core F1.B + F2.B)
//
// Endpoints autenticados pra orquestrar OAuth ML/Shopee.
// Mounted em /companies/:id/marketplaces/... via private.js.
//
// Endpoints publicos do callback:
//   GET /api/v1/marketplaces/:platform/callback?code=XXX&state=YYY
// Esses ficam em /api/v1/marketplaces (sem auth) montados em index.js.
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { getAdapter, SUPPORTED_PLATFORMS } = require('../marketplaces/registry');

// ─── GET /companies/:id/marketplaces/:platform/auth-url ───
// Devolve URL OAuth pro frontend abrir em popup/redirect.
router.get('/:platform/auth-url', async (req, res) => {
  const { platform } = req.params;
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform invalida. Use: ${SUPPORTED_PLATFORMS.join(', ')}` });
  }
  try {
    const adapter = getAdapter(platform);
    const { authUrl, state } = await adapter.getAuthUrl({ companyId: req.params.id });
    res.json({ auth_url: authUrl, state, platform });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error(`[marketplaces/${platform}/auth-url] ${err.message}`);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ─── POST /companies/:id/marketplaces/:platform/authorize ───
// Recebe `code` (do callback) e troca por access_token.
// Frontend chama isso depois que o popup OAuth voltar.
router.post('/:platform/authorize', async (req, res) => {
  const { platform } = req.params;
  const { code, shop_id } = req.body || {};
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform invalida. Use: ${SUPPORTED_PLATFORMS.join(', ')}` });
  }
  if (!code) {
    return res.status(400).json({ error: 'code obrigatorio (vem do callback OAuth)' });
  }
  try {
    const adapter = getAdapter(platform);
    const connection = await adapter.authorize({
      companyId: req.params.id,
      code,
      shopId: shop_id,  // Shopee
    });
    res.status(201).json({
      ok: true,
      platform,
      connection: {
        id: connection.id,
        store_id: connection.store_id,
        store_name: connection.store_name,
        status: connection.status,
        scope: connection.scope,
        token_expires: connection.token_expires,
      },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error(`[marketplaces/${platform}/authorize] ${err.message}`);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ─── POST /companies/:id/marketplaces/:platform/refresh ───
// Manual refresh — o adapter.ensureFreshToken faz auto, mas isso permite
// forçar.
router.post('/:platform/refresh', async (req, res) => {
  const { platform } = req.params;
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform invalida` });
  }
  try {
    const { rows } = await db.query(
      `SELECT * FROM marketplace_connections
        WHERE company_id = $1 AND platform = $2 AND status = 'ativo'
        ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, platform]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conexao ativa nao encontrada' });
    const adapter = getAdapter(platform);
    const refreshed = await adapter.refreshAuth(rows[0]);
    res.json({
      ok: true,
      token_expires: refreshed.token_expires,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── POST /companies/:id/marketplaces/:platform/revoke ───
router.post('/:platform/revoke', async (req, res) => {
  const { platform } = req.params;
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform invalida` });
  }
  try {
    const { rows } = await db.query(
      `SELECT * FROM marketplace_connections
        WHERE company_id = $1 AND platform = $2 AND status = 'ativo'
        ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, platform]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conexao ativa nao encontrada' });
    const adapter = getAdapter(platform);
    await adapter.revoke(rows[0]);
    res.json({ ok: true, message: 'Conexao revogada' });
  } catch (err) {
    console.error(`[marketplaces/${platform}/revoke] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
