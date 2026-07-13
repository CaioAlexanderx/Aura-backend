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
    ({ rows } = await db.query(
      `SELECT id, code, type, plan, discount_pct, trial_days, max_uses, uses,
              expires_at, is_active, referrer_id
         FROM access_codes
        WHERE code = $1`,
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
  if (discountPct <= 0 && trialDays <= 0) {
    // Codigo existe mas nao desconta nem adia nada — dizer isso e melhor do que
    // aceitar em silencio e cobrar cheio (foi exatamente o bug antigo).
    return { valid: false, error: 'Este cupom nao concede desconto nem dias gratis.' };
  }
  if (discountPct > 100) {
    return { valid: false, error: 'Cupom com desconto invalido (acima de 100%).' };
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
    trial_days: trialDays,
    referrer_id: ac.referrer_id || null,
  };
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
  try {
    await db.query(
      `INSERT INTO coupon_redemptions
         (company_id, user_id, code_id, code, type, discount_pct, trial_days,
          plan, cycle, billing_type, recurring_value, charged_value,
          asaas_payment_id, asaas_subscription_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
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
      ]
    );
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
  reserveCoupon,
  releaseCoupon,
  recordRedemption,
};
