// ============================================================
// AURA. — Vinculo transaction -> venda pela idempotency_key.
//
// Uma venda do PDV deixa rastro no financeiro por chaves previsiveis. As que
// AMARRAM o lancamento de volta na venda (e portanto permitem editar as
// mercadorias a partir do lancamento) sao duas:
//
//   pdv-sale-<saleId>                        receita paga na hora (pdv.js).
//                                            So existe quando entrou dinheiro
//                                            (cashAmount > 0) — venda 100%
//                                            fiada NAO tem essa linha.
//   pdv-credit-receivable-<saleId>           'A Receber' do crediario
//                                            (services/credit/ledger.js).
//   pdv-credit-receivable-<saleId>-rest-<ts> saldo remanescente de pagamento
//                                            parcial (applyPayment quita o
//                                            original e abre o resto).
//
// Ficam DE FORA de proposito:
//   pdv-card-fee-<saleId>   despesa da maquininha, nao e a venda.
//   pdv-troca-v2-<saleId>   troca tem fluxo proprio (Devolveu/Levou).
//
// 28/08/2026 — extraido de routes/transactionSale.js (relato Eryca #1: a
// edicao do lancamento de uma venda no crediario nao listava os produtos,
// porque so 'pdv-sale-' era reconhecido). Mora aqui pra ser testavel sem
// subir o router.
// ============================================================

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Solto de proposito: chaves 'pdv-sale-' sempre carregaram o uuid cru e ha
// base antiga demais pra apertar agora. '-rest-' nao casa aqui porque 'r',
// 's' e 't' estao fora de [0-9a-f-].
const RE_PDV_SALE = /^pdv-sale-([0-9a-f-]+)$/i;
const RE_CREDIT_RECEIVABLE = new RegExp('^pdv-credit-receivable-(' + UUID + ')(?:-rest-.*)?$', 'i');

/**
 * resolveSaleLink — de qual venda esse lancamento veio.
 *
 * @param {string|null|undefined} idempotencyKey
 * @returns {{ saleId: string, source: 'pdv'|'credit' } | null}
 */
function resolveSaleLink(idempotencyKey) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;

  const pdv = idempotencyKey.match(RE_PDV_SALE);
  if (pdv) return { saleId: pdv[1], source: 'pdv' };

  const credit = idempotencyKey.match(RE_CREDIT_RECEIVABLE);
  if (credit) return { saleId: credit[1], source: 'credit' };

  return null;
}

/** Atalho pra quem so precisa do id (retorna null quando nao ha vinculo). */
function extractSaleId(idempotencyKey) {
  const link = resolveSaleLink(idempotencyKey);
  return link ? link.saleId : null;
}

module.exports = { resolveSaleLink, extractSaleId };
