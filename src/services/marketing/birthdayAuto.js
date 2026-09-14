// ============================================================
// AURA — FASE 8: aniversário pelo WhatsApp oficial
//
// O fluxo manual continua exatamente como era: o card mostra os
// aniversariantes, o dono cria o cupom (POST /birthday/create-coupon) e
// abre o wa.me com o texto pronto (POST /birthday/send-log registra).
// Isso é de graça e não passa por fila nenhuma. Esta é a pista PAGA, que
// faz a mesma coisa sozinha para quem ligou o automático.
//
// Uma mensagem por cliente por ANO. Duas garantias independentes:
//  - o índice único de wa_marketing_log (company, customer, kind, ano);
//  - o dedupeKey `bday-<cliente>-<ano>` da própria fila.
// E, antes das duas, a checagem no birthday_messages_sent — porque quem
// já mandou o parabéns pelo wa.me de manhã não pode receber outro pago
// à tarde.
// ============================================================
'use strict';

const db = require('../../config/database');
const waOutbox = require('../waOutbox');
const addons = require('../addons');
const mkt = require('./marketingCommon');

// Aniversariantes do dia. `today` (YYYY-MM-DD) é o que permite ao QA
// rodar o dia de ontem sem mexer no relógio do servidor; sem ele, a data
// é a de São Paulo — "hoje" para o lojista é o dia dele.
async function loadBirthdaysToday(companyId, { today = null, limit = 200, onlyOptIn = true } = {}) {
  const teto = Math.max(1, Math.min(Number(limit) || 200, 500));
  try {
    const { rows } = await db.query(
      `-- mkt:bday-do-dia
       SELECT c.id, c.name, c.phone, c.birth_date, c.marketing_opt_out
         FROM customers c
        WHERE c.company_id = $1
          AND c.is_active = true
          AND c.birth_date IS NOT NULL
          AND EXTRACT(MONTH FROM c.birth_date)
              = EXTRACT(MONTH FROM COALESCE($2::date, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date))
          AND EXTRACT(DAY FROM c.birth_date)
              = EXTRACT(DAY FROM COALESCE($2::date, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date))
          AND ($3::boolean IS NOT TRUE
               OR (c.marketing_opt_out = false AND c.phone IS NOT NULL AND c.phone <> ''))
        ORDER BY c.name ASC
        LIMIT $4`,
      [companyId, today, onlyOptIn, teto]
    );
    return rows;
  } catch (e) {
    if (mkt.schemaMissing(e)) return [];
    throw e;
  }
}

async function loadCustomer(companyId, customerId) {
  const { rows } = await db.query(
    `-- mkt:bday-cliente
     SELECT id, name, phone, birth_date, marketing_opt_out, is_active
       FROM customers WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [customerId, companyId]
  );
  return rows[0] || null;
}

// Já recebeu o parabéns deste ano — por QUALQUER via. O log de marketing
// cobre a pista paga; birthday_messages_sent cobre o wa.me manual, que
// continua sendo o caminho da maioria das lojas.
async function jaEnviouEsteAno(companyId, customerId, ano) {
  if (await mkt.jaRecebeu(companyId, customerId, mkt.KIND_ANIVERSARIO, { refYear: ano })) return true;
  try {
    const { rows } = await db.query(
      `-- mkt:bday-ja-enviado
       SELECT 1 FROM birthday_messages_sent
        WHERE company_id = $1 AND customer_id = $2 AND birthday_year = $3 LIMIT 1`,
      [companyId, customerId, ano]
    );
    return rows.length > 0;
  } catch (e) {
    if (mkt.schemaMissing(e)) return false;
    throw e;
  }
}

// Espelha o envio no histórico que o card já lê. `method` é 'wa_api'
// (valor que o CHECK da 065 aceita) e não 'whatsapp_auto': a coluna tem
// lista fechada e escrever um valor fora dela derrubaria o INSERT com
// 23514 em produção. 'wa_link' segue significando o envio manual.
async function recordBirthdaySent(companyId, { customerId, couponId, ano, userId = null, message = null }) {
  try {
    await db.query(
      `-- mkt:bday-historico
       INSERT INTO birthday_messages_sent
         (company_id, customer_id, coupon_id, method, birthday_year, user_id, message)
       VALUES ($1,$2,$3,'wa_api',$4,$5,$6)
       ON CONFLICT (company_id, customer_id, birthday_year) DO NOTHING`,
      [companyId, customerId, couponId || null, ano, userId, message]
    );
  } catch (e) {
    if (!mkt.schemaMissing(e)) throw e;
  }
}

// Envia (enfileira) o parabéns de UM cliente. É o miolo da rota
// POST /birthday/send-whatsapp e do job — um caminho só, para a tela e o
// automático nunca divergirem.
//
// Devolve sempre `{ queued, reason }`: motivo nunca vira exceção, porque
// "não mandei e este é o porquê" é informação que a tela mostra.
async function sendForCustomer(companyId, { customerId, couponId = null, today = null, userId = null } = {}) {
  const ref = mkt.hojeBRT(today);
  const ano = new Date(ref.getTime() - 3 * 3600000).getUTCFullYear();

  const cliente = await loadCustomer(companyId, customerId);
  if (!cliente || cliente.is_active === false) {
    return { queued: false, reason: 'CLIENTE_NAO_ENCONTRADO', status: 404, coupon: null };
  }
  if (cliente.marketing_opt_out === true) {
    return { queued: false, reason: 'OPT_OUT_MARKETING', coupon: null };
  }
  const phone = waOutbox.normalizePhone(cliente.phone);
  if (!phone) return { queued: false, reason: 'SEM_TELEFONE', coupon: null };

  if (await jaEnviouEsteAno(companyId, customerId, ano)) {
    return { queued: false, reason: 'JA_ENVIADO', coupon: null };
  }

  // Guardas em modo leitura antes de criar o cupom (o enqueue repete
  // todas): cupom criado para uma mensagem que a guarda vai barrar é
  // lixo no banco e desconto que ninguém prometeu.
  const sim = await waOutbox.simulate({
    companyId, toPhone: cliente.phone,
    templateName: mkt.TEMPLATE_ANIVERSARIO, templateLanguage: 'pt_BR',
    sourceType: mkt.KIND_ANIVERSARIO,
  });
  if (!sim.ok) return { queued: false, reason: sim.reason, coupon: null };

  const cupom = couponId
    ? await mkt.loadCoupon(companyId, couponId)
    : await mkt.createCoupon(companyId, cliente, mkt.KIND_ANIVERSARIO);
  if (!cupom) return { queued: false, reason: 'SEM_CUPOM', coupon: null };

  const storeName = await mkt.loadStoreName(companyId);
  const components = mkt.buildComponents({
    customerName: String(cliente.name || '').trim().split(/\s+/)[0] || 'Cliente',
    storeName,
    discountText: mkt.describeDiscount(cupom.discount_type, cupom.discount_value),
    validUntil: mkt.formatDateBR(cupom.expires_at),
    code: cupom.code,
  });

  const r = await waOutbox.enqueue({
    companyId,
    toPhone: cliente.phone,
    kind: 'template',
    templateName: mkt.TEMPLATE_ANIVERSARIO,
    templateLanguage: 'pt_BR',
    components,
    sourceType: mkt.KIND_ANIVERSARIO,
    sourceId: String(cliente.id),
    dedupeKey: `bday-${cliente.id}-${ano}`,
  });

  if (!r.queued) {
    return { queued: false, reason: r.reason || 'NAO_ENFILEIRADO', outbox_id: r.id || null, coupon: cupom };
  }

  await mkt.logMarketing({
    companyId, customerId: cliente.id, kind: mkt.KIND_ANIVERSARIO,
    couponId: cupom.id, waOutboxId: r.id, refYear: ano,
  });
  await recordBirthdaySent(companyId, {
    customerId: cliente.id, couponId: cupom.id, ano, userId,
    message: `[template ${mkt.TEMPLATE_ANIVERSARIO}] ${cupom.code}`,
  });

  return { queued: true, outbox_id: r.id, reason: null, coupon: cupom };
}

// Todos os aniversariantes do dia de UMA loja. `dryRun` é a prévia:
// mesma seleção, mesmas guardas em leitura, zero escrita.
async function runForCompany(companyId, { today = null, dryRun = false, limit = 200 } = {}) {
  const out = { enqueued: 0, skipped: {}, items: [] };
  const bump = (reason) => { out.skipped[reason] = (out.skipped[reason] || 0) + 1; };
  const pushItem = (c, reason) => {
    if (out.items.length < 200) {
      out.items.push({
        customer_id: c.id, customer_name: c.name || null,
        phone: c.phone || null, birth_date: c.birth_date, reason,
      });
    }
  };

  if (!(await addons.canAutoWhatsapp(companyId))) return { ...out, skipped_reason: 'ADDON_INATIVO' };
  const conn = await waOutbox.connectionState(companyId);
  if (!conn.connected) {
    return { ...out, skipped_reason: conn.token_expired ? 'TOKEN_EXPIRADO' : 'NAO_CONECTADO' };
  }
  if (!(await waOutbox.hasMarketingConsent(companyId))) {
    return { ...out, skipped_reason: 'SEM_CONSENTIMENTO' };
  }

  // Na prévia entram TODOS os aniversariantes do dia, inclusive os
  // pulados: a tela precisa mostrar "estes 3 não recebem, e por quê".
  const aniversariantes = await loadBirthdaysToday(companyId, { today, limit, onlyOptIn: !dryRun });
  if (!aniversariantes.length) return out;

  const ref = mkt.hojeBRT(today);
  const ano = new Date(ref.getTime() - 3 * 3600000).getUTCFullYear();
  const marketingLimit = waOutbox.marketingDailyCap();
  let marketingHoje = dryRun ? await waOutbox.countMarketing(companyId, { todayOnly: true }) : 0;

  for (const c of aniversariantes) {
    if (dryRun) {
      if (c.marketing_opt_out === true) { bump('OPT_OUT_MARKETING'); pushItem(c, 'OPT_OUT_MARKETING'); continue; }
      if (!waOutbox.normalizePhone(c.phone)) { bump('SEM_TELEFONE'); pushItem(c, 'SEM_TELEFONE'); continue; }
      if (await jaEnviouEsteAno(companyId, c.id, ano)) { bump('JA_ENVIADO'); pushItem(c, 'JA_ENVIADO'); continue; }
      const sim = await waOutbox.simulate({
        companyId, toPhone: c.phone,
        templateName: mkt.TEMPLATE_ANIVERSARIO, templateLanguage: 'pt_BR',
        sourceType: mkt.KIND_ANIVERSARIO,
      });
      if (!sim.ok) { bump(sim.reason); pushItem(c, sim.reason); continue; }
      if (marketingHoje >= marketingLimit) { bump('LIMITE_MARKETING'); pushItem(c, 'LIMITE_MARKETING'); continue; }
      marketingHoje++;
      out.enqueued++;
      continue;
    }

    const r = await sendForCustomer(companyId, { customerId: c.id, today });
    if (r.queued) out.enqueued++;
    else { bump(r.reason || 'NAO_ENFILEIRADO'); pushItem(c, r.reason || 'NAO_ENFILEIRADO'); }
  }

  return out;
}

async function runAll(today = null) {
  const ids = await mkt.listCompaniesWithAuto('wa_birthday_auto');
  const agg = { companies: ids.length, enqueued: 0, skipped: {}, failed: 0 };
  for (const companyId of ids) {
    try {
      const r = await runForCompany(companyId, { today });
      agg.enqueued += r.enqueued;
      for (const [k, v] of Object.entries(r.skipped || {})) agg.skipped[k] = (agg.skipped[k] || 0) + v;
    } catch (e) {
      agg.failed++;
      console.error('[birthdayAuto] company', companyId, 'falhou:', e.message);
    }
  }
  return agg;
}

module.exports = {
  loadBirthdaysToday, loadCustomer, jaEnviouEsteAno, recordBirthdaySent,
  sendForCustomer, runForCompany, runAll,
};
