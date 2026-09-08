// ============================================================
// AURA. — Testes: galeria de fotos por cor (migration 323)
//
// O que estes testes travam, no nivel da ROTA (a regra pura vive em
// __tests__/galeriaPorCor.test.js):
//
//   1. A quinta foto de uma cor leva 400 com a mensagem em portugues, e a
//      da galeria principal leva a OUTRA mensagem.
//   2. A foto na posicao 0 espelha a coluna legada: products.image_url
//      quando e a principal, product_variants.image_url quando e de uma
//      cor. Toda a vitrine, o PDV e o marketplace leem essas colunas e
//      nenhum deles foi tocado — se o espelho quebra, some foto em lugar
//      que ninguem esta olhando agora.
//   3. Apagar a capa PROMOVE a seguinte; apagar a ultima LIMPA a coluna
//      legada. Peca sem capa com fotos no banco e o pior dos dois mundos.
//   4. Produto de outra empresa da 404, nao 200 com galeria alheia.
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../src/utils/fotosDeProduto', () => ({
  salvarFotoEmDoisTamanhos: jest.fn(async () => ({
    success: true,
    image_url: 'https://cdn.aura/nova.jpg?v=1',
    image_thumb_url: 'https://cdn.aura/nova.thumb.jpg?v=1',
    key: 'k',
  })),
  apagarFoto: jest.fn(async () => {}),
  chaveBaseDe: (s) => s,
}));

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const productImagesRouter = require('../../src/routes/productImages');

let db;
let fotosUtil;
beforeAll(() => {
  db = require('../../src/config/database');
  fotosUtil = require('../../src/utils/fotosDeProduto');
});
beforeEach(() => {
  jest.resetAllMocks();
  // resetAllMocks apaga a implementacao do mock do modulo — sem isto o
  // upload devolve undefined e todo POST vira 500.
  fotosUtil.salvarFotoEmDoisTamanhos.mockResolvedValue({
    success: true,
    image_url: 'https://cdn.aura/nova.jpg?v=1',
    image_thumb_url: 'https://cdn.aura/nova.thumb.jpg?v=1',
    key: 'k',
  });
  fotosUtil.apagarFoto.mockResolvedValue(undefined);
});

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const pid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/products', productImagesRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

/** n fotos ja gravadas no par (produto, cor). */
function fotos(n, cor = null) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${i}`, color_hex: cor, url: `https://cdn.aura/${i}.jpg`,
    thumb_url: `https://cdn.aura/${i}.thumb.jpg`, position: i,
  }));
}

/**
 * @param {object} o
 * @param {boolean} o.visivel   o produto pertence (ou e shared pra) esta empresa
 * @param {Array}   o.doPar     as fotos ja gravadas no par consultado
 * @param {Array}   o.todas     as fotos do produto inteiro (GET)
 * @param {Array}   o.alvo      a linha do DELETE (id + color_hex)
 */
function mockDb({ visivel = true, doPar = [], todas = null, alvo = null } = {}) {
  let leiturasDoPar = 0;
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/SELECT id, company_id FROM products/i.test(s)) {
      return Promise.resolve({ rows: visivel ? [{ id: pid, company_id: cid }] : [] });
    }
    if (/SELECT id, color_hex FROM product_images/i.test(s)) {
      return Promise.resolve({ rows: alvo ? [alvo] : [] });
    }
    // O GET do produto inteiro ordena por cor; a leitura de UM par nao.
    if (/FROM product_images/i.test(s) && /ORDER BY color_hex/i.test(s)) {
      return Promise.resolve({ rows: todas || doPar });
    }
    if (/FROM product_images/i.test(s) && /ORDER BY position/i.test(s)) {
      leiturasDoPar++;
      return Promise.resolve({ rows: doPar });
    }
    if (/INSERT INTO product_images/i.test(s)) {
      return Promise.resolve({
        rows: [{
          id: 'nova', color_hex: params[3], url: params[4],
          thumb_url: params[5], position: params[6], created_at: '2026-09-08T12:00:00Z',
        }],
      });
    }
    if (/FROM product_variants pv/i.test(s)) {
      return Promise.resolve({
        rows: [
          { id: 'v1', attributes: [{ attribute: 'Cor', value: '#1F2937' }] },
          { id: 'v2', attributes: [{ attribute: 'Cor', value: '#FF0000' }] },
        ],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  return { leiturasDoPar: () => leiturasDoPar };
}

const chamadas = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

const postFoto = (body) => request(app)
  .post(`/api/v1/companies/${cid}/products/${pid}/images`).set(auth).send(body);

const CONTEUDO = { content: 'YmFzZTY0', content_type: 'image/jpeg' };

describe('POST /images — o limite de 4', () => {
  test('a quinta foto de uma cor leva 400 em portugues', async () => {
    mockDb({ doPar: fotos(4, '#1f2937') });
    const r = await postFoto({ ...CONTEUDO, color_hex: '#1f2937' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Máximo de 4 fotos por cor');
    // E nao subiu nada pro R2: o limite e checado ANTES do upload.
    const { salvarFotoEmDoisTamanhos } = require('../../src/utils/fotosDeProduto');
    expect(salvarFotoEmDoisTamanhos).not.toHaveBeenCalled();
  });

  test('a quinta foto principal leva a OUTRA mensagem', async () => {
    mockDb({ doPar: fotos(4) });
    const r = await postFoto(CONTEUDO);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Máximo de 4 fotos principais');
  });

  // Duas por cor e a sugestao da tela; virar regra aqui recusaria quem
  // fotografou quatro angulos do mesmo tenis.
  test('a terceira foto de uma cor passa — a sugestao da UI nao e regra', async () => {
    mockDb({ doPar: fotos(2, '#1f2937') });
    const r = await postFoto({ ...CONTEUDO, color_hex: '#1f2937' });
    expect(r.status).toBe(201);
    expect(r.body.position).toBe(2);
  });

  test('cor invalida e recusada com o formato na mensagem', async () => {
    mockDb({});
    const r = await postFoto({ ...CONTEUDO, color_hex: 'vermelho' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/#rrggbb/);
  });

  test('sem content nao ha o que gravar', async () => {
    mockDb({});
    const r = await postFoto({ content_type: 'image/jpeg' });
    expect(r.status).toBe(400);
  });
});

describe('POST /images — compatibilidade com as colunas legadas', () => {
  test('a primeira foto principal vira products.image_url', async () => {
    mockDb({ doPar: [] });
    const r = await postFoto(CONTEUDO);
    expect(r.status).toBe(201);
    const espelho = chamadas(/UPDATE products SET image_url/i);
    expect(espelho).toHaveLength(1);
    expect(espelho[0][1][0]).toBe('https://cdn.aura/nova.jpg?v=1');
    expect(espelho[0][1][1]).toBe('https://cdn.aura/nova.thumb.jpg?v=1');
  });

  test('a segunda foto principal NAO mexe na capa', async () => {
    mockDb({ doPar: fotos(1) });
    const r = await postFoto(CONTEUDO);
    expect(r.status).toBe(201);
    expect(chamadas(/UPDATE products SET image_url/i)).toHaveLength(0);
  });

  // O mesmo que POST /color-image faz hoje: a foto vai pra TODAS as
  // variantes ativas daquela cor, independente do tamanho.
  test('a primeira foto de uma cor vai pras variantes daquela cor', async () => {
    mockDb({ doPar: [] });
    const r = await postFoto({ ...CONTEUDO, color_hex: '#1F2937' });
    expect(r.status).toBe(201);
    // Normalizada minuscula na gravacao.
    expect(r.body.color_hex).toBe('#1f2937');
    const espelho = chamadas(/UPDATE product_variants SET image_url/i);
    expect(espelho).toHaveLength(1);
    expect(espelho[0][1][2]).toEqual(['v1']);   // so a variante da cor
  });

  test('produto invisivel pra esta empresa da 404', async () => {
    mockDb({ visivel: false });
    const r = await postFoto(CONTEUDO);
    expect(r.status).toBe(404);
  });
});

describe('DELETE /images/:imageId', () => {
  test('apagar a capa promove a seguinte na coluna legada', async () => {
    mockDb({ doPar: fotos(3), alvo: { id: 'f0', color_hex: null } });
    const r = await request(app)
      .delete(`/api/v1/companies/${cid}/products/${pid}/images/f0`).set(auth);
    expect(r.status).toBe(200);
    const espelho = chamadas(/UPDATE products SET image_url/i);
    expect(espelho[0][1][0]).toBe('https://cdn.aura/1.jpg');
  });

  test('apagar a ultima limpa a coluna legada — sem foto fantasma na vitrine', async () => {
    mockDb({ doPar: fotos(1), alvo: { id: 'f0', color_hex: null } });
    const r = await request(app)
      .delete(`/api/v1/companies/${cid}/products/${pid}/images/f0`).set(auth);
    expect(r.status).toBe(200);
    expect(chamadas(/UPDATE products SET image_url/i)[0][1][0]).toBeNull();
  });

  test('as posicoes sao reempacotadas sem buraco', async () => {
    mockDb({ doPar: fotos(4), alvo: { id: 'f1', color_hex: null } });
    await request(app)
      .delete(`/api/v1/companies/${cid}/products/${pid}/images/f1`).set(auth);
    const repack = chamadas(/UPDATE product_images SET position = \$1/i)
      .map((c) => [c[1][1], c[1][0]]);
    expect(repack).toEqual([['f2', 1], ['f3', 2]]);
  });

  test('apagar a capa de uma cor reaplica a proxima nas variantes', async () => {
    mockDb({ doPar: fotos(2, '#1f2937'), alvo: { id: 'f0', color_hex: '#1F2937' } });
    const r = await request(app)
      .delete(`/api/v1/companies/${cid}/products/${pid}/images/f0`).set(auth);
    expect(r.status).toBe(200);
    const espelho = chamadas(/UPDATE product_variants SET image_url/i);
    expect(espelho[0][1][0]).toBe('https://cdn.aura/1.jpg');
    expect(espelho[0][1][2]).toEqual(['v1']);
  });

  test('foto de outro produto da 404', async () => {
    mockDb({ alvo: null });
    const r = await request(app)
      .delete(`/api/v1/companies/${cid}/products/${pid}/images/xyz`).set(auth);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /images/reorder', () => {
  test('lista incompleta e recusada — capa nao se decide por sorteio', async () => {
    mockDb({ doPar: fotos(3) });
    const r = await request(app)
      .patch(`/api/v1/companies/${cid}/products/${pid}/images/reorder`)
      .set(auth).send({ color_hex: null, ids: ['f1', 'f0'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/todas as fotos/);
  });

  test('id que nao e daquele par e recusado', async () => {
    mockDb({ doPar: fotos(2, '#1f2937') });
    const r = await request(app)
      .patch(`/api/v1/companies/${cid}/products/${pid}/images/reorder`)
      .set(auth).send({ color_hex: '#1f2937', ids: ['f0', 'de-outra-cor'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/nao pertence/);
  });

  test('a ordem pedida vira UPDATE e a capa e re-espelhada', async () => {
    mockDb({ doPar: fotos(3) });
    const r = await request(app)
      .patch(`/api/v1/companies/${cid}/products/${pid}/images/reorder`)
      .set(auth).send({ color_hex: null, ids: ['f2', 'f0', 'f1'] });
    expect(r.status).toBe(200);
    const upd = chamadas(/UPDATE product_images SET position = CASE/i);
    expect(upd).toHaveLength(1);
    expect(upd[0][1].slice(1, 7)).toEqual(['f2', 0, 'f0', 1, 'f1', 2]);
    expect(chamadas(/UPDATE products SET image_url/i)).toHaveLength(1);
  });
});

describe('GET /images', () => {
  test('devolve main e by_color separados', async () => {
    mockDb({
      todas: [
        ...fotos(2),
        { id: 'c1', color_hex: '#1f2937', url: 'u1', thumb_url: null, position: 0 },
      ],
    });
    const r = await request(app)
      .get(`/api/v1/companies/${cid}/products/${pid}/images`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.main.map((f) => f.id)).toEqual(['f0', 'f1']);
    expect(r.body.by_color['#1f2937']).toHaveLength(1);
    expect(r.body.max_por_cor).toBe(4);
  });

  // Base atras da migration abre a tela vazia em vez de dar 500
  // (CLAUDE.md, armadilha 1).
  test('sem a tabela ainda, devolve galeria vazia', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id, company_id FROM products/i.test(String(sql))) {
        return Promise.resolve({ rows: [{ id: pid, company_id: cid }] });
      }
      const e = new Error('relation "product_images" does not exist');
      e.code = '42P01';
      return Promise.reject(e);
    });
    const r = await request(app)
      .get(`/api/v1/companies/${cid}/products/${pid}/images`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ main: [], by_color: {} });
  });
});
