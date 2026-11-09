// ============================================================
// Rotas /companies/:id/nfse com o provider 'nacional' (serviço simulado).
//   • PUT /config aceita provider 'nacional', valida os campos novos,
//     nasce em produção restrita, recusa URL/senha de certificado solta e
//     só deixa a numeração da DPS andar pra frente;
//   • GET /config mostra se está apta e o que falta;
//   • POST / delega ao serviço nacional (tomador opcional; chave de
//     idempotência do corpo ou do header Idempotency-Key) e mapeia status;
//   • cancelamento, consulta, PDF e XML da nota nacional vão ao serviço;
//   • providers antigos seguem como antes (tomador obrigatório).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../src/services/nfseNacional', () => ({
  emitir: jest.fn(),
  cancelar: jest.fn(),
  consultar: jest.fn(),
  danfse: jest.fn(),
  situacaoConfig: jest.fn(),
}));

const db = require('../../src/config/database');
const nacional = require('../../src/services/nfseNacional');
const { NfseNacionalError } = require('../../src/services/nfseNacional/errors');

const token = jwt.sign({ id: 'u1', role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };
const BASE = '/companies/c1/nfse';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id/nfse', require('../../src/routes/nfse'));
  return a;
}

const notaAutorizada = { id: 'n1', status: 'autorizada', chave_acesso: '1'.repeat(50), nfse_number: '7', dps_serie: '1', dps_number: '1', ambiente: 'producao_restrita' };

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  Object.values(nacional).forEach((f) => f.mockReset());
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PUT /config — provider nacional', () => {
  test('cria config nacional: campos validados e ambiente nasce em producao_restrita', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })                // getNfseConfig: não existe
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] }); // INSERT
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({
      provider: 'nacional', is_active: true, municipio_ibge: '3524402', ctribnac_padrao: '01.05.01',
      op_simp_nac: 3, p_tot_trib_sn: 6, serie: '00001',
    });
    expect(res.status).toBe(201);
    const [sql, values] = db.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO nfse_config/);
    const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim());
    const row = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
    expect(row).toMatchObject({
      provider: 'nacional', municipio_ibge: '3524402', ctribnac_padrao: '010501',
      op_simp_nac: 3, p_tot_trib_sn: 6, serie: '1', ambiente: 'producao_restrita', company_id: 'c1',
    });
  });

  test('campos inválidos → 400 com os motivos, nada gravado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({
      provider: 'nacional', municipio_ibge: '35244', ctribnac_padrao: 'abc', ambiente: 'teste', serie: '70000',
    });
    expect(res.status).toBe(400);
    expect(res.body.detalhes.join(' ')).toMatch(/municipio_ibge/);
    expect(res.body.detalhes.join(' ')).toMatch(/ctribnac_padrao/);
    expect(res.body.detalhes.join(' ')).toMatch(/ambiente/);
    expect(res.body.detalhes.join(' ')).toMatch(/serie/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('certificado por URL/senha no nacional → 400 apontando para o envio do A1', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ certificate_url: 'https://x/a.pfx' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CERTIFICADO');
  });

  test('next_dps_number só anda pra frente (GREATEST)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ next_dps_number: 100, ambiente: 'producao' });
    expect(res.status).toBe(200);
    const [sql, values] = db.query.mock.calls[1];
    expect(sql).toMatch(/next_dps_number = GREATEST\(next_dps_number, \$\d\)/);
    expect(sql).toMatch(/ambiente = \$\d/);
    expect(values).toEqual(expect.arrayContaining([100, 'producao']));
  });

  test('provider antigo: ambiente continua livre como antes', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'mock' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ ambiente: 'homologacao' });
    expect(res.status).toBe(200);
  });
});

describe('GET /config — situação do emissor nacional', () => {
  test('mostra apta/pendências e se há certificado, sem segredo', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional', api_key_encrypted: null, certificate_pwd: null }] });
    nacional.situacaoConfig.mockResolvedValueOnce({ apta: false, pendencias: ['Certificado digital A1 não enviado.'], ligado: false, ambiente: 'producao_restrita', certificado: null });
    const res = await request(app()).get(`${BASE}/config`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.config.nacional).toMatchObject({ apta: false, ligado: false });
    expect(res.body.config.has_certificate).toBe(false);
  });
});

describe('POST / — emissão nacional', () => {
  function comConfigNacional() {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.connect.mockReturnValueOnce(client);
    db.query.mockResolvedValueOnce({ rows: [{ company_id: 'c1', is_active: true, provider: 'nacional' }] });
    return client;
  }

  test('delega ao serviço com a chave do header; tomador opcional; 201', async () => {
    const client = comConfigNacional();
    nacional.emitir.mockResolvedValueOnce({ nota: notaAutorizada });
    const res = await request(app()).post(BASE).set(auth).set('Idempotency-Key', 'asaas-pay-1')
      .send({ service_description: 'Licença de uso', service_amount: 199.9 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ nfse_id: 'n1', status: 'autorizada', chave_acesso: '1'.repeat(50), nfse_number: '7' });
    const [, args] = nacional.emitir.mock.calls[0];
    expect(args).toMatchObject({ companyId: 'c1', idempotencyKey: 'asaas-pay-1', nota: { descricao: 'Licença de uso', valor: 199.9 } });
    expect(args.nota.tomador).toBeUndefined();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('tomador e endereço mapeados para o serviço', async () => {
    comConfigNacional();
    nacional.emitir.mockResolvedValueOnce({ nota: notaAutorizada });
    await request(app()).post(BASE).set(auth).send({
      idempotency_key: 'k2', service_description: 'x', service_amount: 10,
      recipient_name: 'Cliente', recipient_doc: '52998224725', recipient_email: 'c@example.com',
      recipient_address: { logradouro: 'Rua A', numero: '1', bairro: 'Centro', codigo_municipio: '3524402', cep: '12327000' },
    });
    const { nota } = nacional.emitir.mock.calls[0][1];
    expect(nota.tomador).toMatchObject({ doc: '52998224725', nome: 'Cliente', email: 'c@example.com', endereco: { cMun: '3524402', cep: '12327000', logradouro: 'Rua A' } });
  });

  test.each([
    [{ nota: { ...notaAutorizada }, replay: true }, 200],
    [{ nota: { id: 'n1', status: 'pendente' }, aguardando: true }, 202],
    [{ nota: { id: 'n1', status: 'rejeitada', error_codes: [{ codigo: 'E0310' }] } }, 422],
    [{ nota: { id: 'n1', status: 'erro' } }, 502],
  ])('resultado %j → HTTP %i', async (resultado, status) => {
    comConfigNacional();
    nacional.emitir.mockResolvedValueOnce(resultado);
    const res = await request(app()).post(BASE).set(auth).send({ idempotency_key: 'k', service_description: 'x', service_amount: 10 });
    expect(res.status).toBe(status);
  });

  test('liga desligada → 503 com mensagem clara', async () => {
    comConfigNacional();
    nacional.emitir.mockRejectedValueOnce(new NfseNacionalError('Emissor nacional de NFS-e desligado neste servidor (NFSE_NACIONAL_ENABLED). Nada foi enviado.', 'NACIONAL_DESLIGADO'));
    const res = await request(app()).post(BASE).set(auth).send({ idempotency_key: 'k', service_description: 'x', service_amount: 10 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NACIONAL_DESLIGADO');
  });

  test('provider antigo sem tomador → 400 como antes, sem chamar o nacional', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.connect.mockReturnValueOnce(client);
    db.query.mockResolvedValueOnce({ rows: [{ company_id: 'c1', is_active: true, provider: 'mock' }] });
    const res = await request(app()).post(BASE).set(auth).send({ service_description: 'x', service_amount: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recipient_name/);
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('nota nacional: cancelar, consultar, PDF, XML', () => {
  test('cancelar vai ao serviço com o motivo e o código', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'n1', nota_provider: 'nacional', status: 'autorizada' }] });
    nacional.cancelar.mockResolvedValueOnce({ nota: { ...notaAutorizada, status: 'cancelada' } });
    const res = await request(app()).post(`${BASE}/n1/cancel`).set(auth).send({ reason: 'Valor digitado errado na fatura', motivo_codigo: 1 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelada');
    expect(nacional.cancelar.mock.calls[0][1]).toMatchObject({ companyId: 'c1', nfseId: 'n1', cMotivo: 1, xMotivo: 'Valor digitado errado na fatura' });
  });

  test('cancelamento recusado pelo Sefin → 422 com os códigos', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'n1', nota_provider: 'nacional' }] });
    nacional.cancelar.mockRejectedValueOnce(new NfseNacionalError('Cancelamento recusado', 'REJEITADA', [{ codigo: 'E0840' }]));
    const res = await request(app()).post(`${BASE}/n1/cancel`).set(auth).send({ reason: 'Serviço cancelado pelo cliente' });
    expect(res.status).toBe(422);
    expect(res.body.detalhes).toEqual([{ codigo: 'E0840' }]);
  });

  test('refresh vai ao serviço', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'n1', nota_provider: 'nacional' }] });
    nacional.consultar.mockResolvedValueOnce({ nota: notaAutorizada });
    const res = await request(app()).post(`${BASE}/n1/refresh`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.chave_acesso).toBe('1'.repeat(50));
  });

  test('PDF: DANFSe do ADN repassado como application/pdf', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ pdf_url: null, provider: 'nacional' }] });
    nacional.danfse.mockResolvedValueOnce(Buffer.from('%PDF-1.7 teste'));
    const res = await request(app()).get(`${BASE}/n1/pdf`).set(auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  test('XML: o XML da NFS-e gravado na nota', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ xml_url: null, provider: 'nacional' }] })
      .mockResolvedValueOnce({ rows: [{ xml_nfse: '<NFSe/>' }] });
    const res = await request(app()).get(`${BASE}/n1/xml`).set(auth);
    expect(res.status).toBe(200);
    expect(res.text).toBe('<NFSe/>');
  });
});
