// ============================================================
// Dados de uma loja de roupa para as fixtures byte a byte da vitrine
// (tq-58, 29/10/2026).
//
// As fixtures .html ao lado foram geradas com o codigo de origin/main
// ANTES do tq-58 (textos pela frente da conta), com este mesmo objeto, o
// ano travado em ANO_DA_FIXTURE e o endereco padrao da API. O teste
// __tests__/textosDaFrente.test.js renderiza de novo e compara byte a
// byte: loja de roupa (frente vazia ou 'varejo') nao pode mudar nada.
//
// Inclui produto com descricao para o script da pagina do produto (onde
// mora "Sobre esta peca") e WhatsApp para o bloco "Duvida sobre tamanho
// ou modelo?".
// ============================================================
'use strict';

const ANO_DA_FIXTURE = '2026-10-29T12:00:00Z';

function dados(extra) {
  return Object.assign({
    site: {
      name: 'Loja Modelo', tagline: 'Moda que veste a semana', primary_color: '#7a1f3a',
      logo_url: 'https://x/logo.jpg', cnpj_formatado: '12.345.678/0001-90',
      announcement_auto: 'Troca em até 7 dias', horario_resumo: 'Seg a sáb, 9h às 18h',
      banners: [{ headline: 'Peças da estação', cta: 'Ver a coleção', cta_url: '#cat=/vestidos', image_url: 'https://x/b.jpg' }],
      service_cards: [{ icon: 'shield', title: 'Compra segura', body: 'Pix ou cartão' }],
      is_open_now: true,
    },
    contact: { whatsapp: '(34) 99999-9999', address: 'Av. Central, 100' },
    settings: { has_pix: true, pickup_enabled: true },
    products: [{
      id: 'p1', name: 'Vestido Midi', description: 'Viscose com forro.', price: 199.9,
      category: 'Vestidos', image_url: 'https://x/p1.jpg', in_stock: true, variants: [],
    }],
    categories: [], categorias_arvore: [], tira_de_categorias: [],
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
  }, extra || {});
}

module.exports = { dados, ANO_DA_FIXTURE };
