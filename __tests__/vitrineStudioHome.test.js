// ============================================================
// Vitrine Studio · Fase 5 — a home nova (25/09/2026)
//
// A aba Design grava faixa de anuncio, selos e banners com botao e
// destino; a loja comum le tudo isso e a vitrine Studio jogava fora
// (JORNADA §4.2). O que estes testes guardam:
//   1. o payload publico entrega faixa, selos, os campos do banner e a
//      peca do destaque (hero_product_id, migration 356);
//   2. o conjunto de selos que o PAINEL grava sozinho conta como vazio —
//      as duas lojas Studio tinham exatamente ele no banco;
//   3. o PUT grava o destino do botao do banner (Anexo A, item 1) com a
//      mesma regra da vitrine;
//   4. o PUT grava a peca do destaque so se ela for da loja, e base sem a
//      migration 356 nao impede salvar o resto.
// ============================================================
'use strict';

jest.mock('../src/services/cacheDaPaginaDaLoja', () => ({
  esquecerPagina: jest.fn(), paginaLembrada: jest.fn(() => null), lembrarPagina: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { __montarSite: montarSite } = require('../src/routes/studioStorefront');
const { sanitizeBanners } = require('../src/routes/digitalChannel');
const { selosDaLojista, destinoDoCta, parseBanners } = require('../src/services/storefrontBuilder');
const { lerPecaDoDestaque } = require('../src/services/pecaDoDestaque');

const DE_FABRICA = [
  { body: 'Confirmação no WhatsApp', icon: 'truck', title: 'Entrega rápida', enabled: true },
  { body: 'Pronta pra presentear', icon: 'pkg', title: 'Embalagem cuidadosa', enabled: true },
  { body: 'Pix e demais opções', icon: 'shield', title: 'Pagamento seguro', enabled: true },
  { body: 'Produtos selecionados', icon: 'sparkle', title: 'Curadoria editada', enabled: true },
];

describe('o bloco site da vitrine Studio', () => {
  const base = { site_name: 'Sheid Mania', primary_color: '#1a1612', studio_settings: {} };

  test('faixa de anuncio: o texto da aba Design, aparado; vazio quando nao ha', () => {
    expect(montarSite({ ...base, announcement_bar: '  Frete gratis no Natal  ' }, 'X').announcement_bar).toBe('Frete gratis no Natal');
    expect(montarSite({ ...base, announcement_bar: null }, 'X').announcement_bar).toBe('');
    expect(montarSite(base, 'X').announcement_bar).toBe('');
  });

  test('selos: os escritos pela lojista, sanitizados; os de fabrica do painel viram vazio', () => {
    expect(montarSite({ ...base, service_cards: DE_FABRICA }, 'X').service_cards).toEqual([]);
    const escritos = [
      { icon: 'heart', title: 'Produção própria', body: 'Feito em São José dos Campos', enabled: true },
      { icon: 'javascript', title: 'A gente cria a arte', body: '', enabled: true },
      { icon: 'pkg', title: 'Desligado', body: 'x', enabled: false },
    ];
    expect(montarSite({ ...base, service_cards: escritos }, 'X').service_cards).toEqual([
      { icon: 'heart', title: 'Produção própria', body: 'Feito em São José dos Campos', enabled: true },
      { icon: 'sparkle', title: 'A gente cria a arte', body: '', enabled: true },
    ]);
    // Nunca os padroes da loja comum ("Troca em ate 7 dias").
    expect(montarSite({ ...base, service_cards: [] }, 'X').service_cards).toEqual([]);
  });

  test('um selo de fabrica misturado com um escrito: e dela, fica tudo', () => {
    const misturado = [DE_FABRICA[0], { icon: 'heart', title: 'Produção própria', body: 'x' }];
    expect(selosDaLojista(misturado)).toHaveLength(2);
    expect(selosDaLojista(JSON.stringify(DE_FABRICA))).toEqual([]);
  });

  test('banner: kicker, botao, destino interno, tom, tinta e arte do celular', () => {
    const site = montarSite({
      ...base,
      banners: [{
        kicker: 'Dia das Mães', headline: 'Canecas com a foto dela', body: 'Mande a foto',
        cta: 'Ver canecas', cta_url: '#cat=/canecas', tone: 'editorial', tint: 'accent',
        image_url: 'https://cdn/b0.jpg', image_url_mobile: 'https://cdn/b0m.jpg', enabled: true,
      }, { image_url: 'https://cdn/b1.jpg', cta_url: '#vista=lote' }],
    }, 'X');
    expect(site.banners[0]).toEqual({
      kicker: 'Dia das Mães', headline: 'Canecas com a foto dela', body: 'Mande a foto',
      cta: 'Ver canecas', cta_url: '#cat=/canecas', tone: 'editorial', tint: 'accent',
      image_url: 'https://cdn/b0.jpg', image_url_mobile: 'https://cdn/b0m.jpg', enabled: true,
    });
    expect(site.banners[1].cta_url).toBe('#vista=lote');
    expect(site.banners_automaticos).toBe(false);
  });

  test('sem banner da lojista: o fallback da capa continua, marcado como automatico', () => {
    const site = montarSite({ ...base, tagline: 'Presentes que ninguém mais tem', banners: [] }, 'X');
    expect(site.banners).toHaveLength(1);
    expect(site.banners_automaticos).toBe(true);
  });

  test('peca do destaque: o id gravado, ou null (base sem a coluna tambem)', () => {
    expect(montarSite({ ...base, hero_product_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, 'X').hero_product_id)
      .toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(montarSite(base, 'X').hero_product_id).toBeNull();
  });
});

describe('o destino do botao do banner', () => {
  test('#vista=lote e destino (orcamento em lote da loja Studio); os outros continuam', () => {
    expect(destinoDoCta('#vista=lote')).toBe('#vista=lote');
    expect(destinoDoCta('#vista=todos')).toBe('#vista=todos');
    expect(destinoDoCta('#vista=lotes')).toBe('');
    expect(destinoDoCta('javascript:alert(1)')).toBe('');
  });

  test('o PUT agora grava cta_url, com a regra da vitrine', () => {
    const [a, b, c] = sanitizeBanners([
      { headline: 'Natal', cta: 'Ver', cta_url: '#cat=/canecas' },
      { headline: 'Lote', cta: 'Pedir', cta_url: ' https://wa.me/5512999990001 ' },
      { headline: 'X', cta: 'Y', cta_url: 'javascript:alert(1)' },
    ]);
    const [d] = sanitizeBanners([{ headline: 'Z', cta_url: 'https://loja.com/' + 'a'.repeat(600) }]);
    expect(a.cta_url).toBe('#cat=/canecas');
    expect(b.cta_url).toBe('https://wa.me/5512999990001');
    expect(c.cta_url).toBe('');
    expect(d.cta_url).toBe('');
  });

  test('o que o PUT grava e o que a vitrine le', () => {
    const gravado = sanitizeBanners([{ image_url: 'https://cdn/b.jpg', cta_url: '#vista=novidades' }]);
    expect(parseBanners(gravado)[0].cta_url).toBe('#vista=novidades');
  });
});

describe('a peca do destaque no corpo do PUT', () => {
  test('ausente nao mexe; vazio e null sao automatico; uuid passa; o resto e erro', () => {
    expect(lerPecaDoDestaque({ site_name: 'x' })).toEqual({ definido: false });
    expect(lerPecaDoDestaque({ hero_product_id: null })).toEqual({ definido: true, valor: null });
    expect(lerPecaDoDestaque({ hero_product_id: '  ' })).toEqual({ definido: true, valor: null });
    expect(lerPecaDoDestaque({ hero_product_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }))
      .toEqual({ definido: true, valor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(lerPecaDoDestaque({ hero_product_id: '1; drop table' }).erro).toMatch(/produto da loja/);
    expect(lerPecaDoDestaque({ hero_product_id: 42 }).erro).toBeTruthy();
  });
});

describe('o PUT /companies/:id/digital-channel com a peca do destaque', () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { role: 'client' }; next(); });
  app.use('/companies/:id/digital-channel', require('../src/routes/digitalChannel'));

  const PECA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let semColuna;
  let pecaDaLoja;
  let linha;
  beforeEach(() => {
    semColuna = false;
    pecaDaLoja = true;
    linha = { company_id: 'cid-1', slug: 'sheid-mania' };
    db.query.mockReset();
    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (s.includes('information_schema')) return { rows: [] };
      if (s.includes('SELECT id FROM products')) return { rows: pecaDaLoja ? [{ id: params[0] }] : [] };
      if (s.includes('INSERT INTO digital_channel_config')) return { rows: [{ ...linha }] };
      const m = /UPDATE digital_channel_config SET (\w+) = \$1/.exec(s);
      if (m) {
        if (m[1] === 'hero_product_id' && semColuna) {
          throw Object.assign(new Error('column "hero_product_id" does not exist'), { code: '42703' });
        }
        linha[m[1]] = params[0];
        return { rows: [{ ...linha }] };
      }
      return { rows: [] };
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const consultas = () => db.query.mock.calls.map(([s]) => String(s));

  test('peca da loja: confere com a visibilidade da vitrine e grava', async () => {
    const r = await request(app).put('/companies/cid-1/digital-channel').send({ hero_product_id: PECA });
    expect(r.status).toBe(200);
    const q = db.query.mock.calls.find(([s]) => String(s).includes('SELECT id FROM products'));
    expect(q[1]).toEqual([PECA, 'cid-1']);
    expect(String(q[0])).toContain('is_group_shared = true');
    expect(r.body.config.hero_product_id).toBe(PECA);
  });

  test('peca de outra loja: 400 e nada gravado', async () => {
    pecaDaLoja = false;
    const r = await request(app).put('/companies/cid-1/digital-channel').send({ hero_product_id: PECA, site_name: 'X' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Essa peça não está na loja.');
    expect(consultas().some((s) => s.includes('INSERT INTO digital_channel_config'))).toBe(false);
  });

  test('vazio volta ao automatico sem consultar produto', async () => {
    const r = await request(app).put('/companies/cid-1/digital-channel').send({ hero_product_id: '' });
    expect(r.status).toBe(200);
    expect(consultas().some((s) => s.includes('SELECT id FROM products'))).toBe(false);
    expect(r.body.config.hero_product_id).toBeNull();
  });

  test('sem o campo, a coluna nao e tocada', async () => {
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'Sheid' });
    expect(consultas().some((s) => s.includes('hero_product_id'))).toBe(false);
  });

  test('base sem a migration 356: o resto salva mesmo assim', async () => {
    semColuna = true;
    const r = await request(app).put('/companies/cid-1/digital-channel').send({ hero_product_id: PECA, pedidos_pausados: true });
    expect(r.status).toBe(200);
    expect(r.body.config.pedidos_pausados).toBe(true);
  });
});

describe('a migration 356', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '356_hero_product_id.sql'), 'utf8');
  test('idempotente e nullable, voltando ao automatico se a peca sumir', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS hero_product_id uuid NULL');
    expect(sql).toContain('ON DELETE SET NULL');
    expect(sql).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
  });

  test('os selos de fabrica do painel sao os que a vitrine ignora', () => {
    const rota = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'digitalChannel.js'), 'utf8');
    const bloco = rota.slice(rota.indexOf('const DEFAULT_SERVICE_CARDS'), rota.indexOf('];', rota.indexOf('const DEFAULT_SERVICE_CARDS')));
    const pares = [...bloco.matchAll(/title: '([^']+)',\s*body: '([^']+)'/g)].map((m) => ({ title: m[1], body: m[2] }));
    expect(pares.length).toBe(4);
    expect(selosDaLojista(pares)).toEqual([]);
  });
});
