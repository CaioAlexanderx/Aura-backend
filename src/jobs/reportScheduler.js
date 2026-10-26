// ============================================================
// AURA. — Report Scheduler
// Dispara o relatorio semanal no dia e na hora que cada empresa escolheu.
// Verifica a cada minuto.
//
// 11/05/2026 v3: allowlist por companies.weekly_report_enabled (migration
// 105). Grupos por owner_id geram relatorio consolidado quando ids.length > 1.
//
// 24/10/2026 v4 (tq-88): preferencias por empresa (company_email_prefs,
// migration 409; services/emailPreferencias):
//   - entra a empresa com o relatorio ligado (linha ausente = padrao ligado;
//     conta interna so com linha explicita), ativa, fora de sandbox e do
//     Karate, e com teste vigente ou billing_status = 'active';
//   - dia e hora vem da primaria do grupo (padrao segunda, 8h, BRT). Sai no
//     dia escolhido a partir da hora escolhida: um reinicio no meio do dia
//     ainda envia, e nada sai em outro dia (sem retroativo);
//   - destinatarios = enderecos confirmados marcados para o relatorio;
//   - idempotencia no email_log (chave relatorio:<primaria>:<inicio do
//     periodo>), reservada ANTES de gerar: reinicio, dois ticks ou duas
//     instancias nunca mandam o mesmo relatorio duas vezes. report_deliveries
//     continua com o status de cada tentativa.
// A trava em memoria virou so "nao rodar dois ticks ao mesmo tempo".
//
// 24/10/2026 (tq-110): empresa marcada "Nao quer" (nota mais recente com
// resultado = 'nao_quer', emailPreferencias.sqlMarcaNaoQuer) sai da lista.
// No consolidado, ela sai do grupo do dono; com todas marcadas, nada sai.
// O "Me enviar um agora" e pedido do dono e continua valendo.
//
// 26/10/2026 (hotfix): so entra no relatorio a empresa criada ANTES do fim
// do periodo reportado (endDate, data de Brasilia, inclusivo). Sem isso a
// conta criada na segunda a tarde entrava na janela (dia escolhido, a partir
// da hora) e recebia, segundos depois do cadastro, o relatorio de uma semana
// em que ainda nao existia. No grupo, a loja criada durante a semana
// reportada entra (o relatorio marca "comecou em dd/mm"); a criada depois do
// fim do periodo fica fora.
// ============================================================

const db = require('../config/database');
const P = require('../services/emailPreferencias');
// tq-113 (26/10/2026): conta pendente (dono nunca confirmou o e-mail) não recebe o relatório.
const { semPendente } = require('../utils/contaPendente');
const { reservarEnvio, marcarEnviado, marcarFalha } = require('../services/emailLog');
const { resolvePeriodForReport } = require('../services/reportDataQueries');

const VERTICAIS_FORA = ['karate_dojo', 'karate_federation'];
const MAX_AGORA_POR_DIA = 3;

function nowBRT(now = Date.now()) {
  return new Date(now - 3 * 3600000);
}

/**
 * Empresas que podem receber o relatorio agora (antes do filtro de dia e
 * hora). Uma consulta so; sem a tabela 409 (42P01) cai na allowlist antiga.
 */
async function empresasElegiveis({ env = process.env } = {}) {
  const padraoLigado = P.relatorioPadraoLigado(env);
  // Fim do periodo reportado: 'YYYY-MM-DD' (BRT, inclusivo). Empresa criada a
  // partir da meia-noite de Sao Paulo do dia seguinte nao tinha movimento.
  const fimDoPeriodo = resolvePeriodForReport('weekly').endDate;
  const params = [VERTICAIS_FORA, padraoLigado, fimDoPeriodo];
  const filtros = (pFim) => `
        c.is_active = true
    AND COALESCE(c.is_sandbox, false) = false
    AND COALESCE(c.vertical, '') <> ALL($1::text[])
    AND COALESCE(c.vertical_active, '') <> ALL($1::text[])
    AND NOT ${P.sqlMarcaNaoQuer('c.id')}
    AND ${semPendente('c')}
    AND c.created_at < ((${pFim}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
  const interna = `(COALESCE(u.is_staff, false) = true
                    OR lower(COALESCE(u.email, '')) LIKE '%@getaura.com.br'
                    OR lower(COALESCE(c.email, '')) LIKE '%@getaura.com.br')`;
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.owner_id, c.is_primary, c.created_at,
              COALESCE(c.trade_name, c.legal_name) AS name, c.plan,
              u.email AS owner_email,
              p.ligado AS pref_ligado, p.config AS pref_config,
              ${interna} AS interna
         FROM companies c
         LEFT JOIN users u ON u.id = c.owner_id
         LEFT JOIN company_email_prefs p ON p.company_id = c.id AND p.tipo = 'relatorio'
        WHERE ${filtros('$3')}
          AND (p.ligado = true OR (p.ligado IS NULL AND $2::boolean AND NOT ${interna}))
          AND (
                ${interna}
             OR c.billing_status = 'active'
             OR (COALESCE(c.billing_status, 'trial') = 'trial' AND c.trial_ends_at > NOW())
          )
        ORDER BY c.owner_id NULLS LAST, c.is_primary DESC NULLS LAST, c.created_at ASC
        LIMIT 2000`,
      params
    );
    return rows;
  } catch (err) {
    if (err && err.code !== '42P01') throw err;
    // Deploy antes da migration 409: so a allowlist de sempre.
    const { rows } = await db.query(
      `SELECT c.id, c.owner_id, c.is_primary, c.created_at,
              COALESCE(c.trade_name, c.legal_name) AS name, c.plan,
              u.email AS owner_email, true AS pref_ligado, '{}'::jsonb AS pref_config,
              false AS interna, true AS legado,
              lower(COALESCE(NULLIF(c.report_email_override, ''), c.email)) AS legado_email
         FROM companies c
         LEFT JOIN users u ON u.id = c.owner_id
        WHERE ${filtros('$2')}
          AND c.weekly_report_enabled = true
        ORDER BY c.owner_id NULLS LAST, c.is_primary DESC NULLS LAST, c.created_at ASC
        LIMIT 2000`,
      [VERTICAIS_FORA, fimDoPeriodo]
    );
    return rows;
  }
}

/** Periodo do relatorio gerado, no formato do e-mail (tq-85). */
function periodoDoResultado(result) {
  const p = result && result.period;
  return p ? { inicio: p.startDate, fim: p.endDate } : null;
}

/** Agrupa por dono: a primaria do grupo decide dia, hora e destinatarios. */
function agruparPorDono(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.owner_id || `solo:${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const result = [];
  for (const members of groups.values()) {
    const primary = members.find((m) => m.is_primary) || members[0];
    const pref = P.preferenciaEfetiva('relatorio', { ligado: true, config: primary.pref_config || {} });
    result.push({ owner_id: primary.owner_id, primary, all: members, config: pref.config });
  }
  return result;
}

/** O grupo esta na janela: dia escolhido, a partir da hora escolhida (BRT). */
function naJanela(config, now = Date.now()) {
  const t = nowBRT(now);
  return t.getUTCDay() === config.dia && t.getUTCHours() >= config.hora;
}

/** Compatibilidade: os grupos elegiveis (sem o filtro de dia e hora). */
async function getEligibleOwnerGroups(opts = {}) {
  return agruparPorDono(await empresasElegiveis(opts));
}

async function jaEnviadoNoPeriodo(primaryId, periodStart) {
  const { rows } = await db.query(
    `SELECT 1 FROM report_deliveries
      WHERE company_id = $1 AND report_type = 'weekly' AND period_start = $2 AND status = 'sent'
      LIMIT 1`,
    [primaryId, periodStart]
  );
  return rows.length > 0;
}

/**
 * Gera e envia o relatorio de um grupo, com a reserva no email_log feita
 * antes de gerar. Devolve 'sent' | 'skipped' | 'duplicate' | 'failed'.
 */
async function enviarGrupo(g, { now = Date.now(), env = process.env, contadores } = {}) {
  const {
    generateReport,
    generateConsolidatedReport,
    updateDelivery,
  } = require('../services/reportGenerator');
  const { sendWeeklyReport } = require('../services/mailer');

  const ids = g.all.map((c) => c.id);
  const consolidated = ids.length > 1;
  const label = consolidated ? `${g.primary.name} (+${ids.length - 1} unid.)` : g.primary.name;
  const period = resolvePeriodForReport('weekly');

  if (await jaEnviadoNoPeriodo(g.primary.id, period.startDate)) return 'duplicate';

  // Sem a 409 (legado): o destinatário de sempre.
  const destinatarios = g.primary.legado
    ? [P.normalizarEmail(g.primary.legado_email)].filter(Boolean)
    : await P.destinatariosDoTipo(db, g.primary.id, 'relatorio', {
      prefs: { relatorio: { config: g.config } },
      dono: { email: P.normalizarEmail(g.primary.owner_email) },
      env,
    });
  if (!destinatarios.length) {
    console.log(`[reportScheduler] skipped (sem destinatario confirmado): company=${g.primary.id}`);
    return 'skipped';
  }

  const chave = `relatorio:${g.primary.id}:${period.startDate}`;
  const logId = await reservarEnvio(db, {
    chave, tipo: 'relatorio_semanal', companyId: g.primary.id, userId: g.primary.owner_id || null,
    destinatario: destinatarios, assunto: `Relatório semanal — ${label}`,
    metadata: { periodo: period.startDate, consolidado: consolidated, empresas: ids.length },
  });
  if (!logId) return 'duplicate';

  let result;
  try {
    // tq-85: a config da primária decide versão e blocos do grupo.
    result = consolidated
      ? await generateConsolidatedReport(ids, g.primary.id, 'weekly', null, { destinatarios, config: g.config })
      : await generateReport(g.primary.id, 'weekly', null, { destinatarios, config: g.config });
  } catch (err) {
    await marcarFalha(db, logId, 'gerar: ' + err.message).catch(() => {});
    throw err;
  }
  if (result.skipped) {
    // Corrida com outro envio (already_sent): solta a reserva sem contar.
    await db.query(`DELETE FROM email_log WHERE id = $1 AND status = 'reserved'`, [logId]).catch(() => {});
    console.log(`[reportScheduler] skipped (${result.reason}): ${label}`);
    return 'skipped';
  }

  const sendCompany = {
    ...result.company,
    // tq-74: o id da primaria assina o link de descadastro (no consolidado,
    // desliga o grupo inteiro do dono).
    id:    g.primary.id,
    email: destinatarios[0],
    name:  result.company.name || label,
  };
  let envio;
  try {
    envio = await sendWeeklyReport(sendCompany, result.kpis, result.reportUrl, {
      grupo: consolidated, destinatarios, config: g.config, registrado: true,
      relatorio: result.relatorio, versao: result.versao, periodo: periodoDoResultado(result),
    });
  } catch (sendErr) {
    await marcarFalha(db, logId, sendErr.message).catch(() => {});
    if (!(await updateDelivery(result.deliveryId, 'failed', { error: sendErr.message })) && contadores) contadores.deliveryErrors++;
    throw sendErr;
  }
  const envioId = (envio && envio.id) || null;
  await marcarEnviado(db, logId, envioId).catch((e) => console.error('[reportScheduler] marcar enviado falhou:', e.message));
  if (!(await updateDelivery(result.deliveryId, 'sent', { resendId: envioId })) && contadores) contadores.deliveryErrors++;
  // Sem o e-mail do destinatario no log: empresa, entrega e id do envio.
  console.log(`[reportScheduler] sent ${consolidated ? '[CONS]' : '[SINGLE]'} company=${g.primary.id} delivery=${result.deliveryId} id=${envioId || '-'}: ${label}`);
  return 'sent';
}

/**
 * Tira os grupos cujo relatorio do periodo ja saiu (report_deliveries
 * 'sent') ou ja tem a chave tomada no email_log (enviado, em andamento ou
 * sem mais tentativas). Duas consultas por volta, em vez de uma por grupo a
 * cada minuto do resto do dia.
 */
async function semOsJaEnviados(groups, periodStart) {
  if (!groups.length) return groups;
  const ids = groups.map((g) => g.primary.id);
  const chaves = ids.map((id) => `relatorio:${id}:${periodStart}`);
  const feitos = new Set();
  const { rows: rd } = await db.query(
    `SELECT company_id FROM report_deliveries
      WHERE company_id = ANY($1::uuid[]) AND report_type = 'weekly' AND period_start = $2 AND status = 'sent'`,
    [ids, periodStart]
  );
  for (const r of rd || []) feitos.add(String(r.company_id));
  try {
    const { rows: el } = await db.query(
      `SELECT company_id FROM email_log
        WHERE chave_idempotencia = ANY($1::text[])
          AND (status IN ('sent', 'reserved') OR tentativas >= $2)`,
      [chaves, require('../services/emailLog').MAX_TENTATIVAS]
    );
    for (const r of el || []) feitos.add(String(r.company_id));
  } catch (err) {
    if (err && err.code !== '42P01') throw err;
  }
  return groups.filter((g) => !feitos.has(String(g.primary.id)));
}

/**
 * Uma volta: envia para todo grupo que esta na janela agora.
 * `forcar` (testes): ignora o dia e a hora.
 */
async function triggerWeeklyReports({ now = Date.now(), env = process.env, forcar = false } = {}) {
  const start = Date.now();
  const c = { sent: 0, skipped: 0, errors: 0, duplicate: 0, deliveryErrors: 0 };
  try {
    const naHora = (await getEligibleOwnerGroups({ env })).filter((g) => forcar || naJanela(g.config, now));
    const groups = await semOsJaEnviados(naHora, resolvePeriodForReport('weekly').startDate);
    if (!groups.length) return c;
    console.log(`[reportScheduler] ${groups.length} grupo(s) na janela do relatorio semanal.`);
    for (const g of groups) {
      try {
        const r = await enviarGrupo(g, { now, env, contadores: c });
        c[r] = (c[r] || 0) + 1;
      } catch (err) {
        c.errors++;
        console.error(`[reportScheduler] error em ${g.primary.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[reportScheduler] fatal:', err.message);
  }
  if (c.sent || c.errors || c.skipped) {
    console.log(`[reportScheduler] semanal concluido em ${Date.now() - start}ms — sent=${c.sent} skipped=${c.skipped} errors=${c.errors} delivery_update_errors=${c.deliveryErrors}`);
  }
  return c;
}

// ── "Me enviar um agora" (tq-88) ────────────────────────────────

function hojeBRT(now = Date.now()) {
  return nowBRT(now).toISOString().slice(0, 10);
}

/**
 * Relatorio da empresa (so ela, a semana fechada mais recente) para o dono
 * que pediu, fora da agenda: nao conta como o envio da semana. Limite de
 * MAX_AGORA_POR_DIA por empresa e dia (BRT), pelo email_log; envio que
 * falhou nao gasta o limite.
 *
 * @returns {Promise<{ok, codigo?, para?, restantes?}>}
 */
async function enviarRelatorioAgora({ companyId, userId, email, now = Date.now() }) {
  const para = P.normalizarEmail(email);
  if (!para) return { ok: false, codigo: 'SEM_EMAIL' };
  const { generateReport } = require('../services/reportGenerator');
  const { sendWeeklyReport } = require('../services/mailer');

  const dia = hojeBRT(now);
  let logId = null;
  let n = 0;
  for (n = 1; n <= MAX_AGORA_POR_DIA && !logId; n++) {
    logId = await reservarEnvio(db, {
      chave: `relatorio-agora:${companyId}:${dia}:${n}`, tipo: 'relatorio_semanal',
      companyId, userId, destinatario: para, assunto: 'Relatório semanal (pedido agora)',
      metadata: { agora: true },
    });
  }
  if (!logId) return { ok: false, codigo: 'LIMITE_DIARIO', limite: MAX_AGORA_POR_DIA };
  const usados = n - 1;

  try {
    const prefs = await P.preferenciasDaEmpresa(db, companyId);
    const result = await generateReport(companyId, 'weekly', null, {
      destinatarios: [para], semEntrega: true, config: prefs.relatorio.config,
    });
    if (result.skipped) {
      await db.query(`DELETE FROM email_log WHERE id = $1 AND status = 'reserved'`, [logId]).catch(() => {});
      return { ok: false, codigo: 'RELATORIO_INDISPONIVEL' };
    }
    const envio = await sendWeeklyReport(
      { ...result.company, id: companyId, email: para, name: result.company.name },
      result.kpis, result.reportUrl,
      {
        destinatarios: [para], config: prefs.relatorio.config, registrado: true,
        relatorio: result.relatorio, versao: result.versao, periodo: periodoDoResultado(result),
      }
    );
    await marcarEnviado(db, logId, (envio && envio.id) || null).catch(() => {});
    return { ok: true, para, restantes: MAX_AGORA_POR_DIA - usados };
  } catch (err) {
    await marcarFalha(db, logId, err.message).catch(() => {});
    console.error(`[reportScheduler] relatorio agora falhou company=${companyId}: ${err.message}`);
    return { ok: false, codigo: 'ENVIO_FALHOU' };
  }
}

// ── Tick ────────────────────────────────────────────────────────

let _rodando = false;
let _lastMonthlyDate = null;

function tick() {
  const now = nowBRT();
  const dom = now.getUTCDate();
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  const dateStr = now.toISOString().slice(0, 10);

  // Toda volta (60 s) olha quem esta na janela. A reserva no email_log e a
  // trava de verdade; esta so evita duas voltas sobrepostas no processo.
  if (!_rodando) {
    _rodando = true;
    triggerWeeklyReports({ forcar: false })
      .catch((e) => console.error('[reportScheduler] weekly crash:', e.message))
      .finally(() => { _rodando = false; });
  }

  if (dom === 1 && hour === 8 && min < 5 && _lastMonthlyDate !== dateStr) {
    _lastMonthlyDate = dateStr;
    console.log('[reportScheduler] mensal pendente de implementacao');
  }
}

let _interval = null;

function initReportScheduler() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  console.log('[reportScheduler] iniciado — verificando a cada minuto (dia e hora por empresa, padrao seg 8h BRT)');
}

function stopReportScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  MAX_AGORA_POR_DIA,
  initReportScheduler,
  stopReportScheduler,
  triggerWeeklyReports,
  getEligibleOwnerGroups,
  empresasElegiveis,
  agruparPorDono,
  naJanela,
  enviarGrupo,
  enviarRelatorioAgora,
};
