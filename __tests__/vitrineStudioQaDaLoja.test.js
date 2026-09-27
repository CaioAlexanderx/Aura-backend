// ============================================================
// QA da vitrine Studio no Chrome (26/09/2026) — o que o backend corrige
//
//  1. P0 · o slug nao muda mais a cada salvamento do painel
//  2. P1 · campo de texto apagado no painel fica apagado
//  3. P0 · o endereco de retirada chega na vitrine, na confirmacao e no
//     acompanhamento
//  4. P1 · o GET do painel diz se os banners sao os automaticos
//  5. P1 · a tipografia "Marcante" (editorial) e aceita
//  6. P1 · "Nao achamos essa loja" com titulo, estilo e saida
//  7. Pix pendente antigo: o cancelamento nao tem janela de idade
//  8. o preco no Pix com a regra combinada com o app
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

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function appDoPainel() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { role: 'client' }; next(); });
  app.use('/companies/:id/digital-channel', require('../src/routes/digitalChannel'));
  return app;
}

// Banco falso do PUT: sem as colunas v2/Fase 5 (information_schema vazio),
// entao o UPSERT e o de fallback, com o slug no parametro $23.
function bancoDoPut({ slugAtual, linhaExiste = true, slugDeOutra = null } = {}) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    if (s.includes('information_schema')) return { rows: [] };
    if (/SELECT slug FROM digital_channel_config WHERE company_id = \$1/.test(s)) {
      return { rows: linhaExiste ? [{ slug: slugAtual }] : [] };
    }
    if (/SELECT slug FROM digital_channel_config WHERE slug = \$1 AND company_id != \$2/.test(s)) {
      return { rows: slugDeOutra && params[0] === slugDeOutra ? [{ slug: slugDeOutra }] : [] };
    }
    if (s.includes('INSERT INTO digital_channel_config')) {
      return { rows: [{ company_id: 'cid-1', slug: params[22] || slugAtual || null }] };
    }
    if (s.includes('UPDATE digital_channel_config')) return { rows: [{ company_id: 'cid-1', slug: slugAtual }] };
    return { rows: [] };
  });
}

const upsert = () => db.query.mock.calls.find(([s]) => String(s).includes('INSERT INTO digital_channel_config'));

describe('1 · o slug da loja nao muda por causa do nome', () => {
  const app = appDoPainel();
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('loja com slug: salvar o nome nao manda slug novo (aura-qa continua aura-qa)', async () => {
    bancoDoPut({ slugAtual: 'aura-qa' });
    const r = await request(app).put('/companies/cid-1/digital-channel')
      .send({ site_name: 'Aura QA Espelho da Sheid', tagline: 'Oi' });
    expect(r.status).toBe(200);
    // null no $23 = COALESCE mantem o slug gravado.
    expect(upsert()[1][22]).toBeNull();
    expect(r.body.config.slug).toBe('aura-qa');
  });

  test('loja nova (sem linha): o nome gera o slug', async () => {
    bancoDoPut({ linhaExiste: false });
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'Sheid Mania' });
    expect(upsert()[1][22]).toBe('sheid-mania');
  });

  test('linha com slug vazio ou nulo: o nome gera o slug', async () => {
    bancoDoPut({ slugAtual: '' });
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'Sheid Mania' });
    expect(upsert()[1][22]).toBe('sheid-mania');
    bancoDoPut({ slugAtual: null });
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'Sheid Mania' });
    expect(upsert()[1][22]).toBe('sheid-mania');
  });

  test('slug gerado que ja e de outra empresa ganha sufixo', async () => {
    bancoDoPut({ linhaExiste: false, slugDeOutra: 'sheid-mania' });
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'Sheid Mania' });
    expect(upsert()[1][22]).toMatch(/^sheid-mania-[a-z0-9]{1,4}$/);
  });

  test('slug pedido explicitamente continua valendo', async () => {
    bancoDoPut({ slugAtual: 'aura-qa' });
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'X', slug: 'aura-qa-2' });
    expect(upsert()[1][22]).toBe('aura-qa-2');
  });

  test('slug pedido que e de outra empresa: 409 e nada gravado', async () => {
    bancoDoPut({ slugAtual: 'aura-qa', slugDeOutra: 'sheid-mania' });
    const r = await request(app).put('/companies/cid-1/digital-channel').send({ slug: 'sheid-mania' });
    expect(r.status).toBe(409);
    expect(upsert()).toBeUndefined();
  });
});

describe('2 · apagar um campo de texto apaga', () => {
  const app = appDoPainel();
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  const limpeza = () => db.query.mock.calls
    .map(([s]) => String(s))
    .find((s) => /UPDATE digital_channel_config\s+SET [a-z_]+ = NULL/.test(s));

  test('null e vazio viram NULL; valor preenchido e chave ausente nao entram', async () => {
    bancoDoPut({ slugAtual: 'aura-qa' });
    const r = await request(app).put('/companies/cid-1/digital-channel').send({
      site_name: 'Aura QA', tagline: null, description: '', address: '   ',
      phone: '(11) 99999-0000', pix_holder_name: null, pix_holder_city: null,
    });
    expect(r.status).toBe(200);
    const sql = limpeza();
    expect(sql).toBeDefined();
    const colunas = [...sql.matchAll(/([a-z_]+) = NULL/g)].map((m) => m[1]);
    expect(colunas.sort()).toEqual(['address', 'description', 'pix_holder_city', 'pix_holder_name', 'tagline']);
    // O UPDATE e da empresa do PUT.
    const chamada = db.query.mock.calls.find(([s]) => String(s) === sql);
    expect(chamada[1]).toEqual(['cid-1']);
  });

  test('sem campo apagado, nao ha UPDATE de limpeza', async () => {
    bancoDoPut({ slugAtual: 'aura-qa' });
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'Aura QA', tagline: 'Oi' });
    expect(limpeza()).toBeUndefined();
  });

  test('nome, slug e publicacao nunca se apagam por este caminho', async () => {
    bancoDoPut({ slugAtual: 'aura-qa' });
    await request(app).put('/companies/cid-1/digital-channel')
      .send({ site_name: null, slug: '', is_published: null, whatsapp: null });
    const colunas = [...limpeza().matchAll(/([a-z_]+) = NULL/g)].map((m) => m[1]);
    expect(colunas).toEqual(['whatsapp']);
    // slug vazio nao gera nem apaga: $23 fica null (mantem o gravado).
    expect(upsert()[1][22]).toBeNull();
  });

  test('instagram apagado continua limpo pelo UPDATE das redes', async () => {
    bancoDoPut({ slugAtual: 'aura-qa' });
    await request(app).put('/companies/cid-1/digital-channel').send({ instagram: null });
    const redes = db.query.mock.calls.find(([s]) => /SET instagram = \$1/.test(String(s)));
    expect(redes[1]).toEqual([null, 'cid-1']);
  });
});

describe('3 · o endereco de retirada', () => {
  test('a vitrine Studio recebe pickup_address no bloco delivery, com os prazos', () => {
    const studio = fonte('src/routes/studioStorefront.js');
    const bloco = studio.slice(studio.indexOf('      delivery: {'), studio.indexOf('      total_products: products.length,'));
    expect(bloco).toContain('pickup_address:         config.pickup_address    || null,');
    expect(bloco).toContain('pickup_eta_text:        config.pickup_eta_text   || null,');
    expect(bloco).toContain('delivery_eta_text:      config.delivery_eta_text || null,');
  });

  test('o mesmo formato da loja comum', () => {
    expect(fonte('src/services/storefrontBuilder.js')).toContain('pickup_address: config.pickup_address || null,');
  });

  test('a confirmacao do pedido mostra o endereco de retirada, e o do negocio so sem ele', () => {
    const { montarConfirmacao } = require('../src/services/confirmacaoDoPedido');
    const pedido = { status: 'pending_payment', delivery_type: 'pickup', created_at: new Date().toISOString() };
    const loja = { address: 'Rua do Negócio, 10', pickup_address: 'Av. da Retirada, 553' };
    expect(montarConfirmacao({ pedido, itens: [], loja }).entrega.retirada_endereco).toBe('Av. da Retirada, 553');
    expect(montarConfirmacao({ pedido, itens: [], loja: { address: 'Rua do Negócio, 10' } }).entrega.retirada_endereco)
      .toBe('Rua do Negócio, 10');
    expect(montarConfirmacao({ pedido: { ...pedido, delivery_type: 'delivery' }, itens: [], loja }).entrega.retirada_endereco)
      .toBeNull();
  });
});

describe('3b · o acompanhamento le o endereco de retirada da marca', () => {
  const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';

  test('a consulta traz pickup_address', async () => {
    const { vitrineDaEmpresa } = require('../src/services/marcaDaLoja');
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [{ slug: 'aura-qa', address: 'Negócio', pickup_address: 'Retirada' }] });
    const v = await vitrineDaEmpresa(CID);
    expect(String(db.query.mock.calls[0][0])).toContain('dcc.pickup_address');
    expect(v.pickup_address).toBe('Retirada');
  });

  test('base sem a coluna (42703): cai para a consulta sem ela e a marca continua', async () => {
    await jest.isolateModulesAsync(async () => {
      const dbi = require('../src/config/database');
      const { vitrineDaEmpresa } = require('../src/services/marcaDaLoja');
      dbi.query.mockReset();
      dbi.query.mockImplementation(async (sql) => {
        if (String(sql).includes('pickup_address')) {
          throw Object.assign(new Error('column dcc.pickup_address does not exist'), { code: '42703' });
        }
        return { rows: [{ slug: 'aura-qa', address: 'Negócio' }] };
      });
      const v = await vitrineDaEmpresa(CID);
      expect(v).toEqual({ slug: 'aura-qa', address: 'Negócio' });
      // Da segunda vez em diante, direto sem a coluna.
      await vitrineDaEmpresa(CID);
      expect(dbi.query).toHaveBeenCalledTimes(3);
      expect(String(dbi.query.mock.calls[2][0])).not.toContain('pickup_address');
    });
  });

  test('o acompanhamento usa pickup_address, com o endereco do negocio como reserva', () => {
    expect(fonte('src/routes/studioTrackPublic.js'))
      .toContain('String(vitrine.pickup_address || vitrine.address)');
  });
});

describe('4 · banners_automaticos no GET do painel', () => {
  const app = appDoPainel();
  const { bannersAutomaticos } = require('../src/services/storefrontBuilder');
  const BANNER = { kicker: '', headline: 'Coleção de verão', body: '', cta: '', image_url: 'https://r2/b.jpg', enabled: true };

  function bancoDoGet(linha) {
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('SELECT * FROM digital_channel_config')) return { rows: linha ? [linha] : [] };
      if (s.includes('FROM companies')) return { rows: [{ trade_name: 'Aura QA' }] };
      return { rows: [] };
    });
  }

  test('a mesma funcao que a vitrine Studio le', () => {
    expect(fonte('src/routes/studioStorefront.js')).toContain('banners_automaticos: bannersAutomaticos(config.banners),');
    expect(fonte('src/routes/digitalChannel.js')).toContain('banners_automaticos: bannersAutomaticos(config.banners),');
    expect(bannersAutomaticos([])).toBe(true);
    expect(bannersAutomaticos(null)).toBe(true);
    expect(bannersAutomaticos([{ ...BANNER, enabled: false }])).toBe(true);
    expect(bannersAutomaticos([BANNER])).toBe(false);
  });

  test('loja sem banner gravado: o painel recebe os de fabrica e sabe que sao automaticos', async () => {
    bancoDoGet({ company_id: 'cid-1', slug: 'aura-qa', banners: [] });
    const r = await request(app).get('/companies/cid-1/digital-channel');
    expect(r.status).toBe(200);
    expect(r.body.banners[0].headline).toBe('Bem-vindo à nossa loja');
    expect(r.body.banners_automaticos).toBe(true);
  });

  test('loja com banner proprio', async () => {
    bancoDoGet({ company_id: 'cid-1', slug: 'aura-qa', banners: [BANNER] });
    const r = await request(app).get('/companies/cid-1/digital-channel');
    expect(r.body.banners_automaticos).toBe(false);
  });

  test('loja que nunca salvou nada', async () => {
    bancoDoGet(null);
    const r = await request(app).get('/companies/cid-1/digital-channel');
    expect(r.body.exists).toBe(false);
    expect(r.body.banners_automaticos).toBe(true);
  });
});

describe('5 · a tipografia "Marcante"', () => {
  const app = appDoPainel();
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test.each(['classic', 'modern', 'editorial', 'humanist'])('%s e aceita', async (chave) => {
    bancoDoPut({ slugAtual: 'aura-qa' });
    const r = await request(app).put('/companies/cid-1/digital-channel').send({ font_family: chave });
    expect(r.status).toBe(200);
  });

  test('chave desconhecida: 400 em portugues, com as quatro opcoes', async () => {
    bancoDoPut({ slugAtual: 'aura-qa' });
    const r = await request(app).put('/companies/cid-1/digital-channel').send({ font_family: 'comic' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Tipografia inválida. Use classic, modern, editorial ou humanist.');
  });
});

describe('6 · "Nao achamos essa loja"', () => {
  const app = express();
  app.use('/storefront', require('../src/routes/storefront'));
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
  });

  test('slug inexistente ou loja despublicada: 404 com a pagina nova', async () => {
    const r = await request(app).get('/storefront/nao-existe/page');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toMatch(/text\/html; charset=utf-8/);
    const html = r.text;
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('<title>Não achamos essa loja</title>');
    expect(html).toContain('<h1>Não achamos essa loja</h1>');
    expect(html).toContain('Confira o link com quem te mandou, ou é possível que a loja ainda não esteja publicada.');
    expect(html).toMatch(/<a class="botao" href="https:\/\/getaura\.com\.br">Ir para a Aura<\/a>/);
    expect(html).toContain('#FAF7F2');
    expect(html).toContain('#1A1612');
    expect(html).toMatch(/'Fraunces', Georgia/);
    expect(html).toMatch(/'DM Sans', system-ui/);
    expect(html).toContain('height: 48px;');
    expect(html).toContain('<svg');
    // Nada do texto antigo, nem "pra".
    expect(html).not.toMatch(/Loja não encontrada|peça ao lojista|\bpra\b/);
  });

  test('a pagina so usa o que a CSP da loja libera (Google Fonts, sem script)', async () => {
    const r = await request(app).get('/storefront/nao-existe/page');
    expect(r.text).not.toContain('<script');
    const csp = r.headers['content-security-policy'];
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
  });
});

describe('7 · Pix pendente antigo', () => {
  const { tickCancelarPixVencido, JANELA_DIAS } = require('../src/jobs/lojaPixExpiradoJob');

  test('o cancelamento nao tem limite de idade: a janela de 7 dias e so do aviso', async () => {
    const velho = {
      id: 'baa22b9d-9196-45d6-b422-fff42919b71e', company_id: '56135b5d-defa-4225-aa2c-e6b9433c98ea',
      order_number: '00012', customer_name: 'Teste', total: '49.90', vertical: 'studio',
      created_at: new Date(Date.now() - 22 * 24 * 3600 * 1000).toISOString(),
    };
    const deps = {
      db: { query: jest.fn().mockResolvedValue({ rows: [velho] }) },
      lojaEvents: { emitLojaEvent: jest.fn().mockResolvedValue({ id: 'n1' }) },
    };
    const r = await tickCancelarPixVencido(deps);
    const [sql] = deps.db.query.mock.calls[0];
    expect(sql).not.toMatch(/created_at > NOW\(\)/);
    expect(sql).not.toContain(`${JANELA_DIAS} days`);
    expect(r).toEqual({ cancelados: 1, avisados: 0 });
    expect(deps.lojaEvents.emitLojaEvent).not.toHaveBeenCalled();
  });
});

describe('8 · o preco no Pix (regra combinada com o app)', () => {
  const { totaisDoPedido, descontoDoPix, r2 } = require('../src/services/precoDoStudio');

  test.each([
    [49.90, 5, 47.41],
    [99.80, 10, 89.82],
    [49.90, 7.5, 46.16],
    [94.80, 10, 85.32],
  ])('R$ %s a %s%% sai R$ %s no Pix', (preco, pct, noPix) => {
    const centavos = Math.round(preco * 100);
    const esperado = Math.round(centavos * (100 - pct) / 100);
    expect(esperado / 100).toBe(noPix);
    expect(descontoDoPix(preco, pct)).toBe(r2(preco - noPix));
    const t = totaisDoPedido({ subtotal: preco, pixPct: pct, formaDePagamento: 'pix', frete: 0 });
    expect(r2(t.total)).toBe(noPix);
    expect(r2(t.total_pix)).toBe(noPix);
    // Frete fica fora do desconto.
    expect(r2(totaisDoPedido({ subtotal: preco, pixPct: pct, formaDePagamento: 'pix', frete: 12 }).total)).toBe(r2(noPix + 12));
  });

  test('a regra anterior dava R$ 47,40 para R$ 49,90 a 5%', () => {
    expect(49.90 - Math.round(49.90 * 5) / 100).toBeCloseTo(47.40, 10);
    expect(descontoDoPix(49.90, 5)).toBe(2.49);
  });

  test('sem desconto ou fora do Pix, preco cheio', () => {
    expect(descontoDoPix(49.90, 0)).toBe(0);
    expect(descontoDoPix(49.90, null)).toBe(0);
    expect(totaisDoPedido({ subtotal: 49.90, pixPct: 5, formaDePagamento: 'card', frete: 0 }).total).toBe(49.90);
  });
});
