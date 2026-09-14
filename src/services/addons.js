// ============================================================
// AURA — ADICIONAIS POR EMPRESA (company_addons, migration 328)
//
// Um adicional é cobrado à parte do plano. O primeiro é o
// 'whatsapp_auto' (R$39/mês): envio AUTOMÁTICO de cobrança pela Cloud
// API. O gate do envio automático mora aqui e NÃO no plano — 104 dos
// 106 dojôs estão no 'essencial' e são exatamente o público do
// adicional; gatear por plano barraria quem paga.
//
// hasAddon é chamado em caminho quente (toda checagem antes de
// enfileirar/ligar o toggle), por isso o cache de 60s em memória. O
// cache é invalidado no setAddon do mesmo processo; em outro processo,
// o pior caso é o adicional demorar até 1 minuto para valer.
//
// A 328 pode não estar aplicada quando o deploy sobe (o backend não
// roda migration no boot): 42P01/42703 viram "não tem adicional", nunca
// exceção — um erro de schema não pode virar 500 na tela do dojô.
// ============================================================
'use strict';

const db = require('../config/database');

const ADDON_WHATSAPP_AUTO = 'whatsapp_auto';
const DEFAULT_PRICE_CENTS = 3900;
const TTL_MS = 60 * 1000;

// Map<`${companyId}:${key}`, { value, at }>
const _cache = new Map();

function schemaMissing(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

function invalidate(companyId, key) {
  if (key) _cache.delete(`${companyId}:${key}`);
  else for (const k of _cache.keys()) if (k.startsWith(`${companyId}:`)) _cache.delete(k);
}

function clearCache() {
  _cache.clear();
}

async function hasAddon(companyId, key) {
  if (!companyId || !key) return false;
  const ck = `${companyId}:${key}`;
  const hit = _cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = false;
  try {
    const { rows } = await db.query(
      `-- addon:has
       SELECT 1 FROM company_addons
        WHERE company_id = $1 AND addon_key = $2 AND status = 'active'
        LIMIT 1`,
      [companyId, key]
    );
    value = rows.length > 0;
  } catch (e) {
    if (!schemaMissing(e)) throw e;
    value = false;
  }
  _cache.set(ck, { value, at: Date.now() });
  return value;
}

// ── Gate ÚNICO do envio automático (Fase 6) ─────────────────
// Quem pode gastar mensagem paga: quem CONTRATOU o adicional (o caso do
// dojô, quase todo mundo no 'essencial') OU quem já paga um plano que
// inclui WhatsApp (Negócio/Expansão — MODULE_PLAN_MAP já põe o módulo
// 'whatsapp' no 'negocio'). O adicional de R$39 é justamente para quem
// está fora desses planos; cobrar de novo de quem já paga o plano seria
// vender duas vezes a mesma coisa.
//
// O plano vem SEMPRE do banco, nunca do JWT: o token do app carrega o
// plano de quando a pessoa entrou e não revalida sozinho (armadilha nº 9
// do CLAUDE.md) — uma troca de plano hoje só valeria no próximo login.
const PLANOS_COM_WHATSAPP_AUTO = new Set(['negocio', 'expansao']);
const PLAN_CACHE_KEY = '__plan__';

async function planAllowsAutoWhatsapp(companyId) {
  const ck = `${companyId}:${PLAN_CACHE_KEY}`;
  const hit = _cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = false;
  try {
    const { rows } = await db.query(
      `-- addon:plan
       SELECT plan FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const plan = rows[0] && rows[0].plan ? String(rows[0].plan).toLowerCase() : null;
    value = !!plan && PLANOS_COM_WHATSAPP_AUTO.has(plan);
  } catch (e) {
    if (!schemaMissing(e)) throw e;
    value = false;
  }
  _cache.set(ck, { value, at: Date.now() });
  return value;
}

async function canAutoWhatsapp(companyId) {
  if (!companyId) return false;
  if (await hasAddon(companyId, ADDON_WHATSAPP_AUTO)) return true;
  return planAllowsAutoWhatsapp(companyId);
}

async function listAddons(companyId) {
  try {
    const { rows } = await db.query(
      `-- addon:list
       SELECT id, addon_key, status, price_cents, started_at, ended_at, source, notes, updated_at
         FROM company_addons WHERE company_id = $1 ORDER BY addon_key ASC`,
      [companyId]
    );
    return rows;
  } catch (e) {
    if (schemaMissing(e)) return [];
    throw e;
  }
}

// Upsert. Desativar = status 'cancelled' + ended_at (o histórico de que
// a empresa JÁ teve o adicional é o que permite cobrar proporcional e
// explicar a fatura depois).
// Devolve null com a 328 pendente — quem chama decide o que dizer.
async function setAddon(companyId, key, { active = true, priceCents = null, source = null, notes = null } = {}) {
  const status = active ? 'active' : 'cancelled';
  try {
    const { rows } = await db.query(
      `-- addon:set
       INSERT INTO company_addons (company_id, addon_key, status, price_cents, source, notes, ended_at)
       VALUES ($1, $2, $3, COALESCE($4, ${DEFAULT_PRICE_CENTS}), $5, $6,
               CASE WHEN $3 = 'cancelled' THEN NOW() END)
       ON CONFLICT (company_id, addon_key) DO UPDATE SET
         status      = EXCLUDED.status,
         price_cents = COALESCE($4, company_addons.price_cents),
         source      = COALESCE($5, company_addons.source),
         notes       = COALESCE($6, company_addons.notes),
         started_at  = CASE WHEN $3 = 'active' AND company_addons.status <> 'active'
                            THEN NOW() ELSE company_addons.started_at END,
         ended_at    = CASE WHEN $3 = 'cancelled' THEN NOW() ELSE NULL END,
         updated_at  = NOW()
       RETURNING id, addon_key, status, price_cents, started_at, ended_at, source, notes, updated_at`,
      [companyId, key, status, priceCents, source, notes]
    );
    invalidate(companyId, key);
    return rows[0] || null;
  } catch (e) {
    if (schemaMissing(e)) { invalidate(companyId, key); return null; }
    throw e;
  }
}

module.exports = {
  ADDON_WHATSAPP_AUTO,
  DEFAULT_PRICE_CENTS,
  PLANOS_COM_WHATSAPP_AUTO,
  hasAddon, canAutoWhatsapp, planAllowsAutoWhatsapp,
  listAddons, setAddon,
  invalidate, clearCache,
};
