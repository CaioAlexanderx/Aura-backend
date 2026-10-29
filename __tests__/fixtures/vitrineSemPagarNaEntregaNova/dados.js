// Dados das lojas usadas no teste de HTML identico (tq-44, 29/10/2026).
// Os .html ao lado foram gerados com o codigo de origin/main ANTES do
// "pagar na entrega" com formas e troco. Lojas que nao ligam as formas
// novas tem de continuar produzindo exatamente estes bytes.
'use strict';

const produto = {
  id: 'p1', name: 'Cerveja 600 ml', price: 12.5, stock_qty: 10, image_url: null,
  category: 'Bebidas', is_active: true, variants: [],
};

const base = () => ({
  site: {
    name: 'Loja Exemplo', primary_color: '#7c3aed', accent_color: '#a78bfa', logo_url: null,
    banners: [], service_cards: [], is_open_now: true, next_open_text: '', next_open_when: '',
    horario_resumo: 'Todos os dias, 18h às 3h',
  },
  contact: { phone: '', whatsapp: '11999990000', address: 'Rua A, 1', redes: [] },
  business_hours: {}, always_open: false,
  products: [produto], categories: [], pix_discount_pct: 0,
});

module.exports = {
  so_pix: () => ({ ...base(), settings: {
    show_prices: true, pickup_enabled: true, delivery_enabled: false, delivery_fee: 0,
    has_pix: true, has_card: false, pay_on_delivery_enabled: false, delivery_pricing_mode: 'flat',
  } }),
  na_entrega_legado: () => ({ ...base(), settings: {
    show_prices: true, pickup_enabled: true, delivery_enabled: true, delivery_fee: 6,
    has_pix: true, has_card: true, card_max_installments: 3, pay_on_delivery_enabled: true,
    delivery_eta_text: '30 a 45 min', delivery_pricing_mode: 'flat',
  }, pix_discount_pct: 5 }),
  so_na_entrega: () => ({ ...base(), settings: {
    show_prices: true, pickup_enabled: false, delivery_enabled: true, delivery_fee: 0,
    has_pix: false, has_card: false, pay_on_delivery_enabled: true, delivery_pricing_mode: 'flat',
  } }),
};
