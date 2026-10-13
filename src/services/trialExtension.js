// ============================================================
// AURA. — Extensão de trial (regra única)
//
// 13/10/2026: a conta saiu do PATCH /admin/clients/:cid/extend-trial para
// cá, sem mudar nada nela, para a Aurinha de plantão (ferramenta
// estender_trial, services/aurinhaSuporte.js) usar a MESMA regra do admin.
//
// Trial ainda no futuro → soma N dias ao fim atual. Vencido ou sem data →
// conta a partir de agora. Quem chama grava a auditoria (admin_audit_log no
// admin, audit_log na Aurinha): aqui só a regra e o UPDATE.
// ============================================================
'use strict';

const pool = require('../config/database');

const DIA_MS = 24 * 60 * 60 * 1000;

function novoFimDoTrial(previousEnds, days, now = new Date()) {
  const base = previousEnds && previousEnds > now ? previousEnds : now;
  return new Date(base.getTime() + days * DIA_MS);
}

// Devolve null quando a empresa não existe.
async function estenderTrial({ companyId, days, now = new Date() }) {
  const { rows: current } = await pool.query(
    'SELECT trial_ends_at, billing_status FROM companies WHERE id = $1',
    [companyId]
  );
  if (!current.length) return null;

  const previousEnds = current[0].trial_ends_at ? new Date(current[0].trial_ends_at) : null;
  const newEnds = novoFimDoTrial(previousEnds, days, now);

  await pool.query(
    `UPDATE companies SET trial_ends_at = $1, updated_at = NOW() WHERE id = $2`,
    [newEnds, companyId]
  );

  return { previousEnds, newEnds, billingStatus: current[0].billing_status, daysAdded: days };
}

module.exports = { estenderTrial, novoFimDoTrial };
