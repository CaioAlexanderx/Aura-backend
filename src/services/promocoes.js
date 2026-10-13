// ============================================================
// AURA. — Promocoes de campanha do checkout (13/10/2026)
//
// "Primeiro mes pelo calendario: quem assinar ate 31/10 nao paga novembro."
//
// >>> PARA MUDAR PRAZO, DATA DA 1a COBRANCA, CODIGO OU TEXTOS: SO AQUI. <<<
// (PRIMEIRO_MES logo abaixo. Nenhuma outra data vive no codigo; a migration 372
// cria a linha do codigo em access_codes SEM expires_at de proposito, para o
// prazo nao existir em dois lugares.)
//
// Como o desconto chega a Asaas:
//   A Asaas nao cria cobranca de R$ 0 (MIN_CHARGE_BRL) e o desconto de 100% da
//   1a mensalidade e exatamente "nao cobrar nada ate X". O sistema de cupom ja
//   tem esse efeito — dias gratis (trial_days): nenhuma cobranca agora, o cartao
//   fica salvo (ou o Pix nao gera QR) e a assinatura recorrente nasce com
//   nextDueDate = fim do periodo gratis. Esta promocao reaproveita o caminho e so
//   troca a CONTA do periodo: em vez de "N dias a partir de hoje", a 1a cobranca
//   cai numa data de CALENDARIO (primeiraCobrancaEm), igual para todo mundo.
//   Por isso "pelo calendario": assinou em 14/10 ou em 31/10, a primeira cobranca
//   e 01/12 e novembro nao e cobrado.
//   No anual a assinatura e mensal com endDate (12 parcelas): a parcela de
//   novembro e a que some; o cliente paga as 11 restantes.
//
// Elegibilidade (todas):
//   1. agora <= terminaEm (Brasilia);
//   2. empresa sem assinatura anterior (ver temAssinaturaAnterior);
//   3. empresa ainda nao resgatou o codigo (coupon_redemptions, indice unico
//      da migration 228 + validateCoupon).
//
// Aplicacao automatica: no /billing/subscribe sem access_code. Com access_code
// informado, o informado prevalece e nada e somado.
// ============================================================

const { validateCoupon } = require('./checkoutCoupon');

const PRIMEIRO_MES = Object.freeze({
  codigo: 'PRIMEIROMES',
  titulo: 'Assine até 31/10 e não pague novembro',
  descricao:
    'Quem assina até 31/10 não paga novembro: a primeira cobrança só acontece em 01/12/2026. ' +
    'No plano anual, a parcela de novembro é a que sai de graça.',
  // Ultimo instante valido: 31/10/2026 23:59:59.999 em Brasilia (UTC-3, sem horario de verao).
  terminaEm: '2026-10-31T23:59:59.999-03:00',
  // Data (calendario) da 1a cobranca de quem entra na promocao.
  primeiraCobrancaEm: '2026-12-01',
});

const DIA_MS = 24 * 60 * 60 * 1000;

// Status de companies.billing_status que provam que ja houve assinatura/cobranca.
// 'trial' e 'pending' ficam de fora: trial sem assinatura e o publico-alvo, e
// 'pending' so conta se houve tentativa de cobranca (ver temAssinaturaAnterior).
const STATUS_COM_HISTORICO = new Set([
  'active', 'overdue', 'cancelled', 'canceled', 'suspended', 'refunded', 'chargeback',
]);

function toDate(now) {
  return now instanceof Date ? now : new Date(now == null ? Date.now() : now);
}

function getPromocao() {
  return PRIMEIRO_MES;
}

/** O prazo da promocao ainda vale em `now`? Puro. */
function dentroDoPrazo(now) {
  return toDate(now).getTime() <= Date.parse(PRIMEIRO_MES.terminaEm);
}

/**
 * A empresa ja teve assinatura? Puro — le so a linha de companies.
 *   - ja pagou alguma vez (last_payment_date);
 *   - status de quem assinou/cancelou/atrasou;
 *   - assinatura viva no Asaas (inclui trial com cartao salvo de outro cupom),
 *     exceto o Pix que ficou 'pending' sem nunca ser pago: esse cliente nao
 *     assinou de fato e o /subscribe recria a assinatura de qualquer forma.
 * Trial de cadastro (sem assinatura) NAO conta: e o publico da promocao.
 */
function temAssinaturaAnterior(company) {
  if (!company) return false;
  if (company.last_payment_date) return true;
  const status = String(company.billing_status || '').toLowerCase();
  if (STATUS_COM_HISTORICO.has(status)) return true;
  if (company.asaas_pending_payment_id) return true; // cartao com cobranca em analise
  if (company.asaas_subscription_id && status !== 'pending') return true;
  return false;
}

/** @returns {{elegivel:boolean, motivo:string|null, mensagem:string|null}} */
function avaliarElegibilidade(company, now) {
  if (!dentroDoPrazo(now)) {
    return { elegivel: false, motivo: 'encerrada', mensagem: 'Esta promoção já foi encerrada.' };
  }
  if (temAssinaturaAnterior(company)) {
    return {
      elegivel: false,
      motivo: 'assinatura_anterior',
      mensagem: 'Esta promoção vale só para quem ainda não assinou o Aura.',
    };
  }
  return { elegivel: true, motivo: null, mensagem: null };
}

// Data de hoje em Brasilia (YYYY-MM-DD).
function hojeEmBrasilia(now) {
  return new Date(toDate(now).getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Dias corridos de hoje (Brasilia) ate a 1a cobranca. Minimo 1. */
function diasAteAPrimeiraCobranca(now) {
  const dias = Math.round(
    (Date.parse(PRIMEIRO_MES.primeiraCobrancaEm + 'T00:00:00Z') -
      Date.parse(hojeEmBrasilia(now) + 'T00:00:00Z')) / DIA_MS
  );
  return Math.max(1, dias);
}

/**
 * Ajusta um cupom JA VALIDADO (checkoutCoupon.validateCoupon) quando ele e o da
 * campanha: confere elegibilidade e troca o efeito pelo periodo gratis de
 * calendario. Qualquer outro cupom volta intacto. Puro.
 *
 * @returns o cupom (possivelmente com trial_days/first_charge_date/campaign) ou
 *          { valid:false, error } quando a empresa nao pode usar a promocao.
 */
function aplicarCampanha(coupon, company, now) {
  if (!coupon || !coupon.valid || coupon.code !== PRIMEIRO_MES.codigo) return coupon;
  const el = avaliarElegibilidade(company, now);
  if (!el.elegivel) return { valid: false, error: el.mensagem };
  return {
    ...coupon,
    discount_pct: 0,
    discount_value: 0,
    discount_months: 1,
    trial_days: diasAteAPrimeiraCobranca(now),
    first_charge_date: PRIMEIRO_MES.primeiraCobrancaEm,
    campaign: true,
  };
}

let avisouLinhaAusente = false;

/**
 * Cupom da campanha para aplicar SOZINHO, ou null. Nunca lanca.
 * null = fora do prazo, empresa inelegivel, ja resgatado, ou a linha do codigo
 * nao existe/esta desativada/esgotada (migration 372 pendente).
 */
async function buscarCupomAutomatico(company, now = new Date()) {
  try {
    if (!avaliarElegibilidade(company, now).elegivel) return null;
    const coupon = await validateCoupon(PRIMEIRO_MES.codigo, company.id);
    if (!coupon.valid) {
      if (!avisouLinhaAusente && coupon.error === 'Cupom nao encontrado.') {
        avisouLinhaAusente = true;
        console.warn('[PROMO] ' + PRIMEIRO_MES.codigo + ' nao existe em access_codes (migration 372 pendente) — promocao nao aplicada');
      }
      return null;
    }
    const ajustado = aplicarCampanha(coupon, company, now);
    return ajustado.valid ? ajustado : null;
  } catch (err) {
    console.error('[PROMO] cupom automatico falhou:', err.message);
    return null;
  }
}

/**
 * Payload do GET /billing/promocao-ativa. `elegivel` ja considera o prazo, o
 * historico da empresa e o resgate previo: e o que o /subscribe vai fazer.
 */
async function promocaoAtiva(company, now = new Date()) {
  const coupon = await buscarCupomAutomatico(company, now);
  return {
    codigo: PRIMEIRO_MES.codigo,
    titulo: PRIMEIRO_MES.titulo,
    descricao: PRIMEIRO_MES.descricao,
    termina_em: new Date(PRIMEIRO_MES.terminaEm).toISOString(),
    primeira_cobranca_em: PRIMEIRO_MES.primeiraCobrancaEm,
    elegivel: !!coupon,
  };
}

function _resetAvisos() {
  avisouLinhaAusente = false;
}

module.exports = {
  PRIMEIRO_MES,
  getPromocao,
  dentroDoPrazo,
  temAssinaturaAnterior,
  avaliarElegibilidade,
  diasAteAPrimeiraCobranca,
  aplicarCampanha,
  buscarCupomAutomatico,
  promocaoAtiva,
  _resetAvisos,
};
