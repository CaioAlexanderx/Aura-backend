// ============================================================
// AURA KARATÊ — P2.1: TOKEN DE MESA do mesário (fora do shell)
//
// Cobertura:
//   (1) federação emite o link (201, token em claro 64 chars, rotação) e
//       revoga (200; revogar de novo → 404). Convocação fora do escopo → 404.
//   (2) mesa /me: bootstrap com evento + oficial + koto + fila de
//       categorias do koto; token inválido → 401 GENÉRICO (mesmo body
//       para "não existe" e "revogado").
//   (3) escopo do koto: categoria de OUTRO koto → 403 CATEGORIA_FORA_DO_
//       KOTO; do próprio koto → delega ao handler compartilhado do GET
//       bracket (not_generated).
//   (4) troca de koto AO VIVO: mesmo token, area_id da convocação muda →
//       a MESMA categoria passa a 403 no request seguinte (o escopo é
//       relido a cada request, não congelado na emissão).
//   (5) mesário sem koto: /me devolve area null + fila vazia; operar
//       categoria → 409 MESARIO_SEM_KOTO.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const FED_ID = 'fed-uuid-mesa';
const COMP_ID = 'comp-uuid-mesa';
const AREA_1 = 'area-1-uuid-mesa';
const AREA_2 = 'area-2-uuid-mesa';
const ROW_1 = 'row-1-uuid-mesa';
const CAT_A = 'cat-a-uuid-mesa'; // no koto do mesário (AREA_1)
const CAT_B = 'cat-b-uuid-mesa'; // em OUTRO koto (AREA_2)

const MESA_TOKEN = 'a'.repeat(64); // token opaco válido (>= 32 chars)

const adminToken = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildFedApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateOfficials'));
  return app;
}

function buildMesaApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/karate/mesa', require('../src/routes/karateMesaPublic'));
  return app;
}

// Contexto padrão devolvido pelo resolve (query `-- mesa:resolve`).
function mesaContext(overrides = {}) {
  return Object.assign({
    competition_official_id: ROW_1,
    area_id: AREA_1,
    status: 'present',
    is_chief: false,
    official_id: 'off-uuid-mesa',
    official_name: 'Marina Kobayashi',
    official_role: 'mesario',
    area_name: 'Koto 1',
    area_sort_order: 1,
    competition_id: COMP_ID,
    competition_name: 'XXV Campeonato Paulista',
    competition_status: 'open',
    event_date: '2026-08-22',
    location: 'Barueri',
    federation_id: FED_ID,
  }, overrides);
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── (1) federação emite e revoga ────────────────────────────
describe('federação: emitir/revogar o link da mesa', () => {
  it('(1) POST emite token em claro (201); DELETE revoga; revogar de novo → 404', async () => {
    let issued = null;
    let active = false;
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/-- mesa:issue/.test(s)) {
        issued = params[0]; // hash persistido — nunca o token em claro
        active = true;
        return Promise.resolve({ rows: [{ id: ROW_1, created_at: '2026-08-23T10:00:00Z', official_name: 'Marina Kobayashi' }] });
      }
      if (/-- mesa:revoke/.test(s)) {
        if (!active) return Promise.resolve({ rows: [] });
        active = false;
        return Promise.resolve({ rows: [{ id: ROW_1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = buildFedApp();
    const res = await request(app)
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/officials/${ROW_1}/mesa-token`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.official_name).toBe('Marina Kobayashi');
    // No banco vai o HASH, nunca o token em claro.
    expect(issued).not.toBe(res.body.token);
    expect(issued).toMatch(/^[0-9a-f]{64}$/); // sha256 hex

    const del = await request(app)
      .delete(`/federation/${FED_ID}/competitions/${COMP_ID}/officials/${ROW_1}/mesa-token`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(del.status).toBe(200);
    expect(del.body.revoked).toBe(true);

    const delAgain = await request(app)
      .delete(`/federation/${FED_ID}/competitions/${COMP_ID}/officials/${ROW_1}/mesa-token`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(delAgain.status).toBe(404);
  });

  it('(1b) convocação fora do escopo da federação → 404 (UPDATE não encontra)', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await request(buildFedApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/officials/alheia/mesa-token`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(404);
  });
});

// ── (2) mesa /me ────────────────────────────────────────────
describe('mesa pública: bootstrap /me', () => {
  it('(2) /me devolve evento + oficial + koto + fila do koto', async () => {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/-- mesa:resolve/.test(s)) return Promise.resolve({ rows: [mesaContext()] });
      if (/FROM karate_competition_categories cat/.test(s)) {
        expect(params).toEqual([COMP_ID, AREA_1]); // fila SÓ do koto do mesário
        return Promise.resolve({ rows: [
          { id: CAT_A, name: 'Kata Masc até 7', modality: 'kata', group_label: 'Grupo 1',
            area_order: 1, division_name: 'Paulista', bracket_status: 'locked',
            kata_mode: 'score_rounds', entry_count: 6 },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(buildMesaApp())
      .get('/public/karate/mesa/me')
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.competition.name).toBe('XXV Campeonato Paulista');
    expect(res.body.official).toEqual({
      name: 'Marina Kobayashi', role: 'mesario', is_chief: false, status: 'present',
    });
    expect(res.body.area).toEqual({ id: AREA_1, name: 'Koto 1', sort_order: 1 });
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0]).toMatchObject({
      id: CAT_A, bracket_status: 'locked', kata_mode: 'score_rounds', entry_count: 6,
    });
  });

  it('(2b) token inválido/revogado → 401 GENÉRICO (nunca vaza o motivo)', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] })); // resolve não encontra
    const res = await request(buildMesaApp())
      .get('/public/karate/mesa/me')
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MESA_LINK_INVALID');

    const semAuth = await request(buildMesaApp()).get('/public/karate/mesa/me');
    expect(semAuth.status).toBe(401);
    expect(semAuth.body).toEqual(res.body); // mesmo body — indistinguível
  });
});

// ── (3)+(4) escopo do koto ──────────────────────────────────
describe('mesa pública: escopo do koto', () => {
  // Mock com area do mesário MUTÁVEL — simula a federação movendo o
  // mesário de koto entre um request e outro.
  function mockWithArea(getArea) {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/-- mesa:resolve/.test(s)) {
        return Promise.resolve({ rows: [mesaContext({ area_id: getArea() })] });
      }
      if (/-- mesa:cat-scope/.test(s)) {
        const areaByCat = { [CAT_A]: AREA_1, [CAT_B]: AREA_2 };
        if (!(params[0] in areaByCat)) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ id: params[0], area_id: areaByCat[params[0]] }] });
      }
      return Promise.resolve({ rows: [] });
    });
    // Handler compartilhado do GET bracket usa db.connect (client próprio).
    db.connect.mockImplementation(() => Promise.resolve({
      query: (sql) => {
        const s = String(sql);
        if (/FROM karate_competitions WHERE id/.test(s)) {
          return Promise.resolve({ rows: [{ id: COMP_ID, status: 'open' }] });
        }
        return Promise.resolve({ rows: [] });
      },
      release: () => {},
    }));
  }

  it('(3) categoria de outro koto → 403; do próprio koto → delega (not_generated)', async () => {
    mockWithArea(() => AREA_1);

    const alheia = await request(buildMesaApp())
      .get(`/public/karate/mesa/categories/${CAT_B}/bracket`)
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(alheia.status).toBe(403);
    expect(alheia.body.code).toBe('CATEGORIA_FORA_DO_KOTO');

    const propria = await request(buildMesaApp())
      .get(`/public/karate/mesa/categories/${CAT_A}/bracket`)
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(propria.status).toBe(200);
    expect(propria.body.status).toBe('not_generated'); // handler compartilhado respondeu
  });

  it('(4) troca de koto AO VIVO: mesmo token, escopo segue o area_id atual', async () => {
    let area = AREA_1;
    mockWithArea(() => area);
    const app = buildMesaApp();

    const antes = await request(app)
      .get(`/public/karate/mesa/categories/${CAT_A}/bracket`)
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(antes.status).toBe(200);

    area = AREA_2; // federação moveu o mesário para o Koto 2
    const depois = await request(app)
      .get(`/public/karate/mesa/categories/${CAT_A}/bracket`)
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(depois.status).toBe(403);
    expect(depois.body.code).toBe('CATEGORIA_FORA_DO_KOTO');

    // ... e o CAT_B (do Koto 2) passou a ser operável.
    const catB = await request(app)
      .get(`/public/karate/mesa/categories/${CAT_B}/bracket`)
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(catB.status).toBe(200);
  });
});

// ── (5) mesário sem koto ────────────────────────────────────
describe('mesa pública: mesário ainda sem koto', () => {
  it('(5) /me devolve area null + fila vazia; operar → 409 MESARIO_SEM_KOTO', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/-- mesa:resolve/.test(s)) {
        return Promise.resolve({ rows: [mesaContext({ area_id: null, area_name: null, area_sort_order: null })] });
      }
      return Promise.resolve({ rows: [] });
    });

    const me = await request(buildMesaApp())
      .get('/public/karate/mesa/me')
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(me.status).toBe(200);
    expect(me.body.area).toBeNull();
    expect(me.body.categories).toEqual([]);

    const op = await request(buildMesaApp())
      .get(`/public/karate/mesa/categories/${CAT_A}/bracket`)
      .set('Authorization', 'Bearer ' + MESA_TOKEN);
    expect(op.status).toBe(409);
    expect(op.body.code).toBe('MESARIO_SEM_KOTO');
  });
});

// ── (6) súmula gravável pela mesa (304) ─────────────────────
describe('mesa pública: súmula gravável', () => {
  it('(6) PATCH scoresheet grava shuchin/mesário/duração no escopo do koto', async () => {
    const saved = {};
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/-- mesa:resolve/.test(s)) return Promise.resolve({ rows: [mesaContext()] });
      if (/-- mesa:cat-scope/.test(s)) {
        return Promise.resolve({ rows: [{ id: params[0], area_id: AREA_1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    db.connect.mockImplementation(() => Promise.resolve({
      query: (sql, params) => {
        const s = String(sql);
        if (/FROM karate_competitions WHERE id/.test(s)) {
          return Promise.resolve({ rows: [{ id: COMP_ID, status: 'open' }] });
        }
        if (/FROM karate_brackets WHERE category_id/.test(s)) {
          return Promise.resolve({ rows: [{ id: 'br-1', status: 'locked', sumula: { shuchin: 'Sensei Okada' } }] });
        }
        if (/UPDATE karate_brackets SET sumula/.test(s)) {
          Object.assign(saved, JSON.parse(params[0]));
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      },
      release: () => {},
    }));

    const res = await request(buildMesaApp())
      .patch(`/public/karate/mesa/categories/${CAT_A}/scoresheet`)
      .set('Authorization', 'Bearer ' + MESA_TOKEN)
      .send({ mesario: 'Marina Kobayashi', duracao: '2h10' });
    expect(res.status).toBe(200);
    // merge parcial: preserva o shuchin já gravado.
    expect(res.body.sumula).toEqual({ shuchin: 'Sensei Okada', mesario: 'Marina Kobayashi', duracao: '2h10' });
    expect(saved).toEqual(res.body.sumula);

    // Categoria de outro koto segue 403 também no PATCH.
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/-- mesa:resolve/.test(s)) return Promise.resolve({ rows: [mesaContext()] });
      if (/-- mesa:cat-scope/.test(s)) return Promise.resolve({ rows: [{ id: params[0], area_id: AREA_2 }] });
      return Promise.resolve({ rows: [] });
    });
    const fora = await request(buildMesaApp())
      .patch(`/public/karate/mesa/categories/${CAT_B}/scoresheet`)
      .set('Authorization', 'Bearer ' + MESA_TOKEN)
      .send({ mesario: 'X' });
    expect(fora.status).toBe(403);
  });
});
