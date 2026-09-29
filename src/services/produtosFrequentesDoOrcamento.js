// ============================================================
// Studio · "Mais usados" e "Recentes" do catálogo do orçamento (29/09/2026)
//
// O modal novo do orçamento abre o catálogo sem a lojista digitar nada,
// com duas faixas no topo. A fonte são os itens dos orçamentos e dos
// pedidos Studio DA EMPRESA (multi-CNPJ: cada CNPJ vê só o que ele vendeu
// e orçou), numa janela de dias.
//
// Um pedido que nasceu de um orçamento não conta duas vezes: o SQL só
// traz pedidos sem orçamento de origem.
// ============================================================
'use strict';

const DIAS_PADRAO = 90;
const LIMITE_PADRAO = 8;

/** ?days= entre 7 e 365 (padrão 90). */
function lerDias(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return DIAS_PADRAO;
  return Math.max(7, Math.min(365, n));
}

/** ?limit= entre 1 e 20 (padrão 8). */
function lerLimite(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return LIMITE_PADRAO;
  return Math.max(1, Math.min(20, n));
}

function quando(v) {
  const t = v ? new Date(v).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Das linhas agregadas por produto ({product_id, usos, ultima_vez}) saem
 * as duas listas: mais usados (mais orçamentos/pedidos, desempate pelo
 * mais recente) e recentes (último uso primeiro). As duas podem repetir
 * produto: quem mostra decide se tira os repetidos.
 */
function listasDeProdutosFrequentes(linhas, limite) {
  const lim = lerLimite(limite);
  const limpas = (linhas || [])
    .filter((r) => r && r.product_id)
    .map((r) => ({
      product_id: String(r.product_id),
      usos: parseInt(r.usos, 10) || 0,
      ultima_vez: r.ultima_vez ? new Date(r.ultima_vez).toISOString() : null,
    }));
  const maisUsados = limpas
    .slice()
    .sort((a, b) => (b.usos - a.usos) || (quando(b.ultima_vez) - quando(a.ultima_vez)))
    .slice(0, lim);
  const recentes = limpas
    .slice()
    .sort((a, b) => quando(b.ultima_vez) - quando(a.ultima_vez))
    .slice(0, lim);
  return { mais_usados: maisUsados, recentes };
}

/**
 * Modelo de mockup do item do orçamento (studio_quote_items
 * .visual_template_key, migration 364). Vazio = null = herda do produto.
 * O app grava "sem-mockup" quando a lojista tira o modelo só naquele
 * orçamento (SEM_MODELO em components/studio/orcamentoVideo/modeloDaPeca.ts).
 */
function lerModeloDoItem(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 120) return null;
  return s;
}

module.exports = {
  DIAS_PADRAO,
  LIMITE_PADRAO,
  lerDias,
  lerLimite,
  listasDeProdutosFrequentes,
  lerModeloDoItem,
};
