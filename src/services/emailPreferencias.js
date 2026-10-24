// ============================================================
// AURA. — Preferências de e-mail por empresa (tq-74, 24/10/2026)
//
// Hoje só existe um tipo que a empresa pode desligar: o relatório semanal,
// guardado em companies.weekly_report_enabled (migration 105). O tq-87 vai
// trocar isso por uma tabela de preferências por tipo: a escrita fica TODA
// em desligarTipoDeEmail(), para ele trocar só o miolo.
//
// Cada desligamento grava uma linha em audit_log (action
// 'email.descadastro') por empresa desligada.
// ============================================================
'use strict';

const TIPOS = Object.freeze({
  relatorio: { rotulo: 'o relatório semanal' },
});

function tipoValido(tipo) {
  return Object.prototype.hasOwnProperty.call(TIPOS, tipo);
}

/**
 * Desliga um tipo de e-mail da empresa.
 *
 * @param db
 * @param {string} companyId
 * @param {string} tipo       chave de TIPOS
 * @param {object} [opts]
 * @param {boolean} [opts.grupo]  relatório consolidado (multi-CNPJ): desliga
 *                                todas as empresas do mesmo dono, que recebiam
 *                                o mesmo e-mail
 * @param {string} [opts.origem]  'link' | 'one_click' | ...
 * @param {object} [opts.contexto] { ip, userAgent }
 * @returns {Promise<{ok: boolean, desligadas: string[], jaEstava: boolean}>}
 */
async function desligarTipoDeEmail(db, companyId, tipo, { grupo = false, origem = 'link', contexto = null } = {}) {
  if (!tipoValido(tipo)) return { ok: false, desligadas: [], jaEstava: false };

  // Miolo de hoje (tq-87 troca): companies.weekly_report_enabled.
  const { rows: alvo } = await db.query(
    grupo
      ? `SELECT c.id, c.weekly_report_enabled
           FROM companies c
           JOIN companies p ON p.id = $1
          WHERE c.id = p.id OR (p.owner_id IS NOT NULL AND c.owner_id = p.owner_id)`
      : `SELECT id, weekly_report_enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!alvo || !alvo.length) return { ok: false, desligadas: [], jaEstava: false };

  const ids = alvo.filter((r) => r.weekly_report_enabled === true).map((r) => r.id);
  if (!ids.length) return { ok: true, desligadas: [], jaEstava: true };

  const { rows } = await db.query(
    `UPDATE companies SET weekly_report_enabled = false, updated_at = NOW()
      WHERE id = ANY($1::uuid[]) AND weekly_report_enabled = true
    RETURNING id`,
    [ids]
  );
  const desligadas = (rows || []).map((r) => r.id);

  for (const id of desligadas) {
    try {
      await db.query(
        `INSERT INTO audit_log (user_id, company_id, action, detail, metadata, ip_address, user_agent)
         VALUES (NULL, $1, 'email.descadastro', $2, $3, $4, $5)`,
        [
          id,
          `Descadastro de ${TIPOS[tipo].rotulo} pelo e-mail (${origem})`,
          JSON.stringify({ tipo, origem, grupo: !!grupo, empresa_do_link: companyId }),
          (contexto && contexto.ip) || null,
          (contexto && contexto.userAgent) ? String(contexto.userAgent).slice(0, 200) : null,
        ]
      );
    } catch (err) {
      console.error('[emailPreferencias] audit_log falhou: ' + err.message);
    }
  }
  return { ok: true, desligadas, jaEstava: false };
}

module.exports = { TIPOS, tipoValido, desligarTipoDeEmail };
