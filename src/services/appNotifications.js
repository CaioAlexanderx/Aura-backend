// ============================================================
// AURA. — Notificações do app: disparo pelo BACKEND
//
// O sino do app (GET /companies/:id/notifications) lê app_notifications.
// Até aqui só a Gestão Aura escrevia nessa tabela (adminNotifications.js).
// Este módulo é o outro caminho: qualquer fluxo do backend pode criar um
// banner para uma empresa ou para um shell inteiro.
//
//   createAppNotification({...})            — forma completa
//   notifyCompany(companyId, {...})         — banner para UMA empresa
//   notifyVertical(vertical, {...})         — banner para TODO um shell
//
// REGRA: notificar NUNCA derruba o fluxo de origem. Toda falha aqui é
// logada e vira `null` no retorno — quem chama não precisa de try/catch.
//
// dedupeKey: opcional. Com ele, o mesmo evento não vira dois banners
// (índice único parcial uq_app_notifications_dedupe_key, migration 285).
// Quando a chave já existe, o retorno é `null` — não é erro.
//
// Defensivo (CLAUDE.md, armadilha 1): target_vertical/dedupe_key só
// existem depois da migration 285. Antes dela o INSERT cai no formato
// antigo (sem as duas colunas) em vez de estourar 42703 — o cache
// module-level abaixo paga esse custo uma vez só.
// ============================================================
'use strict';

const db = require('../config/database');

// Shells do app. `negocio` é o shell base (companies.vertical_active NULL).
// karate_dojo/karate_federation vêm do cadastro (auth.js); as demais são
// ativadas pela Gestão Aura (adminVertical.js, VALID_VERTICALS).
const SHELLS = Object.freeze([
  'negocio',
  'karate_dojo',
  'karate_federation',
  'studio',
  'odonto',
  'barber',
  'food',
  'estetica',
  'pet',
  'academia',
]);

// null = ainda não sabemos; true/false = decidido para o resto do processo.
let hasVerticalCols = null;

function isValidShell(v) {
  return typeof v === 'string' && SHELLS.includes(v);
}

const COLS_NEW = `(type, title, body, html_content, cta_label, cta_url, cta_route,
                   target_company_id, target_plan, target_vertical, expires_at, is_active, dedupe_key)`;
const COLS_OLD = `(type, title, body, html_content, cta_label, cta_url, cta_route,
                   target_company_id, target_plan, expires_at, is_active)`;

/**
 * Cria um banner de app.
 *
 * @param {object}  p
 * @param {string}  p.title            obrigatório
 * @param {string} [p.type='banner']
 * @param {string} [p.body]
 * @param {string} [p.htmlContent]
 * @param {string} [p.ctaLabel]
 * @param {string} [p.ctaUrl]
 * @param {string} [p.ctaRoute]
 * @param {string} [p.targetCompanyId] NULL = todas as empresas
 * @param {string} [p.targetPlan]      NULL = todos os planos
 * @param {string} [p.targetVertical]  NULL = todos os shells
 * @param {Date|string} [p.expiresAt]
 * @param {boolean}[p.isActive=true]
 * @param {string} [p.dedupeKey]       idempotência do disparo automático
 * @returns {Promise<object|null>} a linha criada, ou null (dedup ou falha)
 */
async function createAppNotification(p = {}) {
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  if (!title) {
    console.error('[appNotifications] title é obrigatório — nada criado');
    return null;
  }
  if (p.targetVertical != null && !isValidShell(p.targetVertical)) {
    console.error('[appNotifications] vertical inválida:', p.targetVertical);
    return null;
  }

  const base = [
    p.type || 'banner',
    title,
    p.body            || null,
    p.htmlContent     || null,
    p.ctaLabel        || null,
    p.ctaUrl          || null,
    p.ctaRoute        || null,
    p.targetCompanyId || null,
    p.targetPlan      || null,
  ];
  const isActive = p.isActive === undefined ? true : !!p.isActive;
  const dedupeKey = p.dedupeKey || null;

  const runNew = () => db.query(
    `INSERT INTO app_notifications ${COLS_NEW}
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [...base, p.targetVertical || null, p.expiresAt || null, isActive, dedupeKey]
  );

  // Pré-285: sem target_vertical não há como segmentar por shell. Um banner
  // de shell viraria banner global (aparece para todo mundo) — por isso ele
  // é DESCARTADO no fallback, e só o banner sem alvo de shell é criado.
  const runOld = () => {
    if (p.targetVertical) {
      console.error('[appNotifications] migration 285 ausente — banner de vertical descartado:', p.targetVertical);
      return null;
    }
    return db.query(
      `INSERT INTO app_notifications ${COLS_OLD}
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [...base, p.expiresAt || null, isActive]
    );
  };

  try {
    const res = hasVerticalCols === false ? await runOld() : await runNew();
    if (hasVerticalCols === null && res) hasVerticalCols = true;
    // DO NOTHING no dedup: 0 linhas, e isso não é erro.
    return res && res.rows.length ? res.rows[0] : null;
  } catch (err) {
    if (err.code === '42703') {
      hasVerticalCols = false;
      try {
        const res = await runOld();
        return res && res.rows.length ? res.rows[0] : null;
      } catch (e2) {
        console.error('[appNotifications] create error (fallback):', e2.message);
        return null;
      }
    }
    console.error('[appNotifications] create error:', err.message);
    return null;
  }
}

/** Banner para UMA empresa (qualquer shell). */
function notifyCompany(companyId, payload = {}) {
  return createAppNotification({ ...payload, targetCompanyId: companyId });
}

/** Banner para TODAS as empresas de um shell (ex.: 'karate_dojo'). */
function notifyVertical(vertical, payload = {}) {
  return createAppNotification({ ...payload, targetVertical: vertical });
}

/** Só para teste: reseta o cache de capacidade do schema. */
function _resetSchemaCache() { hasVerticalCols = null; }

module.exports = {
  SHELLS,
  isValidShell,
  createAppNotification,
  notifyCompany,
  notifyVertical,
  _resetSchemaCache,
};
