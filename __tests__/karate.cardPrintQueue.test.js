// ============================================================
// AURA KARATÊ — Testes da fila de impressão de carteirinhas (migration 233)
// Cobertura mínima pedida:
//   1. Transição de estado (to_print -> printed -> delivered)
//   2. "Não saiu" / reimprimir devolve para a fila SEM contar via nova
//   3. Lote nunca perde ninguém (item inválido vira error, não trava o resto)
//   4. listPrintQueue monta contadores + agrupamento por dojô
//
// jest.setup.js já mocka src/config/database (db.query/db.connect = jest.fn()).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const cardService = require('../src/services/karateCardService');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateCards'));
  return app;
}

const FED = 'fed-uuid-001';

function makeClient() {
  return { query: jest.fn(), release: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

// ── Service: markPrinted ─────────────────────────────────────
describe('karateCardService — markPrinted', () => {
  it('move to_print -> printed e incrementa print_count', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})                                            // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'to_print' }] }) // SELECT...FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })                   // UPDATE
      .mockResolvedValueOnce({});                                           // COMMIT

    const out = await cardService.markPrinted({ federation_id: FED, card_ids: ['card-1'] });
    expect(out.ok).toEqual(['card-1']);
    expect(out.errors).toEqual([]);

    const updateCall = client.query.mock.calls.find((c) => /UPDATE karate_membership_cards/.test(c[0]));
    expect(updateCall[0]).toMatch(/print_status = 'printed'/);
    expect(updateCall[0]).toMatch(/print_count = print_count \+ 1/);
  });

  it('lote nunca perde ninguém: 1 id inexistente vira error, o outro segue ok', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      // card-1: sucesso
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'to_print' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({})
      // card-2: não encontrado (outra federação / revogado)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    const out = await cardService.markPrinted({ federation_id: FED, card_ids: ['card-1', 'card-2'] });
    expect(out.total).toBe(2);
    expect(out.ok).toEqual(['card-1']);
    expect(out.errors).toEqual([{ id: 'card-2', error: expect.stringContaining('não encontrado') }]);
  });

  it('sem ids -> lança NO_IDS', async () => {
    await expect(cardService.markPrinted({ federation_id: FED, card_ids: [] })).rejects.toMatchObject({ code: 'NO_IDS' });
  });
});

// ── Service: markDelivered ────────────────────────────────────
describe('karateCardService — markDelivered', () => {
  it('move printed -> delivered com delivered_by', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'printed' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({});

    const out = await cardService.markDelivered({ federation_id: FED, card_ids: ['card-1'], delivered_by: 'user-1' });
    expect(out.ok).toEqual(['card-1']);

    const updateCall = client.query.mock.calls.find((c) => /UPDATE karate_membership_cards/.test(c[0]));
    expect(updateCall[0]).toMatch(/print_status = 'delivered'/);
    expect(updateCall[1]).toEqual(['card-1', 'user-1']);
  });
});

// ── Service: returnToQueue ("não saiu" / reimprimir) ──────────
describe('karateCardService — returnToQueue', () => {
  it('devolve para to_print SEM tocar em print_count (nem printed_at/delivered_at)', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'printed' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({});

    const out = await cardService.returnToQueue({ federation_id: FED, card_ids: ['card-1'] });
    expect(out.ok).toEqual(['card-1']);

    const updateCall = client.query.mock.calls.find((c) => /UPDATE karate_membership_cards/.test(c[0]));
    expect(updateCall[0]).toMatch(/print_status = 'to_print'/);
    expect(updateCall[0]).not.toMatch(/print_count/);
    expect(updateCall[0]).not.toMatch(/printed_at/);
    expect(updateCall[0]).not.toMatch(/delivered_at/);
  });

  it('funciona tanto a partir de printed quanto de delivered (reimpressão pós-entrega)', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-9', print_status: 'delivered' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-9' }] })
      .mockResolvedValueOnce({});

    const out = await cardService.returnToQueue({ federation_id: FED, card_ids: ['card-9'] });
    expect(out.ok).toEqual(['card-9']);
  });
});

// ── Service: listPrintQueue ────────────────────────────────────
describe('karateCardService — listPrintQueue', () => {
  it('monta data + counters (3 etapas) + dojos da etapa atual', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', student_id: 's1', student_name: 'Ana', card_number: 'FPKT-1', belt_name: 'Roxa', dojo_id: 'd1', dojo_name: 'Dojô Central', is_minor: false, print_status: 'to_print', issued_at: new Date(), printed_at: null, delivered_at: null, print_count: 0 }] }) // rows
      .mockResolvedValueOnce({ rows: [{ total: '1' }] }) // count
      .mockResolvedValueOnce({ rows: [{ print_status: 'to_print', n: '18' }, { print_status: 'printed', n: '40' }, { print_status: 'delivered', n: '380' }] }) // counters
      .mockResolvedValueOnce({ rows: [{ dojo_id: 'd1', dojo_name: 'Dojô Central', n: '1' }] }); // dojos

    const out = await cardService.listPrintQueue({ federation_id: FED, print_status: 'to_print' });
    expect(out.counters).toEqual({ to_print: 18, printed: 40, delivered: 380 });
    expect(out.dojos).toEqual([{ dojo_id: 'd1', dojo_name: 'Dojô Central', count: 1 }]);
    expect(out.data).toHaveLength(1);
    expect(out.data[0].student_name).toBe('Ana');
    expect(out.total).toBe(1);
  });

  it('print_status inválido cai para to_print (defensivo)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const out = await cardService.listPrintQueue({ federation_id: FED, print_status: 'bogus' });
    expect(out.print_status).toBe('to_print');
  });
});

// ── Rotas HTTP ──────────────────────────────────────────────────
describe('GET /federation/:id/cards/queue', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('200 com contadores e dados da etapa pedida', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [{ print_status: 'to_print', n: '2' }] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/federation/${FED}/cards/queue?print_status=to_print`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.counters.to_print).toBe(2);
        done();
      });
  });
});

describe('POST /federation/:id/cards/queue/mark-printed', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('200 e devolve ok/errors', (done) => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'to_print' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({});

    request(app)
      .post(`/federation/${FED}/cards/queue/mark-printed`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ card_ids: ['card-1'] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.ok).toEqual(['card-1']);
        done();
      });
  });

  it('400 sem card_ids', (done) => {
    request(app)
      .post(`/federation/${FED}/cards/queue/mark-printed`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NO_IDS');
        done();
      });
  });
});

describe('POST /federation/:id/cards/queue/return-to-queue', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('200 e volta pra to_print', (done) => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'printed' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({});

    request(app)
      .post(`/federation/${FED}/cards/queue/return-to-queue`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ card_ids: ['card-1'] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.ok).toEqual(['card-1']);
        done();
      });
  });
});
