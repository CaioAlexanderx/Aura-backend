// ============================================================
// AURA. — Retorno do OAuth do Mercado Pago (público, sem auth)
//
// GET /api/v1/mp/oauth/callback?code=...&state=...      (autorizou)
// GET /api/v1/mp/oauth/callback?error=access_denied&state=...  (não autorizou)
//
// Esta é a URL de retorno cadastrada na aplicação da Aura no Mercado Pago.
// O navegador da lojista chega aqui vindo da tela do Mercado Pago; não há
// token da Aura nesta requisição, então quem diz a empresa é o `state`
// assinado (services/mpOAuth.js). Trocamos o code, gravamos cifrado e
// mandamos o navegador de volta para o app com o resultado:
//   <APP_URL><caminho>?mp=conectado|negado|erro&empresa=<company_id>
// O motivo técnico de um erro fica só no log, nunca na URL.
// ============================================================
'use strict';

const router    = require('express').Router();
const db        = require('../config/database');
const mpOAuth   = require('../services/mpOAuth');
const mpGateway = require('../services/mpGateway');

const CAMINHO_PADRAO = '/canal?tab=site';

function appUrl() {
  return String(process.env.APP_URL || 'https://app.getaura.com.br').replace(/\/+$/, '');
}

function voltar(res, { returnPath, resultado, companyId }) {
  const caminho = mpOAuth.caminhoSeguro(returnPath) || CAMINHO_PADRAO;
  const sep = caminho.includes('?') ? '&' : '?';
  const qs = new URLSearchParams({ mp: resultado });
  if (companyId) qs.set('empresa', companyId);
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, `${appUrl()}${caminho}${sep}${qs.toString()}`);
}

/** Quem começou a conexão ainda é dono da empresa (ou equipe Aura)? */
async function podeConectar(companyId, userId) {
  if (!userId) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM companies c
      WHERE c.id = $1
        AND (c.owner_id = $2 OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'admin'))
      LIMIT 1`,
    [companyId, userId]
  );
  return rows.length > 0;
}

router.get('/callback', async (req, res) => {
  if (!mpOAuth.oauthDisponivel()) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).send('<!doctype html><meta charset="utf-8"><title>Aura</title>'
      + '<p style="font-family:system-ui;padding:32px">A conexão com o Mercado Pago ainda não está disponível. '
      + `<a href="${appUrl()}${CAMINHO_PADRAO}">Voltar para a Aura</a></p>`);
  }

  const { code, state, error } = req.query;

  let st;
  try {
    st = mpOAuth.verifyState(String(state || ''));
  } catch (e) {
    console.warn('[mpOAuth] retorno com state recusado:', e.code || e.message);
    return voltar(res, { resultado: 'erro' });
  }
  const base = { returnPath: st.returnPath, companyId: st.companyId };

  if (error) {
    // access_denied = ela tocou em cancelar na tela do Mercado Pago. Não grava nada.
    return voltar(res, { ...base, resultado: 'negado' });
  }
  if (!code || typeof code !== 'string' || code.length > 512) {
    return voltar(res, { ...base, resultado: 'erro' });
  }

  try {
    if (!(await podeConectar(st.companyId, st.userId))) {
      console.warn(`[mpOAuth] retorno de quem não é dono (company=${st.companyId})`);
      return voltar(res, { ...base, resultado: 'erro' });
    }

    const tokens = await mpOAuth.exchangeCode({ code, sandbox: st.sandbox });
    if (!tokens.user_id) throw new Error('resposta sem user_id');

    // "Conectado como": nickname logo após a autorização. Se falhar, segue
    // conectada e o app mostra "sua conta do Mercado Pago".
    let nickname = null;
    try {
      const me = await mpOAuth.getUserMe({ accessToken: tokens.access_token });
      if (me.ok) nickname = me.nickname;
    } catch (_) { /* não bloqueia */ }

    await mpGateway.salvarConexaoOAuth(db, {
      companyId: st.companyId,
      userId: st.userId,
      tokens,
      nickname,
      sandbox: st.sandbox,
    });
    console.log(`[mpOAuth] conectado (company=${st.companyId}, mp_user=${tokens.user_id}, sandbox=${st.sandbox})`);
    return voltar(res, { ...base, resultado: 'conectado' });
  } catch (e) {
    console.error(`[mpOAuth] retorno falhou (company=${st.companyId}):`, e.message);
    return voltar(res, { ...base, resultado: 'erro' });
  }
});

module.exports = router;
