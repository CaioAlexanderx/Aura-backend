// ============================================================
// AURA — FASE 6: a régua do CREDIÁRIO pelo WhatsApp oficial
//
// Até aqui a régua de credit_collection_rules era só uma lista de
// intenções: nenhum job rodava, quem cobrava era uma pessoa abrindo o
// wa.me com o texto pronto. Este serviço é a pista AUTOMÁTICA — a mesma
// régua, enfileirando na wa_outbox e saindo pela Cloud API.
//
// Princípio nº 1 (spec do WhatsApp): CADA MENSAGEM CUSTA DINHEIRO.
// Por isso aqui não há guarda nova nenhuma: tudo o que pode barrar um
// envio (opt-out, janela, template não aprovado, telefone recusado pela
// Meta, fila pausada, teto diário, teto por contato) já vive no
// waOutbox.enqueue e é reforçado no despacho. Este arquivo só decide
// QUEM entra na fila e registra o histórico de quem entrou.
//
// A base da Valen tem 1938 parcelas abertas. O que impede um disparo de
// 1938 mensagens num dia é a combinação de duas coisas: a régua casa
// `due_date = hoje - days` (um dia de vencimento por regra, não a
// carteira inteira) e o teto diário da company no enqueue.
//
// Nada é gravado quando a fila NÃO aceita: sem evento, sem stage. A
// parcela volta a ser candidata amanhã se a régua ainda casar — o
// contrário (marcar como avisado o que nunca saiu) faria o cliente
// nunca mais receber aquela etapa da cobrança.
// ============================================================
'use strict';

const db = require('../../config/database');
const waOutbox = require('../waOutbox');
const addons = require('../addons');
const collectionNotice = require('./collectionNotice');

// Canal do histórico. 'whatsapp' continua sendo a pista MANUAL (wa.me);
// 'whatsapp_auto' é o que saiu pela fila paga — separar os dois é o que
// permite responder "esta cobrança custou dinheiro?" olhando a tabela.
const CHANNEL_AUTO = 'whatsapp_auto';

// Mapeamento regra → template aprovado na Meta (6c). A régua tem 6
// templates de TEXTO; a Meta só aprova 2 formatos para este caso, então
// os três avisos "antes/no dia" viram o lembrete e os dois de atraso
// viram a cobrança de atraso. `bloqueio` não é WhatsApp: é aviso de
// sistema (a mensagem fala em suspender crédito — não é utilitário de
// cobrança e não deve sair por template pago).
const RULE_TEMPLATE_MAP = {
  lembrete:    'parcela_lembrete',
  confirmacao: 'parcela_lembrete',
  vencimento:  'parcela_lembrete',
  atraso_1:    'parcela_atraso',
  atraso_2:    'parcela_atraso',
  bloqueio:    null,
};

const TEMPLATE_LEMBRETE = 'parcela_lembrete';
const TEMPLATE_ATRASO = 'parcela_atraso';

function templateForRule(ruleTemplate) {
  const key = String(ruleTemplate || 'lembrete');
  return Object.prototype.hasOwnProperty.call(RULE_TEMPLATE_MAP, key)
    ? RULE_TEMPLATE_MAP[key]
    : TEMPLATE_LEMBRETE;
}

// Parâmetro de template que a Meta ACEITA: nunca vazio, sem quebra de
// linha, sem tabulação e sem 4+ espaços seguidos — qualquer um desses
// devolve erro 132012 e queima a tentativa (paga) do envio.
function waParam(value, fallback) {
  const txt = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
  return txt || String(fallback);
}

// Pix ausente não pode virar parâmetro vazio: a mensagem continua
// fazendo sentido mandando a pessoa à loja.
const PIX_FALLBACK = 'Pague na loja ou fale conosco';

// Os 6 parâmetros do corpo, na ordem dos dois presets:
//   {{1}} cliente · {{2}} loja · {{3}} parcela x/y · {{4}} valor
//   {{5}} vencimento (lembrete) ou dias em atraso · {{6}} Pix
function buildComponents(composed, { templateName, daysLate }) {
  const quinto = templateName === TEMPLATE_ATRASO
    ? waParam(Math.max(0, Number(daysLate) || 0), '1')
    : waParam(composed.due_date_br, 'em breve');
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: waParam(composed.customer_name, 'Cliente') },
      { type: 'text', text: waParam(composed.store_name, 'Loja') },
      { type: 'text', text: waParam(composed.installment_label, '1/1') },
      { type: 'text', text: waParam(composed.amount_br, 'a combinar') },
      { type: 'text', text: quinto },
      { type: 'text', text: waParam(composed.pix_text, PIX_FALLBACK) },
    ],
  }];
}

// Régua da company. SELECT * de propósito: `whatsapp_auto` chega na 330
// e, com a migration pendente, a coluna simplesmente não vem na linha —
// vira `undefined` e o automático fica desligado, sem 42703 nenhum para
// tratar. 42P01 (tabela inteira ausente) → sem régua.
async function loadRules(companyId) {
  try {
    const { rows } = await db.query(
      `-- cred:auto-rules
       SELECT * FROM credit_collection_rules WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

function parseRules(raw) {
  if (!raw) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (_) { return []; }
  }
  return Array.isArray(arr) ? arr : [];
}

// Parcelas que a regra alcança HOJE. `days` é relativo ao vencimento e
// negativo quer dizer "antes": due_date = hoje - days resolve os dois
// lados com a mesma conta (days -3 → vence daqui a 3 dias; days 3 →
// venceu há 3 dias). Saldo = amount_due - covered_amount: parcela já
// coberta pelo FIFO não é cobrada, mesmo que o status ainda não tenha
// virado.
async function loadInstallmentsForRule(companyId, { today, days }) {
  try {
    const { rows } = await db.query(
      `-- cred:auto-parcelas
       SELECT ci.id, ci.company_id, ci.customer_id, ci.installment_number, ci.total_installments,
              ci.amount_due, ci.covered_amount, ci.due_date, ci.status, ci.pix_link,
              ci.late_fee, ci.late_interest, ci.collection_stage,
              COALESCE(cu.name, cu.phone) AS customer_name, cu.phone,
              COALESCE(co.trade_name, co.legal_name) AS store_name
         FROM credit_installments ci
         LEFT JOIN customers cu ON cu.id = ci.customer_id AND cu.company_id = ci.company_id
         LEFT JOIN companies  co ON co.id = ci.company_id
        WHERE ci.company_id = $1
          AND ci.status IN ('pending','overdue')
          AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0
          AND ci.due_date = (COALESCE($2::date, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date) - $3::int)
        ORDER BY ci.due_date ASC, ci.id ASC`,
      [companyId, today || null, days]
    );
    return rows;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return [];
    throw e;
  }
}

// Dedupe forte: a MESMA parcela não recebe o MESMO template de novo,
// nem que a régua rode duas vezes no dia ou que alguém reprocesse uma
// data antiga. O dedupeKey da fila cobre o mesmo caso; aqui a checagem
// é antes, para não gastar nem a ida ao enqueue.
async function alreadyNotified(installmentId, templateName) {
  try {
    const { rows } = await db.query(
      `-- cred:auto-ja-enviado
       SELECT 1 FROM credit_collection_events
        WHERE installment_id = $1 AND channel = $2 AND template = $3
        LIMIT 1`,
      [installmentId, CHANNEL_AUTO, templateName]
    );
    return rows.length > 0;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return false;
    throw e;
  }
}

// Histórico + estágio. Só é chamado quando a fila ACEITOU o item.
// 42P01/42703 em silêncio: perder o histórico é ruim, mas derrubar a
// régua depois de a mensagem já estar enfileirada seria pior (viraria
// reenvio no próximo tick).
async function recordEvent({ installmentId, templateName, daysRelative, preview }) {
  try {
    await db.query(
      `-- cred:auto-evento
       INSERT INTO credit_collection_events
         (installment_id, channel, template, days_relative, status, message_preview)
       VALUES ($1, '${CHANNEL_AUTO}', $2, $3, 'queued', $4)`,
      [installmentId, templateName, daysRelative, preview ? String(preview).slice(0, 300) : null]
    );
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  try {
    await db.query(
      `-- cred:auto-stage
       UPDATE credit_installments
          SET collection_stage = collection_stage + 1, updated_at = NOW()
        WHERE id = $1`,
      [installmentId]
    );
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
}

// Roda a régua de UMA company. `dryRun` é a prévia: mesma seleção,
// mesmas guardas (em modo leitura, via waOutbox.simulate), zero escrita.
//
// Retorno: { enqueued, skipped: {MOTIVO: n}, rules, items, skipped_reason }.
// `skipped_reason` só aparece quando a company inteira foi barrada — é o
// que a tela mostra por baixo do interruptor travado.
async function runForCompany(companyId, { today = null, dryRun = false } = {}) {
  const out = { enqueued: 0, skipped: {}, rules: 0, items: [] };
  const bump = (reason) => { out.skipped[reason] = (out.skipped[reason] || 0) + 1; };
  const pushItem = (inst, reason) => {
    if (out.items.length < 200) {
      out.items.push({
        installment_id: inst.id,
        student_name: inst.customer_name || null,
        phone: inst.phone || null,
        amount: inst.amount_due != null ? Number(inst.amount_due) : null,
        due_date: inst.due_date,
        reason,
      });
    }
  };

  const regra = await loadRules(companyId);
  if (!regra) return { ...out, skipped_reason: 'SEM_REGUA' };
  if (regra.enabled === false) return { ...out, skipped_reason: 'REGUA_DESLIGADA' };
  if (regra.whatsapp_auto !== true) return { ...out, skipped_reason: 'AUTO_DESLIGADO' };

  // O interruptor pode estar ligado de quando o plano era outro; a
  // coluna no banco não sabe disso. Sem plano/adicional, nada sai.
  if (!(await addons.canAutoWhatsapp(companyId))) return { ...out, skipped_reason: 'ADDON_INATIVO' };

  const conn = await waOutbox.connectionState(companyId);
  if (!conn.connected) {
    return { ...out, skipped_reason: conn.token_expired ? 'TOKEN_EXPIRADO' : 'NAO_CONECTADO' };
  }

  // Tetos: no envio real quem aplica é o enqueue. Na prévia simulate()
  // não tem memória entre itens, então o acumulado é mantido aqui, na
  // MESMA ordem em que a régua enfileiraria (igual ao preview do dojô).
  const dailyLimit = waOutbox.dailyCap();
  const perPhoneLimit = waOutbox.perPhoneDailyCap();
  let dailyCount = dryRun ? await waOutbox.countToday(companyId, {}) : 0;
  const phoneCounts = new Map();

  for (const rule of parseRules(regra.rules)) {
    if (!rule || rule.active === false) continue;
    if (rule.channel !== 'whatsapp') continue;
    const templateName = templateForRule(rule.template);
    if (!templateName) continue; // 'bloqueio' é aviso de sistema, não WhatsApp
    const days = Number(rule.days);
    if (!Number.isFinite(days)) continue;
    out.rules++;

    const parcelas = await loadInstallmentsForRule(companyId, { today, days });
    for (const inst of parcelas) {
      const phone = waOutbox.normalizePhone(inst.phone);
      if (!phone) { bump('SEM_TELEFONE'); pushItem(inst, 'SEM_TELEFONE'); continue; }

      if (await alreadyNotified(inst.id, templateName)) {
        bump('JA_ENVIADO'); pushItem(inst, 'JA_ENVIADO'); continue;
      }

      const composed = await collectionNotice.composeNotice({
        companyId, template: rule.template || 'lembrete', row: inst, today,
      });
      if (!composed) { bump('SEM_DADOS'); continue; }

      const components = buildComponents(composed, { templateName, daysLate: days });

      if (dryRun) {
        const sim = await waOutbox.simulate({
          companyId, toPhone: inst.phone, templateName, templateLanguage: 'pt_BR',
        });
        if (!sim.ok) { bump(sim.reason); pushItem(inst, sim.reason); continue; }
        if (dailyCount >= dailyLimit) { bump('LIMITE_DIARIO'); pushItem(inst, 'LIMITE_DIARIO'); continue; }
        if (!phoneCounts.has(phone)) {
          phoneCounts.set(phone, await waOutbox.countToday(companyId, { phone }));
        }
        const usados = phoneCounts.get(phone);
        if (usados >= perPhoneLimit) { bump('LIMITE_POR_CONTATO'); pushItem(inst, 'LIMITE_POR_CONTATO'); continue; }
        dailyCount++;
        phoneCounts.set(phone, usados + 1);
        out.enqueued++;
        continue;
      }

      const r = await waOutbox.enqueue({
        companyId,
        toPhone: inst.phone,
        kind: 'template',
        templateName,
        templateLanguage: 'pt_BR',
        components,
        sourceType: 'crediario',
        sourceId: String(inst.id),
        dedupeKey: `cred-${inst.id}-${templateName}`,
      });

      if (r.queued) {
        out.enqueued++;
        await recordEvent({
          installmentId: inst.id,
          templateName,
          daysRelative: days,
          preview: composed.message,
        });
      } else {
        bump(r.reason || 'NAO_ENFILEIRADO');
        pushItem(inst, r.reason || 'NAO_ENFILEIRADO');
      }
    }
  }

  return out;
}

// Todas as companies com a régua e o automático ligados. 42P01/42703
// (330 pendente ou tabela ausente no CI) → lista vazia: o job vira no-op
// silencioso em vez de logar erro a cada dia.
async function listEnabledCompanies() {
  try {
    const { rows } = await db.query(
      `-- cred:auto-companies
       SELECT company_id FROM credit_collection_rules
        WHERE enabled = true AND whatsapp_auto = true`
    );
    return rows.map((r) => r.company_id);
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return [];
    throw e;
  }
}

// A falha de uma loja nunca derruba as outras: são cobranças de lojistas
// diferentes, sem relação entre si.
async function runAll(today = null) {
  const ids = await listEnabledCompanies();
  const agg = { companies: ids.length, enqueued: 0, skipped: {}, failed: 0 };
  for (const companyId of ids) {
    try {
      const r = await runForCompany(companyId, { today });
      agg.enqueued += r.enqueued;
      for (const [k, v] of Object.entries(r.skipped || {})) agg.skipped[k] = (agg.skipped[k] || 0) + v;
    } catch (e) {
      agg.failed++;
      console.error('[creditCollectionAuto] company', companyId, 'falhou:', e.message);
    }
  }
  return agg;
}

module.exports = {
  CHANNEL_AUTO,
  RULE_TEMPLATE_MAP,
  TEMPLATE_LEMBRETE,
  TEMPLATE_ATRASO,
  PIX_FALLBACK,
  templateForRule,
  waParam,
  buildComponents,
  // composeNotice mora em collectionNotice (é lá que estão o Pix e os
  // encargos); re-exportado aqui porque é a peça que a régua automática
  // usa e quem procurar por ela vai procurar neste arquivo.
  composeNotice: collectionNotice.composeNotice,
  loadRules,
  parseRules,
  loadInstallmentsForRule,
  alreadyNotified,
  recordEvent,
  runForCompany,
  runAll,
  listEnabledCompanies,
};
