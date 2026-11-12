// ============================================================
// Gestão Aura > Aura Notas: toda empresa com certificado A1 aparece
// (decisão do Caio, 12/11/2026) + requisitos de NFC-e e NFS-e + edição
// da NFS-e pela equipe com as regras do lojista.
//
// O que estes testes travam:
//   1. empresa só com certificado (sem nfce_config) aparece na lista;
//   2. empresa só com NFS-e (cofre + nfse_config, sem nfce_config) aparece;
//   3. fontes antigas do A1 (Nuvem Fiscal, URL da NFS-e antiga) aparecem;
//   4. dojô e conta pendente continuam fora; nenhuma empresa duplicada;
//   5. nenhum segredo (pfx, senha, CSC, api key, URL do certificado) no JSON;
//   6. o contrato antigo da lista continua (só acréscimos);
//   7. detalhe com a lista de requisitos de NFC-e e NFS-e;
//   8. PUT /:companyId/nfse usa a validação do lojista, pede confirmação para
//      produção e numeração, e grava admin_audit_log com o staff;
//   9. PUT /fiscal pede confirmação para produção e numeração;
//  10. DELETE não apaga o A1 de quem usa NFS-e sem ?certificado=apagar.
//
// Banco de mentira por CONTEÚDO do SQL (padrão de adminSemDojos.test.js):
// aplica os filtros de dojô e de conta pendente só quando a consulta pede.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');

const SECRET = 'aura-test-secret-2026';
const STAFF_ID = 'bbbbbbbb-0000-4000-8000-0000000000aa';
const staff = jwt.sign({ id: STAFF_ID, role: 'admin', is_staff: true }, SECRET);
const naoStaff = jwt.sign({ id: 'cccccccc-0000-4000-8000-000000000001', role: 'user' }, SECRET);

function cnpjValido(seed) {
  const base = String(seed).padStart(8, '0') + '0001';
  const dv = (s, w) => { const r = s.split('').reduce((acc, d, i) => acc + Number(d) * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base + d1 + d2;
}

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-00000000000${n}`;
const COMPLETA = id(1);      // nfce_config + cofre + nfse_config
const SO_CERT = id(2);       // só cofre (vence em 10 dias)
const SO_NFSE = id(3);       // cofre + nfse_config, sem nfce_config
const DOJO = id(4);          // cofre, mas é dojô
const PENDENTE = id(5);      // cofre, mas conta pendente
const NUVEM = id(6);         // envio antigo à Nuvem Fiscal
const NFSE_ANTIGA = id(7);   // nfse_config antiga com certificate_url
const VENCIDO = id(8);       // cofre vencido

const dia = 86400000;
const em = (d) => new Date(Date.now() + d * dia).toISOString();

const empresa = (cid, n, extra) => ({
  id: cid, trade_name: `Empresa Teste ${n}`, legal_name: `Empresa Teste ${n} LTDA`, cnpj: cnpjValido(10000000 + n),
  inscricao_estadual: '123456789110', tax_regime: 'simples_nacional', ibge_code: '3550308',
  address_state: 'SP', address_city: 'São Paulo', vertical: null, pendente: false,
  certificate_uploaded: false, ...(extra || {}),
});

let EMPRESAS;
let NFCE;
let CERTS;
let NFSE;
let consultas;
let auditoria;
let escritas;

function reset() {
  EMPRESAS = [
    empresa(COMPLETA, 1), empresa(SO_CERT, 2), empresa(SO_NFSE, 3),
    empresa(DOJO, 4, { vertical: 'karate_dojo' }), empresa(PENDENTE, 5, { pendente: true }),
    empresa(NUVEM, 6, { certificate_uploaded: true }), empresa(NFSE_ANTIGA, 7), empresa(VENCIDO, 8),
  ];
  const cn = (cid) => `EMPRESA TESTE LTDA:${EMPRESAS.find((e) => e.id === cid).cnpj}`;
  const cert = (cid, dias) => ({
    company_id: cid, subject_cn: cn(cid), not_before: em(-300), not_after: em(dias), updated_at: em(-10),
    pfx_enc: 'SEGREDO-PFX', pfx_iv: 'SEGREDO-IV', password_enc: 'SEGREDO-SENHA',
  });
  CERTS = [cert(COMPLETA, 200), cert(SO_CERT, 10), cert(SO_NFSE, 300), cert(DOJO, 100), cert(PENDENTE, 100), cert(VENCIDO, -3)];
  NFCE = [{
    company_id: COMPLETA, ambiente: 'producao', uf: 'SP', provider: null, is_active: true,
    csc_id: '000001', csc_token_enc: 'SEGREDO-CSC', csc_token: null, certificate_file: null,
    certificate_password_hash: 'SEGREDO-HASH', inscricao_estadual: null,
    serie_sefaz_sp: 2, next_number_sefaz_sp: 31, serie_nfce: 1, next_number: 1,
  }];
  const nfse = (cid, extra) => ({
    company_id: cid, provider: 'nacional', ambiente: 'producao_restrita', is_active: false,
    serie: '1', next_dps_number: '1', municipio_ibge: '3550308', ctribnac_padrao: '010501',
    cnbs_padrao: null, op_simp_nac: 3, p_tot_trib_sn: 6, inscricao_municipal: null,
    api_key_encrypted: 'SEGREDO-API', api_secret: 'SEGREDO-SECRET', certificate_pwd: 'SEGREDO-PWD',
    certificate_url: null, ultimo_teste_status: null, outro_emissor: false, ...(extra || {}),
  });
  NFSE = [
    nfse(COMPLETA), nfse(SO_NFSE),
    nfse(NFSE_ANTIGA, { provider: 'nuvem_fiscal', certificate_url: 'https://r2.exemplo/SEGREDO-URL.pfx' }),
  ];
  consultas = [];
  auditoria = [];
  escritas = [];
}

const visivel = (s) => (e) => !(/karate_dojo/.test(s) && e.vertical === 'karate_dojo') && !(/pend_dono/.test(s) && e.pendente);
const co = (e) => ({
  name: e.trade_name, cnpj: e.cnpj, co_inscricao_estadual: e.inscricao_estadual, co_tax_regime: e.tax_regime,
  co_ibge_code: e.ibge_code, co_address_state: e.address_state, co_address_city: e.address_city,
});
const porEmpresa = (lista, params, s) => (/company_id ?= ?\$1/.test(s) ? lista.filter((r) => r.company_id === params[0]) : lista);

function responder(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  consultas.push(s);
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
  if (/INSERT INTO admin_audit_log/.test(s)) { auditoria.push({ staff_user_id: params[0], company_id: params[1], action: params[2], payload: JSON.parse(params[3]) }); return { rows: [], rowCount: 1 }; }
  if (/^DELETE FROM/.test(s)) { escritas.push({ s, params }); return { rows: [], rowCount: 1 }; }
  if (/FROM nfce_config nc JOIN companies c/.test(s)) {
    return { rows: NFCE.map((n) => ({ n, e: EMPRESAS.find((x) => x.id === n.company_id) }))
      .filter(({ e }) => visivel(s)(e)).map(({ n, e }) => ({ ...n, ...co(e) })) };
  }
  if (/FROM companies c WHERE c\.id = ANY\(\$1/.test(s)) {
    return { rows: EMPRESAS.filter((e) => params[0].includes(e.id)).filter(visivel(s)).map((e) => ({ company_id: e.id, ...co(e) })) };
  }
  if (/certificate_uploaded IS TRUE/.test(s)) {
    return { rows: EMPRESAS.filter((e) => e.certificate_uploaded && (!params.length || e.id === params[0])).map((e) => ({ id: e.id })) };
  }
  if (/FROM company_certificates/.test(s)) return { rows: porEmpresa(CERTS, params, s) };
  if (/FROM nfce_emissions/.test(s)) return { rows: /COUNT\(\*\)::int AS n FROM/.test(s) ? [{ n: 0 }] : [] };
  if (/FROM nfse_config nf/.test(s)) {
    const lista = /nf\.company_id=\$1/.test(s) ? NFSE.filter((r) => r.company_id === params[0]) : NFSE;
    return { rows: lista.map((r) => ({ ...r, ultimo_teste_error_codes: null })) };
  }
  if (/^SELECT \* FROM nfse_config WHERE company_id = \$1/.test(s)) return { rows: NFSE.filter((r) => r.company_id === params[0]) };
  if (/^UPDATE nfse_config SET/.test(s)) { escritas.push({ s, params }); return { rows: [{ id: 'cfg-1' }], rowCount: 1 }; }
  if (/^INSERT INTO nfse_config/.test(s)) { escritas.push({ s, params }); return { rows: [{ id: 'cfg-2' }], rowCount: 1 }; }
  if (/FROM nfce_config WHERE company_id=\$1/.test(s)) return { rows: NFCE.filter((r) => r.company_id === params[0]) };
  if (/^(UPDATE companies|INSERT INTO nfce_config)/.test(s)) { escritas.push({ s, params }); return { rows: [], rowCount: 1 }; }
  if (/FROM companies WHERE id ?= ?\$1/.test(s)) {
    return { rows: EMPRESAS.filter((e) => e.id === params[0]).map((e) => ({ ...e, nome: e.trade_name })) };
  }
  return { rows: [] };
}

const app = express();
app.use(express.json());
app.use('/admin/aura-notas', require('../../src/routes/adminAuraNotas'));
const comStaff = (r) => r.set('Authorization', 'Bearer ' + staff);

beforeEach(() => {
  reset();
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => responder(sql, params));
  db.connect.mockImplementation(async () => ({
    query: jest.fn(async (sql, params) => responder(sql, params)),
    release: jest.fn(),
  }));
});

describe('GET /admin/aura-notas/companies — certificado de qualquer fonte', () => {
  test('só a equipe vê', async () => {
    const r = await request(app).get('/admin/aura-notas/companies').set('Authorization', 'Bearer ' + naoStaff);
    expect(r.status).toBe(403);
  });

  test('empresa só com certificado aparece, com o que falta', async () => {
    const r = await comStaff(request(app).get('/admin/aura-notas/companies'));
    expect(r.status).toBe(200);
    const c = r.body.companies.find((x) => x.company_id === SO_CERT);
    expect(c).toBeTruthy();
    expect(c.na_lista_por).toBe('certificado');
    expect(c.nfce_configurada).toBe(false);
    expect(c.nfse_configurada).toBe(false);
    expect(c.nfse).toBeNull();
    expect(c.certificado_fontes).toEqual(['cofre']);
    expect(c.cert.vencido).toBe(false);
    expect(c.cert.vence_em_breve).toBe(true);
    expect(c.cert.days_left).toBeGreaterThanOrEqual(9);
    expect(c.uf).toBe('SP');
    expect(c.municipio).toBe('São Paulo');
    expect(c.nfce_pronta).toBe(false);
    expect(c.faltas.nfce).toBeGreaterThan(0);
  });

  test('empresa só com NFS-e aparece, com ambiente e se está ativa', async () => {
    const r = await comStaff(request(app).get('/admin/aura-notas/companies'));
    const c = r.body.companies.find((x) => x.company_id === SO_NFSE);
    expect(c).toBeTruthy();
    expect(c.nfce_configurada).toBe(false);
    expect(c.nfse_configurada).toBe(true);
    expect(c.nfse).toEqual({ provider: 'nacional', ambiente: 'producao_restrita', ativa: false, municipio_ibge: '3550308' });
  });

  test('fontes antigas do A1 também entram (Nuvem Fiscal e NFS-e antiga)', async () => {
    const r = await comStaff(request(app).get('/admin/aura-notas/companies'));
    const nuvem = r.body.companies.find((x) => x.company_id === NUVEM);
    expect(nuvem.certificado_fontes).toEqual(['nuvem_fiscal_legado']);
    expect(nuvem.cert).toBeNull();
    const antiga = r.body.companies.find((x) => x.company_id === NFSE_ANTIGA);
    expect(antiga.certificado_fontes).toEqual(['nfse_legado']);
    const vencido = r.body.companies.find((x) => x.company_id === VENCIDO);
    expect(vencido.cert.vencido).toBe(true);
    expect(vencido.cert.vence_em_breve).toBe(false);
  });

  test('dojô e conta pendente seguem fora; ninguém duplicado', async () => {
    const r = await comStaff(request(app).get('/admin/aura-notas/companies'));
    const ids = r.body.companies.map((c) => c.company_id);
    expect(ids).not.toContain(DOJO);
    expect(ids).not.toContain(PENDENTE);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([COMPLETA, SO_CERT, SO_NFSE, NUVEM, NFSE_ANTIGA, VENCIDO].sort());
    // as duas consultas de empresa pedem os dois filtros
    const deEmpresa = consultas.filter((s) => /JOIN companies c|FROM companies c WHERE c\.id = ANY/.test(s));
    expect(deEmpresa).toHaveLength(2);
    for (const s of deEmpresa) {
      expect(s).toMatch(/c\.vertical IS DISTINCT FROM 'karate_dojo'/);
      expect(s).toMatch(/pend_dono/);
    }
  });

  test('nenhum segredo no JSON', async () => {
    const r = await comStaff(request(app).get('/admin/aura-notas/companies'));
    const txt = JSON.stringify(r.body);
    expect(txt).not.toMatch(/SEGREDO/);
    expect(txt).not.toMatch(/csc_token|pfx|password|api_key|certificate_pwd|certificate_url/);
  });

  test('contrato antigo continua: campos de antes presentes na empresa com NFC-e', async () => {
    const r = await comStaff(request(app).get('/admin/aura-notas/companies'));
    const c = r.body.companies.find((x) => x.company_id === COMPLETA);
    for (const k of ['company_id', 'name', 'cnpj', 'ambiente', 'provider', 'provider_efetivo', 'engine_capable',
      'csc_ok', 'serie_sefaz_sp', 'cert', 'last_emission', 'stats_30d', 'breaker_open']) {
      expect(c).toHaveProperty(k);
    }
    expect(c.ambiente).toBe('producao');
    expect(c.csc_ok).toBe(true);
    expect(c.engine_capable).toBe(true);
    expect(c.provider_efetivo).toBe('sefaz_sp');
    expect(c.cert).toMatchObject({ subject_cn: expect.any(String), not_after: expect.any(String), days_left: expect.any(Number) });
    expect(c.nfce_configurada).toBe(true);
    expect(c.nfse_configurada).toBe(true);
    expect(c.certificado_fontes).toEqual(['cofre']);
    expect(c.nfce_pronta).toBe(true);
    expect(c.faltas.nfce).toBe(0);
  });
});

describe('GET /admin/aura-notas/:companyId — requisitos', () => {
  test('lista de requisitos de NFC-e e NFS-e, sem segredo', async () => {
    const r = await comStaff(request(app).get('/admin/aura-notas/' + SO_NFSE));
    expect(r.status).toBe(200);
    const nfce = r.body.requisitos.nfce;
    const nfse = r.body.requisitos.nfse;
    expect(nfce.configurada).toBe(false);
    expect(nfce.itens.map((i) => i.chave)).toEqual([
      'certificado', 'cnpj_certificado', 'inscricao_estadual', 'regime_tributario', 'municipio_ibge',
      'uf', 'csc', 'serie_numero', 'ambiente', 'ativa',
    ]);
    expect(nfce.itens.find((i) => i.chave === 'csc').estado).toBe('falta');
    expect(nfse.itens.map((i) => i.chave)).toEqual([
      'certificado', 'cnpj_certificado', 'municipio_ibge', 'regime_simples', 'ctribnac_padrao',
      'cnbs_padrao', 'inscricao_municipal', 'serie_numero', 'ambiente', 'nota_teste', 'ativa',
    ]);
    expect(nfse.itens.find((i) => i.chave === 'inscricao_municipal').estado).toBe('opcional');
    expect(nfse.itens.find((i) => i.chave === 'cnbs_padrao').estado).toBe('opcional');
    expect(nfse.itens.find((i) => i.chave === 'ativa').estado).toBe('falta');
    expect(nfse.apta).toBe(false); // desligada
    expect(r.body.nfse).toMatchObject({ provider: 'nacional', serie: '1', next_dps_number: '1' });
    expect(r.body.ufs_atendidas).toEqual(expect.arrayContaining(['SP', 'AP', 'MG', 'RJ']));
    expect(JSON.stringify(r.body)).not.toMatch(/SEGREDO|api_key|certificate_pwd|certificate_url|pfx_enc|password_enc/);
  });

  test('certificado de outro CNPJ vira problema nos dois documentos', async () => {
    CERTS.find((c) => c.company_id === SO_NFSE).subject_cn = 'OUTRA EMPRESA:' + cnpjValido(99999999);
    const r = await comStaff(request(app).get('/admin/aura-notas/' + SO_NFSE));
    expect(r.body.requisitos.nfce.itens.find((i) => i.chave === 'cnpj_certificado').estado).toBe('problema');
    expect(r.body.requisitos.nfse.itens.find((i) => i.chave === 'cnpj_certificado').estado).toBe('problema');
  });
});

describe('PUT /admin/aura-notas/:companyId/nfse — regras do lojista', () => {
  const put = (cid, body) => comStaff(request(app).put(`/admin/aura-notas/${cid}/nfse`)).send(body);

  test('validação compartilhada: código de tributação inválido → 400, nada gravado', async () => {
    const r = await put(SO_NFSE, { ctribnac_padrao: '12' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_INPUT');
    expect(escritas).toHaveLength(0);
    expect(auditoria).toHaveLength(0);
  });

  test('campo editável grava, com provider nacional e auditoria do staff', async () => {
    const r = await put(SO_NFSE, { inscricao_municipal: '12345', api_key: 'nao-entra', certificate_url: 'x' });
    expect(r.status).toBe(200);
    expect(escritas).toHaveLength(1);
    expect(escritas[0].s).toMatch(/UPDATE nfse_config SET/);
    expect(escritas[0].s).not.toMatch(/api_key|certificate_url/);
    expect(escritas[0].params).toEqual(expect.arrayContaining(['12345', 'nacional']));
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ staff_user_id: STAFF_ID, company_id: SO_NFSE, action: 'aura_notas_nfse' });
    expect(auditoria[0].payload.campos).toEqual({ inscricao_municipal: '12345' });
  });

  test('ir para produção pede confirmação', async () => {
    const r = await put(SO_NFSE, { ambiente: 'producao' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CONFIRMAR_PRODUCAO');
    expect(escritas).toHaveLength(0);
  });

  test('mudar série ou número pede confirmação; confirmado, grava', async () => {
    const sem = await put(SO_NFSE, { serie: '3' });
    expect(sem.status).toBe(409);
    expect(sem.body.code).toBe('CONFIRMAR_NUMERACAO');
    const num = await put(SO_NFSE, { next_dps_number: 40 });
    expect(num.body.code).toBe('CONFIRMAR_NUMERACAO');
    // mandar o mesmo valor não pede nada
    const igual = await put(SO_NFSE, { serie: '1' });
    expect(igual.status).toBe(200);
    escritas = [];
    const ok = await put(SO_NFSE, { serie: '3', next_dps_number: 40, confirmar_numeracao: true });
    expect(ok.status).toBe(200);
    expect(escritas[0].s).toMatch(/next_dps_number = GREATEST\(next_dps_number/);
    expect(auditoria[auditoria.length - 1].payload.confirmou_numeracao).toBe(true);
  });

  test('ligar sem a nota de teste: mesma trava do lojista', async () => {
    const r = await put(SO_NFSE, { is_active: true, ambiente: 'producao_restrita' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NAO_PODE_LIGAR');
    expect(escritas).toHaveLength(0);
  });
});

describe('PUT /admin/aura-notas/:companyId/fiscal — confirmação e auditoria', () => {
  const put = (cid, body) => comStaff(request(app).put(`/admin/aura-notas/${cid}/fiscal`)).send(body);

  test('primeira configuração em produção pede confirmação', async () => {
    const r = await put(SO_CERT, { ambiente: 'producao', uf: 'SP' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CONFIRMAR_PRODUCAO');
    const ok = await put(SO_CERT, { ambiente: 'producao', uf: 'SP', confirmar_producao: true });
    expect(ok.status).toBe(200);
    expect(auditoria[0]).toMatchObject({ staff_user_id: STAFF_ID, company_id: SO_CERT, action: 'aura_notas_fiscal' });
  });

  test('mesma série de antes não pede nada; próximo número novo pede', async () => {
    const igual = await put(COMPLETA, { serie_sefaz_sp: 2, ambiente: 'producao' });
    expect(igual.status).toBe(200);
    const novo = await put(COMPLETA, { next_number_sefaz_sp: 10 });
    expect(novo.status).toBe(409);
    expect(novo.body.code).toBe('CONFIRMAR_NUMERACAO');
    const ok = await put(COMPLETA, { next_number_sefaz_sp: 10, confirmar_numeracao: true });
    expect(ok.status).toBe(200);
    const ins = escritas.filter((e) => /INSERT INTO nfce_config/.test(e.s)).pop();
    expect(ins.s).toMatch(/next_number_sefaz_sp/);
  });

  test('série nula (empresa sem série ainda) não quebra o salvar', async () => {
    const r = await put(SO_CERT, { serie_sefaz_sp: null, uf: 'SP' });
    expect(r.status).toBe(200);
  });
});

describe('DELETE /admin/aura-notas/:companyId/fiscal — certificado da NFS-e', () => {
  test('quem usa NFS-e: sem confirmação nada é apagado', async () => {
    const r = await comStaff(request(app).delete(`/admin/aura-notas/${COMPLETA}/fiscal`));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CERTIFICADO_DA_NFSE');
    expect(escritas.filter((e) => /DELETE FROM/.test(e.s))).toHaveLength(0);
  });

  test('com ?certificado=apagar segue, avisa e audita', async () => {
    const r = await comStaff(request(app).delete(`/admin/aura-notas/${COMPLETA}/fiscal?certificado=apagar`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, certificado_removido: true, nfse_afetada: true });
    expect(escritas.filter((e) => /DELETE FROM company_certificates/.test(e.s))).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ staff_user_id: STAFF_ID, action: 'aura_notas_remover' });
  });

  test('sem NFS-e o Remover continua como antes', async () => {
    NFSE = NFSE.filter((n) => n.company_id !== COMPLETA);
    const r = await comStaff(request(app).delete(`/admin/aura-notas/${COMPLETA}/fiscal`));
    expect(r.status).toBe(200);
    expect(r.body.nfse_afetada).toBe(false);
  });
});

describe('services/auraNotas/requisitos', () => {
  const req_ = require('../../src/services/auraNotas/requisitos');
  test('UFs atendidas saem do mapa de endpoints', () => {
    const { ENDPOINTS } = require('../../src/services/sefazSp/endpoints');
    expect(req_.ufsAtendidas()).toEqual(Object.keys(ENDPOINTS).sort());
  });
  test('UF fora do mapa vira problema', () => {
    const r = req_.requisitosNfce({ company: { cnpj: cnpjValido(1), address_state: 'BA' }, nfce: null, certRow: null });
    expect(r.itens.find((i) => i.chave === 'uf').estado).toBe('problema');
  });
  test('NFS-e completa e ligada fica apta (mesma conta da emissão)', () => {
    const cnpj = cnpjValido(2);
    const r = req_.requisitosNfse({
      company: { cnpj },
      nfse: { provider: 'nacional', is_active: true, ambiente: 'producao', municipio_ibge: '3550308', ctribnac_padrao: '010501', serie: '1', next_dps_number: 5, op_simp_nac: 1, outro_emissor: false, ultimo_teste_status: 'ok' },
      certRow: { subject_cn: 'X:' + cnpj, not_after: em(100) },
    });
    expect(r.apta).toBe(true);
    expect(r.itens.filter((i) => i.estado === 'falta' || i.estado === 'problema')).toEqual([]);
  });
});
