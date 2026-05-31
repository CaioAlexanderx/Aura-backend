// ============================================================
// AURA. — Marketplace Auth Callback (publico, sem auth)
//
// GET /api/v1/marketplaces/:platform/callback?code=XXX&state=YYY[&shop_id=ZZZ]
//
// Recebe redirect do OAuth ML/Shopee depois que o lojista autorizou.
// Decodifica `state` (que tem companyId), faz autoryze via adapter,
// e renderiza HTML simples que avisa o frontend (via postMessage no popup
// ou redirect) que terminou.
//
// Frontend abre POPUP pra essa URL, escuta postMessage do popup, e ao
// receber sucesso/erro fecha o popup + recarrega lista de conexoes.
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router();
const { getAdapter, SUPPORTED_PLATFORMS } = require('../marketplaces/registry');

router.get('/:platform/callback', async (req, res) => {
  const { platform } = req.params;
  const { code, state, shop_id, error } = req.query;

  function renderHtml({ ok, message, payload }) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Aura — ${platform}</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; padding: 40px; text-align: center; background: #FAFAFC; }
.card { max-width: 480px; margin: 40px auto; padding: 32px; background: #fff; border-radius: 14px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
h1 { font-size: 22px; margin: 0 0 12px; color: #1E3A8A; }
.ok { color: #065F46; }
.err { color: #991B1B; }
button { margin-top: 20px; padding: 10px 24px; border-radius: 8px; border: 0; background: #1E3A8A; color: #fff; font-weight: 700; cursor: pointer; }
</style></head><body>
<div class="card">
<h1 class="${ok ? 'ok' : 'err'}">${ok ? '✓ Conexao autorizada' : '✗ Erro na conexao'}</h1>
<p>${message}</p>
<button onclick="window.close()">Fechar essa janela</button>
</div>
<script>
try {
  if (window.opener) {
    window.opener.postMessage(${JSON.stringify({
      type: 'aura-marketplace-callback',
      platform,
      ok,
      message,
      payload: payload || null,
    })}, '*');
  }
} catch(e) {}
</script>
</body></html>`;
  }

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return res.status(400).send(renderHtml({ ok: false, message: `platform invalida: ${platform}` }));
  }
  if (error) {
    return res.status(400).send(renderHtml({ ok: false, message: `OAuth recusado: ${error}` }));
  }
  if (!code) {
    return res.status(400).send(renderHtml({ ok: false, message: 'code ausente na callback URL' }));
  }
  if (!state) {
    return res.status(400).send(renderHtml({ ok: false, message: 'state ausente — possivel CSRF' }));
  }

  // Decodifica state pra recuperar companyId
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch (e) {
    return res.status(400).send(renderHtml({ ok: false, message: 'state invalido' }));
  }
  const companyId = stateData?.companyId;
  if (!companyId) {
    return res.status(400).send(renderHtml({ ok: false, message: 'companyId nao encontrado no state' }));
  }

  // Verifica que o state nao expirou (10 min)
  if (stateData.ts && (Date.now() - stateData.ts) > 10 * 60 * 1000) {
    return res.status(400).send(renderHtml({ ok: false, message: 'state expirado (>10min). Reabra a tela de conectar.' }));
  }

  try {
    const adapter = getAdapter(platform);
    const connection = await adapter.authorize({ companyId, code, shopId: shop_id });
    return res.send(renderHtml({
      ok: true,
      message: `Conta ${platform} vinculada a empresa. Voce pode fechar essa janela.`,
      payload: {
        connection_id: connection.id,
        store_id: connection.store_id,
        store_name: connection.store_name,
      },
    }));
  } catch (e) {
    console.error(`[marketplaces/${platform}/callback]`, e.message);
    return res.status(500).send(renderHtml({ ok: false, message: e.message }));
  }
});

module.exports = router;
