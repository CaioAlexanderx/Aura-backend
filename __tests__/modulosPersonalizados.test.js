// ============================================================
// AURA. — Chaves de módulo "personalizados.*" (p-127, 16/11/2026)
//
// Personalizados é a frente Studio dentro do shell Negócio. O backend precisa
// conhecer as chaves ANTES do app, porque o override de módulo responde 400
// para chave desconhecida.
//
//   1. services/modules.js: as 9 chaves existem, no plano Negócio
//   2. PUT /admin/clients/:cid/modules aceita as chaves (antes: 400)
//   3. /auth/my-permissions devolve "personalizados.access" do membro, e o
//      consolidado só libera quando todas as empresas liberam
//   4. cadastro de membro: convite e edição gravam a chave como veio
//   5. o cadastro de empresa não mudou: applySegment segue igual (fase 4)
// ============================================================
'use strict';

jest.mock('../src/services/mailer', () => ({
  sendInviteEmail: jest.fn(() => Promise.resolve({ id: 'email-1' })),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const modules = require('../src/services/modules');

const SECRET = 'aura-test-secret-2026';
const CID = '11111111-0000-4000-8000-000000000001';

const CHAVES = [
  'personalizados.access',
  'personalizados.orcamentos',
  'personalizados.producao',
  'personalizados.insumos',
  'personalizados.galeria',
  'personalizados.pedido',
  'personalizados.ficha',
  'personalizados.loja',
  'personalizados.config',
];

beforeEach(() => {
  jest.resetAllMocks();
});

describe('services/modules.js', () => {
  test('as 9 chaves existem e pedem o plano Negócio', () => {
    for (const chave of CHAVES) {
      expect(modules.MODULE_PLAN_MAP[chave]).toBe('negocio');
    }
    const registradas = Object.keys(modules.MODULE_PLAN_MAP).filter((k) => k.startsWith('personalizados.'));
    expect(registradas.sort()).toEqual([...CHAVES].sort());
  });

  test('Essencial não vê nenhuma; Negócio e Expansão veem todas', () => {
    const noEssencial = modules.getVisibleModules('essencial', {});
    const noNegocio = modules.getVisibleModules('negocio', {});
    const noExpansao = modules.getVisibleModules('expansao', {});
    for (const chave of CHAVES) {
      expect(noEssencial).not.toContain(chave);
      expect(noNegocio).toContain(chave);
      expect(noExpansao).toContain(chave);
    }
  });

  test('o override por empresa liga no Essencial e desliga no Negócio', () => {
    expect(modules.getVisibleModules('essencial', { 'personalizados.producao': true }))
      .toContain('personalizados.producao');
    expect(modules.getVisibleModules('negocio', { 'personalizados.producao': false }))
      .not.toContain('personalizados.producao');
    expect(modules.getModuleMap('essencial', {})['personalizados.producao'])
      .toEqual({ visible: false, minPlan: 'negocio', reason: 'plan_required' });
  });

  test('as chaves que já existiam não mudaram de plano', () => {
    expect(modules.MODULE_PLAN_MAP['matcon.orcamentos']).toBe('essencial');
    expect(modules.MODULE_PLAN_MAP['otica.config']).toBe('essencial');
    expect(modules.MODULE_PLAN_MAP.canal).toBe('negocio');
    expect(modules.MODULE_PLAN_MAP.agentes).toBe('expansao');
  });
});

describe('PUT /admin/clients/:cid/modules', () => {
  const app = express();
  app.use(express.json());
  app.use('/admin', require('../src/routes/admin'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));

  const staff = `Bearer ${jwt.sign({ id: 'staff-1', role: 'admin' }, SECRET, { expiresIn: '1h' })}`;

  test('aceita as chaves personalizados.* e grava como vieram', async () => {
    db.query.mockImplementation((sql, params) => {
      if (/UPDATE companies SET module_overrides/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: CID, plan: 'essencial', module_overrides: JSON.parse(params[0]) }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const overrides = { 'personalizados.producao': true, 'personalizados.loja': false };
    const res = await request(app).put(`/admin/clients/${CID}/modules`).set('Authorization', staff).send({ overrides });

    expect(res.status).toBe(200);
    expect(res.body.overrides).toEqual(overrides);
    expect(res.body.visible).toContain('personalizados.producao');
    expect(res.body.visible).not.toContain('personalizados.loja');
    const gravado = db.query.mock.calls.find(([s]) => /UPDATE companies SET module_overrides/i.test(s));
    expect(JSON.parse(gravado[1][0])).toEqual(overrides);
  });

  test('chave desconhecida continua 400 e não grava', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).put(`/admin/clients/${CID}/modules`).set('Authorization', staff)
      .send({ overrides: { 'personalizados.nao_existe': true } });
    expect(res.status).toBe(400);
    expect(db.query.mock.calls.some(([s]) => /UPDATE companies/i.test(s))).toBe(false);
  });
});

describe('GET /auth/my-permissions', () => {
  const app = express();
  app.use('/auth', require('../src/routes/myPermissions'));

  const USER = 'u-1';
  const A = 'company-a';
  const B = 'company-b';
  let tabela;

  const linha = (company_id, permissions) => ({
    company_id, plan: 'negocio', is_company_owner: false, role_label: 'colaborador', permissions,
  });
  const token = (payload) => `Bearer ${jwt.sign({ id: USER, role: 'user', ...payload }, SECRET, { expiresIn: '1h' })}`;
  const get = (payload) => request(app).get('/auth/my-permissions').set('Authorization', token(payload));

  beforeEach(() => {
    db.query.mockImplementation((sql, params) => {
      let rows = tabela.slice();
      if (/c\.id\s*=\s*\$2/.test(sql)) rows = rows.filter((r) => r.company_id === params[1]);
      if (/LIMIT 1/i.test(sql)) rows = rows.slice(0, 1);
      return Promise.resolve({ rows });
    });
  });

  test('devolve personalizados.access do membro na empresa do token', async () => {
    tabela = [linha(A, JSON.stringify({ pdv: true, 'personalizados.access': true }))];
    const res = await get({ company: A, consolidated_view: false });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual({ pdv: true, 'personalizados.access': true });
  });

  test('membro sem a chave não ganha a permissão', async () => {
    tabela = [linha(A, { pdv: true })];
    const res = await get({ company: A, consolidated_view: false });
    expect(res.body.permissions['personalizados.access']).toBeUndefined();
  });

  test('consolidado: liberada só numa empresa = negada', async () => {
    tabela = [linha(A, { pdv: true, 'personalizados.access': true }), linha(B, { pdv: true })];
    const res = await get({ company: null, consolidated_view: true });
    expect(res.body.permissions['personalizados.access']).toBe(false);
    expect(res.body.permissions.pdv).toBe(true);
  });

  test('consolidado: liberada em todas = liberada', async () => {
    tabela = [
      linha(A, { 'personalizados.access': true }),
      linha(B, { 'personalizados.access': true }),
    ];
    const res = await get({ company: null, consolidated_view: true });
    expect(res.body.permissions['personalizados.access']).toBe(true);
  });
});

describe('cadastro de membro', () => {
  const members = require('../src/services/members');
  const { diffPermissions } = require('../src/services/memberAudit');
  const PERMS = { painel: true, pdv: false, 'personalizados.access': true };

  test('o convite grava personalizados.access como veio', async () => {
    db.query.mockImplementation((sql) => {
      if (/INSERT INTO company_members/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'm1', invite_token: 't', invite_email: null, role_label: 'colaborador', status: 'pending' }] });
      }
      if (/FROM companies c/i.test(sql)) return Promise.resolve({ rows: [{ company_name: 'Loja', inviter_name: 'Dona' }] });
      return Promise.resolve({ rows: [] });
    });
    await members.inviteMember(CID, 'owner-1', { role_label: 'colaborador', permissions: PERMS });
    const insert = db.query.mock.calls.find(([s]) => /INSERT INTO company_members/i.test(s));
    expect(JSON.parse(insert[1][3])).toEqual(PERMS);
  });

  test('o convite sem permissões não liga a chave por padrão', async () => {
    db.query.mockImplementation((sql) => {
      if (/INSERT INTO company_members/i.test(sql)) return Promise.resolve({ rows: [{ id: 'm1', invite_token: 't' }] });
      if (/FROM companies c/i.test(sql)) return Promise.resolve({ rows: [{}] });
      return Promise.resolve({ rows: [] });
    });
    await members.inviteMember(CID, 'owner-1', { role_label: 'colaborador' });
    const insert = db.query.mock.calls.find(([s]) => /INSERT INTO company_members/i.test(s));
    expect(JSON.parse(insert[1][3])['personalizados.access']).toBeUndefined();
  });

  test('a edição do membro grava personalizados.access como veio', async () => {
    db.query.mockImplementation((sql, params) => {
      if (/UPDATE company_members SET/i.test(sql)) return Promise.resolve({ rows: [{ id: 'm1', permissions: params[0] }] });
      return Promise.resolve({ rows: [] });
    });
    await members.updateMemberPermissions(CID, 'm1', { permissions: PERMS });
    const update = db.query.mock.calls.find(([s]) => /UPDATE company_members SET/i.test(s));
    expect(update[0]).toMatch(/permissions=\$1/);
    expect(JSON.parse(update[1][0])).toEqual(PERMS);
  });

  test('o histórico do membro registra a chave ligada e desligada', () => {
    expect(diffPermissions({ pdv: true }, { pdv: true, 'personalizados.access': true }))
      .toEqual({ added: ['personalizados.access'], removed: [] });
    expect(diffPermissions({ 'personalizados.access': true }, {}))
      .toEqual({ added: [], removed: ['personalizados.access'] });
  });
});

describe('o que não muda nesta fase', () => {
  const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('o cadastro de empresa não conhece as chaves novas', () => {
    expect(fonte('src/services/segment.js')).not.toMatch(/personalizados\./);
  });

  test('nenhuma rota ganhou gate pelas chaves novas', () => {
    expect(fonte('src/routes/private.js')).not.toMatch(/personalizados\./);
  });
});
