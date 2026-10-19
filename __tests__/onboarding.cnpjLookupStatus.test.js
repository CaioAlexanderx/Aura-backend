// 19/10/2026 — INC-2026-10-19-03: com a Receita fora, o cadastro recebia 500
// "CNPJ lookup timeout". Agora: nenhuma fonte respondeu → 503 com mensagem
// para a pessoa; "não encontrado" continua 404.
const express = require('express');
const request = require('supertest');

jest.mock('../src/services/cnpj', () => {
  const real = jest.requireActual('../src/services/cnpj');
  return { ...real, lookupCNPJ: jest.fn() };
});
const { lookupCNPJ } = require('../src/services/cnpj');

const app = express();
app.use(express.json());
app.use('/onboarding', require('../src/routes/onboarding'));

const CNPJ = '33.000.167/0001-01';

describe('POST /onboarding/cnpj-lookup — status quando a Receita falha', () => {
  test('nenhuma fonte respondeu → 503 com a mensagem do serviço', async () => {
    const err = new Error('Não conseguimos consultar a Receita agora. Tente de novo em alguns minutos.');
    err.status = 503;
    lookupCNPJ.mockRejectedValueOnce(err);
    const res = await request(app).post('/onboarding/cnpj-lookup').send({ cnpj: CNPJ });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Não conseguimos consultar a Receita agora. Tente de novo em alguns minutos.');
  });

  test('não encontrado continua 404', async () => {
    lookupCNPJ.mockRejectedValueOnce(new Error('CNPJ não encontrado na Receita Federal'));
    const res = await request(app).post('/onboarding/cnpj-lookup').send({ cnpj: CNPJ });
    expect(res.status).toBe(404);
  });

  test('erro inesperado continua 500', async () => {
    lookupCNPJ.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/onboarding/cnpj-lookup').send({ cnpj: CNPJ });
    expect(res.status).toBe(500);
  });
});
