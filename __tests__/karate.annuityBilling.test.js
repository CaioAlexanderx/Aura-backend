// ============================================================
// AURA KARATÊ — Fase F4: testes de
//   POST /financial/annuities/send-email-batch
//   POST /financial/annuities/void-batch
//
// Cobertura pedida no plano F4:
//   - alvo sem e-mail cadastrado vira `skipped` (motivo claro), NÃO `error`
//     (ausência de e-mail é o estado normal da maioria hoje — nunca erro).
//   - void-batch pula (skipped) anuidade com parcela paga, e anuidade com
//     NFS-e emitida/em processamento — nos dois casos SEM remover nada.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const db      = require('../src/config/database');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const FED_ID = 'fed-uuid-annuity-billing';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/financial', require('../src/routes/karateAnnuityBilling'));
  return app;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
  delete process.env.RESEND_API_KEY; // dev mode: sendRaw simula sem hit de rede
});

// ============================================================
// POST /financial/annuities/send-email-batch
// ============================================================
describe('POST /financial/annuities/send-email-batch', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('alvo sem e-mail cadastrado vira skipped (não error); alvo com e-mail é enviado', (done) => {
    const installments = {
      'inst-sem-email': {
        id: 'inst-sem-email', annuity_id: 'ann-1', seq: 1, amount: '500.00',
        due_date: '2026-05-31', status: 'pending', transaction_id: null,
        federation_id: FED_ID, dojo_id: 'dojo-1', practitioner_id: null,
        reference_period: '2026', plan: 'anual',
        ref_name: 'Dojô Sem Email', ref_email: null, ref_phone: '11999990000',
      },
      'inst-com-email': {
        id: 'inst-com-email', annuity_id: 'ann-2', seq: 1, amount: '500.00',
        due_date: '2026-05-31', status: 'pending', transaction_id: null,
        federation_id: FED_ID, dojo_id: 'dojo-2', practitioner_id: null,
        reference_period: '2026', plan: 'anual',
        ref_name: 'Dojô Com Email', ref_email: 'dojo2@example.com', ref_phone: null,
      },
    };

    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (/FROM karate_annuity_installments i/.test(s) && /JOIN karate_dojo_annuity_history h/.test(s)) {
        const [instId] = params;
        const row = installments[instId];
        return { rows: row ? [row] : [] };
      }
      if (/FROM companies WHERE id = \$1/.test(s)) {
        return { rows: [{ name: 'Federação Teste', slug: 'fedteste', karate_logo_url: null, wa_phone_display: null, email: null }] };
      }
      if (/FROM karate_reminder_config WHERE federation_id = \$1/.test(s)) {
        return { rows: [{ subject_template: null, body_template: null }] };
      }
      if (/FROM karate_annual_fees/.test(s)) {
        return { rows: [] }; // sem fee configurada — planos fica vazio, não quebra
      }
      if (/FROM digital_channel_config/.test(s)) {
        return { rows: [] }; // sem chave PIX — provider cai no mock, não lança
      }
      if (/INSERT INTO karate_reminder_log/.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/send-email-batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ installment_ids: ['inst-sem-email', 'inst-com-email'] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.errors).toEqual([]);
        expect(res.body.skipped).toHaveLength(1);
        expect(res.body.skipped[0]).toMatchObject({ installment_id: 'inst-sem-email', reason: 'sem_email' });
        expect(res.body.sent).toHaveLength(1);
        expect(res.body.sent[0]).toMatchObject({ installment_id: 'inst-com-email', recipient: 'dojo2@example.com' });
        done();
      });
  });

  it('parcela já paga vira skipped (parcela_ja_paga), não envia cobrança de novo', (done) => {
    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (/FROM karate_annuity_installments i/.test(s) && /JOIN karate_dojo_annuity_history h/.test(s)) {
        return { rows: [{
          id: 'inst-pago', annuity_id: 'ann-3', seq: 1, amount: '500.00',
          due_date: '2026-05-31', status: 'paid', transaction_id: 'tx-1',
          federation_id: FED_ID, dojo_id: 'dojo-3', practitioner_id: null,
          reference_period: '2026', plan: 'anual',
          ref_name: 'Dojô Pago', ref_email: 'dojo3@example.com', ref_phone: null,
        }] };
      }
      return { rows: [] };
    });

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/send-email-batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ installment_ids: ['inst-pago'] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.sent).toEqual([]);
        expect(res.body.skipped[0]).toMatchObject({ installment_id: 'inst-pago', reason: 'parcela_ja_paga' });
        done();
      });
  });

  it('installment_ids ausente/vazio → 422', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/send-email-batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ============================================================
// POST /financial/annuities/void-batch
// ============================================================
describe('POST /financial/annuities/void-batch', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  function makeVoidClient() {
    const headers = {
      'a-paga':  { id: 'a-paga',  dojo_id: 'd1', practitioner_id: null, federation_id: FED_ID, reference_period: '2026', plan: 'anual', status: 'pending', transaction_id: null },
      'a-nfse':  { id: 'a-nfse',  dojo_id: 'd2', practitioner_id: null, federation_id: FED_ID, reference_period: '2026', plan: 'anual', status: 'pending', transaction_id: null },
      'a-limpa': { id: 'a-limpa', dojo_id: 'd3', practitioner_id: null, federation_id: FED_ID, reference_period: '2026', plan: 'anual', status: 'pending', transaction_id: null },
    };
    const installmentsByAnnuity = {
      'a-paga':  [{ id: 'i1', status: 'paid',    transaction_id: 'tx-paga' }],
      'a-nfse':  [{ id: 'i2', status: 'pending', transaction_id: 'tx-nfse' }],
      'a-limpa': [{ id: 'i3', status: 'pending', transaction_id: null }],
    };
    const deleted = [];

    async function query(sql, params = []) {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s.trim()) || /SAVEPOINT/i.test(s)) return {};
      if (/FROM karate_dojo_annuity_history WHERE id = \$1 AND federation_id = \$2/.test(s)) {
        const [id] = params;
        const h = headers[id];
        return { rows: h ? [h] : [] };
      }
      if (/FROM karate_annuity_installments WHERE annuity_id = \$1/.test(s)) {
        const [id] = params;
        return { rows: installmentsByAnnuity[id] || [] };
      }
      if (/FROM nfe_documents/.test(s)) {
        const [txIds] = params;
        const hasNfse = (txIds || []).includes('tx-nfse');
        return { rows: hasNfse ? [{ id: 'nfse-1' }] : [] };
      }
      if (/UPDATE transactions SET status = 'cancelled'/.test(s)) return { rows: [] };
      if (/UPDATE karate_payment_intents/.test(s)) return { rows: [] };
      if (/DELETE FROM karate_dojo_annuity_history WHERE id = \$1/.test(s)) {
        deleted.push(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    }
    return { client: { query, release: () => {} }, deleted };
  }

  it('pula anuidade com parcela paga E anuidade com NFS-e emitida; remove só a anuidade limpa', (done) => {
    const { client, deleted } = makeVoidClient();
    db.connect.mockResolvedValue(client);

    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/void-batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ annuity_ids: ['a-paga', 'a-nfse', 'a-limpa'] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.errors).toEqual([]);
        expect(res.body.removed).toHaveLength(1);
        expect(res.body.removed[0].annuity_id).toBe('a-limpa');
        expect(res.body.skipped).toHaveLength(2);
        const byId = Object.fromEntries(res.body.skipped.map((s) => [s.annuity_id, s.reason]));
        expect(byId['a-paga']).toBe('has_paid_installment');
        expect(byId['a-nfse']).toBe('has_nfse');
        // Só a anuidade limpa foi de fato apagada — void-batch nunca é
        // all-or-nothing e o guard bloqueou as outras duas ANTES do DELETE.
        expect(deleted).toEqual(['a-limpa']);
        done();
      });
  });

  it('annuity_ids ausente/vazio → 422', (done) => {
    request(app)
      .post(`/federation/${FED_ID}/financial/annuities/void-batch`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});
