// ============================================================
// AURA KARATÊ — Fase F4: GET/PUT /federation/:id/financial-adjacent
// /reminder-config passam a incluir subject_template/body_template.
//   - PUT com variável desconhecida no template → 422 (PT, antes de tocar o banco)
//   - PUT válido persiste e devolve os templates
//   - GET devolve os templates gravados
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

const FED_ID = 'fed-uuid-reminder-config';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateReminders'));
  return app;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
});

describe('PUT /federation/:id/reminder-config — validação de template', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('variável desconhecida em body_template → 422, sem chamar o banco', (done) => {
    request(app)
      .put(`/federation/${FED_ID}/reminder-config`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ enabled: false, body_template: 'Olá {{nome}}, seu {{codigo_secreto}} venceu' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(res.body.error).toContain('codigo_secreto');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('variável desconhecida em subject_template → 422 com mensagem clara em português', (done) => {
    request(app)
      .put(`/federation/${FED_ID}/reminder-config`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ subject_template: 'Cobrança {{ano_fiscal}}' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/variável desconhecida/i);
        expect(res.body.error).toContain('ano_fiscal');
        done();
      });
  });

  it('templates só com variáveis conhecidas → 200, persiste e devolve', (done) => {
    db.query.mockResolvedValueOnce({
      rows: [{
        enabled: true, channel: 'email', offsets_days: [-7, -1, 3],
        subject_template: 'Lembrete {{competencia}}',
        body_template: 'Olá {{nome}}, pague {{valor}} até {{vencimento}}. PIX: {{pix_copia_cola}}. Planos: {{planos}}',
        updated_at: '2026-07-11T00:00:00.000Z',
      }],
    });

    request(app)
      .put(`/federation/${FED_ID}/reminder-config`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        enabled: true,
        offsets_days: [-7, -1, 3],
        subject_template: 'Lembrete {{competencia}}',
        body_template: 'Olá {{nome}}, pague {{valor}} até {{vencimento}}. PIX: {{pix_copia_cola}}. Planos: {{planos}}',
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.config.subject_template).toBe('Lembrete {{competencia}}');
        expect(res.body.config.body_template).toContain('{{pix_copia_cola}}');
        done();
      });
  });

  it('subject_template/body_template vazios voltam pro default (NULL persistido)', (done) => {
    db.query.mockResolvedValueOnce({
      rows: [{ enabled: false, channel: 'email', offsets_days: [-7, -1, 3, 15, 30], subject_template: null, body_template: null, updated_at: '2026-07-11T00:00:00.000Z' }],
    });
    request(app)
      .put(`/federation/${FED_ID}/reminder-config`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ enabled: false, subject_template: '', body_template: '' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.config.subject_template).toBeNull();
        expect(res.body.config.body_template).toBeNull();
        const [, params] = db.query.mock.calls[0];
        expect(params[4]).toBeNull(); // subject_template
        expect(params[5]).toBeNull(); // body_template
        done();
      });
  });
});

describe('GET /federation/:id/reminder-config — inclui templates', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('devolve subject_template/body_template gravados', (done) => {
    db.query.mockResolvedValueOnce({
      rows: [{
        enabled: true, channel: 'email', offsets_days: [-7, -1],
        subject_template: 'Assunto customizado', body_template: 'Corpo customizado {{nome}}',
        updated_at: '2026-07-11T00:00:00.000Z',
      }],
    });
    request(app)
      .get(`/federation/${FED_ID}/reminder-config`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.config.subject_template).toBe('Assunto customizado');
        expect(res.body.config.body_template).toBe('Corpo customizado {{nome}}');
        done();
      });
  });

  it('federação sem config gravada → default com templates null (não quebra)', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    request(app)
      .get(`/federation/${FED_ID}/reminder-config`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.config.subject_template).toBeNull();
        expect(res.body.config.body_template).toBeNull();
        expect(res.body.config.enabled).toBe(false);
        done();
      });
  });
});
