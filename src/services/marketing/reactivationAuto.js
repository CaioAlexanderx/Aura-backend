// ============================================================
// AURA — FASE 7: reativação de clientes pelo WhatsApp oficial
//
// A tela de reativação (customerReactivation.js) já sabia QUEM sumiu —
// segmentava por recência, ordenava por gasto e escrevia a sugestão de
// mensagem. O que ela nunca fez foi ENVIAR: alguém tinha que copiar o
// texto e abrir o WhatsApp um cliente por vez. Este serviço é a pista
// automática dessa lista.
//
// É MARKETING: custa mais caro que cobrança, tem limite por usuário e
// derruba a qualidade do número quando incomoda. Por isso o teto é
// pequeno de propósito (30 por rodada semanal) e todas as guardas do
// waOutbox valem — consentimento declarado, opt-out, 1 marketing por
// contato a cada 7 dias, qualidade YELLOW, teto diário de marketing.
//
// Ordem dos passos importa: o cupom nasce DEPOIS de as guardas
// aprovarem o envio. O código do cupom é parâmetro do template, então
// ele precisa existir antes da mensagem — mas criar primeiro e perguntar
// depois encheria a tabela de cupons que ninguém nunca viu.
// ============================================================
'use strict';

const db = require('../../config/database');
const waOutbox = require('../waOutbox');
const addons = require('../addons');
const mkt = require('./marketingCommon');
const quota = require('./marketingQuota');

// Janelas de recência, iguais às da tela (customerReactivation.js):
// active ≤30d, at_risk ≤60d, dormant ≤120d. 'both' cobre as duas faixas
// que ainda vale a pena reconquistar — quem passou de 120 dias ('lost')
// fica fora do automático de propósito: é a lista com menor resposta e
// maior chance de a pessoa nem lembrar da loja (= denúncia de spam).
const SEGMENT_RANGES = {
  at_risk: [31, 60],
  dormant: [61, 120],
  both: [31, 120],
};

// Não insistir com quem foi contatado há pouco, por qualquer via — o
// PATCH /contact manual da tela grava o mesmo campo.
const CONTATO_RECENTE_DIAS = 30;

// Dedupe próprio da reativação: no máximo uma por cliente a cada 60
// dias. A guarda de frequência do waOutbox (7 dias) é sobre marketing em
// geral; esta é sobre não transformar reativação em perseguição.
const REATIVACAO_JANELA_DIAS = 60;

function normalizeSegment(segment) {
  const s = String(segment || 'at_risk');
  return SEGMENT_RANGES[s] ? s : 'at_risk';
}

// Candidatos do segmento. `today` permite reprocessar uma data (QA) sem
// mexer no relógio. Todos os $n são citados na consulta — Postgres conta
// pelo maior $n e um parâmetro sobrando derruba a query inteira.
async function loadCandidates(companyId, { today = null, segment = 'at_risk', limit = 30, customerIds = null } = {}) {
  const [minDias, maxDias] = SEGMENT_RANGES[normalizeSegment(segment)];
  const teto = Math.max(1, Math.min(Number(limit) || 30, 200));
  try {
    const { rows } = await db.query(
      `-- mkt:react-candidatos
       SELECT c.id, c.name, c.phone, c.email, c.total_spent, c.total_purchases,
              c.last_purchase_at, c.reactivation_status, c.reactivation_contacted_at,
              (COALESCE($2::date, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
                 - c.last_purchase_at::date) AS days_since
         FROM customers c
        WHERE c.company_id = $1
          AND c.is_active = true
          AND c.phone IS NOT NULL AND c.phone <> ''
          AND c.marketing_opt_out = false
          AND c.last_purchase_at IS NOT NULL
          AND (COALESCE($2::date, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
                 - c.last_purchase_at::date) BETWEEN $3 AND $4
          AND (c.reactivation_contacted_at IS NULL
               OR c.reactivation_status IS DISTINCT FROM 'contacted'
               OR c.reactivation_contacted_at < NOW() - ($5::int || ' days')::interval)
          AND ($6::text[] IS NULL OR c.id::text = ANY($6::text[]))
        ORDER BY c.total_spent DESC NULLS LAST, c.last_purchase_at ASC
        LIMIT $7`,
      [companyId, today, minDias, maxDias, CONTATO_RECENTE_DIAS,
       customerIds && customerIds.length ? customerIds.map(String) : null, teto]
    );
    return rows;
  } catch (e) {
    if (mkt.schemaMissing(e)) return [];
    throw e;
  }
}

// O manual (PATCH /:customerId/contact) grava exatamente isto. Só é
// chamado quando a fila ACEITOU o item: marcar "contatado" quem a guarda
// barrou esconderia da lojista justamente quem ela ainda precisa
// alcançar.
async function markContacted(companyId, customerId) {
  try {
    await db.query(
      `-- mkt:react-contatado
       UPDATE customers SET reactivation_status = 'contacted', reactivation_contacted_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
  } catch (e) {
    if (!mkt.schemaMissing(e)) throw e;
  }
}

// Chave de idempotência do mês: a mesma pessoa não recebe duas
// reativações no mesmo mês nem que a rotina rode toda semana.
function dedupeKey(customerId, ref) {
  const d = ref instanceof Date ? ref : new Date();
  const iso = new Date(d.getTime() - 3 * 3600000).toISOString();
  return `react-${customerId}-${iso.slice(0, 7)}`;
}

async function runForCompany(companyId, {
  today = null, dryRun = false, segment = 'at_risk', limit = 30, customerIds = null,
} = {}) {
  const seg = normalizeSegment(segment);
  const out = { enqueued: 0, skipped: {}, segment: seg, items: [] };
  const bump = (reason) => { out.skipped[reason] = (out.skipped[reason] || 0) + 1; };
  const pushItem = (c, reason) => {
    if (out.items.length < 200) {
      out.items.push({
        customer_id: c.id,
        customer_name: c.name || null,
        phone: c.phone || null,
        total_spent: c.total_spent != null ? Number(c.total_spent) : null,
        days_since: c.days_since != null ? Number(c.days_since) : null,
        reason,
      });
    }
  };

  // Gate da company inteira — os mesmos três motivos que a tela mostra
  // por baixo do interruptor travado, mais o consentimento (que só o
  // marketing exige).
  if (!(await addons.canAutoWhatsapp(companyId))) return { ...out, skipped_reason: 'ADDON_INATIVO' };
  const conn = await waOutbox.connectionState(companyId);
  if (!conn.connected) {
    return { ...out, skipped_reason: conn.token_expired ? 'TOKEN_EXPIRADO' : 'NAO_CONECTADO' };
  }
  if (!(await waOutbox.hasMarketingConsent(companyId))) {
    return { ...out, skipped_reason: 'SEM_CONSENTIMENTO' };
  }

  const candidatos = await loadCandidates(companyId, { today, segment: seg, limit, customerIds });
  if (!candidatos.length) return out;

  const storeName = await mkt.loadStoreName(companyId);
  const ref = mkt.hojeBRT(today);

  // Tetos são sobre ACÚMULO: no envio real quem aplica é o enqueue; na
  // prévia o acumulado é mantido aqui, na mesma ordem em que a rotina
  // enfileiraria (igual às prévias do dojô e do crediário). São DOIS
  // acúmulos desde a Fase 8b — o teto diário anti-rajada e a cota mensal
  // do plano — e a prévia precisa dos dois, senão ela promete 30 envios
  // para quem só tem 4 de cota sobrando.
  const tracker = quota.makeCapTracker({
    dailyCap: waOutbox.marketingDailyCap(),
    dailyUsed: dryRun ? await waOutbox.countMarketing(companyId, { todayOnly: true }) : 0,
    remaining: dryRun ? await quota.remainingThisMonth(companyId) : Infinity,
  });

  for (const c of candidatos) {
    if (await mkt.jaRecebeu(companyId, c.id, mkt.KIND_REATIVACAO, { days: REATIVACAO_JANELA_DIAS })) {
      bump('JA_ENVIADO'); pushItem(c, 'JA_ENVIADO'); continue;
    }

    // Guardas em modo leitura ANTES de criar o cupom. No envio real elas
    // rodam de novo dentro do enqueue (o estado pode mudar entre uma
    // coisa e outra) — aqui servem para não gerar cupom à toa.
    const sim = await waOutbox.simulate({
      companyId, toPhone: c.phone,
      templateName: mkt.TEMPLATE_REATIVACAO, templateLanguage: 'pt_BR',
      sourceType: mkt.KIND_REATIVACAO,
    });
    if (!sim.ok) { bump(sim.reason); pushItem(c, sim.reason); continue; }
    const limite = tracker.reason();
    if (limite) { bump(limite); pushItem(c, limite); continue; }

    if (dryRun) { tracker.bump(); out.enqueued++; continue; }

    const cupom = await mkt.createCoupon(companyId, c, mkt.KIND_REATIVACAO);
    if (!cupom) { bump('SEM_CUPOM'); pushItem(c, 'SEM_CUPOM'); continue; }

    const components = mkt.buildComponents({
      customerName: String(c.name || '').trim().split(/\s+/)[0] || 'Cliente',
      storeName,
      discountText: mkt.describeDiscount(cupom.discount_type, cupom.discount_value),
      validUntil: mkt.formatDateBR(cupom.expires_at),
      code: cupom.code,
    });

    const r = await waOutbox.enqueue({
      companyId,
      toPhone: c.phone,
      kind: 'template',
      templateName: mkt.TEMPLATE_REATIVACAO,
      templateLanguage: 'pt_BR',
      components,
      sourceType: mkt.KIND_REATIVACAO,
      sourceId: String(c.id),
      dedupeKey: dedupeKey(c.id, ref),
    });

    if (r.queued) {
      out.enqueued++;
      tracker.bump();
      await mkt.logMarketing({
        companyId, customerId: c.id, kind: mkt.KIND_REATIVACAO,
        segment: seg === 'both' ? (Number(c.days_since) > 60 ? 'dormant' : 'at_risk') : seg,
        couponId: cupom.id, waOutboxId: r.id,
        refYear: Number(new Date(ref).getUTCFullYear()),
      });
      await markContacted(companyId, c.id);
    } else {
      bump(r.reason || 'NAO_ENFILEIRADO');
      pushItem(c, r.reason || 'NAO_ENFILEIRADO');
    }
  }

  return out;
}

// Todas as lojas com a rotina ligada E o consentimento declarado. A
// falha de uma nunca derruba as outras.
async function runAll(today = null, { segment = 'at_risk', limit = 30 } = {}) {
  const ids = await mkt.listCompaniesWithAuto('wa_reactivation_auto');
  const agg = { companies: ids.length, enqueued: 0, skipped: {}, failed: 0 };
  for (const companyId of ids) {
    try {
      const r = await runForCompany(companyId, { today, segment, limit });
      agg.enqueued += r.enqueued;
      for (const [k, v] of Object.entries(r.skipped || {})) agg.skipped[k] = (agg.skipped[k] || 0) + v;
    } catch (e) {
      agg.failed++;
      console.error('[reactivationAuto] company', companyId, 'falhou:', e.message);
    }
  }
  return agg;
}

module.exports = {
  SEGMENT_RANGES, CONTATO_RECENTE_DIAS, REATIVACAO_JANELA_DIAS,
  normalizeSegment, loadCandidates, markContacted, dedupeKey,
  runForCompany, runAll,
};
