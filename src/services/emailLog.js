// ============================================================
// AURA. — Registro de envios de e-mail (tq-74, migration 407)
//
// Uma linha por e-mail em email_log. Dois caminhos:
//
//   1. enviarEmailRegistrado(): e-mails novos do ciclo (cobrança, recibo,
//      cartão...). A chave de idempotência é RESERVADA ANTES do envio
//      (INSERT ... ON CONFLICT DO NOTHING RETURNING): reenvio do webhook da
//      Asaas, dois ticks do job ou duas instâncias nunca mandam o mesmo
//      e-mail duas vezes. Depois do envio a linha vira 'sent' (com o id do
//      Resend) ou 'failed' (com o erro). Uma linha 'failed' pode ser tentada
//      de novo (até MAX_TENTATIVAS); 'sent' e 'reserved' nunca.
//      Sem a tabela (migration 407 ainda não aplicada) o e-mail NÃO sai: a
//      idempotência é a regra de segurança desses envios.
//
//   2. registrarEnvio(): todo outro sendMail (verificação, senha, convite,
//      pedido, relatório...) grava uma linha sem chave, depois do envio. É
//      ligado no boot (ligarRegistroNoMailer, src/server.js) e nunca derruba
//      o envio: falha de gravação só vai ao log.
//
// Colunas delivered_at/bounced_at/complained_at ficam para o webhook do
// Resend (tq-90), que atualiza pela resend_id.
// ============================================================
'use strict';

const MAX_TENTATIVAS = 3;

function dbPadrao() {
  return require('../config/database');
}

function cortar(s, n) {
  if (s == null) return null;
  const t = String(s);
  return t.length > n ? t.slice(0, n) : t;
}

function destinatarioTexto(to) {
  if (Array.isArray(to)) return cortar(to.join(', '), 500);
  return cortar(to, 500);
}

/**
 * Reserva a chave. Devolve o id da linha (pode enviar) ou null (já foi
 * enviado, está sendo enviado agora, ou esgotou as tentativas).
 */
async function reservarEnvio(db, { chave, tipo, companyId = null, userId = null, destinatario = null, assunto = null, metadata = null }) {
  if (!chave) throw new Error('reservarEnvio: chave obrigatória');
  const { rows } = await db.query(
    `INSERT INTO email_log
       (chave_idempotencia, tipo, company_id, user_id, destinatario, assunto, status, tentativas, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'reserved', 1, COALESCE($7::jsonb, '{}'::jsonb))
     ON CONFLICT (chave_idempotencia) DO UPDATE
        SET status = 'reserved',
            tentativas = email_log.tentativas + 1,
            erro = NULL,
            destinatario = EXCLUDED.destinatario,
            assunto = EXCLUDED.assunto,
            updated_at = NOW()
      WHERE email_log.status = 'failed'
        AND email_log.tentativas < $8
     RETURNING id`,
    [cortar(chave, 300), cortar(tipo, 80), companyId, userId, destinatarioTexto(destinatario),
      cortar(assunto, 300), metadata ? JSON.stringify(metadata) : null, MAX_TENTATIVAS]
  );
  return (rows && rows[0] && rows[0].id) || null;
}

async function marcarEnviado(db, id, resendId) {
  await db.query(
    `UPDATE email_log SET status = 'sent', resend_id = $2, sent_at = NOW(), erro = NULL, updated_at = NOW()
      WHERE id = $1`,
    [id, cortar(resendId, 200)]
  );
}

async function marcarFalha(db, id, erro) {
  await db.query(
    `UPDATE email_log SET status = 'failed', erro = $2, updated_at = NOW() WHERE id = $1`,
    [id, cortar(erro, 1000)]
  );
}

/**
 * Envia um e-mail com idempotência.
 *
 * @returns {Promise<{status:'sent'|'duplicate'|'failed'|'sem_registro', id?, resendId?, error?}>}
 */
async function enviarEmailRegistrado({
  db = dbPadrao(), enviar, chave, tipo, companyId = null, userId = null, metadata = null,
  to, subject, html, text, from, replyTo, headers,
}) {
  const sendMail = enviar || require('./mailer').sendMail;
  let id;
  try {
    id = await reservarEnvio(db, { chave, tipo, companyId, userId, destinatario: to, assunto: subject, metadata });
  } catch (err) {
    // 42P01: email_log ainda não existe. Sem registro não há idempotência:
    // não envia (o próximo tick, depois da migration, envia).
    console.error(`[emailLog] reserva falhou (${tipo}): ${err.message}`);
    return { status: 'sem_registro', error: err.message };
  }
  if (!id) return { status: 'duplicate' };

  try {
    const r = await sendMail({ to, subject, html, text, from, replyTo, headers, _registrado: true });
    const resendId = (r && r.id) || null;
    await marcarEnviado(db, id, resendId).catch((e) => console.error(`[emailLog] marcar enviado falhou: ${e.message}`));
    return { status: 'sent', id, resendId };
  } catch (err) {
    await marcarFalha(db, id, err.message).catch((e) => console.error(`[emailLog] marcar falha falhou: ${e.message}`));
    console.error(`[emailLog] envio falhou (${tipo}, log ${id}): ${err.message}`);
    return { status: 'failed', id, error: err.message };
  }
}

/**
 * Registro de um envio que não passou por enviarEmailRegistrado (sem chave).
 * Nunca lança.
 */
async function registrarEnvio({ db = null, tipo = 'outro', companyId = null, userId = null, to, subject, status, resendId = null, erro = null }) {
  try {
    const conn = db || dbPadrao();
    await conn.query(
      `INSERT INTO email_log (tipo, company_id, user_id, destinatario, assunto, status, resend_id, erro, tentativas, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, CASE WHEN $6 = 'sent' THEN NOW() END)`,
      [cortar(tipo, 80), companyId, userId, destinatarioTexto(to), cortar(subject, 300),
        status === 'sent' ? 'sent' : 'failed', cortar(resendId, 200), cortar(erro, 1000)]
    );
  } catch (err) {
    if (err && err.code !== '42P01') console.error(`[emailLog] registro falhou: ${err.message}`);
  }
}

/** Liga o registro de todo sendMail (chamado uma vez no boot). */
function ligarRegistroNoMailer() {
  const mailer = require('./mailer');
  if (typeof mailer.definirRegistroDeEnvio === 'function') {
    mailer.definirRegistroDeEnvio((info) => registrarEnvio(info));
  }
}

module.exports = {
  MAX_TENTATIVAS,
  reservarEnvio,
  marcarEnviado,
  marcarFalha,
  enviarEmailRegistrado,
  registrarEnvio,
  ligarRegistroNoMailer,
};
