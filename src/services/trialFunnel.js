// ============================================================
// AURA. — Sinais do funil do trial (12/10/2026)
//
// Por quê: o self-service converteu 0 de 21 contas em 120 dias e a Gestão
// Aura não mostrava onde cada conta parou. Dois sinais faltavam:
//
//   1. Último acesso de verdade. companies.last_active_at existe mas ninguém
//      gravava (NULL em todas as contas). touchCompanyActivity é chamado por
//      requireCompanyAccess em todo request autenticado de empresa e grava
//      NOW() no máximo uma vez a cada 15 minutos por empresa (Map em memória,
//      por processo — basta para um sinal de "esteve aqui hoje").
//
//   2. Chegada ao checkout. Não havia registro de quem viu a tela de planos
//      depois do trial. recordCheckoutViewed grava audit_log
//      action='checkout.viewed' no máximo uma vez por empresa a cada 24h,
//      chamado pelo GET /billing/status (a tela de checkout chama a rota toda
//      vez que abre).
//
// Os dois são fire-and-forget: nunca bloqueiam nem derrubam o request.
// Nos testes o módulo é substituído por no-op em tests/jest.setup.js — sem
// isso a query extra consumiria os mockResolvedValueOnce dos testes de rota.
// ============================================================
const db = require('../config/database');

const TOUCH_INTERVAL_MS = 15 * 60 * 1000;

const lastTouch = new Map(); // companyId → timestamp (ms) do último UPDATE disparado
let touchWarned = false;
let checkoutWarned = false;

// Dispara o UPDATE de last_active_at se a empresa não foi tocada nos últimos
// 15 minutos. Retorna true quando disparou. Não aguarda o banco.
function touchCompanyActivity(companyId, now = Date.now()) {
  if (!companyId) return false;
  const prev = lastTouch.get(companyId);
  if (prev !== undefined && now - prev < TOUCH_INTERVAL_MS) return false;
  // Marca antes de disparar: requests simultâneos da mesma empresa não
  // geram vários UPDATEs. Se o UPDATE falhar, a próxima tentativa fica para
  // daqui a 15 minutos — não insistir num banco que está recusando.
  lastTouch.set(companyId, now);
  Promise.resolve()
    .then(() => db.query('UPDATE companies SET last_active_at = NOW() WHERE id = $1', [companyId]))
    .catch((err) => {
      if (!touchWarned) {
        touchWarned = true;
        console.warn('[trialFunnel] last_active_at não gravado:', err && err.message);
      }
    });
  return true;
}

// A empresa está "no checkout de verdade": sem cobrança ativa e sem trial
// valendo (trial_ends_at nulo ou no passado).
function isCheckoutDue(company, now = new Date()) {
  if (!company) return false;
  if (company.billing_status === 'active') return false;
  const ends = company.trial_ends_at ? new Date(company.trial_ends_at) : null;
  return !(ends && ends > now);
}

// Grava audit_log checkout.viewed se não houver um nas últimas 24h para a
// empresa. Nunca lança. Retorna true quando inseriu.
async function recordCheckoutViewed({ companyId, userId = null, company = {} }) {
  if (!companyId) return false;
  try {
    const { rows } = await db.query(
      `SELECT created_at FROM audit_log
        WHERE company_id = $1 AND action = 'checkout.viewed'
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 1`,
      [companyId]
    );
    if (rows && rows.length) return false;
    await db.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        companyId,
        'checkout.viewed',
        'Abriu o checkout sem cobrança ativa e sem trial valendo',
        JSON.stringify({
          plan: company.plan || null,
          billing_status: company.billing_status || null,
          trial_ends_at: company.trial_ends_at || null,
        }),
      ]
    );
    return true;
  } catch (err) {
    if (!checkoutWarned) {
      checkoutWarned = true;
      console.warn('[trialFunnel] checkout.viewed não gravado:', err && err.message);
    }
    return false;
  }
}

// Só para testes: zera o throttle e os avisos.
function _resetForTests() {
  lastTouch.clear();
  touchWarned = false;
  checkoutWarned = false;
}

module.exports = {
  TOUCH_INTERVAL_MS,
  touchCompanyActivity,
  isCheckoutDue,
  recordCheckoutViewed,
  _resetForTests,
};
