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
const overdueRule = require('./overdue');

const PAYLOAD_PREFIXO = 'QUERO_PIX';
const TEXTO_BOTAO = 'quero o pix';
const VALIDADE_DIAS = 30;
const REPETIDO_MIN = 10;
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

// Mesmo telefone mesmo com/sem o 9º dígito e com/sem o 55: DDD + últimos 8 dígitos.
function mesmoTelefone(a, b) {
  const f = (x) => {
    let d = String(x || '').replace(/\D/g, '');
    if (d.startsWith('55') && d.length > 11) d = d.slice(2);
    return d.length >= 10 ? { ddd: d.slice(0, 2), fim: d.slice(-8) } : null;
  };
  const x = f(a); const y = f(b);
  return !!x && !!y && x.ddd === y.ddd && x.fim === y.fim;
}

// O cliente ainda DEVE à loja? Mesma regra do ledger que a régua e a lista de
// público usam (overdueRule.ledgerDebtSql). Quem pagou na loja não recebe Pix.
// Erro ao ler = null (na dúvida, não manda o código).
async function temSaldoDevedor(companyId, customerId) {
  try {
    const { rows } = await db.query(
      `-- cred:quero-pix-saldo
       SELECT 1 FROM customer_credit_balances cb
        WHERE cb.company_id = $1 AND cb.customer_id = $2 AND cb.balance > ${overdueRule.LEDGER_MIN_DEBT}
        LIMIT 1`,
      [companyId, customerId]
    );
    return rows.length > 0;
  } catch (_) { return null; }
}

async function jaRespondeuRecente(companyId, phone, parcelaId) {
  try {
    const { rows } = await db.query(
      `-- cred:quero-pix-repetido
       SELECT 1 FROM wa_outbox
        WHERE company_id = $1 AND to_phone = $2 AND source_id = $3 AND source_type = $4
          AND created_at > NOW() - ($5::int || ' minutes')::interval
        LIMIT 1`,
      [companyId, phone, parcelaId, SOURCE_RESPOSTA, REPETIDO_MIN]
    );
    return rows.length > 0;
  } catch (_) { return false; }
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
  // Só o dono do número recebe o Pix daquela parcela: o telefone do cliente ou
  // o número para o qual o aviso foi enviado (compara DDD + 8 últimos dígitos,
  // por causa do 9º dígito).
  const donoDoNumero = !!inst && (mesmoTelefone(inst.phone, msg.from) || (!!aviso && mesmoTelefone(aviso.to_phone, msg.from)));
  if (!inst || !donoDoNumero) {
    await responder(companyId, msg, procure, { sourceType: SOURCE_SEM_PIX, sourceId: parcelaId, sufixo: 'x' });
    return { handled: true, resultado: inst ? 'NAO_E_DO_CLIENTE' : 'PARCELA_NAO_ACHADA' };
  }

  const loja = inst.store_name || 'loja';
  if (inst.status === 'cancelled') {
    await responder(companyId, msg, `Essa parcela foi renegociada na ${loja}. Fale com a loja para saber o valor e o Pix atualizados.`,
      { sourceType: SOURCE_SEM_PIX, sourceId: parcelaId, sufixo: 'x' });
    return { handled: true, resultado: 'CANCELADA' };
  }

  const aberta = ['pending', 'overdue'].includes(inst.status)
    && (parseFloat(inst.amount_due) - parseFloat(inst.covered_amount || 0)) > 0.005;
  const devedor = aberta ? await temSaldoDevedor(companyId, inst.customer_id) : false;
  if (devedor === null) {
    // Não deu para conferir o livro-razão: na dúvida, não manda código.
    await responder(companyId, msg, `Não consegui conferir essa parcela agora. Fale com a ${loja} que ela te passa o Pix.`,
      { sourceType: SOURCE_SEM_PIX, sourceId: parcelaId, sufixo: 'x' });
    return { handled: true, resultado: 'SALDO_NAO_CONFERIDO' };
  }
  if (!aberta || !devedor) {
    await responder(companyId, msg, `Essa parcela já consta como paga aqui na ${loja}. Obrigada!`,
      { sourceType: SOURCE_RESPOSTA, sourceId: parcelaId, sufixo: 'x' });
    return { handled: true, resultado: 'JA_PAGA' };
  }

  // Dois toques seguidos (ou o webhook repetido com outro id): não manda o código de novo.
  if (await jaRespondeuRecente(companyId, waOutbox.normalizePhone(msg.from), parcelaId)) {
    return { handled: true, resultado: 'REPETIDO' };
  }

  const aviso2 = await collectionNotice.composeNotice({ companyId, template: 'lembrete', row: inst });
  // Só vale o BR Code gerado agora (EMV do composeNotice). O pix_link antigo das
  // parcelas é um endereço que não existe: nunca vai como "Pix".
  const codigo = (aviso2 && aviso2.pix_copia_cola) || null;
  const valor = aviso2 && aviso2.total_due > 0 ? aviso2.total_due : (aviso2 ? aviso2.remaining : null);
  if (!codigo || !(valor > 0)) {
    await responder(companyId, msg,
      `A ${loja} ainda não deixou o Pix cadastrado por aqui. Fale com a loja para pagar a parcela ${inst.installment_number} de ${inst.total_installments}.`,
      { sourceType: SOURCE_SEM_PIX, sourceId: parcelaId, sufixo: 'x' });
    console.warn('[queroPix] loja sem Pix utilizável', { companyId, installmentId: parcelaId, temCodigo: !!codigo, valor });
    return { handled: true, resultado: 'SEM_PIX' };
  }

  const comEncargos = aviso2.remaining != null && valor > aviso2.remaining + 0.005;
  await responder(companyId, msg,
    `Aqui está o Pix da parcela ${inst.installment_number} de ${inst.total_installments}, ${reais(valor)}`
    + `${comEncargos ? ' (com os encargos do atraso)' : ''}. `
    + 'Copie o código da próxima mensagem e cole no app do seu banco, em Pix > Pix copia e cola.',
    { sourceId: parcelaId, sufixo: 'a' });
  // O código sozinho, para copiar com um toque.
  await responder(companyId, msg, codigo, { sourceId: parcelaId, sufixo: 'b' });
  return { handled: true, resultado: 'ENVIADO' };
}

module.exports = {
  mesmoTelefone, temSaldoDevedor,
  PAYLOAD_PREFIXO, VALIDADE_DIAS, SOURCE_RESPOSTA, SOURCE_SEM_PIX,
  lerToque, ehQueroPix, parcelaDoPayload, parcelaDoAviso, tratarToque,
};
