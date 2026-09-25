// ============================================================
// BE-3 · "Pedidos pela loja": gravar o que a vitrine ja le (25/09/2026)
//
// A vitrine sabia fechar para pedidos, oferecer retirada por app e
// carregar GA4/Pixel — e o painel nao tinha como salvar nada disso. A
// Sheid nao conseguia encerrar o Natal pela loja.
//
// O que estes testes guardam: o formato que cada campo aceita (com a
// MESMA regra de GA4/Pixel que a vitrine usa para injetar), que campo
// ausente nao e gravado, que um erro devolve 400 sem salvar nada pela
// metade, que base sem a migration 355 nao impede fechar a loja e que
// salvar continua esquecendo a home guardada.
// ============================================================
'use strict';

jest.mock('../src/services/cacheDaPaginaDaLoja', () => ({
  esquecerPagina: jest.fn(), paginaLembrada: jest.fn(() => null), lembrarPagina: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { esquecerPagina } = require('../src/services/cacheDaPaginaDaLoja');
const { sanitizarPedidosPelaLoja, RECADO_MAX } = require('../src/services/pedidosPelaLoja');
const { idGa4, idPixel } = require('../src/services/rastreadores');
const { modoDaLoja } = require('../src/services/modoDaLoja');

const ok = (body) => sanitizarPedidosPelaLoja(body).campos;
const erro = (body) => sanitizarPedidosPelaLoja(body).erro;

describe('o sanitizador', () => {
  test('corpo sem nenhum destes campos nao grava nada', () => {
    expect(ok({ site_name: 'Sheid' })).toEqual({});
    expect(ok(undefined)).toEqual({});
  });

  test('interruptores: booleano ou "true"/"false"; o resto e erro', () => {
    expect(ok({ pedidos_pausados: true, courier_pickup_enabled: 'false' }))
      .toEqual({ pedidos_pausados: true, courier_pickup_enabled: false });
    expect(erro({ pedidos_pausados: 1 })).toMatch(/pedidos_pausados deve ser verdadeiro ou falso/);
    expect(erro({ courier_pickup_enabled: 'sim' })).toMatch(/courier_pickup_enabled/);
    expect(erro({ pedidos_pausados: null })).toBeTruthy();
  });

  test('data limite: AAAA-MM-DD que existe; vazio ou null limpa', () => {
    expect(ok({ pedidos_ate: '2026-12-20' })).toEqual({ pedidos_ate: '2026-12-20' });
    expect(ok({ pedidos_ate: ' 2028-02-29 ' })).toEqual({ pedidos_ate: '2028-02-29' });
    expect(ok({ pedidos_ate: '' })).toEqual({ pedidos_ate: null });
    expect(ok({ pedidos_ate: null })).toEqual({ pedidos_ate: null });
    for (const ruim of ['20/12/2026', '2026-02-30', '2026-13-01', '2026-12-20T00:00:00Z', 'amanha']) {
      expect(erro({ pedidos_ate: ruim })).toMatch(/AAAA-MM-DD/);
    }
  });

  test('data no passado passa: o painel reenvia o formulario inteiro depois da temporada', () => {
    expect(ok({ pedidos_ate: '2025-12-20' })).toEqual({ pedidos_ate: '2025-12-20' });
  });

  test('recado: ate 280, aparado; vazio limpa; acima recusa dizendo o limite', () => {
    expect(ok({ pedidos_recado: '  Voltamos em 6 de janeiro.\n  ' })).toEqual({ pedidos_recado: 'Voltamos em 6 de janeiro.' });
    expect(ok({ pedidos_recado: 'linha 1\nlinha 2' })).toEqual({ pedidos_recado: 'linha 1\nlinha 2' });
    expect(ok({ pedidos_recado: '' })).toEqual({ pedidos_recado: null });
    expect(ok({ pedidos_recado: null })).toEqual({ pedidos_recado: null });
    expect(ok({ pedidos_recado: 'a'.repeat(RECADO_MAX) }).pedidos_recado).toHaveLength(280);
    expect(erro({ pedidos_recado: 'a'.repeat(281) })).toBe('O recado para o cliente pode ter até 280 caracteres (tem 281).');
    expect(erro({ pedidos_recado: 42 })).toMatch(/texto/);
  });

  test('GA4: a mesma regra da vitrine, normalizado em caixa alta', () => {
    expect(ok({ ga4_measurement_id: ' g-8q3fq2n1km ' })).toEqual({ ga4_measurement_id: 'G-8Q3FQ2N1KM' });
    expect(ok({ ga4_measurement_id: '' })).toEqual({ ga4_measurement_id: null });
    expect(ok({ ga4_measurement_id: null })).toEqual({ ga4_measurement_id: null });
    const e = erro({ ga4_measurement_id: 'UA-12345-1' });
    expect(e).toMatch(/Google Analytics inválido/);
    expect(e).toMatch(/G- seguido de 6 a 14 letras ou números/);
  });

  test('Pixel: 15 ou 16 digitos; a mensagem diz o formato', () => {
    expect(ok({ meta_pixel_id: '741852963012345' })).toEqual({ meta_pixel_id: '741852963012345' });
    expect(ok({ meta_pixel_id: '  ' })).toEqual({ meta_pixel_id: null });
    expect(erro({ meta_pixel_id: '741852' })).toMatch(/Pixel da Meta inválido. O Pixel tem 15 ou 16 números/);
    expect(erro({ meta_pixel_id: '7418 5296 3012 345' })).toMatch(/Pixel/);
  });

  test('o que o painel aceita e exatamente o que a vitrine injeta', () => {
    // Se divergissem, a lojista salvaria e o Google nunca veria visita.
    for (const v of ['G-ABC123', 'G-ABCDEFGHIJKLMN', 'G-ABC12', 'G-ABCDEFGHIJKLMNO', 'G_ABC123', 'g-abc123']) {
      const aceito = !erro({ ga4_measurement_id: v });
      expect([v, aceito]).toEqual([v, idGa4(v) !== null]);
    }
    for (const v of ['123456789012345', '1234567890123456', '12345678901234', '12345678901234567', 'abc']) {
      const aceito = !erro({ meta_pixel_id: v });
      expect([v, aceito]).toEqual([v, idPixel(v) !== null]);
    }
  });
});

describe('o recado chega na vitrine', () => {
  const EM = new Date('2026-12-22T15:00:00Z');
  test('loja pausada com recado proprio', () => {
    const m = modoDaLoja({ pedidos_pausados: true, pedidos_recado: 'Voltamos em 6 de janeiro.' });
    expect(m).toMatchObject({ aceita: false, motivo: 'pausado', recado: 'Voltamos em 6 de janeiro.' });
  });
  test('temporada encerrada tambem usa o recado', () => {
    const m = modoDaLoja({ pedidos_ate: '2026-12-20', pedidos_recado: 'Natal encerrado!' }, EM);
    expect(m).toMatchObject({ aceita: false, motivo: 'prazo', recado: 'Natal encerrado!' });
  });
  test('sem recado (ou so espacos, ou base sem a coluna), o texto padrao', () => {
    expect(modoDaLoja({ pedidos_pausados: true, pedidos_recado: '  ' }).recado).toMatch(/fechada para pedidos novos/);
    expect(modoDaLoja({ pedidos_pausados: true }).recado).toMatch(/fechada para pedidos novos/);
  });
  test('loja aberta nao mostra recado, mesmo com um gravado', () => {
    expect(modoDaLoja({ pedidos_recado: 'x' }).recado).toBeNull();
  });
});

describe('o PUT /companies/:id/digital-channel', () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { role: 'client' }; next(); });
  app.use('/companies/:id/digital-channel', require('../src/routes/digitalChannel'));

  let semRecado;
  let linha;
  beforeEach(() => {
    semRecado = false;
    linha = { company_id: 'cid-1', slug: 'sheid-mania', pedidos_ate: null };
    esquecerPagina.mockClear();
    db.query.mockReset();
    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (s.includes('information_schema')) return { rows: [] };
      if (s.includes('INSERT INTO digital_channel_config')) return { rows: [{ ...linha }] };
      const m = /UPDATE digital_channel_config SET (\w+) = \$1/.exec(s);
      if (m) {
        if (m[1] === 'pedidos_recado' && semRecado) {
          throw Object.assign(new Error('column "pedidos_recado" does not exist'), { code: '42703' });
        }
        // O driver devolve `date` como Date: a resposta tem de sair AAAA-MM-DD.
        linha[m[1]] = m[1] === 'pedidos_ate' && params[0] ? new Date(params[0] + 'T00:00:00Z') : params[0];
        return { rows: [{ ...linha }] };
      }
      return { rows: [] };
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const updates = () => db.query.mock.calls
    .map(([s, p]) => [/UPDATE digital_channel_config SET (\w+) = \$1/.exec(String(s)), p])
    .filter(([m]) => m).map(([m, p]) => [m[1], p[0]]);

  test('grava cada campo que veio, e so eles', async () => {
    const r = await request(app).put('/companies/cid-1/digital-channel').send({
      pedidos_pausados: true, pedidos_ate: '2026-12-20', pedidos_recado: 'Voltamos em janeiro.',
      courier_pickup_enabled: true, ga4_measurement_id: 'g-8q3fq2n1km', meta_pixel_id: '',
    });
    expect(r.status).toBe(200);
    expect(updates()).toEqual([
      ['pedidos_pausados', true], ['courier_pickup_enabled', true], ['pedidos_ate', '2026-12-20'],
      ['pedidos_recado', 'Voltamos em janeiro.'], ['ga4_measurement_id', 'G-8Q3FQ2N1KM'], ['meta_pixel_id', null],
    ]);
    expect(r.body.config.pedidos_ate).toBe('2026-12-20');
    expect(r.body.config.ga4_measurement_id).toBe('G-8Q3FQ2N1KM');
  });

  test('salvar continua esquecendo a home guardada', async () => {
    await request(app).put('/companies/cid-1/digital-channel').send({ pedidos_pausados: true });
    expect(esquecerPagina).toHaveBeenCalledWith('sheid-mania');
  });

  test('campo ausente nao vira UPDATE (abrir/fechar so quando pedido)', async () => {
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'Sheid' });
    expect(updates().map(([c]) => c)).not.toEqual(expect.arrayContaining(['pedidos_pausados']));
  });

  test('ID mal formado: 400 em portugues e NADA gravado', async () => {
    const r = await request(app).put('/companies/cid-1/digital-channel')
      .send({ pedidos_pausados: true, meta_pixel_id: '741852' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/15 ou 16 números/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('base sem a migration 355: o recado e pulado e a loja fecha mesmo assim', async () => {
    semRecado = true;
    const r = await request(app).put('/companies/cid-1/digital-channel')
      .send({ pedidos_pausados: true, pedidos_recado: 'Voltamos em janeiro.' });
    expect(r.status).toBe(200);
    expect(r.body.config.pedidos_pausados).toBe(true);
    expect(esquecerPagina).toHaveBeenCalled();
  });
});
