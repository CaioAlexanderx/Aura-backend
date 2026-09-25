// ============================================================
// AURA. — Atribuicao do pedido da loja (Aurinha, migration 313)
//
// A loja manda `origem` e `hub_conversation_id` no POST do pedido quando
// o cliente chegou por um link com `?origem=...&conversa=...` (contrato
// em docs/aurinha-checkout-contract.md). E a metrica de conversao do hub
// social: o pedido nasce atribuido a conversa que o fechou.
//
// Um modulo so para as duas lojas de proposito. A loja comum gravava
// desde a 313; a vitrine Studio nao — e a Aurinha manda link para as
// duas. Duas copias da mesma regra ja divergiram aqui antes (campos
// obrigatorios no S0, retirada por app na 288); ver courierPickup.js.
//
// Regras do contrato:
// - `origem`: texto de ate 32 caracteres (a coluna). Maior e cortado.
// - `hub_conversation_id`: UUID. Qualquer outra coisa e ignorada.
// - Best-effort, FORA da transacao do pedido e guardado 42703 (base sem
//   a migration 313): atribuicao nunca derruba um pedido valido.
// ============================================================
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGEM_MAX = 32;

/**
 * Le a atribuicao do corpo do pedido. Devolve null quando nao ha nada
 * valido para gravar — o chamador nem toca no banco.
 */
function lerAtribuicao(body) {
  const b = body || {};
  const origem = typeof b.origem === 'string' ? b.origem.trim().slice(0, ORIGEM_MAX) : '';
  const conv = typeof b.hub_conversation_id === 'string' ? b.hub_conversation_id.trim() : '';
  const hubConversationId = conv && UUID.test(conv) ? conv : null;
  if (!origem && !hubConversationId) return null;
  return { origem: origem || null, hub_conversation_id: hubConversationId };
}

/**
 * Grava a atribuicao no pedido ja criado. Nunca rejeita: o pedido ja foi
 * confirmado ao banco, e o cliente nao pode receber erro por causa de
 * uma metrica. `rotulo` so identifica a loja no log.
 */
function gravarAtribuicao(db, { orderId, companyId, atribuicao, rotulo = 'STOREFRONT' }) {
  if (!atribuicao || !orderId) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => db.query(
      `UPDATE digital_orders SET origem = COALESCE($1, origem), hub_conversation_id = COALESCE($2, hub_conversation_id)
        WHERE id = $3 AND company_id = $4`,
      [atribuicao.origem, atribuicao.hub_conversation_id, orderId, companyId]
    ))
    .then(() => true)
    .catch((e) => {
      // 42703: a migration 313 ainda nao rodou nesta base. Silencio.
      if (!e || e.code !== '42703') console.error(`[${rotulo}] atribuicao error:`, e && e.message);
      return false;
    });
}

module.exports = { lerAtribuicao, gravarAtribuicao, ORIGEM_MAX };
