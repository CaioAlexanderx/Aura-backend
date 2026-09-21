// ============================================================
// AURA — Otica (334): lembretes automaticos pelo WhatsApp oficial
//
// DIARIO, 10h00 BRT — depois da regua do crediario (9h) e do aniversario
// (9h30), pelo mesmo motivo que separa os dois: cobranca, parabens e
// pos-venda do MESMO cliente nao podem sair no mesmo minuto pelo mesmo
// numero.
//
// Duas reguas, cada uma ligada por loja em companies.otica_settings:
//
//   wa_adaptation_auto → pos-venda de ADAPTACAO: 3 dias depois da
//     entrega, "como esta a adaptacao?". Utilidade (otica_adaptacao):
//     e resposta a uma compra, nao promocao.
//
//   wa_revision_auto → REVISAO DA RECEITA: 30 dias antes de vencer,
//     "revise a receita com seu oftalmologista". Marketing
//     (otica_revisao): e convite pra voltar a loja — a fila aplica
//     consentimento e cota sozinha, este job nao precisa saber.
//
// DADO DE SAUDE: nenhum parametro de template leva grau, prescritor ou
// validade. Primeiro nome e nome da loja, e so.
//
// Idempotente por linha: adaptation_notified_at / revisao_notified_at
// marcam o que ja saiu, e o dedupeKey da fila segura a corrida entre dois
// processos. Kill switch OTICA_WA_AUTO_ENABLED (default ligado).
// ============================================================
'use strict';

const db = require('../config/database');
const waOutbox = require('../services/waOutbox');
const { waParam, primeiroNome } = require('../routes/otica');

const ADAPTACAO_DIAS_APOS_ENTREGA = 3;
const REVISAO_DIAS_ANTES_VENCER = 30;

function habilitado() {
  return String(process.env.OTICA_WA_AUTO_ENABLED || 'true').toLowerCase() !== 'false';
}

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

function schemaMissing(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

// Lojas com a otica ligada. otica_settings vem inteiro; quem decide o que
// esta ligado e cada regua.
async function lojasComOtica() {
  try {
    const { rows } = await db.query(
      `-- otica:lojas-ativas
       SELECT id, COALESCE(trade_name, legal_name) AS loja, otica_settings
         FROM companies
        WHERE pdv_settings->>'otica_enabled' = 'true'`
    );
    return rows;
  } catch (e) {
    if (schemaMissing(e)) return [];
    throw e;
  }
}

function componentes(nome, loja) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: waParam(primeiroNome(nome), 'Cliente') },
      { type: 'text', text: waParam(loja, 'Loja') },
    ],
  }];
}

// ── Pos-venda de adaptacao ──────────────────────────────────
async function reguaAdaptacao(company, today, out) {
  let alvos;
  try {
    const { rows } = await db.query(
      `-- otica:adaptacao-alvos
       SELECT so.id, c.name AS customer_name, c.phone
         FROM service_orders so
         JOIN customers c ON c.id = so.customer_id
        WHERE so.company_id = $1
          AND so.kind = 'otica'
          AND so.status = 'entregue'
          AND so.adaptation_notified_at IS NULL
          AND (so.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date = $2::date - $3::int
          AND NULLIF(TRIM(c.phone), '') IS NOT NULL
        ORDER BY so.delivered_at ASC
        LIMIT 200`,
      [company.id, today, ADAPTACAO_DIAS_APOS_ENTREGA]
    );
    alvos = rows;
  } catch (e) {
    if (schemaMissing(e)) return;
    throw e;
  }

  for (const os of alvos) {
    try {
      const r = await waOutbox.enqueue({
        companyId: company.id,
        toPhone: os.phone,
        kind: 'template',
        templateName: 'otica_adaptacao',
        templateLanguage: 'pt_BR',
        components: componentes(os.customer_name, company.loja),
        sourceType: 'otica_adaptacao',
        sourceId: String(os.id),
        dedupeKey: `otica_adaptacao:${os.id}`,
      });
      if (r && r.queued) {
        out.enqueued++;
        await db.query(
          'UPDATE service_orders SET adaptation_notified_at = NOW() WHERE id = $1 AND company_id = $2',
          [os.id, company.id]
        );
      } else {
        out.skipped++;
      }
    } catch (e) {
      out.failed++;
      console.error('[oticaReminder] adaptacao falhou — os', os.id, e.message);
    }
  }
}

// ── Revisao da receita ──────────────────────────────────────
async function reguaRevisao(company, today, out) {
  let alvos;
  try {
    const { rows } = await db.query(
      `-- otica:revisao-alvos
       SELECT p.id, c.id AS customer_id, c.name AS customer_name, c.phone
         FROM optical_prescriptions p
         JOIN customers c ON c.id = p.customer_id
        WHERE p.company_id = $1
          AND p.revisao_notified_at IS NULL
          AND p.valid_until = $2::date + $3::int
          AND c.is_active = true
          AND NULLIF(TRIM(c.phone), '') IS NOT NULL
        ORDER BY p.valid_until ASC
        LIMIT 200`,
      [company.id, today, REVISAO_DIAS_ANTES_VENCER]
    );
    alvos = rows;
  } catch (e) {
    if (schemaMissing(e)) return;
    throw e;
  }

  for (const rx of alvos) {
    try {
      const r = await waOutbox.enqueue({
        companyId: company.id,
        toPhone: rx.phone,
        kind: 'template',
        templateName: 'otica_revisao',
        templateLanguage: 'pt_BR',
        components: componentes(rx.customer_name, company.loja),
        sourceType: 'otica_revisao',
        sourceId: String(rx.id),
        // Marketing: a guarda de consentimento (340) olha o cliente, não
        // só o telefone.
        customerId: rx.customer_id || null,
        dedupeKey: `otica_revisao:${rx.id}`,
      });
      if (r && r.queued) {
        out.enqueued++;
        await db.query(
          'UPDATE optical_prescriptions SET revisao_notified_at = $1::date WHERE id = $2 AND company_id = $3',
          [today, rx.id, company.id]
        );
      } else {
        out.skipped++;
      }
    } catch (e) {
      out.failed++;
      console.error('[oticaReminder] revisao falhou — receita', rx.id, e.message);
    }
  }
}

// `today` (YYYY-MM-DD) permite ao QA rodar outro dia sem mexer no relogio;
// sem ele, e a data de Sao Paulo.
async function runOticaReminders(today = null) {
  const dia = today || nowBRT().toISOString().slice(0, 10);
  const out = { companies: 0, enqueued: 0, skipped: 0, failed: 0 };

  const lojas = await lojasComOtica();
  for (const company of lojas) {
    const s = (company.otica_settings && typeof company.otica_settings === 'object') ? company.otica_settings : {};
    if (s.wa_adaptation_auto !== true && s.wa_revision_auto !== true) continue;
    out.companies++;
    try {
      if (s.wa_adaptation_auto === true) await reguaAdaptacao(company, dia, out);
      if (s.wa_revision_auto === true) await reguaRevisao(company, dia, out);
    } catch (e) {
      out.failed++;
      console.error('[oticaReminder] company', company.id, 'falhou:', e.message);
    }
  }
  return out;
}

async function triggerOticaReminders(today = null) {
  const start = Date.now();
  try {
    const r = await runOticaReminders(today);
    // Silencio quando nada saiu: a linha no log quer dizer mensagem paga.
    if (r.enqueued > 0 || r.failed > 0) {
      console.log(`[oticaReminder] concluido em ${Date.now() - start}ms — lojas=${r.companies} enfileiradas=${r.enqueued} puladas=${r.skipped} falhas=${r.failed}`);
    }
    return r;
  } catch (e) {
    if (schemaMissing(e)) return null; // 334 pendente
    console.error('[oticaReminder] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  if (!habilitado()) return;
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  // Janela 10h00–10h04 BRT; trava por data garante 1x/dia.
  if (now.getUTCHours() === 10 && now.getUTCMinutes() < 5 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerOticaReminders().catch((e) => console.error('[oticaReminder] crash:', e.message));
  }
}

let _interval = null;

function initOticaReminderJob() {
  if (_interval) return;
  if (!habilitado()) {
    console.log('[oticaReminder] desligado por OTICA_WA_AUTO_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, 60 * 1000);
  console.log('[oticaReminder] scheduler iniciado — diario 10h BRT (adaptacao + revisao da receita)');
}

function stopOticaReminderJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initOticaReminderJob,
  stopOticaReminderJob,
  triggerOticaReminders,
  runOticaReminders,
};
