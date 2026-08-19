// ============================================================
// AURA Studio — S5: triagem da arte enviada pelo cliente
//
// O fluxo que existia ia de LOJISTA -> CLIENTE (/aprovacao/:token). O
// inverso nao existia, e e o que acontece na pratica: o cliente manda a
// arte e ela precisa ser ajustada para caber no produto e para as cores
// de impressao.
//
// DEC-11 — a triagem e PARTE DO PROCESSO, nao um portao. Nao ha estado
// novo de pedido, nao ha prazo suspenso, e a fila e uma visao sobre itens
// que ja existem. E o que os testes de rota garantem: nada aqui toca
// digital_orders.status.
//
// MOCK POR SQL, NUNCA POR POSICAO (CLAUDE.md).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { initialArtStatus, STATUS } = require('../src/services/artReview');

const CID = 'c1';

function makeApp() {
  const app = express();
  app.use(express.json());
  // O router real e montado depois de requireAuth; aqui so o stub do user.
  app.use((req, _res, next) => { req.user = { id: 'user-1' }; next(); });
  app.use('/companies/:id/studio', require('../src/routes/studioArtReview'));
  return app;
}

// ── Quem entra na fila ───────────────────────────────────────
describe('initialArtStatus — so entra quem mandou arte propria', () => {
  const cfgComArte = {
    fields: [
      { id: 'texto', type: 'text',  label: 'Texto', required: false, config: {} },
      { id: 'image', type: 'image', label: 'Arte',  required: false, config: {} },
      {
        id: 'art_service', type: 'option', label: 'Servico de arte', required: false,
        config: {
          is_art_service: true,
          choices: [
            { value: 'none', label: 'Pronta', price_delta: 0 },
            { value: 'adjust', label: 'Ajustem', price_delta: 10 },
            { value: 'designer', label: 'Criem', price_delta: 30 },
          ],
        },
      },
    ],
  };

  test('cliente enviou arquivo: entra como pendente', () => {
    expect(initialArtStatus(cfgComArte, { image: 'https://cdn/a.png' })).toBe(STATUS.PENDENTE);
  });

  test('template da galeria tambem e arte a conferir', () => {
    const cfg = { fields: [{ id: 'template', type: 'template', label: 'Galeria', config: {} }] };
    expect(initialArtStatus(cfg, { template: 'tpl-1' })).toBe(STATUS.PENDENTE);
  });

  test('pediu ajuste: continua na fila — e justamente o caso mais comum', () => {
    expect(initialArtStatus(cfgComArte, { image: 'https://cdn/a.png', art_service: 'adjust' }))
      .toBe(STATUS.PENDENTE);
  });

  // Quem contratou a criacao nao tem arte de cliente para revisar: ali
  // quem produz e a lojista, e o fluxo lojista -> cliente ja cobre.
  test('contratou a criacao: fica fora da fila', () => {
    expect(initialArtStatus(cfgComArte, { art_service: 'designer' })).toBeNull();
  });

  test('upload junto com designer e referencia de briefing, nao a arte', () => {
    expect(initialArtStatus(cfgComArte, { image: 'https://cdn/ref.png', art_service: 'designer' }))
      .toBeNull();
  });

  test('so texto, sem arquivo: nao ha o que revisar', () => {
    expect(initialArtStatus(cfgComArte, { texto: 'Feliz aniversario' })).toBeNull();
  });

  test('campo vazio nao conta como arte enviada', () => {
    expect(initialArtStatus(cfgComArte, { image: '   ' })).toBeNull();
  });

  test('produto sem personalizacao fica fora', () => {
    expect(initialArtStatus(null, { image: 'x' })).toBeNull();
    expect(initialArtStatus({ fields: [] }, { image: 'x' })).toBeNull();
    expect(initialArtStatus(cfgComArte, null)).toBeNull();
  });
});

// ── A fila e a decisao ───────────────────────────────────────
describe('GET /studio/art-review', () => {
  beforeEach(() => { db.query.mockReset(); });

  test('lista os pendentes por padrao, escopado na empresa', async () => {
    const seen = [];
    db.query.mockImplementation((sql, params) => {
      seen.push({ sql, params });
      return Promise.resolve({ rows: [{ id: 1, order_number: 7, art_review_status: 'pendente' }] });
    });

    const res = await request(makeApp()).get(`/companies/${CID}/studio/art-review`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pendente');
    expect(res.body.items).toHaveLength(1);
    expect(seen[0].params).toEqual([CID, 'pendente']);
    expect(seen[0].sql).toMatch(/o\.company_id = \$1/);
  });

  test('status invalido e 400 e nao toca o banco', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(makeApp())
      .get(`/companies/${CID}/studio/art-review`)
      .query({ status: 'aprovadissima' });

    expect(res.status).toBe(400);
    expect(res.body.valid_status).toContain('ajustando');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('migration 289 ausente vira 503 explicito, nao fila vazia', async () => {
    const e = new Error('column "art_review_status" does not exist');
    e.code = '42703';
    db.query.mockRejectedValue(e);

    const res = await request(makeApp()).get(`/companies/${CID}/studio/art-review`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_289_PENDENTE');
  });
});

describe('PATCH /studio/art-review/:itemId', () => {
  beforeEach(() => { db.query.mockReset(); });

  test('registra a decisao e a observacao', async () => {
    const seen = [];
    db.query.mockImplementation((sql, params) => {
      seen.push({ sql, params });
      return Promise.resolve({ rows: [{ id: 10, art_review_status: 'ajustando' }] });
    });

    const res = await request(makeApp())
      .patch(`/companies/${CID}/studio/art-review/10`)
      .send({ status: 'ajustando', note: 'aumentei o logo e tirei a borda branca' });

    expect(res.status).toBe(200);
    expect(res.body.item.art_review_status).toBe('ajustando');
    expect(seen[0].params).toEqual([
      'ajustando', 'aumentei o logo e tirei a borda branca', 'user-1', '10', CID,
    ]);
  });

  // DEC-11: a triagem nao e portao. Nada aqui pode mexer no pedido.
  test('nao toca em digital_orders.status', async () => {
    const seen = [];
    db.query.mockImplementation((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [{ id: 10 }] });
    });

    await request(makeApp())
      .patch(`/companies/${CID}/studio/art-review/10`)
      .send({ status: 'devolvida' });

    expect(seen.join(' ')).not.toMatch(/UPDATE digital_orders/);
    expect(seen[0]).toMatch(/UPDATE digital_order_items/);
  });

  test('item de outra empresa da 404, mesmo com id valido', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(makeApp())
      .patch(`/companies/${CID}/studio/art-review/999`)
      .send({ status: 'aceita' });

    expect(res.status).toBe(404);
  });

  test('status invalido e 400 antes de tocar o banco', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(makeApp())
      .patch(`/companies/${CID}/studio/art-review/10`)
      .send({ status: 'rejeitada' });

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  // Item que nunca teve arte de cliente nao pode ganhar triagem por PATCH.
  test('a query exige art_review_status IS NOT NULL', async () => {
    const seen = [];
    db.query.mockImplementation((sql) => { seen.push(sql); return Promise.resolve({ rows: [{ id: 1 }] }); });

    await request(makeApp())
      .patch(`/companies/${CID}/studio/art-review/10`)
      .send({ status: 'aceita' });

    expect(seen[0]).toMatch(/art_review_status IS NOT NULL/);
  });
});
