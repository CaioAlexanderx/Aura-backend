// ============================================================
// AURA. — A peça do destaque da vitrine Studio (Fase 5, 25/09/2026)
//
// Sem banner, a home da vitrine Studio mostra a peça com o mockup
// girando (mockup 05, tela 2). A automática é a primeira com prévia 3D;
// a lojista escolhe outra na aba Design e o PUT do canal digital grava
// `hero_product_id` (migration 356).
//
// Aqui mora só a leitura do corpo: o que conta como "automático", o que
// é um id e o que é erro. A pergunta "essa peça é da loja?" é do banco,
// e a rota faz com a MESMA visibilidade da vitrine.
// ============================================================
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lê `hero_product_id` do corpo do PUT.
 *
 *  - ausente            → { definido: false } (não mexe na coluna)
 *  - null, '' ou espaço → { definido: true, valor: null } (automático)
 *  - uuid               → { definido: true, valor: '<uuid em minúsculas>' }
 *  - qualquer outra coisa → { erro }
 */
function lerPecaDoDestaque(body) {
  if (!body || typeof body !== 'object' || !('hero_product_id' in body) || body.hero_product_id === undefined) {
    return { definido: false };
  }
  const v = body.hero_product_id;
  if (v === null) return { definido: true, valor: null };
  if (typeof v !== 'string') return { erro: 'A peça do destaque precisa ser um produto da loja.' };
  const s = v.trim();
  if (!s) return { definido: true, valor: null };
  if (!UUID.test(s)) return { erro: 'A peça do destaque precisa ser um produto da loja.' };
  return { definido: true, valor: s.toLowerCase() };
}

module.exports = { lerPecaDoDestaque };
