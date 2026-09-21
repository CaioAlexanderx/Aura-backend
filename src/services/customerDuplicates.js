// ============================================================
// AURA. — Candidatos a cadastro duplicado (Fase 1 CRM)
//
// GET /companies/:id/customers/duplicates. Escopo: todas as empresas do dono
// (clientes são do dono — src/utils/ownerScope.js).
//
// Regras:
//   FORTE  — mesmo phone_e164 OU mesmo CPF/CNPJ (só dígitos, 11 ou 14, sem
//            sequência repetida). As duas chaves se encadeiam: A~B pelo
//            telefone e B~C pelo CPF formam um grupo só (union-find).
//   FRACO  — mesmo nome normalizado (sem acento, sem caixa, espaços
//            colapsados) com pelo menos dois nomes ("Maria" sozinha casaria
//            meia base). Só vira grupo se juntar alguém que o forte não juntou.
//
// Fica fora: inativos e já mesclados (merged_into_id).
// O agrupamento é PURO (groupDuplicates) — a rota só busca as linhas.
// ============================================================
'use strict';

const db = require('../config/database');
const { toPhoneE164BR } = require('../utils/phone');
const { onlyDigits } = require('../utils/personIdentity');

const MAX_GROUPS = 200;

function normalizeName(name) {
  const s = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.split(' ').length < 2) return null;
  return s;
}

function docKey(cpfCnpj) {
  const d = onlyDigits(cpfCnpj);
  if (d.length !== 11 && d.length !== 14) return null;
  if (/^(\d)\1+$/.test(d)) return null;
  return d;
}

function customerView(c) {
  return {
    id: c.id,
    name: c.name || '',
    phone: c.phone || null,
    phone_e164: c.phone_e164 || toPhoneE164BR(c.phone),
    cpf_cnpj: c.cpf_cnpj || null,
    email: c.email || null,
    company_id: c.company_id,
    company_name: c.company_name || 'Empresa',
    total_purchases: parseInt(c.total_purchases, 10) || 0,
    total_spent: parseFloat(c.total_spent) || 0,
    last_purchase_at: c.last_purchase_at || null,
    created_at: c.created_at || null,
  };
}

// Quem tem mais histórico é o sobrevivente sugerido; empate -> o mais antigo.
function byHistory(a, b) {
  if (b.total_purchases !== a.total_purchases) return b.total_purchases - a.total_purchases;
  const ta = a.created_at ? new Date(a.created_at).getTime() : Infinity;
  const tb = b.created_at ? new Date(b.created_at).getTime() : Infinity;
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : 1;
}

/**
 * @param {object[]} rows  clientes (id, name, phone, phone_e164, cpf_cnpj, ...)
 * @returns {object[]} grupos { key, strength, reasons, suggested_target_id, customers }
 */
function groupDuplicates(rows) {
  const list = rows.map(customerView);
  const idx = new Map(list.map((c, i) => [c.id, i]));

  // union-find
  const parent = list.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const byStrongKey = new Map(); // 'phone:...' | 'cpf:...' -> [i]
  list.forEach((c, i) => {
    const keys = [];
    if (c.phone_e164) keys.push(`phone:${c.phone_e164}`);
    const doc = docKey(c.cpf_cnpj);
    if (doc) keys.push(`cpf:${doc}`);
    for (const k of keys) {
      const arr = byStrongKey.get(k) || [];
      arr.push(i);
      byStrongKey.set(k, arr);
    }
  });
  const reasonsByRoot = new Map();
  for (const [k, members] of byStrongKey) {
    if (members.length < 2) continue;
    for (let j = 1; j < members.length; j++) union(members[0], members[j]);
  }
  for (const [k, members] of byStrongKey) {
    if (members.length < 2) continue;
    const root = find(members[0]);
    const set = reasonsByRoot.get(root) || new Set();
    set.add(k.startsWith('phone:') ? 'phone' : 'cpf');
    reasonsByRoot.set(root, set);
  }

  const components = new Map();
  list.forEach((c, i) => {
    const r = find(i);
    const arr = components.get(r) || [];
    arr.push(c);
    components.set(r, arr);
  });

  const groups = [];
  for (const [root, members] of components) {
    if (members.length < 2) continue;
    const sorted = members.slice().sort(byHistory);
    const reasons = [...(reasonsByRoot.get(root) || [])].sort();
    groups.push({
      key: `forte:${sorted.map(m => m.id).sort()[0]}`,
      strength: 'forte',
      reasons,
      suggested_target_id: sorted[0].id,
      customers: sorted,
    });
  }

  const byName = new Map();
  list.forEach((c) => {
    const n = normalizeName(c.name);
    if (!n) return;
    const arr = byName.get(n) || [];
    arr.push(c);
    byName.set(n, arr);
  });
  for (const [name, members] of byName) {
    if (members.length < 2) continue;
    const roots = new Set(members.map(m => find(idx.get(m.id))));
    if (roots.size < 2) continue; // o grupo forte já junta todos
    const sorted = members.slice().sort(byHistory);
    groups.push({
      key: `fraco:${name}`,
      strength: 'fraco',
      reasons: ['name'],
      suggested_target_id: sorted[0].id,
      customers: sorted,
    });
  }

  groups.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength === 'forte' ? -1 : 1;
    if (b.customers.length !== a.customers.length) return b.customers.length - a.customers.length;
    return a.key < b.key ? -1 : 1;
  });
  return groups;
}

let hasProfileColumns = true;
function _resetCache() { hasProfileColumns = true; }

async function loadCandidates(companyIds) {
  const run = (withProfile) => db.query(
    `-- dup:clientes
     SELECT c.id, c.company_id, c.name, c.phone, c.cpf_cnpj, c.email,
            c.total_purchases, c.total_spent, c.last_purchase_at, c.created_at,
            ${withProfile ? 'c.phone_e164' : 'NULL::text AS phone_e164'},
            COALESCE(co.trade_name, co.legal_name) AS company_name
       FROM customers c
       JOIN companies co ON co.id = c.company_id
      WHERE c.company_id = ANY($1)
        AND c.is_active IS NOT FALSE
        ${withProfile ? 'AND c.merged_into_id IS NULL' : ''}`,
    [companyIds]
  );
  if (hasProfileColumns) {
    try {
      return (await run(true)).rows;
    } catch (e) {
      if (e.code !== '42703') throw e;
      hasProfileColumns = false; // migration 341 pendente: telefone sai do JS
    }
  }
  return (await run(false)).rows;
}

async function findDuplicates(companyIds) {
  if (!companyIds.length) return { groups: [], total_groups: 0, truncated: false };
  const rows = await loadCandidates(companyIds);
  const groups = groupDuplicates(rows);
  return {
    groups: groups.slice(0, MAX_GROUPS),
    total_groups: groups.length,
    truncated: groups.length > MAX_GROUPS,
  };
}

module.exports = { groupDuplicates, findDuplicates, normalizeName, docKey, _resetCache };
