// ============================================================
// Banco falso (por SQL) para a casa no Negocio (p-189).
// Guarda as empresas em memoria e responde as queries de
// services/casaNegocio.js, services/personalizadosAtivacao.js
// (gravarDataOriginalDoStudio) e do INSERT em admin_audit_log, para que os
// testes confiram o ESTADO final em vez da ordem das chamadas.
// O SQL de verdade e conferido no Postgres em
// __tests__/casaNegocio.banco.test.js (CI).
// ============================================================
'use strict';

function fakeCasaDb({ companies = {}, primeiroPedido = {} } = {}) {
  const state = { companies: {}, audit: [] };
  for (const [id, c] of Object.entries(companies)) {
    state.companies[id] = {
      id,
      plan: 'negocio',
      trade_name: 'Loja ' + id,
      vertical_active: null,
      vertical_enabled_at: null,
      created_at: new Date('2026-05-22T10:00:00.000Z'),
      pdv_settings: {},
      studio_settings: {},
      ...c,
    };
  }
  const calls = [];
  const copia = (c) => JSON.parse(JSON.stringify(c));
  const row = (id) => state.companies[id];

  const query = jest.fn(async (sql, params = []) => {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    calls.push({ text, params });

    if (/INSERT INTO admin_audit_log/.test(text)) {
      state.audit.push({ staff_user_id: params[0], action: params[1], company_id: params[2], payload: JSON.parse(params[3]) });
      return { rows: [], rowCount: 1 };
    }
    // casaLigadaNoBanco
    if (/AS ligada/.test(text)) {
      const c = row(params[0]);
      return { rows: c ? [{ ligada: !!(c.studio_settings && c.studio_settings.casa_negocio === true) }] : [] };
    }
    // lerEmpresa (casaNegocio)
    if (/pdv_settings, studio_settings\s+FROM companies WHERE id = \$1/.test(text)) {
      const c = row(params[0]);
      return { rows: c ? [copia(c)] : [] };
    }
    // inicioDoUsoDoStudio
    if (/primeiro_pedido_em/.test(text) && /^\s*SELECT/.test(text)) {
      const c = row(params[0]);
      if (!c) return { rows: [] };
      return { rows: [{ ...copia(c), created_at: c.created_at, primeiro_pedido_em: primeiroPedido[c.id] || null }] };
    }
    // gravarDataOriginalDoStudio (UPDATE com guarda)
    if (/SET pdv_settings = COALESCE\(pdv_settings, '\{\}'::jsonb\) \|\| jsonb_build_object\('personalizados_ativado_em', \$2::text\)/.test(text)) {
      const c = row(params[0]);
      const ps = (c && c.pdv_settings) || {};
      const vazia = ps.personalizados_ativado_em === undefined || ps.personalizados_ativado_em === null || ps.personalizados_ativado_em === '';
      const ligada = ps.studio_enabled === true || (c && c.vertical_active === 'studio');
      if (!c || !vazia || !ligada) return { rows: [] };
      c.pdv_settings = { ...ps, personalizados_ativado_em: params[1] };
      return { rows: [{ data: params[1] }] };
    }
    // ligarCasa
    if (/SET vertical_active = NULL,/.test(text)) {
      const c = row(params[0]);
      if (!c || c.vertical_active !== 'studio') return { rows: [] };
      c.vertical_active = null;
      c.vertical_enabled_at = null;
      c.studio_settings = {
        ...(c.studio_settings || {}),
        casa_negocio: true,
        casa_negocio_em: params[1],
        casa_negocio_studio_desde: params[2],
      };
      return { rows: [{ id: c.id }] };
    }
    // desligarCasa
    if (/SET vertical_active = 'studio',/.test(text)) {
      const c = row(params[0]);
      if (!c) return { rows: [] };
      const desde = c.studio_settings && c.studio_settings.casa_negocio_studio_desde;
      c.vertical_active = 'studio';
      c.vertical_enabled_at = desde ? new Date(desde) : (c.vertical_enabled_at || new Date());
      c.studio_settings = { ...(c.studio_settings || {}), casa_negocio: false, casa_negocio_desligada_em: params[1] };
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
    throw new Error('fakeCasaDb: SQL nao esperado: ' + text.slice(0, 120));
  });

  return {
    state,
    calls,
    client: { query, release: jest.fn() },
    writesTo: (re) => calls.filter((c) => re.test(c.text)),
  };
}

module.exports = { fakeCasaDb };
