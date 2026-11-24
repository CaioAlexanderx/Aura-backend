// ============================================================
// AURA. — Cadastro completo do cliente (ótica, p-204, 23/11/2026)
//
// RG, sexo e profissão no POST e no PATCH de /companies/:id/customers.
// Contrato: docs/otica-cadastro-completo-backend.md (aura-app#1361).
//
//   rg          texto, trim, até 20 caracteres; vazio/null apaga. Sem regra
//               de formato (varia por estado).
//   gender      'M' | 'F' | 'outro' (CHECK da migration 050); vazio/null apaga.
//   occupation  texto, trim, até 80 caracteres; vazio/null apaga
//               (coluna da migration 463).
//
// Chave ausente não mexe na coluna (mesmo contrato do resto do PATCH).
//
// Privacidade: CPF e RG são documento. A LISTA de clientes devolve os dois
// mascarados (mascararDocumento); o valor inteiro só sai no GET /:cid, que
// é o que a ficha aberta e o formulário de edição usam.
// ============================================================
'use strict';

const GENEROS = ['M', 'F', 'outro'];
const LIMITES = { rg: 20, occupation: 80 };

function texto(body, campo) {
  const raw = body[campo];
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${campo} deve ser texto`, field: campo };
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  if (v.length > LIMITES[campo]) {
    return { ok: false, error: `${campo} deve ter ate ${LIMITES[campo]} caracteres`, field: campo };
  }
  return { ok: true, value: v };
}

/**
 * Lê rg, gender e occupation do body. Só as chaves presentes entram em
 * `values`. Devolve { ok: true, values } ou { ok: false, error, field }.
 */
function parseDadosCompletos(body) {
  const values = {};
  const b = body || {};
  for (const campo of ['rg', 'occupation']) {
    if (b[campo] === undefined) continue;
    const r = texto(b, campo);
    if (!r.ok) return r;
    values[campo] = r.value;
  }
  if (b.gender !== undefined) {
    const g = b.gender;
    if (g === null || g === '') values.gender = null;
    else if (typeof g === 'string' && GENEROS.includes(g.trim())) values.gender = g.trim();
    else return { ok: false, error: `gender deve ser um de: ${GENEROS.join(', ')}`, field: 'gender' };
  }
  return { ok: true, values };
}

// Coluna occupation (migration 463): null = ainda não sabemos; false = 42703
// visto; true = existe. Compartilhado entre customers.js e meAggregates.js
// para o aviso customer_fields dizer a mesma coisa nas duas listas.
let occupationColumnAvailable = null;
const ocupacao = {
  get: () => occupationColumnAvailable,
  set: (v) => { occupationColumnAvailable = v; },
  reset: () => { occupationColumnAvailable = null; },
};

/**
 * Campos do cadastro completo que o POST e o PATCH gravam AGORA. rg (148) e
 * gender (050) existem há muito; occupation só depois da 463. Enquanto o
 * cache não viu a coluna (null), fica de fora: melhor o app esconder o
 * campo uma vez do que mostrar e o valor cair em ignored_fields.
 */
function customerFieldsAceitos() {
  return occupationColumnAvailable === true ? ['rg', 'gender', 'occupation'] : ['rg', 'gender'];
}

/** 42703 da coluna occupation (migration 463 ainda não aplicada). */
function isMissingOccupationColumn(err) {
  return !!err && err.code === '42703' && /occupation/i.test(String(err.message || ''));
}

// Documento mascarado para a LISTA de clientes. Mostra só o fim, o bastante
// para o balcão distinguir dois clientes de mesmo nome.
//   CPF  12345678909     -> ***.***.789-09
//   CNPJ 11222333000181  -> **.***.***/0001-81
//   outro (RG etc.)      -> *** + 3 últimos caracteres (ou *** se curto)
//   vazio                -> ''
function mascararDocumento(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const d = s.replace(/\D/g, '');
  if (d.length === 11 && d.length === s.replace(/[.\-\s]/g, '').length) {
    return `***.***.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14 && d.length === s.replace(/[.\-/\s]/g, '').length) {
    return `**.***.***/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  const limpo = s.replace(/\s/g, '');
  return limpo.length > 5 ? `***${limpo.slice(-3)}` : '***';
}

module.exports = {
  parseDadosCompletos, isMissingOccupationColumn, mascararDocumento, customerFieldsAceitos, ocupacao, GENEROS,
};
