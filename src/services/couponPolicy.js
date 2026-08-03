// ============================================================
// AURA. -- Politica de titularidade de cupom
//
// Regra unica, compartilhada pelos DOIS caminhos que aceitam cupom:
//   - POST /companies/:id/coupons/validate  (PDV consulta antes de fechar)
//   - POST /companies/:id/pdv/sale          (consome e incrementa current_uses)
//
// Vive aqui, e nao inline nos dois arquivos, porque regra de seguranca
// duplicada e regra que um dia diverge -- e a copia que importa (o /sale)
// e justamente a que ninguem lembra de atualizar.
//
// Cupom NOMINAL  = coupons.customer_id preenchido (source birthday /
//                  credit_lead). So vale para aquele cliente.
// Cupom GENERICO = coupons.customer_id NULL. Segue valendo pra qualquer
//                  venda -- e o caso de 100% dos cupons 'manual' de hoje,
//                  entao nada existente muda de comportamento.
// ============================================================

/** Primeiro nome do dono, so pra mensagem de erro ser acionavel no balcao. */
function firstName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  return n.split(/\s+/)[0];
}

/**
 * @param {{customer_id: string|null, owner_name?: string|null}} coupon
 * @param {string|null|undefined} customerId cliente vinculado a venda
 * @returns {{ok: true} | {ok: false, code: string, error: string}}
 */
function checkCouponOwner(coupon, customerId) {
  if (!coupon || !coupon.customer_id) return { ok: true };

  const who = firstName(coupon.owner_name);
  const cid = customerId ? String(customerId) : null;

  // Venda sem cliente identificado (PDV do Studio, venda avulsa). Nao da
  // pra provar que e o dono, entao nao passa -- mas a mensagem diz o que
  // fazer, em vez de um "cupom invalido" que manda o lojista adivinhar.
  if (!cid) {
    return {
      ok: false,
      code: 'COUPON_REQUIRES_CUSTOMER',
      error: who
        ? `Cupom exclusivo de ${who}. Selecione o cliente na venda para usar.`
        : 'Cupom exclusivo de um cliente. Selecione o cliente na venda para usar.',
    };
  }

  if (cid !== String(coupon.customer_id)) {
    return {
      ok: false,
      code: 'COUPON_CUSTOMER_MISMATCH',
      error: who
        ? `Cupom exclusivo de ${who} -- nao pode ser usado por outro cliente.`
        : 'Cupom exclusivo de outro cliente.',
    };
  }

  return { ok: true };
}

module.exports = { checkCouponOwner };
