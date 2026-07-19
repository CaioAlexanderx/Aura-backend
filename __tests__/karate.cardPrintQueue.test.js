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
    expect(out.counters).toEqual({ to_print: 18, printed: 40, delivered: 380, out_of_queue: 0 });
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

// ============================================================
// Migration 241 — "Tirar da fila" (out_of_queue), NÃO revoga
// Cobertura pedida:
//   (a) individual: sai de to_print e some da aba to_print
//   (b) lote
//   (c) out_of_queue continua status='active' e o QR/validação pública
//       (verifyByToken) continua funcionando — ponto central da feature
//   (d) return-to-queue traz de volta (já funcionava sem mudança —
//       returnToQueue nunca validou print_status de origem)
//   (e) regra do item 4: só aceita a partir de 'to_print'
// ============================================================

// ── Service: removeFromQueue ("Tirar da fila") ────────────────
describe('karateCardService — removeFromQueue', () => {
  it('(a) individual: move to_print -> out_of_queue e grava out_of_queue_at', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})                                                     // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'to_print' }] })  // SELECT...FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })                            // UPDATE
      .mockResolvedValueOnce({});                                                     // COMMIT

    const out = await cardService.removeFromQueue({ federation_id: FED, card_ids: ['card-1'] });
    expect(out.ok).toEqual(['card-1']);
    expect(out.errors).toEqual([]);

    const updateCall = client.query.mock.calls.find((c) => /UPDATE karate_membership_cards/.test(c[0]));
    expect(updateCall[0]).toMatch(/print_status = 'out_of_queue'/);
    expect(updateCall[0]).toMatch(/out_of_queue_at = NOW\(\)/);
  });

  it('(b) lote: dois cartões em to_print saem juntos, nenhum se perde', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      // card-1
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'to_print' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({})
      // card-2
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-2', print_status: 'to_print' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-2' }] })
      .mockResolvedValueOnce({});

    const out = await cardService.removeFromQueue({ federation_id: FED, card_ids: ['card-1', 'card-2'] });
    expect(out.total).toBe(2);
    expect(out.ok).toEqual(['card-1', 'card-2']);
    expect(out.errors).toEqual([]);
  });

  it('(e) regra do item 4: recusa tirar da fila cartão já "printed" (item vira error, não trava o lote)', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})                                                     // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'printed' }] })   // SELECT...FOR UPDATE
      .mockResolvedValueOnce({});                                                     // ROLLBACK (apply lançou)

    const out = await cardService.removeFromQueue({ federation_id: FED, card_ids: ['card-1'] });
    expect(out.ok).toEqual([]);
    expect(out.errors).toEqual([{ id: 'card-1', error: expect.stringContaining("Só é possível tirar da fila") }]);
    // não deve ter tentado nenhum UPDATE
    expect(client.query.mock.calls.some((c) => /UPDATE karate_membership_cards/.test(c[0]))).toBe(false);
  });

  it('(e) regra do item 4: recusa tirar da fila cartão já "delivered"', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'delivered' }] })
      .mockResolvedValueOnce({});

    const out = await cardService.removeFromQueue({ federation_id: FED, card_ids: ['card-1'] });
    expect(out.ok).toEqual([]);
    expect(out.errors[0].error).toMatch(/'delivered'/);
  });

  it('lote misto: um em to_print (sai) + um em printed (recusado) — nenhum trava o outro', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      // card-1: to_print -> sucesso
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'to_print' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({})
      // card-2: printed -> recusado
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-2', print_status: 'printed' }] })
      .mockResolvedValueOnce({});

    const out = await cardService.removeFromQueue({ federation_id: FED, card_ids: ['card-1', 'card-2'] });
    expect(out.ok).toEqual(['card-1']);
    expect(out.errors).toEqual([{ id: 'card-2', error: expect.stringContaining("Só é possível tirar da fila") }]);
  });

  it('sem ids -> lança NO_IDS', async () => {
    await expect(cardService.removeFromQueue({ federation_id: FED, card_ids: [] })).rejects.toMatchObject({ code: 'NO_IDS' });
  });
});

// ── Service: returnToQueue também traz de volta a partir de out_of_queue ──
describe('karateCardService — returnToQueue (a partir de out_of_queue)', () => {
  it('(d) devolve out_of_queue -> to_print sem nenhuma mudança de código (returnToQueue não valida origem)', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'out_of_queue' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({});

    const out = await cardService.returnToQueue({ federation_id: FED, card_ids: ['card-1'] });
    expect(out.ok).toEqual(['card-1']);

    const updateCall = client.query.mock.calls.find((c) => /UPDATE karate_membership_cards/.test(c[0]));
    expect(updateCall[0]).toMatch(/print_status = 'to_print'/);
  });
});

// ── (c) Ponto central da feature: out_of_queue continua ativo e o QR/
// verificação pública continua funcionando normalmente ───────────────
describe('karateCardService — verifyByToken continua válido para cartão out_of_queue', () => {
  const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 32 hex

  it('(c) status="active" + print_status="out_of_queue" -> QR ainda valida (situacao "valida")', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{
        card_number: 'FPKT-A-00009', card_status: 'active', // status da carteirinha (NÃO é print_status) continua active
        student_id: 'stu-9', federation_id: FED,
        birth_date: '1990-01-01', student_name: 'Carlos Lima',
        belt: '2dan', belt_name: 'Preta', belt_since: '2024-01-01',
        dojo_name: 'Dojô Y', federation_name: 'FPKT', federation_logo: null,
      }] })       // cartão
      .mockResolvedValueOnce({ rows: [] });          // anuidade em dia -> valida

    const r = await cardService.verifyByToken(TOKEN);
    expect(r).not.toBeNull();
    expect(r.valid).toBe(true);
    expect(r.status).toBe('valida');
    expect(r.card_number).toBe('FPKT-A-00009');

    // A query do verify não filtra nem seleciona print_status — tirar da
    // fila (out_of_queue) é invisível pra verificação pública, por design.
    const verifyQuery = db.query.mock.calls[0][0];
    expect(verifyQuery).not.toMatch(/print_status/);
  });
});

// ── Rotas HTTP: POST /cards/queue/remove-from-queue ────────────────
describe('POST /federation/:id/cards/queue/remove-from-queue', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('200 individual: to_print -> out_of_queue', (done) => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'to_print' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({});

    request(app)
      .post(`/federation/${FED}/cards/queue/remove-from-queue`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ card_ids: ['card-1'] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.ok).toEqual(['card-1']);
        done();
      });
  });

  it('200 em lote com um item recusado (printed) — devolve o erro por-item, não 500', (done) => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      // card-1 ok
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-1', print_status: 'to_print' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'card-1' }] })
      .mockResolvedValueOnce({})
      // card-2 recusado
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'card-2', print_status: 'printed' }] })
      .mockResolvedValueOnce({});

    request(app)
      .post(`/federation/${FED}/cards/queue/remove-from-queue`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ card_ids: ['card-1', 'card-2'] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.ok).toEqual(['card-1']);
        expect(res.body.errors).toEqual([{ id: 'card-2', error: expect.stringContaining("Só é possível tirar da fila") }]);
        done();
      });
  });

  it('400 sem card_ids', (done) => {
    request(app)
      .post(`/federation/${FED}/cards/queue/remove-from-queue`)
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

// ── listPrintQueue conhece a 4ª aba ──────────────────────────────
describe('karateCardService — listPrintQueue com out_of_queue', () => {
  it('counters incluem out_of_queue e a aba lista out_of_queue_at', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{
        id: 'card-1', student_id: 's1', student_name: 'Ana', card_number: 'FPKT-1',
        belt_name: 'Roxa', dojo_id: 'd1', dojo_name: 'Dojô Central', is_minor: false,
        print_status: 'out_of_queue', issued_at: new Date(), printed_at: null, delivered_at: null,
        out_of_queue_at: new Date(), print_count: 0,
      }] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [
        { print_status: 'to_print', n: '5' }, { print_status: 'printed', n: '40' },
        { print_status: 'delivered', n: '380' }, { print_status: 'out_of_queue', n: '3' },
      ] })
      .mockResolvedValueOnce({ rows: [{ dojo_id: 'd1', dojo_name: 'Dojô Central', n: '1' }] });

    const out = await cardService.listPrintQueue({ federation_id: FED, print_status: 'out_of_queue' });
    expect(out.print_status).toBe('out_of_queue');
    expect(out.counters).toEqual({ to_print: 5, printed: 40, delivered: 380, out_of_queue: 3 });
    expect(out.data[0].out_of_queue_at).toBeInstanceOf(Date);

    // Ordena por out_of_queue_at (mesma regra "gerado por último, visualizado
    // primeiro" das outras 3 abas) — confere que o SELECT referencia a coluna.
    const rowsQuery = db.query.mock.calls[0][0];
    expect(rowsQuery).toMatch(/kc\.out_of_queue_at/);
    expect(rowsQuery).toMatch(/ORDER BY kc\.out_of_queue_at DESC/);
  });
});

// ── Defensivo (armadilha #1 do CLAUDE.md): migration 241 ainda não
// aplicada em produção -> out_of_queue_at não existe -> 42703. A fila
// INTEIRA (todas as 4 abas) não pode quebrar por causa disso.
// ============================================================
describe('karateCardService — listPrintQueue defensivo a out_of_queue_at ausente (migration 241 pendente)', () => {
  it('cai pra fallback sem a coluna quando o SELECT lança 42703, e cacheia a ausência', async () => {
    jest.resetModules();
    const freshDb = require('../src/config/database');
    const freshCardService = require('../src/services/karateCardService');

    const missingColumnError = new Error('column kc.out_of_queue_at does not exist');
    missingColumnError.code = '42703';

    // 1ª chamada: tenta com a coluna (falha 42703), refaz sem ela
    freshDb.query
      .mockRejectedValueOnce(missingColumnError)          // rows (com out_of_queue_at) -> 42703
      .mockResolvedValueOnce({ rows: [] })                 // rows (fallback, sem a coluna)
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })   // count
      .mockResolvedValueOnce({ rows: [] })                 // counters
      .mockResolvedValueOnce({ rows: [] });                // dojos

    const out1 = await freshCardService.listPrintQueue({ federation_id: FED, print_status: 'to_print' });
    expect(out1.total).toBe(0);

    // A query de fallback não referencia a coluna ausente
    const fallbackRowsQuery = freshDb.query.mock.calls[1][0];
    expect(fallbackRowsQuery).not.toMatch(/kc\.out_of_queue_at/);
    expect(fallbackRowsQuery).toMatch(/NULL::timestamptz AS out_of_queue_at/);

    // 2ª chamada: cache já sabe que a coluna está ausente -> não tenta de
    // novo (economiza uma query fadada a falhar em todo request)
    freshDb.query.mockClear();
    freshDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await freshCardService.listPrintQueue({ federation_id: FED, print_status: 'printed' });
    expect(freshDb.query).toHaveBeenCalledTimes(4); // sem a tentativa extra que falharia
  });
});
