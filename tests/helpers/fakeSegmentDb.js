// ============================================================
// Banco falso (por SQL, nao por fila) para a frente da empresa
// (services/segment.js, migration 366). Guarda as empresas em memoria e
// responde as queries de applySegment / setCompanyVertical / register, para
// que os testes confiram o ESTADO final (segment, flags de pdv_settings,
// vertical_active) em vez da ordem das chamadas.
// ============================================================
'use strict';

function fakeSegmentDb({ companies = {}, existingCnpj = null, accessCode = null } = {}) {
  const state = { companies: {} };
  for (const [id, c] of Object.entries(companies)) {
    state.companies[id] = { id, plan: 'negocio', vertical_active: null, pdv_settings: {}, segment: null, ...c };
  }
  const calls = [];
  let seq = 0;

  const rowOf = (id) => state.companies[id];

  const query = jest.fn(async (sql, params = []) => {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    calls.push({ text, params });

    // ── applySegment / setCompanyVertical ──
    if (/FROM companies WHERE id = \$1 FOR UPDATE/.test(text)) {
      const c = rowOf(params[0]);
      return { rows: c ? [{ ...c }] : [] };
    }
    if (/SET vertical_active = \$1/.test(text)) {
      const c = rowOf(params[1]);
      if (!c) return { rows: [] };
      c.vertical_active = params[0];
      return { rows: [{ ...c }] };
    }
    if (/jsonb_build_object\('studio_enabled', (true|false)\)/.test(text)) {
      const c = rowOf(params[0]);
      const on = /'studio_enabled', true/.test(text);
      if (c) c.pdv_settings = { ...(c.pdv_settings || {}), studio_enabled: on };
      return { rows: [] };
    }
    if (/SET segment = \$2/.test(text)) {
      const c = rowOf(params[0]);
      if (!c) return { rows: [] };
      c.segment = params[1];
      c.segment_source = params[2];
      c.pdv_settings = { ...(c.pdv_settings || {}), ...JSON.parse(params[3]) };
      if (params[4]) {
        c.segment_suggested = params[5];
        c.cnae_principal = params[6];
        c.cnae_descricao = params[7];
      }
      return { rows: [{ ...c }] };
    }
    if (/SELECT segment FROM companies WHERE id = \$1/.test(text)) {
      const c = rowOf(params[0]);
      return { rows: c ? [{ segment: c.segment }] : [] };
    }

    // ── /auth/register ──
    if (/FROM access_codes WHERE code/.test(text)) {
      return { rows: accessCode ? [accessCode] : [] };
    }
    if (/INSERT INTO users/.test(text)) {
      return { rows: [{ id: 'u-novo', name: params[0], email: params[1], role: 'client', is_staff: params[3], email_verified: false, created_at: new Date() }] };
    }
    if (/FROM companies WHERE cnpj = \$1/.test(text)) {
      return { rows: existingCnpj ? [{ ...existingCnpj }] : [] };
    }
    if (/INSERT INTO companies/.test(text)) {
      seq += 1;
      const id = 'c-novo-' + seq;
      state.companies[id] = {
        id, legal_name: params[1], trade_name: params[1], plan: params[2], onboarding_step: 'cnpj',
        trial_ends_at: params[3], module_overrides: null, access_code_used: params[4],
        vertical_active: params[7], vertical: params[7], ai_enabled: false, ai_consent_at: null,
        federation_id: params[8], segment: null, pdv_settings: {},
      };
      return { rows: [{ ...state.companies[id] }] };
    }
    return { rows: [] };
  });

  return {
    state,
    calls,
    client: { query, release: jest.fn() },
    writesTo: (re) => calls.filter((c) => re.test(c.text)),
  };
}

module.exports = { fakeSegmentDb };
