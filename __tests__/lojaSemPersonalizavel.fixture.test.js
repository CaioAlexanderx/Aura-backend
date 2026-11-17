// ============================================================
// Loja SEM produto personalizavel: byte a byte igual (p-179, loja unica
// 3.2a, 17/11/2026)
//
// A loja comum vai aprender o produto personalizavel (selo, preco "a
// partir de", personalizador num quadro). Regra do Caio: a loja de quem
// NAO tem personalizavel nao muda um byte. Este teste congela, pela rota
// de verdade (storefront.js -> buildStorefront -> buildStorefrontPage),
// tres lojas sem personalizavel:
//   - loja_simples              pecas sem variacao, barra plana, so Pix
//   - loja_categorias_promocao  arvore + tira, promocao no ar, Black
//                               Friday, cartao e entrega
//   - loja_variacao             tamanho e cor, facetas, ultimas unidades,
//                               pagar na entrega
// Para cada uma: a home (HTML), o payload JSON que o app le e, na loja
// com variacao, a pagina da peca (/p/:id).
//
// Os hashes foram gravados na main de 17/11/2026 (2867613e), antes de
// qualquer mudanca. Se um deles quebrar, a loja de alguem mudou: NAO
// regrave sem entender o porque. Para regravar (so com motivo escrito no
// PR): GRAVAR_FIXTURE=1 npx jest __tests__/lojaSemPersonalizavel.fixture.test.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const { esquecerPagina } = require('../src/services/cacheDaPaginaDaLoja');
const storefront = require('../src/routes/storefront');
const { AGORA, cenarios } = require('./fixtures/lojaSemPersonalizavel/dados');

const ARQUIVO_DOS_HASHES = path.join(__dirname, 'fixtures', 'lojaSemPersonalizavel', 'hashes.json');
const GRAVAR = process.env.GRAVAR_FIXTURE === '1';
const hashes = GRAVAR ? {} : require('./fixtures/lojaSemPersonalizavel/hashes.json');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const marca = (s) => ({ bytes: Buffer.byteLength(s), sha256: sha(s) });

/**
 * Responde cada consulta da loja comum pelo que a identifica: o apelido
 * das colunas devolvidas (o contrato com o codigo que le a linha) ou a
 * tabela do FROM principal (o trecho antes do primeiro WHERE). Nunca pelo
 * WHERE: os fragmentos de la (EM_ESTOQUE, NA_VITRINE, visibilidade) citam
 * outras tabelas e sao justamente o que a loja unica muda sem mudar o
 * resultado de quem nao tem personalizavel.
 */
let naoRespondidas = [];
function bancoDa(loja) {
  return async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    const cabeca = s.split(' WHERE ')[0];
    const ids = Array.isArray(params[0]) ? params[0] : [];

    if (s.startsWith('WITH todos AS')) return { rows: loja.resumo ? [loja.resumo] : [] };
    if (s.startsWith('WITH visiveis AS')) return { rows: loja.arvore };
    if (s.startsWith('WITH pecas AS')) return { rows: loja.capas };
    if (s.includes(' AS restam')) return { rows: loja.ultimas };
    if (s.includes(' AS vendidos')) return { rows: loja.mais_vendidos };
    if (s.includes(' AS atributo')) return { rows: loja.facetas };
    if (s.includes('category AS nome')) return { rows: loja.barra };
    if (s.includes('::float AS min')) return { rows: [loja.faixa] };
    if (s.includes('COUNT(*)::int AS n')) return { rows: [{ n: loja.total }] };
    if (/FROM product_variants pv /.test(s)) return { rows: loja.variantes.filter((v) => ids.includes(v.product_id)) };

    if (cabeca.includes('company_pdv_settings') || cabeca === 'SELECT * FROM digital_channel_config') {
      return { rows: params[0] === loja.config.slug ? [loja.config] : [] };
    }
    if (cabeca.includes('FROM companies_payment_gateways')) return { rows: loja.gateway };
    if (cabeca.startsWith('SELECT trade_name')) return { rows: [loja.empresa] };
    if (cabeca.includes('FROM product_category_links')) return { rows: loja.vinculos.filter((l) => ids.includes(l.product_id)) };
    if (cabeca.includes('FROM product_categories')) return { rows: loja.categorias };
    if (cabeca.includes('FROM product_images')) return { rows: [] };
    if (cabeca.includes('FROM products')) {
      if (cabeca.includes('stock_min')) return { rows: loja.novidades };
      if (s.includes('AND id = $2')) return { rows: loja.produtos.filter((p) => p.id === params[1]) };
      return { rows: loja.produtos };
    }
    naoRespondidas.push(s.slice(0, 160));
    throw new Error('consulta sem resposta no teste: ' + s.slice(0, 160));
  };
}

const app = express();
app.use('/api/v1/storefront', storefront);

beforeAll(() => {
  // So o relogio: o supertest precisa dos timers de verdade.
  jest.useFakeTimers({
    now: new Date(AGORA),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});
afterAll(() => {
  jest.useRealTimers();
  if (GRAVAR) fs.writeFileSync(ARQUIVO_DOS_HASHES, JSON.stringify(hashes, null, 2) + '\n');
});
beforeEach(() => {
  naoRespondidas = [];
  esquecerPagina();
  db.query.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  // Consulta que o mock nao conhece cairia num catch do builder e a loja
  // sairia sem aquele bloco, em silencio: o hash congelaria uma loja oca.
  expect(naoRespondidas).toEqual([]);
});

function conferir(nome, corpo) {
  if (GRAVAR) { hashes[nome] = marca(corpo); return; }
  expect({ nome, ...marca(corpo) }).toEqual({ nome, ...hashes[nome] });
}

describe.each(Object.keys(cenarios))('%s', (cenario) => {
  const loja = cenarios[cenario]();
  const slug = loja.config.slug;

  test('a home sai byte a byte igual', async () => {
    db.query.mockImplementation(bancoDa(loja));
    const r = await request(app).get(`/api/v1/storefront/${slug}/page`);
    expect(r.status).toBe(200);
    expect(r.headers['x-aura-cache']).toBe('miss');
    conferir(`${cenario}.home`, r.text);
  });

  test('a home lembrada (60 s) e a mesma pagina', async () => {
    db.query.mockImplementation(bancoDa(loja));
    const primeira = await request(app).get(`/api/v1/storefront/${slug}/page`);
    const segunda = await request(app).get(`/api/v1/storefront/${slug}/page`);
    expect(segunda.headers['x-aura-cache']).toBe('hit');
    expect(segunda.text).toBe(primeira.text);
    expect(segunda.headers['content-security-policy']).toBe(primeira.headers['content-security-policy']);
  });

  test('o payload JSON sai byte a byte igual', async () => {
    db.query.mockImplementation(bancoDa(loja));
    const r = await request(app).get(`/api/v1/storefront/${slug}`);
    expect(r.status).toBe(200);
    conferir(`${cenario}.payload`, r.text);
  });
});

test('a pagina de uma peca com variacao sai byte a byte igual', async () => {
  const loja = cenarios.loja_variacao();
  db.query.mockImplementation(bancoDa(loja));
  const r = await request(app).get(`/api/v1/storefront/${loja.config.slug}/p/${loja.produtos[0].id}`);
  expect(r.status).toBe(200);
  expect(r.text).toContain('"produto_inicial":{"id":"' + loja.produtos[0].id + '"');
  conferir('loja_variacao.peca', r.text);
});

test('as tres lojas tem o que o cenario promete', async () => {
  // Guarda contra fixture oca: se o mock deixar de responder uma consulta,
  // a pagina sai vazia e o hash congelaria uma loja que nao existe.
  const pagina = async (nome) => {
    const loja = cenarios[nome]();
    db.query.mockImplementation(bancoDa(loja));
    esquecerPagina();
    return (await request(app).get(`/api/v1/storefront/${loja.config.slug}`)).body;
  };
  const simples = await pagina('loja_simples');
  expect(simples.products).toHaveLength(3);
  expect(simples.categorias_barra).toHaveLength(2);
  expect(simples.tem_promocao).toBeUndefined();

  const promo = await pagina('loja_categorias_promocao');
  expect(promo.tem_promocao).toBe(true);
  expect(promo.campanha).toEqual(expect.objectContaining({ ativa: true, ate_pct: 30 }));
  expect(promo.tira_de_categorias.length).toBeGreaterThanOrEqual(3);
  expect(promo.home.mais_vendidos.length).toBeGreaterThan(0);
  expect(promo.products.find((p) => p.em_promocao)).toBeTruthy();
  expect(promo.settings.has_card).toBe(true);

  const variacao = await pagina('loja_variacao');
  expect(variacao.products[0].variants.length).toBe(3);
  expect(variacao.facetas.tamanho).toBeTruthy();
  expect(variacao.facetas.cor).toBeTruthy();
  expect(variacao.home.ultimas_unidades.length).toBeGreaterThan(0);
});
