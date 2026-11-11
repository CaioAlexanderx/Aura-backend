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
  emitirTeste: jest.fn(),
  avaliarLigar: jest.fn(),
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
      provider: 'nacional', municipio_ibge: '3524402', ctribnac_padrao: '01.05.01',
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

// migration 437: serviço do estoque na nota (nota → item → padrão da empresa)
describe('POST / — product_id (serviço do estoque)', () => {
  const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  function comConfig(provider) {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.connect.mockReturnValueOnce(client);
    db.query.mockResolvedValueOnce({ rows: [{ company_id: 'c1', is_active: true, provider }] });
    return client;
  }

  test('nacional: product_id vai ao serviço e a descrição pode vir do item', async () => {
    comConfig('nacional');
    nacional.emitir.mockResolvedValueOnce({ nota: notaAutorizada });
    const res = await request(app()).post(BASE).set(auth).send({ idempotency_key: 'k-item', product_id: PID, service_amount: 350 });
    expect(res.status).toBe(201);
    const { nota } = nacional.emitir.mock.calls[0][1];
    expect(nota).toMatchObject({ product_id: PID, valor: 350 });
    expect(nota.descricao).toBeUndefined();
  });

  test('nacional: valores explícitos seguem na nota junto do product_id', async () => {
    comConfig('nacional');
    nacional.emitir.mockResolvedValueOnce({ nota: notaAutorizada });
    await request(app()).post(BASE).set(auth).send({
      idempotency_key: 'k-exp', product_id: PID, service_amount: 350,
      service_description: 'Instalação especial', service_code: '070201', cnbs: '101010101', iss_rate: 4,
    });
    expect(nacional.emitir.mock.calls[0][1].nota).toMatchObject({
      product_id: PID, descricao: 'Instalação especial', ctribnac: '070201', cnbs: '101010101', aliquota_iss: 4,
    });
  });

  test('item inexistente/invisível → 404 em português', async () => {
    comConfig('nacional');
    nacional.emitir.mockRejectedValueOnce(new NfseNacionalError('Não encontramos este serviço no estoque desta empresa.', 'NOT_FOUND'));
    const res = await request(app()).post(BASE).set(auth).send({ idempotency_key: 'k', product_id: PID, service_amount: 10 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Não encontramos este serviço/);
  });

  test('sem descrição e sem product_id → 400 como antes, sem abrir conexão', async () => {
    const res = await request(app()).post(BASE).set(auth).send({ service_amount: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service_description/);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('provider antigo com product_id e sem descrição → 400 (product_id só vale no nacional)', async () => {
    const client = comConfig('mock');
    const res = await request(app()).post(BASE).set(auth).send({ product_id: PID, service_amount: 10, recipient_name: 'X', recipient_doc: '52998224725' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service_description/);
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /config — default_iss_rate no nacional', () => {
  test('aceita e normaliza ("2,5" → 2.5)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ default_iss_rate: '2,5' });
    expect(res.status).toBe(200);
    const [sql, values] = db.query.mock.calls[1];
    expect(sql).toMatch(/default_iss_rate = \$\d/);
    expect(values).toContain(2.5);
  });

  test.each([[6], ['abc'], [null], [-1]])('valor %j → 400, nada gravado', async (v) => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ default_iss_rate: v });
    expect(res.status).toBe(400);
    expect(res.body.detalhes.join(' ')).toMatch(/default_iss_rate/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('provider antigo: default_iss_rate continua como antes (sem a régua nova)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'mock' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ default_iss_rate: 3 });
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][1]).toContain(3);
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
      .mockResolvedValueOnce({ rows: [{ id: 'n1', status: 'autorizada', xml_nfse: '<NFSe/>' }] });
    const res = await request(app()).get(`${BASE}/n1/xml`).set(auth);
    expect(res.status).toBe(200);
    expect(res.text).toBe('<NFSe/>');
  });

  test('XML (11/11/2026): nota pendente, marcada DPS_NUMERO_JA_USADO ou a linha adotada do incidente → 409, nada servido', async () => {
    const incidente = require('../fixtures/nfseDpsNumeroJaUsado');
    const casos = [
      [{ id: 'n1', status: 'pendente', xml_nfse: '<NFSe/>' }, 'ESTADO_INVALIDO'],
      [{ id: 'n1', status: 'erro', xml_nfse: '<NFSe/>', error_codes: [{ codigo: 'DPS_NUMERO_JA_USADO' }] }, 'NOTA_NAO_CONFERIDA'],
      [incidente.linhaAdotada(), 'NOTA_NAO_CONFERIDA'],
    ];
    for (const [linha, code] of casos) {
      db.query
        .mockResolvedValueOnce({ rows: [{ xml_url: null, provider: 'nacional' }] })
        .mockResolvedValueOnce({ rows: [linha] });
      const res = await request(app()).get(`${BASE}/n1/xml`).set(auth);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(code);
      expect(res.text).not.toContain('<NFSe');
    }
  });
});

// ── migration 441: passo a passo da configuração e nota de teste ──

describe('PUT /config — ligar a NFS-e (is_active) só depois da nota de teste', () => {
  const existente = { id: 'cfg1', provider: 'nacional', is_active: false, ambiente: 'producao_restrita', op_simp_nac: 3 };

  test('sem teste ok: 409 NAO_PODE_LIGAR com os motivos, nada gravado', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente] });
    nacional.avaliarLigar.mockResolvedValueOnce({ ok: false, motivos: ['Antes de ligar, emita a nota de teste.'], passos: {} });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ is_active: true });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NAO_PODE_LIGAR', detalhes: ['Antes de ligar, emita a nota de teste.'] });
    expect(db.query).toHaveBeenCalledTimes(1);
    // a config avaliada é a final, já em produção
    expect(nacional.avaliarLigar.mock.calls[0][2]).toMatchObject({ is_active: true, ambiente: 'producao', provider: 'nacional' });
  });

  test('tudo pronto mas a produção travada no servidor: 409 PRODUCAO_NAO_LIBERADA, nada gravado', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente] });
    nacional.avaliarLigar.mockResolvedValueOnce({ ok: true, motivos: [], passos: {} });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ is_active: true, ambiente: 'producao' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRODUCAO_NAO_LIBERADA');
    expect(res.body.error).toMatch(/Sua loja está pronta/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('tudo pronto e produção liberada: liga em produção', async () => {
    process.env.NFSE_NACIONAL_PRODUCAO = 'true';
    try {
      db.query.mockResolvedValueOnce({ rows: [existente] }).mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
      nacional.avaliarLigar.mockResolvedValueOnce({ ok: true, motivos: [], passos: {} });
      const res = await request(app()).put(`${BASE}/config`).set(auth).send({ is_active: true, p_tot_trib_sn: 6.54, cliente_retem_iss: false });
      expect(res.status).toBe(200);
      const [sql, values] = db.query.mock.calls[1];
      expect(sql).toMatch(/is_active = \$\d/);
      expect(sql).toMatch(/ambiente = \$\d/);
      expect(values).toEqual(expect.arrayContaining([true, 'producao', 6.54, false]));
    } finally {
      delete process.env.NFSE_NACIONAL_PRODUCAO;
    }
  });

  test('já ligada no mesmo ambiente: reenviar is_active não passa pela trava', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ ...existente, is_active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ is_active: true });
    expect(res.status).toBe(200);
    expect(nacional.avaliarLigar).not.toHaveBeenCalled();
  });

  test('desligar nunca é barrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...existente, is_active: true }] }).mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ is_active: false });
    expect(res.status).toBe(200);
    expect(nacional.avaliarLigar).not.toHaveBeenCalled();
  });
});

describe('PUT /config — campos novos (migration 441)', () => {
  test('alíquota do ISSQN retido sem cliente que retém: 400', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional', op_simp_nac: 3, cliente_retem_iss: false }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ aliquota_iss_retencao_sn: '2,79' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Retenção do ISSQN/);
  });

  test('cliente retém + alíquota + Inscrição Municipal + cadastro na prefeitura + série confirmada: grava', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional', op_simp_nac: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({
      cliente_retem_iss: true, aliquota_iss_retencao_sn: '2,79', inscricao_municipal: ' 31.582-0 ',
      prefeitura_cadastro_confirmado: 'sim', serie: '1', serie_confirmada: true,
    });
    expect(res.status).toBe(200);
    const [sql, values] = db.query.mock.calls[1];
    for (const c of ['cliente_retem_iss', 'aliquota_iss_retencao_sn', 'inscricao_municipal', 'prefeitura_cadastro_confirmado', 'serie_confirmada_em']) {
      expect(sql).toMatch(new RegExp(`${c} = \\$\\d`));
    }
    expect(values).toEqual(expect.arrayContaining([true, 2.79, '31.582-0', 'sim', '1']));
    expect(values.some((v) => v instanceof Date)).toBe(true);
  });

  test('dizer que nenhum cliente retém apaga a alíquota', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional', op_simp_nac: 3, cliente_retem_iss: true, aliquota_iss_retencao_sn: 2.79 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ cliente_retem_iss: false });
    expect(res.status).toBe(200);
    const [sql, values] = db.query.mock.calls[1];
    expect(sql).toMatch(/aliquota_iss_retencao_sn = \$\d/);
    expect(values).toEqual(expect.arrayContaining([false, null]));
  });

  test('série do emissor web: 400 explicando a faixa', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cfg1', provider: 'nacional' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ serie: '70000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/faixa do emissor do gov\.br/);
    expect(res.body.error).not.toMatch(/nunca/); // a faixa não garante nada (incidente de 10/11/2026)
  });
});

describe('PUT /config — "Já emite NFS-e por outro emissor?" (migration 443)', () => {
  const existente = (over = {}) => ({ id: 'cfg1', provider: 'nacional', serie: '1', next_dps_number: 1, ...over });
  const campos = (sql) => Object.fromEntries([...sql.matchAll(/(\w+) = (?:GREATEST\(\w+, )?\$(\d+)/g)].map((m) => [m[1], Number(m[2]) - 1]));

  test('sim, na mesma série: grava a série e o último número do outro e a Aura continua no seguinte', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente()] }).mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({
      serie: '1', serie_confirmada: true, outro_emissor: true, outro_emissor_serie: '00001', outro_emissor_ultimo_numero: '12',
    });
    expect(res.status).toBe(200);
    const [sql, values] = db.query.mock.calls[1];
    const i = campos(sql);
    expect(values[i.outro_emissor]).toBe(true);
    expect(values[i.outro_emissor_serie]).toBe('1');
    expect(values[i.outro_emissor_ultimo_numero]).toBe(12);
    expect(sql).toMatch(/next_dps_number = GREATEST\(next_dps_number, \$\d+\)/);
    expect(values[i.next_dps_number]).toBe(13);
  });

  test('sim, com série diferente na Aura: a numeração da Aura não muda', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente()] }).mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({
      serie: '3', serie_confirmada: true, outro_emissor: true, outro_emissor_serie: '1', outro_emissor_ultimo_numero: 40,
    });
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][0]).not.toMatch(/next_dps_number/);
  });

  test('sim, sem a série ou o último número do outro: 400 e nada gravado', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente()] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ serie_confirmada: true, outro_emissor: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outro emissor/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('não: apaga a série e o último número do outro', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente({ outro_emissor: true, outro_emissor_serie: '1', outro_emissor_ultimo_numero: 3 })] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ serie_confirmada: true, outro_emissor: false });
    expect(res.status).toBe(200);
    const [sql, values] = db.query.mock.calls[1];
    const i = campos(sql);
    expect(values[i.outro_emissor]).toBe(false);
    expect(values[i.outro_emissor_serie]).toBeNull();
    expect(values[i.outro_emissor_ultimo_numero]).toBeNull();
  });

  test('app de hoje (sem outro_emissor) que informa o último número: conta como "sim, nesta série"', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente()] }).mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ serie: '1', serie_confirmada: true, next_dps_number: 213 });
    expect(res.status).toBe(200);
    const [sql, values] = db.query.mock.calls[1];
    const i = campos(sql);
    expect(values[i.outro_emissor]).toBe(true);
    expect(values[i.outro_emissor_serie]).toBe('1');
    expect(values[i.outro_emissor_ultimo_numero]).toBe(212);
    expect(values[i.next_dps_number]).toBe(213);
  });

  test('app de hoje sem o último número: grava como antes, sem inventar a resposta', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente()] }).mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ serie: '1', serie_confirmada: true });
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][0]).not.toMatch(/outro_emissor/);
  });

  test('conflito DPS_NUMERO_JA_USADO: confirmar a série com a resposta limpa o conflito', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente({ dps_conflito_em: '2026-11-10T15:00:00Z', dps_conflito_serie: '1', dps_conflito_numero: 1, next_dps_number: 2 })] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({
      serie: '1', serie_confirmada: true, outro_emissor: true, outro_emissor_serie: '1', outro_emissor_ultimo_numero: 1,
    });
    expect(res.status).toBe(200);
    const [sql, values] = db.query.mock.calls[1];
    const i = campos(sql);
    expect(values[i.dps_conflito_em]).toBeNull();
    expect(values[i.dps_conflito_serie]).toBeNull();
    expect(values[i.dps_conflito_numero]).toBeNull();
  });

  test('conflito: confirmar a MESMA série sem responder sobre o outro emissor não limpa', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente({ dps_conflito_em: '2026-11-10T15:00:00Z', dps_conflito_serie: '1', dps_conflito_numero: 1 })] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ serie: '1', serie_confirmada: true });
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][0]).not.toMatch(/dps_conflito_em/);
  });

  test('conflito: trocar de série (app de hoje) limpa', async () => {
    db.query.mockResolvedValueOnce({ rows: [existente({ dps_conflito_em: '2026-11-10T15:00:00Z', dps_conflito_serie: '1', dps_conflito_numero: 1 })] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg1' }] });
    const res = await request(app()).put(`${BASE}/config`).set(auth).send({ serie: '3', serie_confirmada: true });
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][0]).toMatch(/dps_conflito_em = \$\d/);
  });
});

describe('GET /config — passo a passo mesmo sem config', () => {
  test('sem config: has_config false e o passo a passo com a sugestão da empresa', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    nacional.situacaoConfig.mockResolvedValueOnce({ apta: false, passos: { certificado: { estado: 'ok' } }, sugestao: { municipio: 'Jacareí' } });
    const res = await request(app()).get(`${BASE}/config`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ config: null, has_config: false, nacional: { passos: { certificado: { estado: 'ok' } }, sugestao: { municipio: 'Jacareí' } } });
  });
});

describe('POST /teste — nota de teste', () => {
  test('delega ao serviço com a chave do corpo e devolve o resultado traduzido + a situação', async () => {
    nacional.emitirTeste.mockResolvedValueOnce({
      resultado: { status: 'rejeitado', passo: 'prefeitura', codigo: 'E0084', titulo: 'Quase lá', caminho: ['x'] },
      nota: { id: 'nt1', status: 'rejeitada', dps_serie: '49999', dps_number: '1', ambiente: 'producao_restrita' },
    });
    nacional.situacaoConfig.mockResolvedValueOnce({ passos: { teste: { estado: 'problema' } } });
    const res = await request(app()).post(`${BASE}/teste`).set(auth).send({ idempotency_key: 'clique-1' });
    expect(res.status).toBe(200);
    expect(nacional.emitirTeste.mock.calls[0][1]).toEqual({ companyId: 'c1', idempotencyKey: 'clique-1' });
    expect(res.body).toMatchObject({
      resultado: { status: 'rejeitado', passo: 'prefeitura', codigo: 'E0084' },
      nota: { nfse_id: 'nt1', dps_serie: '49999', ambiente: 'producao_restrita' },
      nacional: { passos: { teste: { estado: 'problema' } } },
    });
  });

  test('passos base faltando: 409 TESTE_TRAVADO', async () => {
    nacional.emitirTeste.mockRejectedValueOnce(new NfseNacionalError('A nota de teste libera quando...', 'TESTE_TRAVADO', ['serie']));
    const res = await request(app()).post(`${BASE}/teste`).set(auth).send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TESTE_TRAVADO', detalhes: ['serie'] });
  });

  test('não exige is_active nem toca no banco pela rota', async () => {
    nacional.emitirTeste.mockResolvedValueOnce({ resultado: { status: 'ok' }, nota: null });
    nacional.situacaoConfig.mockResolvedValueOnce(null);
    const res = await request(app()).post(`${BASE}/teste`).set(auth);
    expect(res.status).toBe(200);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('GET / — nota de teste fica fora da lista', () => {
  test('por padrão filtra source_type teste na lista e nas contas; ?incluir_teste=1 mostra', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await request(app()).get(BASE).set(auth);
    expect(db.query.mock.calls[0][0]).toMatch(/source_type IS DISTINCT FROM 'teste'/);
    expect(db.query.mock.calls[1][0]).toMatch(/source_type IS DISTINCT FROM 'teste'/);
    db.query.mockClear();
    await request(app()).get(`${BASE}?incluir_teste=1`).set(auth);
    expect(db.query.mock.calls[0][0]).not.toMatch(/IS DISTINCT FROM 'teste'/);
  });
});
