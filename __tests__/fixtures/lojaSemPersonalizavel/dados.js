// ============================================================
// Lojas SEM produto personalizavel, como o banco as devolve (p-179,
// loja unica 3.2a, 17/11/2026).
//
// Cada cenario e o conjunto de linhas que as consultas da loja comum
// recebem: a config da loja (digital_channel_config + companies), os
// produtos da grade, as variantes, as categorias, os blocos da home e o
// resumo das promocoes. O teste (lojaSemPersonalizavel.fixture.test.js)
// responde cada consulta pelo trecho de SQL que a identifica e monta a
// pagina pela rota de verdade (storefront.js -> buildStorefront ->
// buildStorefrontPage).
//
// Os hashes ao lado foram gravados com o codigo de origin/main de
// 17/11/2026 (2867613e), ANTES de a loja comum aprender o personalizavel.
// Loja sem personalizavel tem de continuar saindo com estes bytes.
//
// Nada aqui depende do relogio: o teste congela a data em AGORA.
// ============================================================
'use strict';

const AGORA = '2026-11-17T15:00:00.000Z';

const CID = {
  simples: '0b1a0000-0000-4000-8000-000000000001',
  categorias: '0b1a0000-0000-4000-8000-000000000002',
  variacao: '0b1a0000-0000-4000-8000-000000000003',
};

const pid = (n) => `0b1a1111-0000-4000-8000-${String(n).padStart(12, '0')}`;
const vid = (n) => `0b1a2222-0000-4000-8000-${String(n).padStart(12, '0')}`;
const catId = (n) => `0b1a3333-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Uma linha de products com as colunas que o builder pede. */
function produto(n, extra) {
  return Object.assign({
    id: pid(n), name: `Peca ${n}`, description: `Descricao da peca ${n}.`,
    price: '49.90', image_url: `https://r2.exemplo/p${n}.jpg`,
    image_thumb_url: `https://r2.exemplo/p${n}-640.jpg`, gallery_urls: [],
    category: 'Geral', stock_qty: '5', stock_min: null,
    created_at: '2026-10-01T12:00:00.000Z',
    material: null, medidas: null, cuidados: null, duration_minutes: null,
    promo_price: null, promo_starts_at: null, promo_ends_at: null,
  }, extra || {});
}

function config(cid, slug, extra) {
  return Object.assign({
    id: cid, company_id: cid, slug, is_published: true,
    site_name: null, tagline: 'Feito com carinho', description: 'Loja de exemplo.',
    primary_color: '#7c3aed', accent_color: '#a78bfa', dark_mode: false,
    font_family: 'classic', card_style: 'editorial', announcement_bar: '',
    logo_url: null, cover_url: null, banners: null, service_cards: null,
    featured_product_ids: null, hidden_product_ids: null, require_product_image: false,
    show_prices: true, show_stock: false, pickup_enabled: true, delivery_enabled: false,
    courier_pickup_enabled: false, delivery_fee: '0', pix_key: 'chave@exemplo.com',
    card_enabled: true, pay_on_delivery_enabled: false, pix_discount_pct: 0,
    business_hours: null, always_open: true,
    phone: '', whatsapp: '11999990000', instagram: '', address: 'Rua das Flores, 10',
    pickup_address: null, politica_troca: null, whats_bloco_titulo: null, whats_bloco_texto: null,
    delivery_free_above_amount: null, delivery_eta_text: null, pickup_eta_text: null,
    delivery_pricing_mode: 'flat', custom_domain: null, custom_domain_status: null,
    bf_ativa: false,
    company_pdv_settings: {}, company_display_name: 'Loja Exemplo LTDA', company_segment: null,
  }, extra || {});
}

const vazio = () => ({
  produtos: [], total: 0, arvore: [], facetas: [], barra: [], faixa: { min: null, max: null },
  categorias: [], vinculos: [], variantes: [], mais_vendidos: [], ultimas: [], novidades: [],
  capas: [], gateway: [], resumo: null,
  empresa: { trade_name: 'Loja Exemplo', legal_name: 'Loja Exemplo LTDA', logo_url: null, cnpj: '12345678000190' },
});

// 1. Loja simples: tres pecas sem variacao, barra plana de categorias,
//    so Pix e retirada.
function loja_simples() {
  const produtos = [
    produto(1, { name: 'Sabonete de Lavanda', category: 'Banho', price: '18.00', stock_qty: '12' }),
    produto(2, { name: 'Vela Aromatica', category: 'Casa', price: '42.50', stock_qty: '3' }),
    produto(3, { name: 'Difusor de Varetas', category: 'Casa', price: '69.90', stock_qty: '1',
      created_at: '2026-11-10T12:00:00.000Z' }),
  ];
  return Object.assign(vazio(), {
    config: config(CID.simples, 'loja-simples', { site_name: 'Cheirinho Bom' }),
    produtos, total: 3,
    barra: [{ nome: 'Casa', total: 2 }, { nome: 'Banho', total: 1 }],
    faixa: { min: 18, max: 69.9 },
    novidades: produtos.slice(),
  });
}

// 2. Loja com arvore de categorias (tira na home) e promocao no ar,
//    cartao pelo Mercado Pago, entrega e campanha de Black Friday.
function loja_categorias_promocao() {
  const produtos = [
    produto(11, { name: 'Vestido Midi Floral', category: 'Vestidos', price: '139.90',
      promo_price: '97.90', promo_starts_at: '2026-11-01T03:00:00.000Z', promo_ends_at: '2026-12-01T02:59:59.000Z' }),
    produto(12, { name: 'Blusa de Linho', category: 'Blusas', price: '89.90', stock_qty: '7' }),
    produto(13, { name: 'Saia Plissada', category: 'Saias', price: '119.00', stock_qty: '2',
      created_at: '2026-11-12T12:00:00.000Z' }),
    produto(14, { name: 'Vestido Longo Festa', category: 'Vestidos', price: '259.00', stock_qty: '4' }),
    produto(15, { name: 'Blusa Cropped', category: 'Blusas', price: '69.90', stock_qty: '3' }),
    produto(16, { name: 'Saia Jeans', category: 'Saias', price: '99.90', stock_qty: '6' }),
  ];
  const arvore = [
    { id: catId(1), nome: 'Vestidos', slug: 'vestidos', path: '/vestidos', depth: 0, banner_url: null, pai_slug: null, total: 2 },
    { id: catId(2), nome: 'Blusas', slug: 'blusas', path: '/blusas', depth: 0, banner_url: 'https://r2.exemplo/banner-blusas.jpg', pai_slug: null, total: 2 },
    { id: catId(3), nome: 'Saias', slug: 'saias', path: '/saias', depth: 0, banner_url: null, pai_slug: null, total: 2 },
    { id: catId(4), nome: 'Festa', slug: 'festa', path: '/vestidos/festa', depth: 1, banner_url: null, pai_slug: 'vestidos', total: 1 },
  ];
  const categorias = [
    { id: catId(1), name: 'Vestidos', slug: 'vestidos', path: '/vestidos', depth: 0, parent_id: null, sort_order: 1 },
    { id: catId(2), name: 'Blusas', slug: 'blusas', path: '/blusas', depth: 0, parent_id: null, sort_order: 2 },
    { id: catId(3), name: 'Saias', slug: 'saias', path: '/saias', depth: 0, parent_id: null, sort_order: 3 },
    { id: catId(4), name: 'Festa', slug: 'festa', path: '/vestidos/festa', depth: 1, parent_id: catId(1), sort_order: 1 },
  ];
  const vinculos = [
    { product_id: pid(11), category_id: catId(1) },
    { product_id: pid(12), category_id: catId(2) },
    { product_id: pid(13), category_id: catId(3) },
    { product_id: pid(14), category_id: catId(4) },
    { product_id: pid(15), category_id: catId(2) },
    { product_id: pid(16), category_id: catId(3) },
  ];
  const mais = [
    Object.assign({}, produtos[0], { vendidos: 9 }),
    Object.assign({}, produtos[1], { vendidos: 6 }),
    Object.assign({}, produtos[3], { vendidos: 3 }),
    Object.assign({}, produtos[2], { vendidos: 1 }),
  ];
  return Object.assign(vazio(), {
    config: config(CID.categorias, 'loja-categorias', {
      site_name: 'Atelie Exemplo', delivery_enabled: true, delivery_fee: '9.90',
      delivery_free_above_amount: '300', delivery_eta_text: '1 a 2 dias', pix_discount_pct: 5,
      always_open: false, business_hours: JSON.stringify({
        mon: { open: '09:00', close: '18:00' }, tue: { open: '09:00', close: '18:00' },
        wed: { open: '09:00', close: '18:00' }, thu: { open: '09:00', close: '18:00' },
        fri: { open: '09:00', close: '18:00' }, sat: { open: '09:00', close: '13:00' },
      }),
      instagram: '@atelie.exemplo', bf_ativa: true,
    }),
    produtos, total: 6, arvore, categorias, vinculos,
    faixa: { min: 69.9, max: 259 },
    mais_vendidos: mais,
    novidades: produtos.slice(),
    capas: [{ caminho: '/vestidos', url: 'https://r2.exemplo/p11-640.jpg' }],
    gateway: [{ id: 'gw-1' }],
    resumo: { no_ar: 1, agendadas: 0, ate_pct: 30, ate_data: '2026-11-30', comeca_em: null, fora_da_loja: 0 },
  });
}

// 3. Loja com variacao (tamanho e cor), facetas e "Ultimas unidades".
function loja_variacao() {
  const produtos = [
    produto(21, { name: 'Camiseta Basica', category: 'Camisetas', price: '59.90', stock_qty: '0' }),
    produto(22, { name: 'Tenis Casual', category: 'Calcados', price: '199.90', stock_qty: '0' }),
    produto(23, { name: 'Bone Aba Curva', category: 'Acessorios', price: '49.90', stock_qty: '2', stock_min: '2' }),
  ];
  const variante = (n, produtoN, sku, valores, extra) => Object.assign({
    id: vid(n), product_id: pid(produtoN), sku_suffix: sku, color_name: null,
    price_override: null, stock_qty: '3', is_active: true, image_url: null, image_thumb_url: null,
    promo_price: null, promo_starts_at: null, promo_ends_at: null,
    produto_price: produtos.find((p) => p.id === pid(produtoN)).price,
    values: valores,
  }, extra || {});
  const variantes = [
    variante(1, 21, 'P/PRETO', [{ attribute: 'Cor', value: '#000000' }, { attribute: 'Tamanho', value: 'P' }], { color_name: 'Preto' }),
    variante(2, 21, 'M/PRETO', [{ attribute: 'Cor', value: '#000000' }, { attribute: 'Tamanho', value: 'M' }], { color_name: 'Preto', stock_qty: '0' }),
    variante(3, 21, 'G/BRANCO', [{ attribute: 'Cor', value: '#FFFFFF' }, { attribute: 'Tamanho', value: 'G' }], { color_name: 'Branco', price_override: '64.90' }),
    variante(4, 22, '38', [{ attribute: 'Tamanho', value: '38' }], { stock_qty: '1' }),
    variante(5, 22, '40', [{ attribute: 'Tamanho', value: '40' }], { stock_qty: '2' }),
  ];
  return Object.assign(vazio(), {
    config: config(CID.variacao, 'loja-variacao', {
      site_name: 'Esporte Exemplo', show_stock: true, pix_key: null,
      pay_on_delivery_enabled: true, delivery_enabled: true, delivery_fee: '5',
    }),
    produtos, total: 3, variantes,
    barra: [{ nome: 'Acessorios', total: 1 }, { nome: 'Calcados', total: 1 }, { nome: 'Camisetas', total: 1 }],
    facetas: [
      { atributo: 'Cor', valor: '#000000', total: 1 },
      { atributo: 'Cor', valor: '#FFFFFF', total: 1 },
      { atributo: 'Tamanho', valor: 'P', total: 1 },
      { atributo: 'Tamanho', valor: 'G', total: 1 },
      { atributo: 'Tamanho', valor: '38', total: 1 },
      { atributo: 'Tamanho', valor: '40', total: 1 },
    ],
    faixa: { min: 49.9, max: 199.9 },
    ultimas: [
      Object.assign({}, produtos[2], { restam: '2', vendidos: 4 }),
      Object.assign({}, produtos[1], { restam: '3', vendidos: 2 }),
      Object.assign({}, produtos[0], { restam: '3', vendidos: 1 }),
    ],
    novidades: produtos.slice(),
  });
}

module.exports = {
  AGORA,
  cenarios: { loja_simples, loja_categorias_promocao, loja_variacao },
};
