// ============================================================
// AURA — WhatsApp · Conversas: produto com fotos e tamanhos (ProdutoGrade)
//
//  (1) leitura: estoque da LOJA, cor sem estoque, "último", sem quantidade,
//      ordem dos tamanhos, reservado/com clientes descontados, outra loja 404.
//  (2) envio: fotos + legenda; botões até 3, lista acima; conversa fechada recusa.
//  (3) resposta da cliente (button_reply / list_reply): grava, etiqueta, sugestão;
//      payload desconhecido e "Quero o Pix" seguem o fluxo normal.
//  (4) reservar e mandar o Pix: reserva sem baixa de estoque, Pix da loja,
//      conversa fechada não grava nada.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({ graphPost: jest.fn(), sendText: jest.fn() }));
jest.mock('../src/services/hubWhatsapp', () => ({ marcarRespostaHumana: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/waOutbox', () => ({
  decryptToken: (t) => t,
  normalizePhone: (p) => String(p || '').replace(/\D+/g, '') || null,
  windowOpenAt: (d) => !!(d && Date.now() - new Date(d).getTime() < 24 * 3600000),
  getContact: jest.fn().mockResolvedValue(null),
  loadPauseReason: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/pedidoBalcao', () => ({
  pedidoLiberado: (req) => process.env.PEDIDO_LIBERADO === 'true' || !!(req && req.user && req.user.is_staff === true),
  hojeSP: () => '2026-11-27',
  guardarPedido: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const waOutbox = require('../src/services/waOutbox');
const pedidoBalcao = require('../src/services/pedidoBalcao');
const grade = require('../src/services/hubProdutoGrade');
const queroPix = require('../src/services/credit/queroPix');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OUTRA = '99999999-9999-4999-8999-999999999999';
const CONV = '22222222-2222-4222-8222-222222222222';
const PROD = '33333333-3333-4333-8333-333333333333';
const MSG = '55555555-5555-4555-8555-555555555555';
const V = (n) => `44444444-4444-4444-8444-44444444444${n}`;
const ITENS_1 = [{ product_id: PROD, variant_id: V(1), quantity: 1 }];
const horas = (h) => new Date(Date.now() - h * 3600000).toISOString();
const FOTO = 'https://r2.getaura.com.br/saia-preta.jpg';
const FOTO2 = 'https://r2.getaura.com.br/saia-preta-2.jpg';

let user;
function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id/hub', (req, _res, next) => { req.user = user; next(); }, require('../src/routes/hubSocialRico'));
  return a;
}

const variante = (n, cor, tam, estoque, extra = {}) => ({
  id: V(n), sku_suffix: null, price_override: null, stock_qty: estoque, image_url: null, image_thumb_url: null,
  color_name: cor.nome, promo_price: null, promo_starts_at: null, promo_ends_at: null,
  attributes: [{ attribute: 'Cor', value: cor.hex }, { attribute: 'Tamanho', value: tam }], ...extra,
});
const PRETO = { nome: 'Preto', hex: '#000000' };
const ROSA = { nome: 'Rosa', hex: '#ec4899' };

let w; // mundo do teste
beforeEach(() => {
  user = { id: 'user-1', is_staff: true };
  process.env.PEDIDO_LIBERADO = 'true';
  w = {
    seq: 0, queries: [],
    conversa: { id: CONV, channel: 'whatsapp', external_id: '5511988887777', customer_id: 'cli-1', customer_name: 'Ana', last_inbound_at: horas(2) },
    produto: { id: PROD, name: 'Saia midi', price: '189.90', image_url: FOTO, image_thumb_url: null, is_group_shared: false, promo_price: null, promo_starts_at: null, promo_ends_at: null },
    variantes: [
      variante(1, PRETO, 'M', 3), variante(2, PRETO, 'P', 2), variante(3, PRETO, 'G', 1),
      variante(4, ROSA, 'M', 0), variante(5, ROSA, 'P', 0),
    ],
    galeria: [
      { url: 'https://r2/principal.jpg', thumb_url: null, color_hex: null },
      { url: FOTO, thumb_url: null, color_hex: '#000000' },
      { url: FOTO2, thumb_url: null, color_hex: '#000000' },
    ],
    reservas: [], comClientes: [],
    loja: { slug: 'lume', is_published: true, pix_key: '11144477735', pix_key_type: 'CPF', pix_holder_name: 'Lume Moda', pix_holder_city: 'Sao Paulo', trade_name: 'Lume Moda' },
    labels: [], vinculos: [], updates: [], pedidosChave: [], enviandoBloqueado: false,
    sugestao: null,
  };
  wa.graphPost.mockReset().mockImplementation(async () => ({ messages: [{ id: `wamid.${++w.seq}` }] }));
  waOutbox.getContact.mockReset().mockResolvedValue(null);
  waOutbox.loadPauseReason.mockReset().mockResolvedValue(null);
  pedidoBalcao.guardarPedido.mockReset().mockResolvedValue({ status: 201, pedido: { id: 'ord-1', order_number: 'PED-7' } });
  db.connect.mockReset().mockImplementation(async () => ({ query: (...a) => db.query(...a), release: jest.fn() }));
  db.query.mockReset().mockImplementation((sql, params = []) => {
    const s = String(sql);
    w.queries.push(s);
    const rows = (r) => Promise.resolve({ rows: r });
    if (s.includes('hubgrade:pedido-da-chave')) return rows(w.pedidosChave.filter((r) => params[1].includes(r.idempotency_key)));
    if (s.includes('FROM studio_payments')) return rows([{ v: w.sinalPago || 0 }]);
    if (s.includes('hubenvio:conv')) return rows(params[1] === COMPANY ? [w.conversa] : []);
    if (s.includes('hubenvio:creds')) return rows([{ wa_phone_number_id: 'PNID', wa_access_token: 'tok' }]);
    if (s.includes('hubenvio:loja')) return rows([w.loja]);
    if (s.includes('hubenvio:grava')) return rows([]);
    // O estoque é da loja: produto de outra loja não aparece (e não é do grupo).
    if (s.includes('hubgrade:produto')) return rows(params[1] === COMPANY && params[0] === PROD ? [w.produto] : []);
    if (s.includes('hubgrade:variantes')) return rows(w.variantes);
    if (s.includes('hubgrade:galeria')) return rows(w.galeria);
    if (s.includes('FROM digital_order_items')) return rows(w.reservas);
    if (s.includes('voltou_defeito')) return rows([]);
    if (s.includes('condicional_itens')) return rows(w.comClientes);
    if (s.includes('hubgrade:msg')) return rows(w.sugestao ? [{ id: MSG, metadata: { sugestao: w.sugestao } }] : []);
    if (s.includes('hubgrade:resposta-grava')) { w.updates.push(params); return rows([{ id: MSG }]); }
    if (s.includes('hubgrade:sugestao-enviando')) { w.claims = (w.claims || 0) + 1; return rows(w.enviandoBloqueado ? [] : [{ id: MSG }]); }
    if (s.includes('hubgrade:sugestao-liberar')) { w.liberou = true; return rows([]); }
    if (s.includes('hubgrade:sugestao-feita')) { w.updates.push(params); return rows([]); }
    if (s.includes('hubgrade:etiqueta-achar')) return rows(w.labels.filter((l) => l.name.toLowerCase() === params[1].toLowerCase()));
    if (s.includes('hubgrade:etiqueta-conta')) return rows([{ n: w.labels.length }]);
    if (s.includes('hubgrade:etiqueta-cria')) { const l = { id: `lab-${w.labels.length + 1}`, name: params[1] }; w.labels.push(l); return rows([{ id: l.id }]); }
    if (s.includes('hubgrade:etiqueta-quer')) {
      const [conv, , manter] = params;
      return rows(w.vinculos.filter(([c, l]) => c === conv && l !== manter)
        .map(([, l]) => ({ label_id: l, name: w.labels.find((x) => x.id === l).name }))
        .filter((r) => r.name.toLowerCase().startsWith('quer o ')));
    }
    if (s.includes('hubgrade:etiqueta-troca')) {
      const [conv, ids] = params;
      w.vinculos = w.vinculos.filter(([c, l]) => !(c === conv && ids.includes(l)));
      return rows([]);
    }
    if (s.includes('hubgrade:etiqueta-aplica')) { if (!w.vinculos.some((v) => v[0] === params[0] && v[1] === params[1])) w.vinculos.push(params); return rows([]); }
    return rows([]);
  });
});

const grava = () => w.queries.filter((q) => q.includes('hubenvio:grava'));
const enviar = (body, company = COMPANY) => request(app()).post(`/companies/${company}/hub/conversations/${CONV}/send`).send(body);
const graph = () => wa.graphPost.mock.calls.map((c) => c[2]);

describe('leitura do produto', () => {
  it('devolve cores, fotos e só os tamanhos com estoque, sem quantidade, com "último"', async () => {
    const res = await request(app()).get(`/companies/${COMPANY}/hub/produtos/${PROD}/grade`);
    expect(res.status).toBe(200);
    const { cores, fotos, produto } = res.body;
    expect(produto).toMatchObject({ nome: 'Saia midi', preco: 189.9, compartilhado: false });
    expect(fotos).toEqual([{ url: 'https://r2/principal.jpg', thumb_url: null }]);
    const preto = cores.find((c) => c.nome === 'Preto');
    expect(preto.tamanhos.map((t) => t.tamanho)).toEqual(['P', 'M', 'G']);
    expect(preto.tamanhos.map((t) => t.ultimo)).toEqual([false, false, true]);
    expect(preto.fotos.map((f) => f.url)).toEqual([FOTO, FOTO2]);
    expect(preto.disponivel).toBe(true);
    // Nenhuma quantidade vaza.
    expect(JSON.stringify(res.body)).not.toMatch(/stock|estoque|livres|quantidade/i);
  });

  it('cor sem estoque aparece, mas indisponível e sem tamanhos', async () => {
    const res = await request(app()).get(`/companies/${COMPANY}/hub/produtos/${PROD}/grade`);
    const rosa = res.body.cores.find((c) => c.nome === 'Rosa');
    expect(rosa).toMatchObject({ disponivel: false, tamanhos: [] });
  });

  it('desconta o reservado e o que está com clientes (livres, não estoque)', async () => {
    w.reservas = [{ product_id: PROD, variant_id: V(3), qtd: '1' }, { product_id: PROD, variant_id: V(2), qtd: '1' }];
    w.comClientes = [{ product_id: PROD, variant_id: V(1), qtd: '2' }];
    const res = await request(app()).get(`/companies/${COMPANY}/hub/produtos/${PROD}/grade`);
    const preto = res.body.cores.find((c) => c.nome === 'Preto');
    // G: 1 - 1 reservado = 0 (some); P: 2 - 1 = 1 (último); M: 3 - 2 = 1 (último).
    expect(preto.tamanhos.map((t) => [t.tamanho, t.ultimo])).toEqual([['P', true], ['M', true]]);
  });

  it('estoque é o da loja que pergunta: produto de outra loja (fora do grupo) dá 404', async () => {
    const res = await request(app()).get(`/companies/${OUTRA}/hub/produtos/${PROD}/grade`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PRODUTO_NAO_ENCONTRADO');
    const consulta = db.query.mock.calls.find((c) => String(c[0]).includes('hubgrade:produto'));
    expect(consulta[0]).toMatch(/is_group_shared = true/); // regra única de visibilidade (grupo)
    expect(consulta[1][1]).toBe(OUTRA);
  });

  it('produto compartilhado do grupo entra e vem marcado', async () => {
    w.produto.is_group_shared = true;
    const res = await request(app()).get(`/companies/${COMPANY}/hub/produtos/${PROD}/grade`);
    expect(res.body.produto.compartilhado).toBe(true);
  });

  it('preço da variante: price_override e promoção vigente', async () => {
    w.variantes[0].price_override = '210.00';
    w.variantes[1].promo_price = '150.00';
    w.variantes[1].price_override = '210.00';
    w.variantes[1].promo_starts_at = horas(24);
    w.variantes[1].promo_ends_at = new Date(Date.now() + 86400000).toISOString();
    const res = await request(app()).get(`/companies/${COMPANY}/hub/produtos/${PROD}/grade`);
    const preto = res.body.cores.find((c) => c.nome === 'Preto');
    expect(preto.tamanhos.find((t) => t.tamanho === 'M').preco).toBe(210);
    expect(preto.tamanhos.find((t) => t.tamanho === 'P').preco).toBe(150);
  });

  it('ordem dos tamanhos: letras, depois números', () => {
    expect(['40', 'G', 'PP', '38', 'M', 'GG'].sort(grade.compararTamanho)).toEqual(['PP', 'M', 'G', 'GG', '38', '40']);
  });
});

describe('envio', () => {
  it('manda as fotos como imagem, a legenda na primeira, e grava o cartão na thread', async () => {
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000' });
    expect(res.status).toBe(200);
    const [foto1, foto2] = graph();
    expect(foto1).toMatchObject({ type: 'image', to: '5511988887777', image: { link: FOTO } });
    expect(foto1.image.caption).toBe('Saia midi · Preto · R$ 189,90 · Tem P, M e G (último)');
    expect(foto2).toMatchObject({ type: 'image', image: { link: FOTO2 } });
    expect(foto2.image.caption).toBeUndefined();
    expect(graph()).toHaveLength(2);
    expect(grava()).toHaveLength(1);
    const meta = JSON.parse(db.query.mock.calls.find((c) => String(c[0]).includes('hubenvio:grava'))[1][4]);
    expect(meta.tipo).toBe('produto');
    expect(meta.cartao).toMatchObject({ nome: 'Saia midi', cor: 'Preto', preco: 189.9, fotos: [FOTO, FOTO2] });
    expect(meta.cartao.tamanhos).toEqual([{ tamanho: 'P', disponivel: true, ultimo: false }, { tamanho: 'M', disponivel: true, ultimo: false }, { tamanho: 'G', disponivel: true, ultimo: true }]);
  });

  it('até 3 tamanhos: UMA bolha, foto no cabeçalho dos botões, legenda e pergunta no corpo', async () => {
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', fotos: [FOTO], perguntar_tamanho: true });
    expect(res.status).toBe(200);
    expect(graph()).toHaveLength(1);
    const q = graph()[0];
    expect(q.type).toBe('interactive');
    expect(q.interactive.type).toBe('button');
    expect(q.interactive.header).toEqual({ type: 'image', image: { link: FOTO } });
    expect(q.interactive.body.text).toBe('Saia midi · Preto · R$ 189,90 · Tem P, M e G (último)\n\nQual tamanho?');
    const botoes = q.interactive.action.buttons;
    expect(botoes.map((b) => b.reply.title)).toEqual(['P', 'M', 'G']);
    expect(botoes[0].reply.id).toBe(`TAM:${PROD}:${V(2)}:P`);
    // Uma linha na thread: o cartão, já com as opções da pergunta.
    expect(grava()).toHaveLength(1);
    const meta = JSON.parse(db.query.mock.calls.find((c) => String(c[0]).includes('hubenvio:grava'))[1][4]);
    expect(meta).toMatchObject({ tipo: 'produto', pergunta: true, formato: 'botoes', opcoes: ['P', 'M', 'G'] });
  });

  it('várias fotos + botões: as outras vão antes e a bolha (com a 1ª foto) fecha', async () => {
    await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', fotos: [FOTO, FOTO2], perguntar_tamanho: true });
    expect(graph().map((g) => g.type)).toEqual(['image', 'interactive']);
    expect(graph()[0].image.link).toBe(FOTO2);
    expect(graph()[1].interactive.header.image.link).toBe(FOTO);
  });

  it('corpo acima de 1024 caracteres: volta para foto com legenda + pergunta separada', async () => {
    w.produto.name = 'Saia '.repeat(220);
    await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', fotos: [FOTO], perguntar_tamanho: true });
    expect(graph().map((g) => g.type)).toEqual(['image', 'interactive']);
    expect(graph()[1].interactive.header).toBeUndefined();
    expect(graph()[1].interactive.body.text).toBe('Qual tamanho?');
    expect(grava()).toHaveLength(2);
  });

  it('tamanho sem peça: vai no cartão com disponivel:false, mas fora da legenda e dos botões', async () => {
    w.variantes.push(variante(6, PRETO, 'GG', 0));
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', fotos: [FOTO], perguntar_tamanho: true });
    expect(res.status).toBe(200);
    const q = graph()[0].interactive;
    expect(q.body.text).toContain('Tem P, M e G (último)');
    expect(q.body.text).not.toContain('GG');
    expect(q.action.buttons.map((b) => b.reply.title)).toEqual(['P', 'M', 'G']);
    const meta = JSON.parse(db.query.mock.calls.find((c) => String(c[0]).includes('hubenvio:grava'))[1][4]);
    expect(meta.cartao.tamanhos).toEqual([
      { tamanho: 'P', disponivel: true, ultimo: false }, { tamanho: 'M', disponivel: true, ultimo: false },
      { tamanho: 'G', disponivel: true, ultimo: true }, { tamanho: 'GG', disponivel: false, ultimo: false },
    ]);
  });

  it('leitura: todos_tamanhos traz a grade inteira; tamanhos só os com peça', async () => {
    w.variantes.push(variante(6, PRETO, 'GG', 0));
    const res = await request(app()).get(`/companies/${COMPANY}/hub/produtos/${PROD}/grade`);
    const preto = res.body.cores.find((c) => c.nome === 'Preto');
    expect(preto.tamanhos.map((t) => t.tamanho)).toEqual(['P', 'M', 'G']);
    expect(preto.todos_tamanhos.map((t) => [t.tamanho, t.disponivel])).toEqual([['P', true], ['M', true], ['G', true], ['GG', false]]);
    const rosa = res.body.cores.find((c) => c.nome === 'Rosa');
    expect(rosa.todos_tamanhos.every((t) => t.disponivel === false)).toBe(true);
  });

  it('reservar tamanho sem peça continua recusado no servidor', async () => {
    w.sugestao = { tipo: 'reservar_e_mandar_pix', product_id: PROD, variant_id: V(4), tamanho: 'M', quantidade: 1, estado: 'sem_estoque' };
    const res = await request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/reservar-pix`).send({ message_id: MSG });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PEDIDO_SEM_SALDO');
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
  });

  it('acima de 3 tamanhos: lista', async () => {
    w.variantes.push(variante(6, PRETO, 'GG', 4));
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', fotos: [FOTO], perguntar_tamanho: true });
    expect(res.status).toBe(200);
    const q = graph()[1].interactive;
    expect(q.type).toBe('list');
    expect(q.action.sections[0].rows.map((r) => r.title)).toEqual(['P', 'M', 'G', 'GG']);
    expect(q.action.button).toBe('Escolher o tamanho');
  });

  it('cor sem estoque → 422 e nada sai', async () => {
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: 'ec4899' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COR_SEM_ESTOQUE');
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('várias cores com estoque e cor omitida → pede a cor', async () => {
    w.variantes[3].stock_qty = 2;
    const res = await enviar({ type: 'produto_grade', product_id: PROD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ESCOLHA_A_COR');
  });

  it('foto que não é do produto é recusada', async () => {
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', fotos: ['https://evil.example/x.jpg'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FOTO_INVALIDA');
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('conversa fechada (24 h) recusa antes de ler ou enviar qualquer coisa', async () => {
    w.conversa.last_inbound_at = horas(30);
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', perguntar_tamanho: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('JANELA_FECHADA');
    expect(wa.graphPost).not.toHaveBeenCalled();
    expect(w.queries.some((q) => q.includes('hubgrade:'))).toBe(false);
  });

  it('conta pausada bloqueia', async () => {
    waOutbox.loadPauseReason.mockResolvedValue('LIMITE');
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000' });
    expect(res.body.code).toBe('PAUSADO');
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('sem foto, a legenda vai como texto', async () => {
    w.galeria = []; w.produto.image_url = null;
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000' });
    expect(res.status).toBe(200);
    expect(graph()[0].type).toBe('text');
  });
});

describe('resposta da cliente', () => {
  const botao = (payload, title = 'M') => ({
    id: 'wamid.CLI1', from: '5511988887777', type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: payload, title } },
  });
  const lista = (payload, title = 'GG') => ({
    id: 'wamid.CLI2', from: '5511988887777', type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: payload, title } },
  });

  it('botão: grava "tocou no botão", etiqueta "Quer o M" e deixa a sugestão de reservar', async () => {
    const r = await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: botao(`TAM:${PROD}:${V(1)}:M`) });
    expect(r).toMatchObject({ handled: true, tamanho: 'M' });
    const [content, metaJson] = w.updates[0];
    expect(content).toBe('Tocou no botão: M');
    const meta = JSON.parse(metaJson);
    expect(meta.sugestao).toMatchObject({
      tipo: 'reservar_e_mandar_pix', rotulo: 'Reservar e mandar o Pix', product_id: PROD, variant_id: V(1),
      tamanho: 'M', quantidade: 1, estado: 'pendente', cor: 'Preto', preco: 189.9,
    });
    expect(w.labels.map((l) => l.name)).toEqual(['Quer o M']);
    expect(w.vinculos).toEqual([[CONV, 'lab-1']]);
  });

  it('lista: mesmo caminho; etiqueta existente é reaproveitada', async () => {
    w.labels.push({ id: 'lab-0', name: 'quer o gg' });
    w.variantes.push(variante(6, PRETO, 'GG', 4));
    const r = await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: lista(`TAM:${PROD}:${V(6)}:GG`) });
    expect(r.handled).toBe(true);
    expect(w.updates[0][0]).toBe('Escolheu na lista: GG');
    expect(w.labels).toHaveLength(1);
    expect(w.vinculos).toEqual([[CONV, 'lab-0']]);
  });

  it('uma etiqueta "Quer o ..." por conversa: a nova troca a anterior; webhook reentregue não duplica', async () => {
    w.variantes.push(variante(6, PRETO, 'GG', 4));
    w.labels.push({ id: 'outra', name: 'Esperando Pix' });
    w.vinculos.push([CONV, 'outra']);
    await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: botao(`TAM:${PROD}:${V(1)}:M`) });
    await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: botao(`TAM:${PROD}:${V(1)}:M`) });
    expect(w.vinculos.map((v) => v[1])).toEqual(['outra', 'lab-2']);
    expect(w.labels.map((l) => l.name)).toEqual(['Esperando Pix', 'Quer o M']);
    await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: lista(`TAM:${PROD}:${V(6)}:GG`) });
    const nomes = w.vinculos.map((v) => w.labels.find((l) => l.id === v[1]).name);
    expect(nomes).toEqual(['Esperando Pix', 'Quer o GG']); // outras etiquetas ficam; só a "Quer o" troca
  });

  it('etiqueta manual com o mesmo começo ("Quer o vestido da vitrine") nunca é apagada', async () => {
    w.labels.push({ id: 'man', name: 'Quer o vestido da vitrine' }, { id: 'ant', name: 'Quer o P' });
    w.vinculos.push([CONV, 'man'], [CONV, 'ant']);
    await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: botao(`TAM:${PROD}:${V(1)}:M`) });
    const nomes = w.vinculos.map((v) => w.labels.find((l) => l.id === v[1]).name).sort();
    expect(nomes).toEqual(['Quer o M', 'Quer o vestido da vitrine']);
  });

  it('a troca e a aplicação correm numa transação com trava por conversa', async () => {
    await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: botao(`TAM:${PROD}:${V(1)}:M`) });
    const ordem = db.query.mock.calls.map((c) => String(c[0]));
    const iBegin = ordem.indexOf('BEGIN');
    const iLock = ordem.findIndex((q) => q.includes('pg_advisory_xact_lock'));
    const iAplica = ordem.findIndex((q) => q.includes('hubgrade:etiqueta-aplica'));
    const iCommit = ordem.indexOf('COMMIT');
    expect(iBegin).toBeGreaterThanOrEqual(0);
    expect(iLock).toBeGreaterThan(iBegin);
    expect(iAplica).toBeGreaterThan(iLock);
    expect(iCommit).toBeGreaterThan(iAplica);
    const trava = db.query.mock.calls.find((c) => String(c[0]).includes('pg_advisory_xact_lock'));
    expect(trava[1][0]).toContain(CONV);
  });

  it('Pedido desligado: a sugestão é só "Mandar o Pix" (sem oferecer a reserva)', async () => {
    process.env.PEDIDO_LIBERADO = 'false';
    await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: botao(`TAM:${PROD}:${V(1)}:M`) });
    const sug = JSON.parse(w.updates[0][1]).sugestao;
    expect(sug).toMatchObject({ tipo: 'mandar_pix', rotulo: 'Mandar o Pix', reserva: false });
  });

  it('tamanho que acabou entre o envio e o toque vira sugestão "sem_estoque"', async () => {
    await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: botao(`TAM:${PROD}:${V(4)}:M`) });
    expect(JSON.parse(w.updates[0][1]).sugestao.estado).toBe('sem_estoque');
  });

  it('payload desconhecido, variante de outro produto e "Quero o Pix" seguem o fluxo normal', async () => {
    const mensagens = [
      botao('OUTRA_COISA:1'),
      botao(`TAM:${PROD}:44444444-4444-4444-8444-444444444499:M`),
      botao(`TAM:${OUTRA}:${V(1)}:M`),
      { id: 'w', from: '5511', type: 'button', button: { payload: 'QUERO_PIX:44444444-4444-4444-8444-444444444444', text: 'Quero o Pix' } },
      { id: 'w', from: '5511', type: 'text', text: { body: 'oi' } },
    ];
    for (const m of mensagens) {
      expect(await grade.tratarResposta({ companyId: COMPANY, conversationId: CONV, msg: m })).toEqual({ handled: false });
    }
    expect(w.updates).toHaveLength(0);
    expect(w.labels).toHaveLength(0);
  });

  it('o toque no tamanho não é confundido com "Quero o Pix" (e vice-versa)', () => {
    expect(queroPix.ehQueroPix(queroPix.lerToque(botao(`TAM:${PROD}:${V(1)}:M`)))).toBe(false);
    expect(grade.lerPayload('QUERO_PIX:44444444-4444-4444-8444-444444444444')).toBeNull();
  });
});

describe('reservar e mandar o Pix', () => {
  beforeEach(() => {
    w.sugestao = {
      tipo: 'reservar_e_mandar_pix', product_id: PROD, variant_id: V(1), tamanho: 'M', quantidade: 1, estado: 'pendente',
    };
  });
  const reservar = (body = { message_id: MSG }) => request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/reservar-pix`).send(body);

  it('cria o pedido do balcão (reserva) sem baixar estoque e manda o Pix da loja', async () => {
    const res = await reservar();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, order_id: 'ord-1', total: 189.9 });
    // Reserva = pedido do balcão com o preço do banco; a chave é a mensagem da cliente (idempotente).
    const arg = pedidoBalcao.guardarPedido.mock.calls[0][0];
    expect(arg.chave).toBe(`wa-res-${CONV}-${MSG}`);
    expect(arg.body.items).toEqual([{ product_id: PROD, variant_id: V(1), variant_label: 'Preto · M', quantity: 1, unit_price: 189.9 }]);
    expect(arg.body.customer_id).toBe('cli-1');
    // Nenhuma escrita em estoque.
    expect(w.queries.some((q) => /UPDATE\s+(products|product_variants)|stock_qty\s*=/i.test(q))).toBe(false);
    // Pix: texto + código copia e cola (BR Code com o valor).
    const [intro, codigo] = graph();
    expect(intro.text.body).toMatch(/Separei Saia midi \(Preto · M\) pra você\. Total R\$ 189,90/);
    expect(codigo.text.body).toMatch(/^00020126/);
    expect(codigo.text.body).toContain('54061');
    // Sugestão marcada como feita.
    const marcada = JSON.parse(w.updates[0][0]);
    expect(marcada.sugestao).toMatchObject({ estado: 'feita', order_id: 'ord-1' });
  });

  it('sugestão já feita → 409 JA_RESERVADO, sem pedido e sem Pix', async () => {
    w.sugestao.estado = 'feita';
    const res = await reservar();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JA_RESERVADO');
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('conversa fechada recusa e não grava pedido', async () => {
    w.conversa.last_inbound_at = horas(25);
    const res = await reservar();
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('JANELA_FECHADA');
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('loja sem Pix recusa ANTES de criar o pedido', async () => {
    w.loja.pix_key = null;
    const res = await reservar();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEM_PIX');
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
  });

  it('sem saldo livre no tamanho → 409 e nada é criado', async () => {
    w.reservas = [{ product_id: PROD, variant_id: V(1), qtd: '3' }];
    const res = await reservar();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PEDIDO_SEM_SALDO');
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
  });

  it('trava do Pedido desligada → 403', async () => {
    user = { id: 'u', is_staff: false };
    process.env.PEDIDO_LIBERADO = 'false';
    const res = await reservar();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PEDIDO_NAO_LIBERADO');
  });

  it('o preço vem do banco: variante de outro produto não passa', async () => {
    const res = await reservar({ product_id: PROD, variant_id: '44444444-4444-4444-8444-444444444499' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('VARIANTE_INDISPONIVEL');
  });
});

describe('reserva: B, D, E', () => {
  beforeEach(() => {
    w.sugestao = { tipo: 'reservar_e_mandar_pix', product_id: PROD, variant_id: V(1), tamanho: 'M', quantidade: 1, estado: 'pendente' };
  });
  const reservar = () => request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/reservar-pix`).send({ message_id: MSG });
  const chaveBase = `wa-res-${CONV}-${MSG}`;

  it('B: pedido já criado (falha depois dele): só reenvia o Pix, sem novo pedido e sem pré-checar o saldo', async () => {
    w.pedidosChave = [{ idempotency_key: chaveBase, id: 'ord-9', order_number: 'PED-9', total: '189.90', cancelado: false, payment_status: 'pending', status: 'confirmed', deposit_paid: null, itens: ITENS_1 }];
    w.reservas = [{ product_id: PROD, variant_id: V(1), qtd: '3' }]; // a própria reserva esgotou o livre
    const res = await reservar();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ order_id: 'ord-9', order_number: 'PED-9', total: 189.9 });
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
    expect(graph()[1].text.body).toMatch(/^00020126/);
  });

  it('E: pedido cancelado não é reaproveitado: nova tentativa usa a chave -2', async () => {
    w.pedidosChave = [{ idempotency_key: chaveBase, id: 'ord-0', order_number: 'PED-0', total: '189.90', cancelado: true, payment_status: 'pending', status: 'confirmed', deposit_paid: null, itens: ITENS_1 }];
    const res = await reservar();
    expect(res.status).toBe(200);
    expect(pedidoBalcao.guardarPedido.mock.calls[0][0].chave).toBe(`${chaveBase}-2`);
    expect(res.body.order_id).toBe('ord-1');
  });

  it('D: duplo clique (sugestão já "enviando") → 409 e nenhum pedido nem Pix', async () => {
    w.enviandoBloqueado = true;
    const res = await reservar();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JA_RESERVADO');
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('D: a sugestão é reservada de forma atômica antes de criar o pedido; falha libera para tentar de novo', async () => {
    pedidoBalcao.guardarPedido.mockRejectedValueOnce(Object.assign(new Error('sem saldo'), { status: 409, code: 'PEDIDO_SEM_SALDO' }));
    const res = await reservar();
    expect(res.status).toBe(409);
    expect(w.claims).toBe(1);
    expect(w.liberou).toBe(true);
  });
});

describe('reserva: G, H, I', () => {
  const corpoDireto = { product_id: PROD, variant_id: V(1) };
  const reservarDireto = (extra = {}) => request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/reservar-pix`).send({ ...corpoDireto, ...extra });
  const chaveDia = `wa-res-${CONV}-${V(1)}-2026-11-27`;
  const linha = (chave, extra) => ({ idempotency_key: chave, id: `ord-${chave}`, order_number: 'PED', total: '189.90', cancelado: false, payment_status: 'pending', status: 'confirmed', deposit_paid: null, itens: ITENS_1, ...extra });

  it('G: reserva sem message_id reaproveita só pedido pendente com os mesmos itens', async () => {
    w.pedidosChave = [linha(chaveDia)];
    const res = await reservarDireto();
    expect(res.status).toBe(200);
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
    expect(res.body.order_id).toBe(`ord-${chaveDia}`);
  });

  it('G: com sinal pago (studio_payments) de manhã, a reserva da tarde cria pedido novo (chave -2) e manda o Pix', async () => {
    w.pedidosChave = [linha(chaveDia)];
    w.sinalPago = 40; // o pedido do balcão segue payment_status pending: o sinal é que prova o pagamento
    const res = await reservarDireto();
    expect(res.status).toBe(200);
    expect(pedidoBalcao.guardarPedido.mock.calls[0][0].chave).toBe(`${chaveDia}-2`);
    expect(graph()[1].text.body).toMatch(/^00020126/);
  });

  it('G: deposit_paid ligado também não é reaproveitado', async () => {
    w.pedidosChave = [linha(chaveDia, { deposit_paid: 'true' })];
    await reservarDireto();
    expect(pedidoBalcao.guardarPedido.mock.calls[0][0].chave).toBe(`${chaveDia}-2`);
  });

  it('G: quantidade diferente cria um pedido novo', async () => {
    w.pedidosChave = [linha(chaveDia)]; // pendente, 1 peça
    const res = await reservarDireto({ quantity: 2 });
    expect(res.status).toBe(200);
    expect(pedidoBalcao.guardarPedido.mock.calls[0][0].chave).toBe(`${chaveDia}-2`);
    expect(pedidoBalcao.guardarPedido.mock.calls[0][0].body.items[0].quantity).toBe(2);
  });

  it('H: novo toque com o pedido da mensagem já pago (sinal): não reenvia o Pix e marca a sugestão "feita"', async () => {
    w.sinalPago = 100;
    w.sugestao = { tipo: 'reservar_e_mandar_pix', product_id: PROD, variant_id: V(1), tamanho: 'M', quantidade: 1, estado: 'enviando' };
    w.pedidosChave = [linha(`wa-res-${CONV}-${MSG}`)];
    const res = await request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/reservar-pix`).send({ message_id: MSG });
    expect(res.status).toBe(200);
    expect(res.body.ja_pago).toBe(true);
    expect(wa.graphPost).not.toHaveBeenCalled();
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
    expect(JSON.parse(w.updates[0][0]).sugestao).toMatchObject({ estado: 'feita', order_id: `ord-wa-res-${CONV}-${MSG}`, quantidade: 1 });
  });

  it('H: pedido da mensagem entregue (status fora de pendente/confirmado) também fecha sem reenviar', async () => {
    w.sugestao = { tipo: 'reservar_e_mandar_pix', product_id: PROD, variant_id: V(1), tamanho: 'M', quantidade: 1, estado: 'enviando' };
    w.pedidosChave = [linha(`wa-res-${CONV}-${MSG}`, { status: 'delivered' })];
    const res = await request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/reservar-pix`).send({ message_id: MSG });
    expect(res.body.ja_pago).toBe(true);
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('com message_id, pedido aberto da mesma mensagem com outra quantidade → 409, sem segundo pedido', async () => {
    w.sugestao = { tipo: 'reservar_e_mandar_pix', product_id: PROD, variant_id: V(1), tamanho: 'M', quantidade: 1, estado: 'pendente' };
    w.pedidosChave = [linha(`wa-res-${CONV}-${MSG}`)]; // 1 peça
    const res = await request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/reservar-pix`).send({ message_id: MSG, quantity: 2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESERVA_COM_OUTRA_QUANTIDADE');
    expect(pedidoBalcao.guardarPedido).not.toHaveBeenCalled();
    expect(wa.graphPost).not.toHaveBeenCalled();
  });

  it('I: a quantidade gravada na mensagem e na sugestão é a do pedido de fato', async () => {
    w.sugestao = { tipo: 'reservar_e_mandar_pix', product_id: PROD, variant_id: V(1), tamanho: 'M', quantidade: 1, estado: 'pendente' };
    pedidoBalcao.guardarPedido.mockResolvedValue({ status: 201, pedido: { id: 'ord-1', order_number: 'PED-7', items: [{ quantity: 2 }] } });
    const res = await request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/reservar-pix`).send({ message_id: MSG });
    expect(res.status).toBe(200);
    const meta = JSON.parse(db.query.mock.calls.filter((c) => String(c[0]).includes('hubenvio:grava'))[0][1][4]);
    expect(meta).toMatchObject({ tipo: 'reserva', quantidade: 2 });
    expect(JSON.parse(w.updates[0][0]).sugestao.quantidade).toBe(2);
  });
});

describe('F: o que a legenda anuncia é o que a pergunta oferece', () => {
  it('mais de 10 tamanhos: lista com 10 e a legenda diz "e mais N"', async () => {
    for (const [i, t] of ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44'].entries()) w.variantes.push(variante(10 + i, PRETO, t, 2));
    // 3 do base (M, P, G) + 11 = 14 tamanhos; 10 ofertados.
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', fotos: [FOTO], perguntar_tamanho: true });
    expect(res.status).toBe(200);
    const [foto, lista] = graph();
    expect(lista.interactive.type).toBe('list');
    expect(lista.interactive.action.sections[0].rows).toHaveLength(10);
    expect(foto.image.caption).toMatch(/\(e mais 4\)$/);
  });

  it('tamanho com mais de 40 caracteres não vira botão (o payload não caberia) e entra no "e mais"', async () => {
    w.variantes.push(variante(20, PRETO, 'X'.repeat(45), 2));
    const res = await enviar({ type: 'produto_grade', product_id: PROD, cor: '000000', fotos: [FOTO], perguntar_tamanho: true });
    expect(res.status).toBe(200);
    const q = graph()[0].interactive;
    expect(q.action.buttons.map((b) => b.reply.title)).toEqual(['P', 'M', 'G']);
    expect(q.body.text).toContain('(e mais 1)');
  });

  it('título maior que o limite da Meta vira "…" em vez de ser recusado', () => {
    const p = grade.montarPergunta(PROD, [{ tamanho: 'T'.repeat(30), variant_id: V(1) }]);
    expect(p.graph.interactive.action.buttons[0].reply.title).toHaveLength(20);
    expect(p.graph.interactive.action.buttons[0].reply.title.endsWith('…')).toBe(true);
  });

  it('títulos que colidem depois de cortados vão para a lista (botões repetidos a Meta recusa)', () => {
    const a = 'M'.repeat(25) + 'A'; const b = 'M'.repeat(25) + 'B';
    const p = grade.montarPergunta(PROD, [{ tamanho: a, variant_id: V(1) }, { tamanho: b, variant_id: V(2) }]);
    expect(p.formato).toBe('lista');
  });
});

describe('legenda', () => {
  it('um tamanho só e sem cor', () => {
    expect(grade.legendaDaGrade({ nome: 'Bolsa', cor: null, preco: 50, tamanhos: [{ tamanho: 'U', ultimo: true }] }))
      .toBe('Bolsa · R$ 50,00 · Tem U (último)');
    expect(grade.legendaDaGrade({ nome: 'Bolsa', cor: 'Preta', preco: 50, tamanhos: [] })).toBe('Bolsa · Preta · R$ 50,00');
  });
});
