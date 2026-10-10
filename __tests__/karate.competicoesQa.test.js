// ============================================================
// AURA KARATÊ — QA de Competições (10/10): correções verificadas em produção
//
//  (1) Kata por notas com kata_mode NULL fecha o pódio (antes: 422 "A final
//      ainda não foi decidida"); generate grava 'score_rounds'.
//  (2) Ausente confirmado (no_show_at) sem nota não trava o avanço do kata;
//      presente/sem informação sem nota continua 422; 305 pendente = antes.
//  (3) Detalhe e lista de categorias devolvem division_id/division_name/
//      group_label.
//  (4) PATCH de categoria com chave: trocar modality/sex → 409 BRACKET_EXISTS.
//  (5) DELETE de categoria: só vazia; em uso → 409 CATEGORY_IN_USE.
//  (6) results_config (pontos por colocação): PATCH valida e grava; GET devolve.
//  (7) DELETE de koto com categorias → 409 AREA_HAS_CATEGORIES (salvo ?force=1).
//  (8) Slug público resolve por companies.slug quando não há canal digital.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const FED = 'fed-uuid-qa';
const COMP = 'comp-uuid-qa';
const CAT = 'cat-uuid-qa';
const BRACKET = 'bracket-uuid-qa';
const E1 = 'entry-1-qa';
const E2 = 'entry-2-qa';
const E3 = 'entry-3-qa';

const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);
const auth = (r) => r.set('Authorization', 'Bearer ' + token);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateBrackets'));
  app.use('/federation/:id', require('../src/routes/karateCompetitions'));
  app.use('/federation/:id', require('../src/routes/karateCompetitionSetup'));
  return app;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// Cliente de transação: `handler(sql, params)` devolve rows (ou lança);
// todo SQL fica em `calls` para as asserções de escrita.
function mockClient(handler) {
  const calls = [];
  db.connect.mockImplementation(() => Promise.resolve({
    query: (sql, params) => {
      const s = String(sql);
      calls.push({ sql: s, params });
      try {
        const rows = handler(s, params);
        return Promise.resolve({ rows: rows || [] });
      } catch (e) {
        return Promise.reject(e);
      }
    },
    release: () => {},
  }));
  db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
  return calls;
}

function pgError(code) { const e = new Error('pg ' + code); e.code = code; return e; }

// ── (1) kata por notas fecha o pódio ─────────────────────────
describe('(1) finalize do kata por notas', () => {
  function kataFinalizeHandler(kataMode) {
    return (s) => {
      if (/SELECT results_config FROM karate_competitions/.test(s)) {
        return [{ results_config: { points_by_placement: { 1: 9, 2: 6, 3: 3 } } }];
      }
      if (/FROM karate_competitions WHERE id/.test(s)) return [{ id: COMP, status: 'open' }];
      if (/FROM karate_competition_categories WHERE id/.test(s)) return [{ id: CAT, modality: 'kata' }];
      if (/FROM karate_brackets WHERE category_id/.test(s)) {
        return [{ id: BRACKET, status: 'locked', modality: 'kata', kata_mode: kataMode, options: {} }];
      }
      if (/FROM karate_competition_entries e/.test(s)) {
        return [
          { id: E1, student_id: 's1', dojo_id: 'd1', student_name: 'Marina', dojo_name: 'Kondei' },
          { id: E2, student_id: 's2', dojo_id: 'd1', student_name: 'Rafael', dojo_name: 'Kondei' },
        ];
      }
      if (/FROM karate_kata_scores\s+WHERE bracket_id = \$1 AND phase = 'final'/.test(s)) {
        return [{ entry_id: E2, nota: '23.5', notas: null }, { entry_id: E1, nota: '24.1', notas: null }];
      }
      return [];
    };
  }

  it.each([[null], ['score_rounds']])('kata_mode=%s → 200 com pódio por nota e pontos', async (mode) => {
    const calls = mockClient(kataFinalizeHandler(mode));
    const res = await auth(request(buildApp())
      .post(`/federation/${FED}/competitions/${COMP}/categories/${CAT}/bracket/finalize`));
    expect(res.status).toBe(200);
    expect(res.body.podium.map((p) => [p.entry_id, p.placement, p.points_awarded]))
      .toEqual([[E1, 1, 9], [E2, 2, 6]]);
    const writes = calls.filter((c) => /SET placement = \$1, points_awarded = \$2/.test(c.sql));
    expect(writes).toHaveLength(2);
  });

  it('generate de kata grava kata_mode=score_rounds (e hantei_tree quando pedido)', async () => {
    for (const [body, expected] of [[{}, 'score_rounds'], [{ kata_mode: 'hantei_tree' }, 'hantei_tree']]) {
      const calls = mockClient((s) => {
        if (/FROM karate_competitions WHERE id/.test(s)) return [{ id: COMP, status: 'open' }];
        if (/FROM karate_competition_categories WHERE id/.test(s)) return [{ id: CAT, modality: 'kata' }];
        if (/FROM karate_competition_entries e/.test(s)) {
          return [
            { id: E1, student_id: 's1', dojo_id: 'd1', student_name: 'Marina' },
            { id: E2, student_id: 's2', dojo_id: 'd2', student_name: 'Rafael' },
          ];
        }
        if (/INSERT INTO karate_brackets/.test(s)) return [{ id: BRACKET }];
        return [];
      });
      const res = await auth(request(buildApp())
        .post(`/federation/${FED}/competitions/${COMP}/categories/${CAT}/bracket/generate`)
        .send(body));
      expect(res.status).toBe(200);
      const ins = calls.find((c) => /INSERT INTO karate_brackets/.test(c.sql));
      expect(ins.params[5]).toBe(expected);
      if (expected === 'score_rounds') expect(res.body.kata_mode).toBe('score_rounds');
    }
  });
});

// ── (2) ausente não trava o avanço do kata ───────────────────
describe('(2) kata-scores/advance com ausência confirmada', () => {
  function advanceHandler({ elim, noShow, noShowError }) {
    return (s) => {
      if (/FROM karate_competitions WHERE id/.test(s)) return [{ id: COMP, status: 'open' }];
      if (/FROM karate_brackets WHERE category_id/.test(s)) {
        return [{ id: BRACKET, status: 'locked', modality: 'kata', kata_mode: null }];
      }
      if (/FROM karate_kata_scores\s+WHERE bracket_id=\$1 AND phase='eliminatoria'/.test(s)) return elim;
      if (/no_show_at IS NOT NULL/.test(s)) {
        if (noShowError) throw pgError(noShowError);
        return noShow.map((id) => ({ id }));
      }
      return [];
    };
  }
  const post = (body = { advance_count: 1 }) => auth(request(buildApp())
    .post(`/federation/${FED}/competitions/${COMP}/categories/${CAT}/kata-scores/advance`)
    .send(body));

  it('ausente sem nota é eliminado automaticamente; os presentes avançam', async () => {
    const calls = mockClient(advanceHandler({
      elim: [
        { entry_id: E1, nota: '24.0', notas: null },
        { entry_id: E2, nota: '22.0', notas: null },
        { entry_id: E3, nota: null, notas: null },
      ],
      noShow: [E3],
    }));
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      advanced: 1, eliminated: 2, absent: 1,
      absent_entry_ids: [E3], advancing_entry_ids: [E1],
    });
    const marcouAusente = calls.find((c) => /advances=false/.test(c.sql) && c.params[1] === E3);
    expect(marcouAusente).toBeTruthy();
    expect(calls.some((c) => /INSERT INTO karate_kata_scores/.test(c.sql) && c.params[1] === E3)).toBe(false);
    // consulta de ausência sob SAVEPOINT (dentro da transação)
    expect(calls.some((c) => /^SAVEPOINT kata_no_show/.test(c.sql))).toBe(true);
  });

  it('presente/sem informação sem nota continua 422', async () => {
    mockClient(advanceHandler({
      elim: [
        { entry_id: E1, nota: '24.0', notas: null },
        { entry_id: E2, nota: null, notas: null },
        { entry_id: E3, nota: null, notas: null },
      ],
      noShow: [E3],
    }));
    const res = await post();
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('305 pendente (42703): sem ausência conhecida → 422 de antes, nunca 500', async () => {
    mockClient(advanceHandler({
      elim: [{ entry_id: E1, nota: '24.0', notas: null }, { entry_id: E3, nota: null, notas: null }],
      noShow: [], noShowError: '42703',
    }));
    const res = await post();
    expect(res.status).toBe(422);
  });
});

// ── (3)(4)(5)(6) rotas de competição/categoria ────────────────
describe('karateCompetitions', () => {
  const COMP_ROW = { id: COMP, federation_id: FED, name: 'Copa', season: 2026, status: 'open' };

  function mockQuery(handler) {
    const calls = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      calls.push({ sql: s, params });
      try { return Promise.resolve({ rows: handler(s, params) || [] }); } catch (e) { return Promise.reject(e); }
    });
    return calls;
  }

  it('(3) detalhe devolve division_id, division_name, group_label e results_config', async () => {
    mockQuery((s) => {
      if (/SELECT \* FROM karate_competitions/.test(s)) {
        return [{ ...COMP_ROW, results_config: { points_by_placement: { 1: 9 } } }];
      }
      if (/FROM karate_competition_categories cat/.test(s)) {
        expect(s).toMatch(/LEFT JOIN karate_competition_divisions d ON d.id = cat.division_id/);
        return [{ id: CAT, name: 'Kata Sub-12', modality: 'kata', sex: 'M', division_id: 'div-1',
          division_name: 'Copa Aspirantes', group_label: 'G1', entry_count: 3 }];
      }
      return [];
    });
    const res = await auth(request(buildApp()).get(`/federation/${FED}/competitions/${COMP}`));
    expect(res.status).toBe(200);
    expect(res.body.categories[0]).toMatchObject({
      division_id: 'div-1', division_name: 'Copa Aspirantes', group_label: 'G1',
    });
    expect(res.body.results_config).toEqual({ points_by_placement: { 1: 9 } });
  });

  it('(3) lista de categorias resolve division_name', async () => {
    mockQuery((s) => {
      if (/SELECT \* FROM karate_competitions/.test(s)) return [COMP_ROW];
      if (/FROM karate_competition_categories cat/.test(s)) {
        expect(s).toMatch(/d\.name AS division_name/);
        return [{ id: CAT, division_id: 'div-1', division_name: 'Copa Aspirantes', group_label: 'G1' }];
      }
      return [];
    });
    const res = await auth(request(buildApp()).get(`/federation/${FED}/competitions/${COMP}/categories`));
    expect(res.status).toBe(200);
    expect(res.body[0].division_name).toBe('Copa Aspirantes');
  });

  describe('(4) PATCH de categoria com chave', () => {
    function setup({ hasBracket }) {
      return mockQuery((s) => {
        if (/SELECT \* FROM karate_competitions/.test(s)) return [COMP_ROW];
        if (/SELECT modality, sex FROM karate_competition_categories/.test(s)) return [{ modality: 'kumite', sex: 'M' }];
        if (/FROM karate_brackets WHERE category_id/.test(s)) return [{ n: hasBracket ? 1 : 0 }];
        if (/UPDATE karate_competition_categories/.test(s)) return [{ id: CAT, name: 'Novo nome' }];
        return [];
      });
    }
    const patch = (body) => auth(request(buildApp())
      .patch(`/federation/${FED}/competitions/${COMP}/categories/${CAT}`).send(body));

    it('trocar modality com chave → 409 BRACKET_EXISTS (sem UPDATE)', async () => {
      const calls = setup({ hasBracket: true });
      const res = await patch({ modality: 'kata' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BRACKET_EXISTS');
      expect(calls.some((c) => /UPDATE karate_competition_categories/.test(c.sql))).toBe(false);
    });

    it('trocar sex com chave → 409', async () => {
      setup({ hasBracket: true });
      const res = await patch({ sex: 'F' });
      expect(res.status).toBe(409);
    });

    it('reenviar a MESMA modality/sex + outros campos com chave → 200', async () => {
      setup({ hasBracket: true });
      const res = await patch({ name: 'Novo nome', modality: 'kumite', sex: 'M' });
      expect(res.status).toBe(200);
    });

    it('sem chave, trocar modality é permitido', async () => {
      setup({ hasBracket: false });
      const res = await patch({ modality: 'kata' });
      expect(res.status).toBe(200);
    });
  });

  describe('(5) DELETE de categoria', () => {
    function setup({ entries = 0, teams = 0, bracket = 0 }) {
      return mockQuery((s) => {
        if (/SELECT \* FROM karate_competitions/.test(s)) return [COMP_ROW];
        if (/SELECT id FROM karate_competition_categories/.test(s)) return [{ id: CAT }];
        if (/FROM karate_competition_entries WHERE category_id/.test(s)) return [{ n: entries }];
        if (/FROM karate_competition_teams WHERE category_id/.test(s)) return [{ n: teams }];
        if (/FROM karate_brackets WHERE category_id/.test(s)) return [{ n: bracket }];
        if (/DELETE FROM karate_competition_categories/.test(s)) return [{ id: CAT }];
        return [];
      });
    }
    const del = () => auth(request(buildApp())
      .delete(`/federation/${FED}/competitions/${COMP}/categories/${CAT}`));

    it('categoria vazia → 200 deleted', async () => {
      const calls = setup({});
      const res = await del();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true, id: CAT });
      expect(calls.some((c) => /DELETE FROM karate_competition_categories/.test(c.sql))).toBe(true);
    });

    it('com inscrições e chave → 409 CATEGORY_IN_USE dizendo o motivo, sem DELETE', async () => {
      const calls = setup({ entries: 3, bracket: 1 });
      const res = await del();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CATEGORY_IN_USE');
      expect(res.body.error).toMatch(/3 inscrição/);
      expect(res.body.error).toMatch(/chave gerada/);
      expect(calls.some((c) => /DELETE FROM/.test(c.sql))).toBe(false);
    });

    it('categoria de outra competição → 404', async () => {
      mockQuery((s) => (/SELECT \* FROM karate_competitions/.test(s) ? [COMP_ROW] : []));
      const res = await del();
      expect(res.status).toBe(404);
    });
  });

  describe('(6) PATCH results_config', () => {
    const patch = (body) => auth(request(buildApp())
      .patch(`/federation/${FED}/competitions/${COMP}`).send(body));

    it('grava points_by_placement normalizado e devolve results_config', async () => {
      const calls = mockQuery((s) => {
        if (/UPDATE karate_competitions SET/.test(s)) {
          return [{ id: COMP, results_config: { points_by_placement: { 1: 9, 2: 6, 3: 3, 4: 1 } } }];
        }
        return [];
      });
      const res = await patch({ results_config: { points_by_placement: { 1: 9, 2: '6', 3: 3, 4: 1 } } });
      expect(res.status).toBe(200);
      const upd = calls.find((c) => /UPDATE karate_competitions SET/.test(c.sql));
      expect(upd.sql).toMatch(/results_config = \$1::jsonb/);
      expect(upd.sql).toMatch(/RETURNING[\s\S]*results_config/);
      expect(JSON.parse(upd.params[0])).toEqual({ points_by_placement: { 1: 9, 2: 6, 3: 3, 4: 1 } });
      expect(res.body.results_config).toBeDefined();
    });

    it.each([
      [{ points_by_placement: { 9: 1 } }],
      [{ points_by_placement: { 1: -1 } }],
      [{ points_by_placement: { 1: 2.5 } }],
      [{ points_by_placement: { 1: 'abc' } }],
      [{ points_by_placement: [9, 6] }],
      [{}],
      ['texto'],
    ])('inválido %j → 422', async (rc) => {
      mockQuery(() => []);
      const res = await patch({ results_config: rc });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('PATCH sem results_config não toca na coluna (pré-301 segue funcionando)', async () => {
      const calls = mockQuery((s) => (/UPDATE karate_competitions SET/.test(s) ? [{ id: COMP }] : []));
      const res = await patch({ name: 'Copa 2' });
      expect(res.status).toBe(200);
      const upd = calls.find((c) => /UPDATE karate_competitions SET/.test(c.sql));
      expect(upd.sql).not.toMatch(/results_config/);
    });
  });

  describe('(7) DELETE de koto com categorias', () => {
    function setup(count) {
      return mockQuery((s) => {
        if (/FROM karate_competitions WHERE id/.test(s)) return [COMP_ROW];
        if (/FROM karate_competition_categories\s+WHERE area_id/.test(s)) return [{ n: count }];
        if (/DELETE FROM karate_competition_areas/.test(s)) return [{ id: 'area-1' }];
        return [];
      });
    }
    const del = (q = '') => auth(request(buildApp())
      .delete(`/federation/${FED}/competitions/${COMP}/areas/area-1${q}`));

    it('com categorias → 409 AREA_HAS_CATEGORIES + count, sem DELETE', async () => {
      const calls = setup(2);
      const res = await del();
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'AREA_HAS_CATEGORIES', count: 2 });
      expect(calls.some((c) => /DELETE FROM karate_competition_areas/.test(c.sql))).toBe(false);
    });

    it('?force=1 apaga mesmo com categorias', async () => {
      setup(2);
      const res = await del('?force=1');
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('koto vazio apaga sem force', async () => {
      setup(0);
      const res = await del();
      expect(res.status).toBe(200);
    });
  });
});

// ── (8) slug público pela companies.slug ─────────────────────
describe('(8) resolveFederationId', () => {
  const { resolveFederationId } = require('../src/services/karateFederationSlug');

  it('sem canal digital, resolve companies.slug da federação', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'fed-jka' }] });
    await expect(resolveFederationId('jka-teste')).resolves.toBe('fed-jka');
    expect(String(db.query.mock.calls[1][0])).toMatch(/FROM companies WHERE slug = \$1 AND vertical = 'karate_federation'/);
  });

  it('canal digital continua tendo prioridade (uma consulta só)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ company_id: 'fed-canal' }] });
    await expect(resolveFederationId('canal')).resolves.toBe('fed-canal');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('UUID direto não consulta companies.slug', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveFederationId(uuid)).resolves.toBe(uuid);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('slug inexistente → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(resolveFederationId('nao-existe')).resolves.toBeNull();
  });

  it('rota pública do ranking usa o fallback (200 para o slug da federação)', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/digital_channel_config/.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM companies WHERE slug/.test(s)) return Promise.resolve({ rows: [{ id: 'fed-jka' }] });
      if (/FROM companies WHERE id/.test(s)) return Promise.resolve({ rows: [{ id: 'fed-jka', name: 'JKA Teste', logo: null }] });
      return Promise.resolve({ rows: [] });
    });
    const app = express();
    app.use('/public/karate', require('../src/routes/karatePublicRanking'));
    const res = await request(app).get('/public/karate/jka-teste/ranking');
    expect(res.status).not.toBe(404);
  });
});
