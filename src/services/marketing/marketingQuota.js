// ============================================================
// AURA — FASE 8b: cota mensal de MARKETING e pacotes extras
//
// O que mudou no modelo comercial (14/09/2026): o WhatsApp oficial vem
// DENTRO dos planos Negócio e Aura Dojô. As duas categorias da Meta
// custam coisas muito diferentes e por isso são tratadas diferente:
//
//   UTILITY  (cobrança, lembrete)  R$ 0,035  → "ilimitado", uso justo
//   MARKETING (cupom, aniversário) R$ 0,3217 → 100/mês + pacotes de 100
//
// A cota de marketing é VISÍVEL (a tela mostra "N de 100", e estourar
// oferece o pacote de R$49). O uso justo de utilidade é SILENCIOSO: o
// teto existe só para o caso patológico — régua em loop, importação
// errada, 3000 parcelas vencendo no mesmo dia — não virar uma fatura da
// Meta que a Aura descobre no fim do mês. Quem estoura 1500 cobranças
// num mês tem um problema para o suporte olhar, não um plano pequeno.
//
// Este módulo depende SÓ do banco de propósito: o waOutbox depende dele
// (para a guarda), então uma dependência de volta criaria ciclo.
//
// Migration 332 pode não estar aplicada quando o deploy sobe (o backend
// não roda migration no boot). Toda consulta é 42P01/42703-safe e a
// direção segura aqui é a PERMISSIVA: sem a tabela de pacotes a empresa
// fica com a cota base do plano, que é o que ela já tinha direito. O
// contrário — bloquear marketing porque a migration atrasou — seria
// derrubar um recurso que o cliente paga por causa de um deploy nosso.
// ============================================================
'use strict';

const db = require('../../config/database');

// O pacote da vitrine: 100 mensagens por R$49. Números fechados aqui
// (e não em env) porque são PREÇO — mudar preço é decisão comercial com
// aviso ao cliente, não ajuste de ambiente.
const PACK_QTY = 100;
const PACK_PRICE_CENTS = 4900;

// Cota base inclusa no plano. A env existe para a Aura poder afrouxar em
// bloco (campanha, incidente) sem deploy; o default é o que a página de
// planos promete.
const DEFAULT_MONTHLY_QUOTA = 100;
const DEFAULT_UTILITY_CAP = 1500;

// As duas famílias de source_type da wa_outbox. Marketing é a lista que
// o waOutbox já usava; utilidade é a cobrança (crediário e mensalidade
// do dojô). 'teste', 'humano' e 'aurinha' ficam FORA das duas contas de
// propósito: teste tem teto próprio e os outros dois são conversa, não
// disparo automático.
//
// Ótica (15/09/2026): "óculos prontos" e "pós-venda de adaptação" são
// resposta a um pedido que o cliente fez — utilidade. "Revisão da receita"
// é convite para voltar à loja — marketing, com consentimento e cota.
const MARKETING_SOURCE_TYPES = ['reativacao', 'aniversario', 'campanha', 'otica_revisao'];
const UTILITY_SOURCE_TYPES = ['crediario', 'crediario_manual', 'dojo_mensalidade', 'otica_pronta', 'otica_adaptacao'];

function schemaMissing(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

// Env inteira e positiva, ou o default. Env vazia/zero/lixo NUNCA vira
// teto zero — isso desligaria o recurso inteiro em silêncio.
function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function packQty() { return PACK_QTY; }
function packPriceCents() { return PACK_PRICE_CENTS; }
function baseMonthlyQuota() { return envInt('WA_MARKETING_MONTHLY_QUOTA', DEFAULT_MONTHLY_QUOTA); }
function utilityMonthlyCap() { return envInt('WA_UTILITY_MONTHLY_CAP', DEFAULT_UTILITY_CAP); }

// Mensagens do MÊS CORRENTE do lojista (America/Sao_Paulo, não UTC: dia
// 1º às 00h30 de Brasília ainda é dia 30 em UTC e a cota viraria um dia
// atrasada). Não conta 'skipped' nem 'failed' — o que não saiu não
// custou nada e não pode consumir cota de ninguém.
async function monthUsage(companyId, kind = 'marketing') {
  const tipos = kind === 'utility' ? UTILITY_SOURCE_TYPES : MARKETING_SOURCE_TYPES;
  try {
    const { rows } = await db.query(
      `-- wa:quota-month-usage
       SELECT COUNT(*)::int AS n FROM wa_outbox
        WHERE company_id = $1
          AND source_type = ANY($2::text[])
          AND status NOT IN ('skipped','failed')
          AND date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo')
            = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')`,
      [companyId, tipos]
    );
    return Number((rows[0] && rows[0].n) || 0);
  } catch (e) {
    if (schemaMissing(e)) return 0;
    throw e;
  }
}

// Exceção comercial da empresa (NULL = padrão do plano). 42703 com a 332
// pendente → null, ou seja, o padrão.
async function loadCompanyQuota(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:quota-company
       SELECT wa_marketing_quota FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const v = rows[0] ? rows[0].wa_marketing_quota : null;
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch (e) {
    if (schemaMissing(e)) return null;
    throw e;
  }
}

// Só pacote PAGO (active) e ainda dentro da validade soma. Pacote
// 'pending' é pedido sem dinheiro: contá-lo entregaria a cota antes do
// pagamento e a Aura descobriria no estorno.
async function activePacksQty(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:quota-packs-active
       SELECT COALESCE(SUM(qty), 0)::int AS qty FROM wa_marketing_packs
        WHERE company_id = $1 AND status = 'active'
          AND valid_until >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
      [companyId]
    );
    return Number((rows[0] && rows[0].qty) || 0);
  } catch (e) {
    if (schemaMissing(e)) return 0;
    throw e;
  }
}

// O bloco que a tela mostra e a guarda consulta. `remaining` nunca é
// negativo: a tela usa esse número numa barra de progresso e um valor
// negativo viraria barra invertida.
async function marketingStatus(companyId) {
  const quotaBase = (await loadCompanyQuota(companyId)) ?? baseMonthlyQuota();
  const packsQty = await activePacksQty(companyId);
  const monthSent = await monthUsage(companyId, 'marketing');
  const quota = quotaBase + packsQty;
  return {
    month_sent: monthSent,
    quota_base: quotaBase,
    packs_qty: packsQty,
    quota,
    remaining: Math.max(0, quota - monthSent),
    pack_price_cents: PACK_PRICE_CENTS,
    pack_qty: PACK_QTY,
  };
}

async function utilityStatus(companyId) {
  return {
    month_sent: await monthUsage(companyId, 'utility'),
    cap: utilityMonthlyCap(),
  };
}

// Atalho da guarda: quantas mensagens de marketing ainda cabem no mês.
async function remainingThisMonth(companyId) {
  const s = await marketingStatus(companyId);
  return s.remaining;
}

// ── Acumulador das prévias ──────────────────────────────────
// Teto diário e cota mensal são contas de ACÚMULO: valem sobre a
// sequência de itens que a rotina enfileiraria, não sobre um item
// isolado. Por isso ficam fora do waOutbox.simulate() (que é
// estado-só) e quem varre a lista mantém o acumulado.
//
// Os dois devolvem o MESMO skip_reason (LIMITE_MARKETING): a tela já
// traduz esse código, e para quem lê a fila "acabou a cota" e "acabou o
// dia" são a mesma frase — o número que diferencia está no /status.
function makeCapTracker({ dailyCap, dailyUsed = 0, remaining = Infinity }) {
  let dia = Number(dailyUsed) || 0;
  let resto = remaining;
  const capDia = Number(dailyCap);
  return {
    // Motivo de pular ESTE item, ou null se ele passa.
    reason() {
      if (resto <= 0) return 'LIMITE_MARKETING';
      if (Number.isFinite(capDia) && dia >= capDia) return 'LIMITE_MARKETING';
      return null;
    },
    // Só depois de o item ser (ou seria ser) enfileirado.
    bump() {
      dia += 1;
      if (Number.isFinite(resto)) resto -= 1;
    },
    get remaining() { return resto; },
    get dailyUsed() { return dia; },
  };
}

// ── Pacotes ─────────────────────────────────────────────────
// Devolve null com a 332 pendente — quem chama responde SCHEMA_PENDING
// em vez de fingir que vendeu um pacote.
async function createPack(companyId, { qty = PACK_QTY, priceCents = PACK_PRICE_CENTS, status = 'pending', source = 'app', createdBy = null } = {}) {
  try {
    const { rows } = await db.query(
      `-- wa:pack-insert
       INSERT INTO wa_marketing_packs
         (company_id, qty, price_cents, status, source, created_by, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $4 = 'active' THEN NOW() END)
       RETURNING id, company_id, qty, price_cents, status, valid_from, valid_until,
                 asaas_payment_id, payment_url, source, activated_at, created_at`,
      [companyId, qty, priceCents, status, source, createdBy]
    );
    return rows[0] || null;
  } catch (e) {
    if (schemaMissing(e)) return null;
    throw e;
  }
}

async function setPackPayment(packId, { asaasPaymentId = null, paymentUrl = null } = {}) {
  try {
    const { rows } = await db.query(
      `-- wa:pack-payment
       UPDATE wa_marketing_packs
          SET asaas_payment_id = COALESCE($2, asaas_payment_id),
              payment_url      = COALESCE($3, payment_url),
              updated_at       = NOW()
        WHERE id = $1
       RETURNING id, company_id, qty, price_cents, status, valid_from, valid_until,
                 asaas_payment_id, payment_url, source, activated_at, created_at`,
      [packId, asaasPaymentId, paymentUrl]
    );
    return rows[0] || null;
  } catch (e) {
    if (schemaMissing(e)) return null;
    throw e;
  }
}

// Ativação pelo webhook do Asaas. Idempotente de propósito: o Asaas
// reenvia o mesmo evento, e `activated_at` só é carimbado na primeira
// vez (COALESCE) para o relatório não mentir sobre quando o dinheiro
// caiu. Pacote cancelado não ressuscita.
//
// 22P02 = o externalReference não era um UUID (evento de outra origem
// que por acaso começa com o prefixo): não é erro nosso, é "não é meu".
async function activatePack(packId, asaasPaymentId = null) {
  try {
    const { rows } = await db.query(
      `-- wa:pack-activate
       UPDATE wa_marketing_packs
          SET status           = 'active',
              activated_at     = COALESCE(activated_at, NOW()),
              asaas_payment_id = COALESCE($2, asaas_payment_id),
              updated_at       = NOW()
        WHERE id = $1 AND status <> 'cancelled'
       RETURNING id, company_id, qty, price_cents, status, valid_from, valid_until,
                 asaas_payment_id, payment_url, source, activated_at, created_at`,
      [packId, asaasPaymentId]
    );
    return rows[0] || null;
  } catch (e) {
    if (schemaMissing(e) || e.code === '22P02') return null;
    throw e;
  }
}

async function listPacks(companyId, limit = 12) {
  try {
    const { rows } = await db.query(
      `-- wa:pack-list
       SELECT id, qty, price_cents, status, valid_from, valid_until,
              asaas_payment_id, payment_url, source, activated_at, created_at
         FROM wa_marketing_packs
        WHERE company_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [companyId, limit]
    );
    return rows;
  } catch (e) {
    if (schemaMissing(e)) return [];
    throw e;
  }
}

// Exceção comercial por empresa. `quota` null limpa a exceção e devolve
// a empresa ao padrão do plano. false com a 332 pendente.
async function setCompanyQuota(companyId, quota) {
  const valor = quota === null || quota === undefined ? null : Math.floor(Number(quota));
  try {
    await db.query(
      `-- wa:quota-set
       UPDATE companies SET wa_marketing_quota = $2, updated_at = NOW() WHERE id = $1`,
      [companyId, valor]
    );
    return true;
  } catch (e) {
    if (schemaMissing(e)) return false;
    throw e;
  }
}

module.exports = {
  PACK_QTY, PACK_PRICE_CENTS,
  MARKETING_SOURCE_TYPES, UTILITY_SOURCE_TYPES,
  packQty, packPriceCents, baseMonthlyQuota, utilityMonthlyCap,
  monthUsage, loadCompanyQuota, activePacksQty,
  marketingStatus, utilityStatus, remainingThisMonth,
  makeCapTracker,
  createPack, setPackPayment, activatePack, listPacks, setCompanyQuota,
};
