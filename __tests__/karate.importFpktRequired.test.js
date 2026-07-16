// ============================================================
// AURA KARATÊ — H2: import legado (CSV) exige número FPKT na planilha
//
// Regra fechada com o Caio: o número de matrícula FPKT é emitido SOMENTE
// pela federação, fora do sistema — o backend NUNCA gera/inventa (H1,
// migration 231). O import legado (POST /federation/:id/practitioners/import)
// usava nextPractitionerRegistrationNumber como fallback incondicional
// (a planilha nem tinha coluna mapeável para o número). Esta cobertura
// prova que:
//   (a) linha SEM matrícula na planilha vai para o relatório de erro,
//       nunca ganha um número inventado (nem em preview, nem em commit)
//   (b) linha COM matrícula é importada usando EXATAMENTE o número da
//       planilha (nenhuma query de geração é chamada — a função nem
//       existe mais em karateService)
//   (c) se NENHUMA linha tem matrícula, commit inteiro falha com 422 e
//       nem abre transação
//
// Estilo: supertest + mock sequencial de db.query/db.connect (mesmo
// padrão de karate.trackA.test.js / karate.rosterPortalScale.test.js).
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const FED_ID = 'fed-uuid-import-001';

const adminToken = jwt.sign(
  { id: 'user-admin-001', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/practitioners/import', require('../src/routes/karateImport'));
  return app;
}

describe('POST /federation/:id/practitioners/import — H2: matrícula FPKT obrigatória, nunca gerada', () => {
  it('(a) preview: linha sem matrícula vira erro; linha com matrícula conta como válida', (done) => {
    const app = buildApp();
    db.query.mockResolvedValueOnce({ rows: [{ id: FED_ID }] }); // fed check

    const csv = 'nome,matricula,email\nJoão Silva,21758-D,joao@x.com\nMaria Souza,,maria@x.com';

    request(app)
      .post(`/federation/${FED_ID}/practitioners/import`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ mode: 'preview', csv_content: csv })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.valid_rows).toBe(1);
        const errs = res.body.errors;
        const regError = errs.find((e) => e.field === 'registration_number');
        expect(regError).toBeDefined();
        expect(regError.row).toBe(2); // segunda linha de dados (Maria)
        done();
      });
  });

  it('(b) commit: praticante é gravado com o NÚMERO EXATO da planilha, nenhuma query de geração é chamada', (done) => {
    const app = buildApp();
    db.query.mockResolvedValueOnce({ rows: [{ id: FED_ID }] }); // fed check

    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'cust-new-1' }] }) // INSERT customers RETURNING id
      .mockResolvedValueOnce({}); // COMMIT

    const csv = 'nome,matricula,email\nJoão Silva,21758-D,joao@x.com';

    request(app)
      .post(`/federation/${FED_ID}/practitioners/import`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ mode: 'commit', csv_content: csv })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.committed).toBe(1);

        // única query de INSERT no client — sem advisory lock / MAX lookup
        expect(mockClient.query).toHaveBeenCalledTimes(3); // BEGIN, INSERT, COMMIT
        const insertCall = mockClient.query.mock.calls.find(
          (c) => typeof c[0] === 'string' && /INSERT INTO customers/i.test(c[0])
        );
        expect(insertCall).toBeDefined();
        const params = insertCall[1];
        // último parâmetro é o karate_registration_number — deve ser
        // exatamente o valor da planilha, nunca um formato "N-D" inventado
        // pelo gerador removido.
        expect(params[params.length - 1]).toBe('21758-D');
        done();
      });
  });

  it('(c) commit: se NENHUMA linha tem matrícula, 422 antes de abrir transação (não inventa número p/ nenhuma)', (done) => {
    const app = buildApp();
    db.query.mockResolvedValueOnce({ rows: [{ id: FED_ID }] }); // fed check

    const csv = 'nome,matricula,email\nMaria Souza,,maria@x.com';

    request(app)
      .post(`/federation/${FED_ID}/practitioners/import`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ mode: 'commit', csv_content: csv })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.committed).toBe(0);
        expect(db.connect).not.toHaveBeenCalled();
        done();
      });
  });
});
