// ============================================================
// Serviço de arte como padrão da loja (28/09/2026)
//
// Decisão do PO: os preços de "ajustar a arte da cliente" e de "criar do
// zero" viram padrão da loja (studio_settings.art_service_defaults), com
// exceção por produto. O produto que segue o padrão tem, no
// customization_config, `art_service_use_store_default: true`; ao salvar
// o padrão, o PATCH /studio/settings reescreve o price_delta das choices
// 'adjust' e 'designer' desses produtos. A vitrine continua lendo só o
// price_delta — este teste guarda que o resto do config não se mexe.
// ============================================================
jest.mock('../src/config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const {
  aplicarPadraoDoServicoDeArte, validarPadraoDoServicoDeArte,
} = require('../src/services/servicoDeArtePadrao');

const CAMPO_ARTE = {
  id: 'art_service', type: 'option', label: 'Arte',
  config: {
    is_art_service: true,
    choices: [
      { value: 'none', label: 'Já tenho a arte pronta', price_delta: 0 },
      { value: 'adjust', label: 'Envio minha arte e vocês ajustam', price_delta: 5 },
      { value: 'designer', label: 'Criem a arte pra mim', price_delta: 20 },
    ],
  },
};
const COR = {
  id: 'cor', type: 'option', label: 'Cor da alça',
  config: { choices: [{ value: 'rosa', label: 'Rosa', price_delta: 2.5 }] },
};
const NOME = { id: 'nome', type: 'text', label: 'Nome' };

const config = (extra = {}) => ({
  print_area: { width_cm: 20, height_cm: 9 },
  tecnica: 'sublimacao',
  fields: [NOME, CAMPO_ARTE, COR],
  art_service_use_store_default: true,
  ...extra,
});
const PADRAO = { adjust_price: 12.5, design_price: 35 };
const precos = (cfg) => Object.fromEntries(
  cfg.fields.find((f) => f.id === 'art_service').config.choices.map((c) => [c.value, c.price_delta])
);

describe('aplicarPadraoDoServicoDeArte', () => {
  test('com a flag e o campo: muda os dois preços e preserva o resto', () => {
    const antes = config();
    const copia = JSON.parse(JSON.stringify(antes));
    const novo = aplicarPadraoDoServicoDeArte(antes, PADRAO);
    expect(precos(novo)).toEqual({ none: 0, adjust: 12.5, designer: 35 });
    // resto do config intacto
    expect(novo.print_area).toEqual(antes.print_area);
    expect(novo.tecnica).toBe('sublimacao');
    expect(novo.art_service_use_store_default).toBe(true);
    expect(novo.fields[0]).toEqual(NOME);
    expect(novo.fields[2]).toEqual(COR);
    const arte = novo.fields[1];
    expect(arte.label).toBe('Arte');
    expect(arte.config.is_art_service).toBe(true);
    expect(arte.config.choices.map((c) => c.label)).toEqual(CAMPO_ARTE.config.choices.map((c) => c.label));
    // pura: não altera o que recebeu
    expect(antes).toEqual(copia);
  });

  test('none continua 0 mesmo que o padrão traga outros números', () => {
    const novo = aplicarPadraoDoServicoDeArte(config(), { adjust_price: 1, design_price: 2 });
    expect(precos(novo).none).toBe(0);
  });

  test('sem a flag (ausente ou false): não muda', () => {
    expect(aplicarPadraoDoServicoDeArte(config({ art_service_use_store_default: undefined }), PADRAO)).toBeNull();
    expect(aplicarPadraoDoServicoDeArte(config({ art_service_use_store_default: false }), PADRAO)).toBeNull();
    expect(aplicarPadraoDoServicoDeArte(config({ art_service_use_store_default: 'true' }), PADRAO)).toBeNull();
  });

  test('sem o campo art_service: não muda', () => {
    expect(aplicarPadraoDoServicoDeArte(config({ fields: [NOME, COR] }), PADRAO)).toBeNull();
    expect(aplicarPadraoDoServicoDeArte(null, PADRAO)).toBeNull();
  });

  test('campo achado só pelo id canônico também recebe o padrão', () => {
    const semMarca = { ...CAMPO_ARTE, config: { ...CAMPO_ARTE.config, is_art_service: undefined } };
    const novo = aplicarPadraoDoServicoDeArte(config({ fields: [semMarca] }), PADRAO);
    expect(precos(novo)).toEqual({ none: 0, adjust: 12.5, designer: 35 });
  });

  test('já com os mesmos preços: null (nada a gravar)', () => {
    const ja = aplicarPadraoDoServicoDeArte(config(), PADRAO);
    expect(aplicarPadraoDoServicoDeArte(ja, PADRAO)).toBeNull();
  });
});

describe('validarPadraoDoServicoDeArte', () => {
  test('números e strings numéricas passam, normalizados', () => {
    expect(validarPadraoDoServicoDeArte({ adjust_price: 10, design_price: 0 })).toEqual({
      ok: true, value: { adjust_price: 10, design_price: 0 },
    });
    expect(validarPadraoDoServicoDeArte({ adjust_price: '12.50', design_price: '30,9' }).value)
      .toEqual({ adjust_price: 12.5, design_price: 30.9 });
  });

  test('inválidos: não-objeto, negativo, NaN, faltando, mais de 2 casas', () => {
    for (const raw of [
      null, 'x', [1, 2], {},
      { adjust_price: -1, design_price: 10 },
      { adjust_price: 10, design_price: NaN },
      { adjust_price: 10 },
      { adjust_price: 10.555, design_price: 10 },
      { adjust_price: Infinity, design_price: 10 },
      { adjust_price: 'abc', design_price: 10 },
    ]) {
      const r = validarPadraoDoServicoDeArte(raw);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
    }
  });
});

describe('PATCH /studio/settings com art_service_defaults', () => {
  const studioRouter = require('../src/routes/studio');
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/companies/:id/studio', studioRouter);
    return a;
  };

  let client;
  beforeEach(() => {
    client = { query: jest.fn(), release: jest.fn() };
    db.connect.mockReset().mockResolvedValue(client);
  });

  test('propaga para quem segue o padrão, na mesma transação', async () => {
    const segue = config();
    const semCampo = config({ fields: [NOME] });
    client.query.mockImplementation(async (sql) => {
      if (/UPDATE companies/.test(sql)) return { rows: [{ settings: { art_service_defaults: PADRAO } }] };
      if (/SELECT id, customization_config/.test(sql)) {
        return { rows: [{ id: 'p1', customization_config: segue }, { id: 'p2', customization_config: semCampo }] };
      }
      return { rows: [] };
    });

    const res = await request(app())
      .patch('/companies/c1/studio/settings')
      .send({ art_service_defaults: { adjust_price: '12.50', design_price: 35 } });

    expect(res.status).toBe(200);
    expect(res.body.art_service_products_updated).toBe(1);
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    const upd = client.query.mock.calls.filter((c) => /UPDATE products/.test(c[0]));
    expect(upd).toHaveLength(1);
    expect(upd[0][1][1]).toBe('p1');
    expect(precos(JSON.parse(upd[0][1][0]))).toEqual({ none: 0, adjust: 12.5, designer: 35 });
    // o padrão foi gravado normalizado
    const comp = client.query.mock.calls.find((c) => /UPDATE companies/.test(c[0]));
    expect(JSON.parse(comp[1][0]).art_service_defaults).toEqual(PADRAO);
    expect(client.release).toHaveBeenCalled();
  });

  test('padrão inválido: 400 sem tocar no banco', async () => {
    const res = await request(app())
      .patch('/companies/c1/studio/settings')
      .send({ art_service_defaults: { adjust_price: -3, design_price: 10 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/adjust_price/);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('sem a chave no body: resposta não traz a contagem', async () => {
    client.query.mockImplementation(async (sql) => (
      /UPDATE companies/.test(sql) ? { rows: [{ settings: { pix_key: 'x' } }] } : { rows: [] }
    ));
    const res = await request(app()).patch('/companies/c1/studio/settings').send({ pix_key: 'x' });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('art_service_products_updated');
    expect(client.query.mock.calls.some((c) => /FROM products/.test(c[0]))).toBe(false);
  });
});
