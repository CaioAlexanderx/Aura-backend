// ============================================================
// AURA. — Aviso interno de chamado de suporte (24/10/2026)
//
// POST /support/tickets e a resposta do cliente em
// POST /support/tickets/:tid/messages só gravavam no banco: o chamado ficava
// aberto sem ninguém saber (2 chamados sem resposta). A cada chamado novo e a
// cada mensagem nova do cliente, este módulo avisa a equipe por dois canais:
//
//   (a) e-mail interno para CS_NOTIFY_EMAIL (padrão contato@getaura.com.br,
//       o mesmo destino do aviso de conta self-service), com loja, quem
//       abriu, assunto, a mensagem e o link do chamado;
//   (b) aviso no sino da empresa Aura (AURA_ALERTA_COMPANY_ID, padrão a mesma
//       empresa de alert_company_id do lembrete de fatura), com dedupe por
//       chamado + mensagem.
//
// REGRA: o aviso NUNCA derruba a criação do chamado nem a mensagem. Nada
// aqui lança: toda falha vai só ao log. Cada canal é independente (o e-mail
// falhar não impede o sino e vice-versa).
//
// Idempotência: a chave do e-mail (enviarEmailRegistrado) e a do sino
// (dedupe_key) são as mesmas por mensagem — uma segunda chamada para a mesma
// mensagem não manda nada.
// ============================================================
'use strict';

const L = require('./emailLayout');

const CS_EMAIL_PADRAO = 'contato@getaura.com.br';
// Mesma empresa de invoice_reminders.alert_company_id (reguaDeCobranca.js).
const ALERTA_COMPANY_ID_PADRAO = '645c1325-8865-48be-af6f-430d93fb2b6c';

const MAX_MENSAGEM_EMAIL = 3000;
const MAX_MENSAGEM_SINO = 220;

function cortar(texto, n) {
  const t = String(texto == null ? '' : texto).trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function destinoInterno(env = process.env) {
  return String(env.CS_NOTIFY_EMAIL || CS_EMAIL_PADRAO).trim() || CS_EMAIL_PADRAO;
}

function empresaDoSino(env = process.env) {
  return String(env.AURA_ALERTA_COMPANY_ID || ALERTA_COMPANY_ID_PADRAO).trim() || ALERTA_COMPANY_ID_PADRAO;
}

/**
 * Link do chamado na Gestão Aura. A Central de Comando abre pelo staff; o
 * parâmetro ?chamado= leva o id para a tela de solicitações (SolicitacoesAdmin,
 * GET /admin/tickets/:id).
 */
function linkDoChamado(ticketId, env = process.env) {
  const base = String(env.APP_URL || 'https://app.getaura.com.br').replace(/\/+$/, '');
  return `${base}/gestao-aura?chamado=${encodeURIComponent(String(ticketId))}`;
}

function chaveDaMensagem(ticketId, mensagemId) {
  return `chamado:${ticketId}:${mensagemId || 'abertura'}`;
}

async function carregarContexto(db, { companyId, userId }) {
  let loja = null;
  let quem = null;
  let email = null;
  try {
    const r = await db.query(
      `SELECT COALESCE(c.trade_name, c.legal_name) AS loja, u.full_name AS quem, u.email AS email
         FROM companies c
         LEFT JOIN users u ON u.id = $2
        WHERE c.id = $1`,
      [companyId, userId]
    );
    const row = r && r.rows && r.rows[0];
    if (row) { loja = row.loja || null; quem = row.quem || null; email = row.email || null; }
  } catch (err) {
    console.error(`[avisoDeChamado] contexto indisponível: ${err.message}`);
  }
  return { loja: loja || 'Loja sem nome', quem: quem || email || 'Cliente', email };
}

function montarEmailInterno({ ticket, mensagem, ctx, novo, link }) {
  const assunto = String(ticket.subject || 'Sem assunto');
  const texto = cortar(mensagem, MAX_MENSAGEM_EMAIL);
  const corpo =
    L.p(novo ? 'Chegou um chamado novo de suporte.' : 'O cliente respondeu num chamado de suporte.') +
    L.tabela([
      ['Loja', ctx.loja],
      ['Quem abriu', ctx.email && ctx.email !== ctx.quem ? `${ctx.quem} (${ctx.email})` : ctx.quem],
      ['Assunto', assunto],
      ['Categoria', ticket.category || null],
      ['Prioridade', ticket.priority && ticket.priority !== 'normal' ? ticket.priority : null],
    ]) +
    L.caixa(`<p class="a-ink" style="margin:0;color:${L.COR.tinta};font-size:14px;line-height:1.6;">${L.esc(texto).replace(/\r?\n/g, '<br>')}</p>`);

  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto: `${novo ? 'Chamado novo' : 'Nova mensagem'}: ${assunto}`,
    previa: `${ctx.loja}: ${cortar(mensagem, 90)}`,
    corpo,
    botao: { rotulo: 'Abrir o chamado', url: link },
    whatsapp: false,
    assinatura: false,
  });

  const subject = `${novo ? 'Chamado novo' : 'Nova mensagem no chamado'}: ${cortar(assunto, 120)} — ${ctx.loja}`;
  const text = [
    novo ? 'Chamado novo de suporte' : 'Nova mensagem do cliente num chamado',
    `Loja: ${ctx.loja}`,
    `Quem abriu: ${ctx.quem}${ctx.email && ctx.email !== ctx.quem ? ` (${ctx.email})` : ''}`,
    `Assunto: ${assunto}`,
    '',
    texto,
    '',
    `Abrir o chamado: ${link}`,
  ].join('\n');
  return { subject, html, text };
}

/**
 * Avisa a equipe de um chamado novo (`novo: true`) ou de uma mensagem nova do
 * cliente num chamado existente. Nunca lança.
 *
 * @param {object} p
 * @param {object} p.ticket        linha de support_tickets (id, subject, category, priority, company_id)
 * @param {string} p.mensagem      texto que o cliente enviou
 * @param {string} [p.mensagemId]  id da linha de support_messages (chave de idempotência)
 * @param {string} p.userId        quem escreveu
 * @param {boolean} p.novo         chamado novo ou mensagem nova
 * @param {object} [p.deps]        { db, notifications, enviar, env } — injetável para teste
 * @returns {Promise<{email: string, sino: string}>} resultado de cada canal (para log e teste)
 */
async function avisarChamado({ ticket, mensagem, mensagemId = null, userId, novo, deps = {} }) {
  const resultado = { email: 'nao_enviado', sino: 'nao_enviado' };
  try {
    const env = deps.env || process.env;
    const db = deps.db || require('../config/database');
    const notifications = deps.notifications || require('./appNotifications');
    const enviarEmailRegistrado = deps.enviarEmailRegistrado || require('./emailLog').enviarEmailRegistrado;

    const companyId = ticket.company_id;
    const ctx = await carregarContexto(db, { companyId, userId });
    const link = linkDoChamado(ticket.id, env);
    const chave = chaveDaMensagem(ticket.id, mensagemId);

    // (a) e-mail interno
    try {
      const mail = montarEmailInterno({ ticket, mensagem, ctx, novo, link });
      const replyTo = ctx.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ctx.email) ? ctx.email : undefined;
      const r = await enviarEmailRegistrado({
        db,
        enviar: deps.enviar,
        chave,
        tipo: novo ? 'chamado_novo_interno' : 'chamado_mensagem_interno',
        companyId,
        userId,
        to: destinoInterno(env),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo,
      });
      resultado.email = r.status;
      if (r.status === 'failed' || r.status === 'sem_registro') {
        console.error(`[avisoDeChamado] e-mail não saiu (${r.status}): chamado=${ticket.id} ${r.error || ''}`);
      }
    } catch (err) {
      resultado.email = 'erro';
      console.error(`[avisoDeChamado] e-mail falhou: chamado=${ticket.id}: ${err.message}`);
    }

    // (b) sino da empresa Aura
    try {
      const assunto = String(ticket.subject || 'Sem assunto');
      const banner = await notifications.notifyCompany(empresaDoSino(env), {
        title: novo ? `Chamado novo: ${ctx.loja}` : `Nova mensagem no chamado: ${ctx.loja}`,
        body: `${ctx.quem} — ${cortar(assunto, 120)}\n${cortar(mensagem, MAX_MENSAGEM_SINO)}`,
        ctaLabel: 'Abrir o chamado',
        ctaUrl: link,
        dedupeKey: chave,
      });
      // notifyCompany devolve null em falha de escrita E em chave repetida.
      resultado.sino = banner ? 'criado' : 'nao_criado';
    } catch (err) {
      resultado.sino = 'erro';
      console.error(`[avisoDeChamado] sino falhou: chamado=${ticket.id}: ${err.message}`);
    }
  } catch (err) {
    console.error(`[avisoDeChamado] aviso falhou: ${err && err.message}`);
  }
  return resultado;
}

module.exports = {
  avisarChamado,
  linkDoChamado,
  chaveDaMensagem,
  destinoInterno,
  empresaDoSino,
  montarEmailInterno,
  CS_EMAIL_PADRAO,
  ALERTA_COMPANY_ID_PADRAO,
};
