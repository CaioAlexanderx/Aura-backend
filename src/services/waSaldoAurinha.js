// ============================================================
// AURA — SALDO DA AURINHA (tela nova, 26/11/2026)
//
// Cada CONVERSA nova que a Aurinha atende gasta 1 do saldo `aurinha`
// (80 por mes no Negocio e no Essencial com add-on; 50 de boas-vindas no
// Essencial sem add-on; pacote de 300 por R$ 29).
//
// "Conversa" = a conversa do hub (hub_conversations.id) dentro de uma
// janela de 24 h: as respostas seguintes na mesma conversa, ate 24 h
// depois da primeira que foi cobrada, nao gastam de novo. Passou 24 h e o
// cliente volta a falar: e uma conversa nova e gasta mais 1.
//
// Esgotou: a Aurinha NAO responde. A mensagem do cliente ja esta gravada
// na caixa (o webhook grava antes de chamar a Aurinha) e a conversa vai
// para a lojista (status precisa_humano). Nada de resposta automatica,
// nada de excedente.
//
// Se a Aurinha nao chegou a responder (modelo fora do ar, nada a dizer),
// `devolver` estorna: so paga conversa que foi atendida de verdade.
// ============================================================
'use strict';

const db = require('../config/database');
const waSaldo = require('./waSaldo');

const JANELA_HORAS = 24;

const MOTIVO_SEM_SALDO = 'Saldo da Aurinha esgotado: a conversa ficou com voce.';

function recusa(code, extra = {}) { return { ok: false, code, ...extra }; }

// Reserva a conversa. Nunca lanca. Devolve:
//   { ok:true, modo:'desligado' | isento:true }      sem trava / Aura
//   { ok:true, jaContada:true }                      mesma conversa, < 24 h
//   { ok:true, reservou:true, refKey, fonte, restante } gastou 1
//   { ok:false, code:'SALDO_ESGOTADO'|'SALDO_INDISPONIVEL' }  NAO responder
async function atender({ companyId, conversationId, agora = new Date() } = {}) {
  if (!companyId || !conversationId) return recusa('SALDO_INDISPONIVEL', { motivo: 'PARAMETROS' });
  if (!waSaldo.ativo()) return { ok: true, modo: 'desligado' };
  if (waSaldo.isento(companyId)) return { ok: true, isento: true };

  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wa_saldo:${companyId}:aurinha`]);

    const ja = await client.query(
      `-- wa:saldo-aurinha-janela
       SELECT 1 FROM wa_saldo_lancamentos l
        WHERE l.company_id = $1 AND l.bucket = 'aurinha' AND l.kind = 'consumo'
          AND l.conversa_id = $2
          AND l.created_at > $3::timestamptz - ($4 || ' hours')::interval
          AND NOT EXISTS (SELECT 1 FROM wa_saldo_lancamentos e
                           WHERE e.company_id = l.company_id AND e.ref_key = 'estorno:' || l.ref_key)
        LIMIT 1`,
      [companyId, conversationId, agora.toISOString(), String(JANELA_HORAS)]
    );
    if (ja.rows.length) { await client.query('COMMIT'); return { ok: true, jaContada: true }; }

    const refKey = `aurinha:${conversationId}:${agora.getTime()}`;
    const r = await waSaldo.reservar(client, {
      companyId, bucket: 'aurinha', refKey, conversaId: conversationId, agora,
    });
    if (!r.ok) { await client.query('ROLLBACK'); return r; }
    await client.query('COMMIT');
    return { ...r, reservou: true, refKey };
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ja caiu */ } }
    console.error('[waSaldoAurinha] atender falhou (nao responde):', e.code || '', e.message);
    return recusa('SALDO_INDISPONIVEL', { motivo: e.code || 'ERRO' });
  } finally {
    if (client) client.release();
  }
}

// A Aurinha nao respondeu: estorna a conversa cobrada. No-op sem `reservou`.
async function devolver(companyId, cobranca) {
  if (!cobranca || !cobranca.reservou || !cobranca.refKey) return { devolvido: false };
  return waSaldo.devolver({ companyId, refKey: cobranca.refKey });
}

// Sem saldo: a conversa fica com a lojista. Falha aqui nunca derruba o fluxo.
async function passarParaLojista(conversationId) {
  try {
    await db.query(
      `-- wa:saldo-aurinha-handoff
       UPDATE hub_conversations
          SET status = 'precisa_humano', handoff_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'ia'`,
      [conversationId, MOTIVO_SEM_SALDO]
    );
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') {
      console.error('[waSaldoAurinha] handoff falhou:', e.code || '', e.message);
    }
  }
}

module.exports = { JANELA_HORAS, MOTIVO_SEM_SALDO, atender, devolver, passarParaLojista };
