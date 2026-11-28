// ============================================================
// AURA. — "Mandar o link para o meu e-mail" (conexão do WhatsApp no celular)
//
// A janela do Facebook não abre no celular. A lojista pede o link e abre
// no computador. O e-mail vai SÓ para o e-mail de quem está logado (nunca
// um endereço vindo do corpo do pedido) e no máximo uma vez por hora por
// pessoa (chave de idempotência do e-mail_log).
// ============================================================
'use strict';

const db = require('../../config/database');
const L = require('../emailLayout');
const { enviarEmailRegistrado } = require('../emailLog');

function montar(link) {
  const corpo =
    L.p('Para ligar o WhatsApp da loja na Aura, abra este link no computador.') +
    L.p('O celular fica com o WhatsApp aberto para confirmar um aviso no meio do caminho. Leva uns 3 minutos.');
  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto: 'Ligue o WhatsApp da loja pelo computador',
    previa: 'Abra no computador para ligar o WhatsApp da loja na Aura.',
    corpo,
    botao: { rotulo: 'Ligar o WhatsApp da loja', url: link },
    whatsapp: false,
  });
  const text = [
    'Para ligar o WhatsApp da loja na Aura, abra este link no computador:',
    link,
    '',
    'O celular fica com o WhatsApp aberto para confirmar um aviso no meio do caminho. Leva uns 3 minutos.',
  ].join('\n');
  return { subject: 'Ligue o WhatsApp da loja pelo computador', html, text };
}

async function enviar(companyId, userId, deps = {}) {
  const dbx = deps.db || db;
  const { rows } = await dbx.query('SELECT email FROM users WHERE id = $1 LIMIT 1', [userId]);
  const to = rows[0] && rows[0].email;
  if (!to) return { enviado: false };
  const base = process.env.APP_URL || L.APP_URL_PADRAO;
  const link = `${String(base).replace(/\/+$/, '')}/whatsapp`;
  const { subject, html, text } = montar(link);
  const hora = new Date().toISOString().slice(0, 13);
  const r = await (deps.enviarRegistrado || enviarEmailRegistrado)({
    db: dbx, chave: `wa-conexao-link:${companyId}:${userId}:${hora}`,
    tipo: 'wa_conexao_link', companyId, userId, to, subject, html, text,
  });
  return { enviado: r.status === 'sent' || r.status === 'duplicate' };
}

module.exports = { enviar, montar };
