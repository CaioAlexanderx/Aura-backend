// ============================================================
// AURA. — Report Scheduler
// Dispara relatórios automáticos: semanal (seg 8h) e mensal (dia 1, 8h).
// Verifica a cada minuto se é hora de disparar.
// ============================================================

const db = require('../config/database');

// Hora BRT = UTC - 3 (sem horário de verão desde 2019)
function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

async function getEligibleCompanies() {
  const { rows } = await db.query(
    `SELECT id, name, email, plan
     FROM companies
     WHERE is_active = true
       AND email IS NOT NULL
       AND email != ''
     LIMIT 500`
  );
  return rows;
}

async function triggerWeeklyReports() {
  console.log('[reportScheduler] iniciando relatórios semanais...');
  const start = Date.now();
  let sent = 0, skipped = 0, errors = 0;

  try {
    const { generateReport, updateDelivery } = require('./reportGenerator');
    const { sendWeeklyReport } = require('./mailer');
    const companies = await getEligibleCompanies();

    for (const co of companies) {
      try {
        const result = await generateReport(co.id, 'weekly');
        if (result.skipped) { skipped++; continue; }
        await sendWeeklyReport(result.company, result.kpis, result.html);
        await updateDelivery(result.deliveryId, 'sent');
        sent++;
        console.log(`[reportScheduler] sent company=${co.id} (${co.name})`);
      } catch (err) {
        errors++;
        console.error(`[reportScheduler] error company=${co.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[reportScheduler] fatal:', err.message);
  }

  console.log(`[reportScheduler] semanal concluído em ${Date.now()-start}ms — sent=${sent} skipped=${skipped} errors=${errors}`);
}

// Verifica a cada minuto se é hora de disparar
// Segunda-feira (dow=1) às 8h BRT → envio semanal
// Dia 1 de cada mês às 8h BRT → envio mensal
let _lastWeeklyDate = null;
let _lastMonthlyDate = null;

function tick() {
  const now = nowBRT();
  const dow = now.getUTCDay();      // 0=dom, 1=seg
  const dom = now.getUTCDate();     // dia do mês
  const hour = now.getUTCHours();   // hora BRT
  const min = now.getUTCMinutes();
  const dateStr = now.toISOString().slice(0, 10);

  // Semanal: toda segunda às 8h (minuto 0-5 para tolerar atrasos de boot)
  if (dow === 1 && hour === 8 && min < 5 && _lastWeeklyDate !== dateStr) {
    _lastWeeklyDate = dateStr;
    triggerWeeklyReports().catch(e => console.error('[reportScheduler] weekly crash:', e.message));
  }

  // Mensal: dia 1 às 8h
  if (dom === 1 && hour === 8 && min < 5 && _lastMonthlyDate !== dateStr) {
    _lastMonthlyDate = dateStr;
    // TODO: triggerMonthlyReports() quando mensal for implementado
    console.log('[reportScheduler] mensal pendente de implementação');
  }
}

let _interval = null;

function initReportScheduler() {
  if (_interval) return; // já iniciado
  _interval = setInterval(tick, 60 * 1000); // verificar a cada minuto
  console.log('[reportScheduler] iniciado — verificando a cada minuto (seg 8h BRT = relatório semanal)');
}

function stopReportScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { initReportScheduler, stopReportScheduler, triggerWeeklyReports };
