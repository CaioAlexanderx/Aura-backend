// ============================================================
// AURA — Crediário: botão "Quero o Pix" (26/11/2026)
//
// Os avisos de parcela (cred_antes, cred_dia, cred_atraso) saem com um
// botão de resposta rápida "Quero o Pix". Quando o cliente toca, chega no
// webhook uma mensagem `type: "button"` (ou `interactive.button_reply`) e a
// conversa já está ABERTA (o toque é mensagem do cliente): a Aura responde
// na hora, como mensagem de sessão (grátis, sem gastar saldo), com o valor
// e o Pix copia e cola daquela parcela. Sem Aurinha: é resposta fixa.
//
// Como achamos a parcela, nesta ordem:
//   1) payload do botão `QUERO_PIX:<id da parcela>`;
//   2) `context.id` (wamid do aviso) -> wa_outbox -> dedupe_key
//      `credaviso-<parcela>-...` (automática nova) ou `cred-<parcela>-...`
//      (régua antiga) ou source_id (parcela, na régua antiga).
// Nunca inventa chave nem valor: o Pix vem do mesmo BR Code estático do
// carnê e do aviso manual (collectionNotice.composeNotice). Loja sem Pix
// recebe a resposta "fale com a loja" e o motivo fica na fila como
// source_type 'pix_sessao_sem_pix'.
// ============================================================
'use strict';

const db = require('../../config/database');
const waOutbox = require('../waOutbox');
const collectionNotice = require('./collectionNotice');

const PAYLOAD_PREFIXO = 'QUERO_PIX';
const TEXTO_BOTAO = 'quero o pix';
const VALIDADE_DIAS = 30;
const SOURCE_RESPOSTA = 'pix_sessao';
const SOURCE_SEM_PIX = 'pix_sessao_sem_pix';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const DEDUPE_RE = new RegExp(`^(?:credaviso|cred)-(${UUID})-`, 'i');

function normalizar(t) {
  return String(t || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Extrai { payload, text } do toque. null = não é botão.
function lerToque(msg) {
  if (!msg) return null;
  if (msg.type === 'button' && msg.button) return { payload: msg.button.payload || '', text: msg.button.text || '' };
  if (msg.type === 'interactive' && msg.interactive && msg.interactive.button_reply) {
    const b = msg.interactive.button_reply;
    return { payload: b.id || '', text: b.title || '' };
  }
  return null;
}

// É um toque no NOSSO botão? (payload nosso, ou o rótulo "Quero o Pix").
function ehQueroPix(toque) {
  if (!toque) return false;
  return String(toque.payload || '').startsWith(PAYLOAD_PREFIXO) || normalizar(toque.text) === TEXTO_BOTAO
    || normalizar(toque.payload) === TEXTO_BOTAO;
}

function parcelaDoPayload(payload) {
  const m = String(payload || '').match(new RegExp(`^${PAYLOAD_PREFIXO}:(${UUID})$`, 'i'));
  return m ? m[1] : null;
}

async function avisoDoContexto(companyId, wamid) {
  if (!wamid) return null;
  try {
    const { rows } = await db.query(
      `-- cred:quero-pix-aviso
       SELECT id, to_phone, source_type, source_id, dedupe_key, created_at
         FROM wa_outbox WHERE company_id = $1 AND wa_message_id = $2 LIMIT 1`,
      [companyId, wamid]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

function parcelaDoAviso(aviso) {
  if (!aviso) return null;
  const d = String(aviso.dedupe_key || '').match(DEDUPE_RE);
  if (d) return d[1];
  if (aviso.source_type === 'crediario' && UUID_RE.test(String(aviso.source_id || ''))) return aviso.source_id;
  return null;
}

function reais(n) {
  const [i, d] = Math.abs(Number(n)).toFixed(2).split('.');
  return `R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`;
}

async function responder(companyId, msg, texto, { sourceType = SOURCE_RESPOSTA, sourceId = null, sufixo = 'a' } = {}) {
  return waOutbox.enqueue({
    companyId, toPhone: msg.from, kind: 'text', textBody: texto,
    sourceType, sourceId, dedupeKey: `quero-pix-${msg.id}-${sufixo}`,
  });
}

/**
 * Trata o toque. Devolve { handled:false } quando a mensagem não é do botão
 * (o webhook segue o fluxo normal) e { handled:true, resultado } quando é.
 * `resultado`: ENVIADO | SEM_PIX | PARCELA_NAO_ACHADA | JA_PAGA | FORA_DO_PRAZO | NAO_E_DO_CLIENTE.
 */
async function tratarToque({ companyId, msg, agora = Date.now() }) {
  const toque = lerToque(msg);
  if (!ehQueroPix(toque)) return { handled: false };

  const aviso = await avisoDoContexto(companyId, msg.context && msg.context.id);
  const parcelaId = parcelaDoPayload(toque.payload) || parcelaDoAviso(aviso);
  const procure = 'Não consegui achar essa parcela por aqui. Fale com a loja que ela te passa o Pix.';

  if (!parcelaId) {
    await responder(companyId, msg, procure, { sourceType: SOURCE_SEM_PIX, sufixo: 'x' });
    return { handled: true, resultado: 'PARCELA_NAO_ACHADA' };
  }

  if (aviso && aviso.created_at && agora - new Date(aviso.created_at).getTime() > VALIDADE_DIAS * 86400000) {
    await responder(companyId, msg, 'Esse aviso já é antigo e o valor pode ter mudado. Fale com a loja que ela te passa o Pix certo.',
      { sourceType: SOURCE_SEM_PIX, sourceId: parcelaId, sufixo: 'x' });
    return { handled: true, resultado: 'FORA_DO_PRAZO' };
  }

  const inst = await collectionNotice.loadInstallment(db, companyId, parcelaId);
  // Só o dono do número recebe o Pix daquela parcela.
  if (!inst || waOutbox.normalizePhone(inst.phone) !== waOutbox.normalizePhone(msg.from)) {
    await responder(companyId, msg, procure, { sourceType: SOURCE_SEM_PIX, sourceId: parcelaId, sufixo: 'x' });
    return { handled: true, resultado: inst ? 'NAO_E_DO_CLIENTE' : 'PARCELA_NAO_ACHADA' };
  }

  const aberta = ['pending', 'overdue'].includes(inst.status)
    && (parseFloat(inst.amount_due) - parseFloat(inst.covered_amount || 0)) > 0.005;
  if (!aberta) {
    await responder(companyId, msg, `Essa parcela já consta como paga aqui na ${inst.store_name || 'loja'}. Obrigada!`,
      { sourceType: SOURCE_RESPOSTA, sourceId: parcelaId, sufixo: 'x' });
    return { handled: true, resultado: 'JA_PAGA' };
  }

  const aviso2 = await collectionNotice.composeNotice({ companyId, template: 'lembrete', row: inst });
  const codigo = (aviso2 && aviso2.pix_copia_cola) || inst.pix_link || null;
  const valor = aviso2 && aviso2.total_due > 0 ? aviso2.total_due : (aviso2 ? aviso2.remaining : null);
  if (!codigo || !(valor > 0)) {
    await responder(companyId, msg,
      `A ${inst.store_name || 'loja'} ainda não deixou o Pix cadastrado por aqui. Fale com a loja para pagar a parcela ${inst.installment_number} de ${inst.total_installments}.`,
      { sourceType: SOURCE_SEM_PIX, sourceId: parcelaId, sufixo: 'x' });
    console.warn('[queroPix] loja sem Pix utilizável', { companyId, installmentId: parcelaId, temCodigo: !!codigo, valor });
    return { handled: true, resultado: 'SEM_PIX' };
  }

  await responder(companyId, msg,
    `Aqui está o Pix da parcela ${inst.installment_number} de ${inst.total_installments}, ${reais(valor)}. `
    + 'Copie o código da próxima mensagem e cole no app do seu banco, em Pix > Pix copia e cola.',
    { sourceId: parcelaId, sufixo: 'a' });
  // O código sozinho, para copiar com um toque.
  await responder(companyId, msg, codigo, { sourceId: parcelaId, sufixo: 'b' });
  return { handled: true, resultado: 'ENVIADO' };
}

module.exports = {
  PAYLOAD_PREFIXO, VALIDADE_DIAS, SOURCE_RESPOSTA, SOURCE_SEM_PIX,
  lerToque, ehQueroPix, parcelaDoPayload, parcelaDoAviso, tratarToque,
};
