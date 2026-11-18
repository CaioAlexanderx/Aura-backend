// ============================================================
// AURA. — E-mail que volta (devolução, "bounce") — 18/11/2026
//
// O webhook do Resend (services/resendWebhook.js) grava a devolução na
// email_log: bounced_at e metadata.bounce.type ('Permanent', 'Transient' ou
// 'Undetermined'). Até aqui ninguém lia esse campo. Este módulo é o ponto
// único de leitura:
//
//   1. enderecosDevolvidos / filtrarDestinatarios: endereço com devolução
//      PERMANENTE não recebe mais os e-mails de TIPOS_QUE_RESPEITAM
//      (verificação, relatório, fechamento do mês, ajuda, acompanhamento e
//      novidades). O resto segue: segurança da conta (redefinição de senha),
//      cobrança e recibo, convite de equipe, pedido da loja online, avisos
//      internos. Quem aplica é o sendMail (services/mailer.js) e o
//      enviarEmailRegistrado (services/emailLog.js).
//      A devolução deixa de valer se um e-mail para o mesmo endereço foi
//      ENTREGUE depois dela (delivered_at mais novo): a caixa voltou a
//      existir.
//      Só conta linha de UM destinatário: na linha com vários não se sabe
//      qual voltou. Falha de leitura nunca segura e-mail (deixa sair).
//
//   2. devolucaoDaVerificacao: o último e-mail de confirmação que SAIU para o
//      endereço (status 'sent') voltou? Vai no /auth/me para a tela de
//      confirmação mostrar o aviso: { tipo: 'permanente'|'temporaria', em }.
//
//   3. alertasDeVerificacaoDevolvida: alerta do Painel da Gestão para o
//      cadastro dos últimos 7 dias cujo último e-mail de confirmação voltou
//      e que não confirmou. Leva ao WhatsApp da loja.
//
// Sem migration: a email_log tem poucas centenas de linhas (18/11/2026).
// ============================================================
'use strict';

const TIPOS_QUE_RESPEITAM = Object.freeze([
  'verificacao_email',
  'relatorio_semanal',
  'fechamento_mes',
]);
// Relacionamento (ajuda_*, acompanhamento_*) e novidades (Black Friday:
// novidades_bf_2026_email1...).
const PREFIXOS_QUE_RESPEITAM = Object.freeze(['ajuda_', 'acompanhamento_', 'novidades']);

// Seguem para o endereço devolvido (para o relatório e para quem audita).
const TIPOS_DE_SEGURANCA = Object.freeze(['redefinicao_senha']);

const ERRO_SUPRIMIDO = 'suprimido: endereço com devolução permanente';

/** Este tipo de e-mail deixa de ir para endereço com devolução permanente? */
function respeitaDevolucao(tipo) {
  const t = String(tipo || '');
  if (!t) return false;
  if (TIPOS_QUE_RESPEITAM.includes(t)) return true;
  return PREFIXOS_QUE_RESPEITAM.some((p) => t.startsWith(p));
}

function normalizar(e) {
  const s = String(e == null ? '' : e).trim().toLowerCase();
  // "Nome <x@y>" vira x@y.
  const m = s.match(/<([^<>\s]+)>\s*$/);
  return m ? m[1] : s;
}

function listaDe(to) {
  return (Array.isArray(to) ? to : [to]).map(normalizar).filter((e) => e.includes('@'));
}

/**
 * Endereços (minúsculos) com devolução permanente que ainda vale.
 * @returns {Promise<Set<string>>}
 */
async function enderecosDevolvidos(db, emails) {
  const lista = Array.from(new Set(listaDe(emails)));
  if (!lista.length) return new Set();
  try {
    const { rows } = await db.query(
      `-- email:devolvidos
       SELECT b.email
         FROM (SELECT lower(destinatario) AS email, MAX(bounced_at) AS devolvido_em
                 FROM email_log
                WHERE lower(destinatario) = ANY($1::text[])
                  AND bounced_at IS NOT NULL
                  AND metadata->'bounce'->>'type' = 'Permanent'
                GROUP BY 1) b
        WHERE NOT EXISTS (SELECT 1 FROM email_log d
                           WHERE lower(d.destinatario) = b.email
                             AND d.delivered_at > b.devolvido_em)`,
      [lista]
    );
    return new Set(((rows || [])).map((r) => String(r.email)));
  } catch (err) {
    if (!err || err.code !== '42P01') console.error(`[emailDevolvido] leitura falhou (deixa sair): ${err && err.message}`);
    return new Set();
  }
}

/**
 * Tira do `to` os endereços com devolução permanente. Devolve o `to` no
 * mesmo formato (string ou lista) e os que saíram.
 */
async function filtrarDestinatarios(db, to) {
  const devolvidos = await enderecosDevolvidos(db, to);
  if (!devolvidos.size) return { to, suprimidos: [] };
  const lista = Array.isArray(to) ? to : [to];
  const ficam = lista.filter((e) => !devolvidos.has(normalizar(e)));
  const suprimidos = lista.filter((e) => devolvidos.has(normalizar(e)));
  return { to: Array.isArray(to) ? ficam : (ficam[0] || null), suprimidos, vazio: !ficam.length };
}

/**
 * O último e-mail de confirmação que saiu para este endereço voltou?
 * @returns {Promise<null|{tipo:'permanente'|'temporaria', em:string}>}
 */
async function devolucaoDaVerificacao(db, email) {
  const e = normalizar(email);
  if (!e.includes('@')) return null;
  try {
    const r = await db.query(
      `-- email:verificacao_devolvida
       SELECT bounced_at, metadata->'bounce'->>'type' AS tipo_bounce
         FROM email_log
        WHERE tipo = 'verificacao_email' AND status = 'sent' AND lower(destinatario) = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [e]
    );
    const row = r && r.rows && r.rows[0];
    if (!row || !row.bounced_at) return null;
    return {
      tipo: row.tipo_bounce === 'Permanent' ? 'permanente' : 'temporaria',
      em: new Date(row.bounced_at).toISOString(),
    };
  } catch (err) {
    if (!err || err.code !== '42P01') console.error(`[emailDevolvido] verificação falhou: ${err && err.message}`);
    return null;
  }
}

/**
 * Alertas `verificacao_devolvida` do Painel da Gestão: cadastro dos últimos
 * `dias` dias, dono sem e-mail confirmado, último e-mail de confirmação que
 * saiu para ele voltou. Fora conta interna, de teste e dojô. Textos
 * aprovados pelo Caio (18/11/2026).
 */
async function alertasDeVerificacaoDevolvida({ db, hoje, dias = 7 } = {}) {
  const b = require('./painelBlocos/_base');
  const { semDojo } = require('../utils/empresasDaGestao');
  const { linkDoWhatsapp } = require('./whatsappDaLoja');
  const rows = await b.opcional(
    db,
    `-- painel:verificacao_devolvida
     SELECT c.id AS company_id, COALESCE(c.name, c.trade_name, c.legal_name) AS nome,
            COALESCE(NULLIF(u.phone, ''), c.phone) AS telefone, c.created_at
       FROM companies c
       JOIN users u ON u.id = c.owner_id
       JOIN LATERAL (
         SELECT l.bounced_at FROM email_log l
          WHERE l.tipo = 'verificacao_email' AND l.status = 'sent'
            AND lower(l.destinatario) = lower(u.email)
          ORDER BY l.created_at DESC LIMIT 1
       ) ult ON ult.bounced_at IS NOT NULL
      WHERE c.created_at >= ${b.desde(dias)}
        AND u.email_verified IS NOT TRUE
        AND u.is_staff IS NOT TRUE
        AND c.is_sandbox IS NOT TRUE
        AND COALESCE(c.email, '') NOT ILIKE '%@getaura.com.br'
        AND COALESCE(u.email, '') NOT ILIKE '%@getaura.com.br'
        AND ${semDojo('c')}
      ORDER BY c.created_at DESC`,
    [hoje]
  );
  return (rows || []).map((r) => ({
    tipo: 'verificacao_devolvida',
    chave: String(r.company_id),
    company_id: r.company_id,
    titulo: `${r.nome || 'Loja'}: e-mail de confirmação voltou`,
    detalhe: `Cadastro de ${b.rotuloDia(b.diaDe(r.created_at))} · não confirmou · falar no WhatsApp`,
    verbo: 'Falar',
    bloco: 'cadastros',
    link: linkDoWhatsapp(r.telefone) || null,
  }));
}

module.exports = {
  TIPOS_QUE_RESPEITAM,
  PREFIXOS_QUE_RESPEITAM,
  TIPOS_DE_SEGURANCA,
  ERRO_SUPRIMIDO,
  respeitaDevolucao,
  enderecosDevolvidos,
  filtrarDestinatarios,
  devolucaoDaVerificacao,
  alertasDeVerificacaoDevolvida,
};
