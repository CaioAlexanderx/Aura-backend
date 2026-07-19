// ============================================================
// AURA KARATÊ — Testes: emissão de carteirinha no upload de foto
//
// Decisão Caio (17/07/2026): a carteirinha deixou de nascer no cadastro do
// praticante (POST /practitioners). Agora só nasce (a) no upload da
// PRIMEIRA foto (POST /:practitionerId/photo) ou (b) no botão manual/lote.
//
// Regra coberta aqui (ver comentário em src/routes/karatePractitioners.js,
// rota /:practitionerId/photo):
//   (a) foto em praticante SEM carteirinha (nenhuma linha em
//       karate_membership_cards) + matrícula + faixa -> EMITE.
//   (b) foto em praticante que JÁ TEM carteirinha (qualquer status,
//       inclusive 'revoked') -> NÃO emite de novo.
//   (c) foto em praticante SEM matrícula FPKT -> NÃO emite.
//   Em todos os casos, falha na emissão é best-effort (nunca derruba o
//   upload da foto em si — coberto por mock de erro no issueCard).
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/utils/r2Storage', () => ({
  uploadToR2: jest.fn(),
}));
jest.mock('../src/services/karateCardService', () => ({
  issueCard: jest.fn(),
}));

const db = require('../src/config/database');
const { uploadToR2 } = require('../src/utils/r2Storage');
const cards = require('../src/services/karateCardService');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const makeToken = (overrides) => jwt.sign(
  Object.assign({ id: 'user-test-uuid', role: 'admin', plan: 'expansao' }, overrides || {}),
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);
const adminToken = makeToken();

function buildApp() {
  const app = express();
  app.use(express.json());
  const practRouter = require('../src/routes/karatePractitioners');
  app.use('/federation/:id/practitioners', practRouter);
  return app;
}

const FED_ID = 'fed-uuid-001';
const PRAC_ID = 'prac-uuid-001';

describe('POST /federation/:id/practitioners/:pid/photo — emissão automática de carteirinha', () => {
  let app;

  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    uploadToR2.mockResolvedValue({ success: true, url: 'https://r2.example.com/foto.jpg' });
  });

  function postPhoto() {
    return request(app)
      .post(`/federation/${FED_ID}/practitioners/${PRAC_ID}/photo`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ content: Buffer.from('fake-image-bytes').toString('base64'), content_type: 'image/jpeg' });
  }

  it('(a) praticante SEM carteirinha, com matrícula e faixa -> emite carteirinha', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: PRAC_ID }] })       // valida praticante pertence à federação
      .mockResolvedValueOnce({})                                 // UPDATE karate_photo_url
      .mockResolvedValueOnce({ rows: [] })                       // alreadyHasCard: nenhuma carteirinha
      .mockResolvedValueOnce({ rows: [{ karate_registration_number: 'FPKT-A-00001', has_belt: true }] }); // elegibilidade
    cards.issueCard.mockResolvedValue({ card: { id: 'card-1' }, warnings: [], renewed: false });

    postPhoto().end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);
      expect(res.body.photo_url).toBe('https://r2.example.com/foto.jpg');
      expect(cards.issueCard).toHaveBeenCalledTimes(1);
      expect(cards.issueCard).toHaveBeenCalledWith(
        expect.objectContaining({ federation_id: FED_ID, student_id: PRAC_ID })
      );
      done();
    });
  });

  it('(b) praticante que JÁ TEM carteirinha (qualquer status) -> NÃO emite de novo', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: PRAC_ID }] })       // valida praticante
      .mockResolvedValueOnce({})                                 // UPDATE karate_photo_url
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });     // alreadyHasCard: já existe (mesmo revogada)

    postPhoto().end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);
      expect(cards.issueCard).not.toHaveBeenCalled();
      done();
    });
  });

  it('(c) praticante SEM matrícula FPKT -> NÃO emite', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: PRAC_ID }] })       // valida praticante
      .mockResolvedValueOnce({})                                 // UPDATE karate_photo_url
      .mockResolvedValueOnce({ rows: [] })                       // alreadyHasCard: nenhuma carteirinha
      .mockResolvedValueOnce({ rows: [{ karate_registration_number: null, has_belt: true }] }); // sem matrícula

    postPhoto().end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);
      expect(cards.issueCard).not.toHaveBeenCalled();
      done();
    });
  });

  it('emissão falha (best-effort) -> upload da foto continua OK (200)', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: PRAC_ID }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ karate_registration_number: 'FPKT-A-00001', has_belt: true }] });
    cards.issueCard.mockRejectedValue(new Error('boom'));

    postPhoto().end((err, res) => {
      if (err) return done(err);
      expect(res.status).toBe(200);
      expect(res.body.photo_url).toBe('https://r2.example.com/foto.jpg');
      done();
    });
  });
});
