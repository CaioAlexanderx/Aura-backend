// ============================================================
// AURA. — Report Scheduler
// Dispara relatorios automaticos: semanal (seg 8h) e mensal (dia 1, 8h).
// Verifica a cada minuto se e hora de disparar.
//
// 11/05/2026: agora agrupa empresas por owner_id e gera UM relatorio
// consolidado por owner com siblings. Empresas standalone seguem como
// envio individual. Recipient usa companies.report_email_override ||
// companies.email.
// ============================================================

const db = require('../config/database');

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

async function getEligibleOwnerGroups() {
  const { rows } = await db.query(
    `SELECT id, owner_id, is_primary, created_at,
            COALESCE(trade_name, legal_name) AS name,
            email, plan,
            COALESCE(report_email_override, email) AS recipient_email,
            report_email_override IS NOT NULL AS has_override
       FROM companies
      WHERE is_active = true
        AND COALESCE(report_email_override, email) IS NOT NULL
        AND COALESCE(report_email_override, email) != ''
      ORDER BY owner_id NULLS LAST, is_primary DESC NULLS LAST, created_at ASC
      LIMIT 1000`
  );

  const groups = new Map();
  for (const r of rows) {
    const key = r.owner_id || `solo:${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const result = [];
  for (const members of groups.values()) {
    const primary = members.find(m => m.is_primary) || members[0];
    result.push({
      owner_id:  primary.owner_id,
      primary,
      all:       members,
      recipient: primary.recipient_email,
    });
  }
  return result;
}

async function triggerWeeklyReports() {
  console.log('[reportScheduler] iniciando relatorios semanais (grupo-by-owner)...');
  const start = Date.now();
  let sent = 0, skipped = 0, errors = 0;

  try {
    const {
      generateReport,
      generateConsolidatedReport,
      updateDelivery,
    } = require('../services/reportGenerator');
    const { sendWeeklyReport } = require('../services/mailer');

    const groups = await getEligibleOwnerGroups();
    console.log(`[reportScheduler] ${groups.length} grupo(s) elegivel(eis) para envio.`);

    for (const g of groups) {
      const ids = g.all.map(c => c.id);
      const consolidated = ids.length > 1;
      const label = consolidated
        ? `${g.primary.name} (+${ids.length - 1} unid.)`
        : g.primary.name;

      try {
        const result = consolidated
          ? await generateConsolidatedReport(ids, g.primary.id, 'weekly')
          : await generateReport(g.primary.id, 'weekly');

        if (result.skipped) {
          skipped++;
          console.log(`[reportScheduler] skipped (${result.reason}): ${label}`);
          continue;
        }

        const sendCompany = {
          ...result.company,
          email: result.company.recipient_email || g.recipient,
          name:  result.company.name || label,
        };
        await sendWeeklyReport(sendCompany, result.kpis, result.reportUrl);
        await updateDelivery(result.deliveryId, 'sent');
        sent++;
        console.log(`[reportScheduler] sent ${consolidated ? '[CONS]' : '[SINGLE]'} -> ${sendCompany.email}: ${label}`);
      } catch (err) {
        errors++;
        console.error(`[reportScheduler] error em ${label}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[reportScheduler] fatal:', err.message);
  }

  console.log(`[reportScheduler] semanal concluido em ${Date.now()-start}ms — sent=${sent} skipped=${skipped} errors=${errors}`);
}

let _lastWeeklyDate = null;
let _lastMonthlyDate = null;

function tick() {
  const now = nowBRT();
  const dow = now.getUTCDay();
  const dom = now.getUTCDate();
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  const dateStr = now.toISOString().slice(0, 10);

  if (dow === 1 && hour === 8 && min < 5 && _lastWeeklyDate !== dateStr) {
    _lastWeeklyDate = dateStr;
    triggerWeeklyReports().catch(e => console.error('[reportScheduler] weekly crash:', e.message));
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
  console.log('[reportScheduler] iniciado — verificando a cada minuto (seg 8h BRT = relatorio semanal)');
}

function stopReportScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initReportScheduler,
  stopReportScheduler,
  triggerWeeklyReports,
  getEligibleOwnerGroups,
};
