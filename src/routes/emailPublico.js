// ============================================================
// AURA. — Rotas públicas dos e-mails (24/10/2026)
// Montado em /api/v1/emails (público, sem login).
//
// tq-74 — descadastro do relatório semanal por empresa:
//   GET  /descadastro/:token  página de confirmação (não desliga nada: leitor
//                             de link e antivírus abrem GET sozinhos)
//   POST /descadastro/:token  desliga. Serve ao botão da página e ao
//                             one-click do RFC 8058 (o aplicativo de e-mail
//                             manda "List-Unsubscribe=One-Click" no corpo)
//   O token (services/emailLinks) é assinado e diz a empresa e o tipo.
//
// tq-77 — QR do Pix nos e-mails de cobrança:
//   GET  /pix-qr/:token.png   desenha o QR do copia e cola que vai no token
// ============================================================
'use strict';

const express = require('express');
const QRCode = require('qrcode');
const router = express.Router();

const db = require('../config/database');
const { lerTokenDescadastro, lerTokenQr } = require('../services/emailLinks');
const { TIPOS, desligarTipoDeEmail } = require('../services/emailPreferencias');
const { contextoDaRequisicao } = require('../middleware/auditLog');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pagina(titulo, corpo) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(titulo)} · Aura</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: #f4f1fb; color: #1b1736; font: 16px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 480px; margin: 0 auto; padding: 48px 16px; }
  .card { background: #fff; border: 1px solid #e4def5; border-radius: 14px; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { margin: 0 0 14px; color: #51497f; }
  button { font: inherit; font-weight: 700; background: #6d28d9; color: #fff; border: 0; border-radius: 10px; padding: 12px 18px; cursor: pointer; }
  .marca { font-weight: 700; margin-bottom: 16px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0c0a16; color: #ece9ff; }
    .card { background: #15122a; border-color: #2b2650; }
    p { color: #b3add8; }
    button { background: #a78bfa; color: #14102b; }
  }
</style>
</head>
<body><main><div class="marca">Aura.</div><div class="card">${corpo}</div></main></body>
</html>`;
}

async function nomeDaEmpresa(companyId) {
  try {
    const { rows } = await db.query(
      'SELECT COALESCE(trade_name, legal_name) AS loja FROM companies WHERE id = $1',
      [companyId]
    );
    return (rows && rows[0] && rows[0].loja) || null;
  } catch (_) {
    return null;
  }
}

function invalido(res) {
  res.status(404).type('html').send(pagina('Link inválido',
    '<h1>Este link não vale mais</h1><p>Se quiser parar de receber algum e-mail da Aura, responda a ele que a gente desliga para você.</p>'));
}

router.get('/descadastro/:token', async (req, res) => {
  const t = lerTokenDescadastro(req.params.token);
  if (!t || !TIPOS[t.tipo]) return invalido(res);
  const loja = await nomeDaEmpresa(t.companyId);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(pagina('Parar de receber',
    `<h1>Parar de receber ${esc(TIPOS[t.tipo].rotulo)}?</h1>` +
    `<p>${loja ? `A ${esc(loja)} deixa` : 'A empresa deixa'} de receber ${esc(TIPOS[t.tipo].rotulo)} por e-mail. Dá para ligar de novo quando quiser, falando com a gente.</p>` +
    `<form method="post" action=""><button type="submit">Parar de receber</button></form>`));
});

router.post('/descadastro/:token', async (req, res) => {
  const t = lerTokenDescadastro(req.params.token);
  // One-click (RFC 8058): o aplicativo de e-mail não lê HTML; responde curto.
  const oneClick = req.body && String(req.body['List-Unsubscribe'] || '') === 'One-Click';
  if (!t || !TIPOS[t.tipo]) {
    if (oneClick) return res.status(404).type('text').send('Link inválido');
    return invalido(res);
  }
  try {
    await desligarTipoDeEmail(db, t.companyId, t.tipo, {
      grupo: t.grupo,
      origem: oneClick ? 'one_click' : 'link',
      contexto: contextoDaRequisicao(req),
    });
  } catch (err) {
    console.error('[emailPublico] descadastro falhou: ' + err.message);
    if (oneClick) return res.status(500).type('text').send('Erro');
    return res.status(500).type('html').send(pagina('Não deu certo',
      '<h1>Não consegui desligar agora</h1><p>Tente de novo em alguns minutos, ou responda ao e-mail que a gente desliga para você.</p>'));
  }
  res.set('Cache-Control', 'no-store');
  if (oneClick) return res.status(200).type('text').send('OK');
  res.type('html').send(pagina('Pronto',
    `<h1>Pronto</h1><p>Você não vai mais receber ${esc(TIPOS[t.tipo].rotulo)} por e-mail.</p>`));
});

router.get('/pix-qr/:token', async (req, res) => {
  const codigo = lerTokenQr(req.params.token);
  if (!codigo) return res.status(404).end();
  try {
    const png = await QRCode.toBuffer(codigo, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 300 });
    // O e-mail é aberto em outro domínio (webmail): a imagem precisa poder
    // ser carregada de fora (helmet põe same-origin por padrão).
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.type('png').send(png);
  } catch (err) {
    console.error('[emailPublico] QR falhou: ' + err.message);
    res.status(500).end();
  }
});

module.exports = router;
