// ============================================================
// AURA KARATÊ — Identidade da federação (rota)
//
// O que estes testes travam:
//
//   1. GET /federation/:id/identity devolve nome + LOGO. A logo é o motivo de
//      o endpoint existir: o app já tem o nome pelo JWT, mas o auth store
//      nunca revalida o token — logo trocada só apareceria no próximo login.
//   2. O endpoint é de LEITURA (guards.read): staff/viewer enxergam a marca.
//   3. Federação inexistente é 404, não 200 com campos nulos — o app precisa
//      distinguir "sem logo" de "id errado".
//   4. POST /settings/identity/logo é adminOnly, valida tipo, só grava depois
//      de o upload dar certo, e carimba ?v= (senão o CDN serve a logo antiga
//      e o admin jura que o upload não funcionou).
//
// O banco responde pelo CONTEÚDO do SQL, nunca por fila posicional: os guards
// consultam company_members antes do handler e a ordem é detalhe deles.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../src/utils/r2Storage', () => ({
  uploadToR2: jest.fn(),
}));

const federationRouter = require('../../src/routes/karateFederation');
const settingsRouter = require('../../src/routes/karateSettings');
const { uploadToR2 } = require('../../src/utils/r2Storage');

let db;
beforeAll(() => { db = require('../../src/config/database'); });

const SECRET = 'aura-test-secret-2026';
const FED = 'fed00000-0000-0000-0000-000000000001';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/v1/federation/:id', federationRouter);
app.use('/api/v1/federation/:id', settingsRouter);

// Linha de companies da federação, como o SELECT de identidade devolve.
const FED_ROW = {
  id: FED,
  name: 'JKA Teste',
  slug: 'jka-teste',
  email: 'secretaria@jka-teste.org',
  karate_logo_url: 'https://cdn.exemplo/karate/federations/fed/logo.png?v=1',
  wa_phone_display: '11999990000',
};

// `papel` é o que company_members devolve para o usuário do token.
function fakeDb({ papel = 'federation_admin', fedRow = FED_ROW, onUpdate } = {}) {
  return (sql, params) => {
    const s = String(sql);

    // Guard: requireCompanyAccess resolve owner/role_label no :id
    if (/company_members/.test(s) || /owner_id/.test(s)) {
      return Promise.resolve({ rows: papel ? [{ role: papel, role_label: papel }] : [] });
    }
    // UPDATE da logo
    if (/^UPDATE companies SET karate_logo_url/.test(s.trim())) {
      if (onUpdate) onUpdate(params);
      return Promise.resolve({ rows: [{ karate_logo_url: params[0] }] });
    }
    // Existência da federação (antes de gastar upload no R2)
    if (/SELECT id FROM companies/.test(s)) {
      return Promise.resolve({ rows: fedRow ? [{ id: FED }] : [] });
    }
    // SELECT de identidade
    if (/FROM companies/.test(s)) {
      return Promise.resolve({ rows: fedRow ? [fedRow] : [] });
    }
    return Promise.resolve({ rows: [] });
  };
}

function auth() {
  return `Bearer ${jwt.sign({ id: 'u-1', role: 'user' }, SECRET, { expiresIn: '1h' })}`;
}

beforeEach(() => {
  jest.resetAllMocks();
  db.query.mockImplementation(fakeDb());
  uploadToR2.mockResolvedValue({
    success: true,
    url: 'https://cdn.exemplo/karate/federations/' + FED + '/logo.png',
  });
});

describe('GET /federation/:id/identity', () => {
  test('devolve a identidade visual, com a logo', async () => {
    const res = await request(app).get(`/api/v1/federation/${FED}/identity`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: FED,
      name: 'JKA Teste',
      slug: 'jka-teste',
      logo_url: FED_ROW.karate_logo_url,
      email: 'secretaria@jka-teste.org',
      whatsapp: '11999990000',
    });
  });

  test('não vaza nada além da identidade (sem CNPJ, sem dado fiscal)', async () => {
    db.query.mockImplementation(fakeDb({ fedRow: { ...FED_ROW, cnpj: '11222333000181' } }));
    const res = await request(app).get(`/api/v1/federation/${FED}/identity`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'logo_url', 'name', 'slug', 'whatsapp']);
  });

  test('é leitura: um viewer da federação enxerga a própria marca', async () => {
    db.query.mockImplementation(fakeDb({ papel: 'federation_viewer' }));
    const res = await request(app).get(`/api/v1/federation/${FED}/identity`).set('Authorization', auth());
    expect(res.status).toBe(200);
  });

  test('federação inexistente é 404, não 200 com campos nulos', async () => {
    db.query.mockImplementation(fakeDb({ fedRow: null }));
    const res = await request(app).get(`/api/v1/federation/${FED}/identity`).set('Authorization', auth());
    expect(res.status).toBe(404);
  });

  test('sem token, 401', async () => {
    const res = await request(app).get(`/api/v1/federation/${FED}/identity`);
    expect(res.status).toBe(401);
  });

  test('logo ausente vira null explícito (o app não recebe undefined)', async () => {
    db.query.mockImplementation(fakeDb({ fedRow: { ...FED_ROW, karate_logo_url: null } }));
    const res = await request(app).get(`/api/v1/federation/${FED}/identity`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.logo_url).toBeNull();
  });
});

describe('POST /federation/:id/settings/identity/logo', () => {
  const base64 = Buffer.from('imagem-de-mentira').toString('base64');

  test('sobe no R2 e grava a URL com ?v= (cache-buster)', async () => {
    let gravado = null;
    db.query.mockImplementation(fakeDb({ onUpdate: (params) => { gravado = params[0]; } }));

    const res = await request(app)
      .post(`/api/v1/federation/${FED}/settings/identity/logo`)
      .set('Authorization', auth())
      .send({ content: base64, content_type: 'image/png' });

    expect(res.status).toBe(200);
    expect(uploadToR2).toHaveBeenCalledWith(
      `karate/federations/${FED}/logo.png`,
      base64,
      'image/png'
    );
    expect(gravado).toMatch(/\?v=\d+$/);
    expect(res.body.logo_url).toBe(gravado);
  });

  test('tipo não suportado é recusado ANTES de gastar upload', async () => {
    const res = await request(app)
      .post(`/api/v1/federation/${FED}/settings/identity/logo`)
      .set('Authorization', auth())
      .send({ content: base64, content_type: 'image/gif' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTENT_TYPE');
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  test('content ausente é 400', async () => {
    const res = await request(app)
      .post(`/api/v1/federation/${FED}/settings/identity/logo`)
      .set('Authorization', auth())
      .send({ content_type: 'image/png' });

    expect(res.status).toBe(400);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  test('falha no R2 não grava coluna nenhuma', async () => {
    let gravou = false;
    db.query.mockImplementation(fakeDb({ onUpdate: () => { gravou = true; } }));
    uploadToR2.mockResolvedValue({ success: false, error: 'boom' });

    const res = await request(app)
      .post(`/api/v1/federation/${FED}/settings/identity/logo`)
      .set('Authorization', auth())
      .send({ content: base64 });

    expect(res.status).toBe(500);
    expect(gravou).toBe(false);
  });

  test('staff (não admin) não troca a marca da federação', async () => {
    db.query.mockImplementation(fakeDb({ papel: 'federation_staff' }));
    const res = await request(app)
      .post(`/api/v1/federation/${FED}/settings/identity/logo`)
      .set('Authorization', auth())
      .send({ content: base64 });

    expect(res.status).toBe(403);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  test('DELETE limpa a coluna', async () => {
    let gravado = 'ainda-nao';
    db.query.mockImplementation(fakeDb({ onUpdate: (params) => { gravado = params[0]; } }));

    const res = await request(app)
      .delete(`/api/v1/federation/${FED}/settings/identity/logo`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(gravado).toBeNull();
    expect(res.body.logo_url).toBeNull();
  });
});
