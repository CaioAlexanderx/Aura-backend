// ============================================================
// AURA. — Motor de cupom do checkout (13/07/2026)
//
// A tabela access_codes existe desde o inicio (code, type, plan, discount_pct,
// trial_days, max_uses, uses, expires_at, referrer_id), mas so era lida no
// /auth/register — e la o discount_pct NUNCA era aplicado a cobranca nenhuma:
// virava um campo `code_applied` na resposta JSON e morria ali. Na pratica, um
// cupom de 50% cobrava o valor cheio.
//
// Agora o codigo vale no checkout, com DOIS efeitos possiveis:
//
//   discount_pct  → desconto na PRIMEIRA mensalidade. A assinatura recorrente
//                   e criada com o valor CHEIO — nada a "restaurar" depois,
//                   nenhum job, nenhum estado pra expirar.
//   trial_days    → nenhuma cobranca hoje. O cartao e tokenizado e salvo, e a
//                   assinatura ja nasce agendada pra D+N (e o formato da
//                   campanha de indicacao: 30 dias gratis com cartao salvo).
//
// Os dois se combinam: um codigo com trial_days=30 e discount_pct=50 da 30 dias
// gratis E cobra a primeira mensalidade pela metade quando ela chegar? NAO —
// ver nota em getFirstChargeValue: com trial_days > 0 nao existe cobranca
// imediata, entao o discount_pct e ignorado (a assinatura recorrente e cheia).
// Isso e proposital: desconto "guardado pra depois" exigiria estado persistente
// e um job pra aplicar/restaurar no Asaas — complexidade que nao se paga hoje.
//
// Fluxo de resgate (importa a ordem):
//   1. validateCoupon  — pode? (ativo, nao expirado, tem uso, empresa nao usou)
//   2. reserveCoupon   — UPDATE atomico uses+1 WHERE uses < max_uses
//   3. cobra no Asaas
//   4a. sucesso → recordRedemption (auditoria em coupon_redemptions)
//   4b. falha   → releaseCoupon (uses-1) — cobranca recusada nao queima o cupom
//
// 11/09/2026 — DESCONTO EM REAIS E POR VARIOS MESES (migration 326):
//   discount_value    → desconto em reais (alternativa ao discount_pct; nunca
//                       os dois no mesmo cupom).
//   discount_months   → quantas mensalidades levam o desconto. 1 = o
//                       comportamento acima, intacto. Mais de 1 = a assinatura
//                       nasce descontada e services/subscriptionDiscount.js
//                       cuida de devolver o valor cheio. So no ciclo mensal
//                       (o anual ja tem 2 meses gratis) e nunca com trial_days.
//   restrict_to_plan  → o cupom so vale no plano da coluna `plan`.
// ============================================================

const db = require('../config/database');

// Tipos de access_code que podem ser resgatados no CHECKOUT.
// 'trial' historicamente so dava dias de trial no cadastro (COMECAR, DAVI10...);
// no checkout ele vale como cupom de dias gratis com cartao salvo, que e' o que
// a campanha de indicacao precisa.
const REDEEMABLE_TYPES = new Set(['promo', 'manual', 'referral', 'trial']);

/**
 * Valida um cupom para uso no checkout de uma empresa.
 * NUNCA lanca — sempre retorna um objeto descritivo.
 *
 * @returns {Promise<{valid:boolean, error?:string, id?:string, code?:string,
 *   type?:string, discount_pct?:number, trial_days?:number, referrer_id?:string}>}
 */
async function validateCoupon(rawCode, companyId) {
  const code = String(rawCode || '').toUpperCase().trim();
  if (!code) return { valid: false, error: 'Informe um cupom.' };

  let rows;
  try {
    // SELECT * de proposito: as colunas da migration 326 (discount_value,
    // discount_months, restrict_to_plan) podem nao existir ainda — uma lista
    // explicita quebraria com 42703; aqui elas so chegam undefined.
    ({ rows } = await db.query(
      `SELECT * FROM access_codes WHERE code = $1`,
      [code]
    ));
  } catch (err) {
    console.error('[COUPON] validate query falhou:', err.message);
    return { valid: false, error: 'Nao foi possivel validar o cupom agora.' };
  }

  if (!rows.length) return { valid: false, error: 'Cupom nao encontrado.' };
  const ac = rows[0];

  if (!ac.is_active) return { valid: false, error: 'Cupom desativado.' };
  if (ac.expires_at && new Date(ac.expires_at) < new Date()) {
    return { valid: false, error: 'Cupom expirado.' };
  }
  if ((ac.uses || 0) >= (ac.max_uses || 1)) {
    return { valid: false, error: 'Cupom ja atingiu o limite de usos.' };
  }
  if (!REDEEMABLE_TYPES.has(ac.type)) {
    return { valid: false, error: 'Este codigo nao vale como cupom de assinatura.' };
  }

  const discountPct = parseInt(ac.discount_pct, 10) || 0;
  const trialDays = parseInt(ac.trial_days, 10) || 0;
  const discountValue = Math.round((parseFloat(ac.discount_value) || 0) * 100) / 100;
  const discountMonths = parseInt(ac.discount_months, 10) || 1;
  if (discountPct <= 0 && discountValue <= 0 && trialDays <= 0) {
    // Codigo existe mas nao desconta nem adia nada — dizer isso e melhor do que
    // aceitar em silencio e cobrar cheio (foi exatamente o bug antigo).
    return { valid: false, error: 'Este cupom nao concede desconto nem dias gratis.' };
  }
  if (discountPct > 100) {
    return { valid: false, error: 'Cupom com desconto invalido (acima de 100%).' };
  }
  // Combinacoes que o painel ja recusa na criacao; aqui e a ultima linha de
  // defesa para cupom criado direto no banco.
  if ((discountPct > 0 && discountValue > 0) || (discountMonths > 1 && trialDays > 0) ||
      (discountMonths > 1 && discountPct <= 0 && discountValue <= 0)) {
    return { valid: false, error: 'Cupom configurado de forma invalida.' };
  }

  // Mesma empresa nao resgata o mesmo cupom duas vezes.
  // Defensivo pre-migration 228: se a tabela ainda nao existe (42P01), segue —
  // o indice unico da migration e a ultima linha de defesa quando ela subir.
  try {
    const { rows: used } = await db.query(
      'SELECT 1 FROM coupon_redemptions WHERE company_id = $1 AND code_id = $2 LIMIT 1',
      [companyId, ac.id]
    );
    if (used.length) {
      return { valid: false, error: 'Esta empresa ja usou este cupom.' };
    }
  } catch (err) {
    if (err.code !== '42P01') {
      console.error('[COUPON] checagem de resgate previo falhou:', err.message);
    }
  }

  return {
    valid: true,
    id: ac.id,
    code: ac.code,
    type: ac.type,
    discount_pct: discountPct,
    discount_value: discountValue,
    discount_months: discountMonths,
    trial_days: trialDays,
    plan: ac.plan || null,
    restrict_to_plan: ac.restrict_to_plan === true,
    referrer_id: ac.referrer_id || null,
  };
}

const PLAN_LABELS = { essencial: 'Essencial', negocio: 'Negócio', expansao: 'Expansão' };

/**
 * O cupom (ja validado) serve para este plano e ciclo? Puro.
 * @returns {string|null} mensagem de erro, ou null quando serve.
 */
function checkCouponFits(coupon, { plan, cycle }) {
  if (!coupon) return null;
  if (coupon.restrict_to_plan && coupon.plan && plan !== coupon.plan) {
    return 'Este cupom vale só para o plano ' + (PLAN_LABELS[coupon.plan] || coupon.plan) + '.';
  }
  if ((coupon.discount_months || 1) > 1 && cycle === 'annual') {
    return 'Este cupom vale só no plano mensal.';
  }
  return null;
}

/**
 * Reserva um uso do cupom ANTES de cobrar. Atomico: o WHERE uses < max_uses no
 * proprio UPDATE fecha a corrida entre dois checkouts simultaneos.
 * @returns {Promise<boolean>} false = esgotou no meio do caminho.
 */
async function reserveCoupon(codeId) {
  try {
    const { rows } = await db.query(
      `UPDATE access_codes
          SET uses = uses + 1, updated_at = NOW()
        WHERE id = $1
          AND is_active = true
          AND uses < max_uses
      RETURNING uses`,
      [codeId]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[COUPON] reserve falhou:', err.message);
    return false;
  }
}

/**
 * Devolve o uso reservado quando a cobranca falha. Best-effort — nunca lanca.
 * Cobranca recusada nao pode queimar o cupom do cliente.
 */
async function releaseCoupon(codeId) {
  try {
    await db.query(
      `UPDATE access_codes
          SET uses = GREATEST(uses - 1, 0), updated_at = NOW()
        WHERE id = $1`,
      [codeId]
    );
  } catch (err) {
    console.error('[COUPON] release falhou (uso ficou reservado):', err.message);
  }
}

/**
 * Registra o resgate em coupon_redemptions (auditoria). Best-effort: se falhar,
 * a cobranca ja aconteceu e nao pode ser desfeita por causa de um INSERT de log.
 * Defensivo pre-migration 228 (42P01 -> so loga).
 */
async function recordRedemption(data) {
  const base = [
    data.companyId,
    data.userId || null,
    data.codeId || null,
    data.code,
    data.type || null,
    data.discountPct || 0,
    data.trialDays || 0,
    data.plan || null,
    data.cycle || null,
    data.billingType || null,
    data.recurringValue != null ? data.recurringValue : null,
    data.chargedValue != null ? data.chargedValue : null,
    data.paymentId || null,
    data.subscriptionId || null,
  ];
  const columns = `company_id, user_id, code_id, code, type, discount_pct, trial_days,
          plan, cycle, billing_type, recurring_value, charged_value,
          asaas_payment_id, asaas_subscription_id`;
  try {
    try {
      await db.query(
        `INSERT INTO coupon_redemptions (${columns}, discount_value, discount_months)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [...base, data.discountValue || 0, data.discountMonths || 1]
      );
    } catch (err) {
      // Pre-migration 326: grava sem as colunas novas em vez de perder a auditoria.
      if (err.code !== '42703') throw err;
      await db.query(
        `INSERT INTO coupon_redemptions (${columns})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        base
      );
    }
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[COUPON] coupon_redemptions nao existe (migration 228 pendente) — resgate nao auditado');
    } else {
      console.error('[COUPON] recordRedemption falhou:', err.message);
    }
  }
}

module.exports = {
  REDEEMABLE_TYPES,
  validateCoupon,
  checkCouponFits,
  reserveCoupon,
  releaseCoupon,
  recordRedemption,
};
