// ============================================================
// AURA. — Plano de gravação da grade (cor x tamanho) de um produto
// 10/11/2026 — fix(estoque): editar a grade não deixa estoque preso
//
// Até aqui o PUT /variations desativava TODAS as variantes ativas e criava
// todas de novo a cada Salvar. Medido na Finesse (10/11/2026): 9.845
// variantes para 585 produtos, 8.146 das 8.167 inativas nasceram desse
// rewrite, e 2.862 inativas ficaram com stock_qty > 0 (7.702 peças) —
// a maioria cópia congelada do que foi levado, mas 61 combinações com 208
// peças saíram da grade sem aviso nenhum, e cada rewrite também perdia o
// que não era copiado (price_override, promoção, miniatura da foto).
//
// Regras deste plano (função pura; quem grava é a rota):
//   1. A combinação que continua na grade (mesmo hex, sem diferença de
//      caixa, e mesmo tamanho) é ATUALIZADA na mesma linha — mesmo id,
//      mesmo histórico, nada fica para trás.
//   2. Combinação nova é criada.
//   3. Combinação que sai da grade com estoque > 0 só sai com confirmação
//      explícita (confirmar_remocao_com_estoque). Sem ela, o plano volta
//      `bloqueio` e a rota responde 409 com a mensagem gentil.
//   4. Célula que a lojista não mexeu (valor igual ao que o editor leu,
//      `matrizLida`) mantém o estoque do banco: uma venda feita enquanto o
//      editor estava aberto não "volta" para a prateleira, e uma entrada
//      não some.
//   5. Duas variantes ativas para a mesma combinação (legado da corrida
//      de 01/06) — fica a mais nova, que é a que o GET mostra; as outras
//      saem como antes (o rewrite antigo já as desativava a cada Salvar).
// ============================================================
'use strict';

function chaveNormalizada(hex, tamanho) {
  return (hex ? String(hex).toUpperCase() : '') + '|' + (tamanho == null ? '' : String(tamanho));
}

function numeroDaMatriz(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function pecas(n) {
  return n === 1 ? '1 peça' : n + ' peças';
}

function rotuloDaCombinacao(r) {
  const partes = [];
  if (r.colorHex) partes.push(r.colorName || r.colorHex);
  if (r.sizeValue) partes.push(r.sizeValue);
  return partes.join(' · ') || 'Esta variação';
}

/** Mensagem que a lojista lê quando tenta tirar da grade algo com estoque. */
function mensagemDaRemocao(removidas) {
  const lista = removidas || [];
  if (lista.length === 0) return null;
  if (lista.length === 1) {
    const r = lista[0];
    return rotuloDaCombinacao(r) + ' ainda tem ' + pecas(r.stock)
      + '. Zere o estoque ou transfira antes de remover.';
  }
  const total = lista.reduce((acc, r) => acc + r.stock, 0);
  const nomes = lista.slice(0, 4).map((r) => rotuloDaCombinacao(r) + ' (' + pecas(r.stock) + ')');
  const resto = lista.length > 4 ? ' e mais ' + (lista.length - 4) : '';
  return 'Estas cores/tamanhos ainda têm ' + pecas(total) + ': ' + nomes.join(', ') + resto
    + '. Zere o estoque ou transfira antes de remover.';
}

/**
 * @param o.existentes  variantes ATIVAS do produto, em ordem de criação:
 *                      [{ id, colorHex, sizeValue, stock, colorName }]
 * @param o.combinacoes o que o PUT pediu: [{ colorHex, sizeValue, stock, ... }]
 * @param o.matrizLida  (opcional) { "hex|tam": n } que o editor leu ao abrir
 * @param o.confirmarRemocao true = a lojista confirmou tirar com estoque
 * @returns {{ atualizar, criar, remover, duplicadas, removidasComEstoque, bloqueio }}
 */
function planejarGrade(o) {
  const existentes = (o && o.existentes) || [];
  const combinacoes = (o && o.combinacoes) || [];
  const lida = (o && o.matrizLida && typeof o.matrizLida === 'object') ? o.matrizLida : null;
  const confirmar = !!(o && o.confirmarRemocao);

  // Lida normalizada (hex em caixa alta) para casar com a chave do banco.
  const lidaNorm = {};
  if (lida) {
    for (const k of Object.keys(lida)) {
      const i = k.indexOf('|');
      const nk = i < 0 ? k : k.slice(0, i).toUpperCase() + k.slice(i);
      lidaNorm[nk] = lida[k];
    }
  }

  // Mais nova vence (é a que o GET mostra: matrix[key] sobrescreve em
  // ordem de created_at ASC).
  const porChave = new Map();
  const duplicadas = [];
  for (const v of existentes) {
    const k = chaveNormalizada(v.colorHex, v.sizeValue);
    if (porChave.has(k)) duplicadas.push(porChave.get(k));
    porChave.set(k, v);
  }

  const atualizar = [];
  const criar = [];
  const usadas = new Set();
  for (const c of combinacoes) {
    const k = chaveNormalizada(c.colorHex, c.sizeValue);
    const atual = porChave.get(k);
    if (atual && !usadas.has(k)) {
      usadas.add(k);
      let stock = numeroDaMatriz(c.stock);
      const intocada = Object.prototype.hasOwnProperty.call(lidaNorm, k)
        && numeroDaMatriz(lidaNorm[k]) === stock;
      if (intocada) stock = numeroDaMatriz(atual.stock);
      atualizar.push({ ...c, id: atual.id, stock, manteveDoBanco: intocada });
    } else if (!atual) {
      criar.push({ ...c, stock: numeroDaMatriz(c.stock) });
    }
    // (combinação repetida no próprio pedido: a primeira vence, como antes)
  }

  const remover = [];
  for (const [k, v] of porChave.entries()) {
    if (!usadas.has(k)) remover.push(v);
  }
  const removidasComEstoque = remover
    .filter((v) => numeroDaMatriz(v.stock) > 0)
    .map((v) => ({ id: v.id, colorHex: v.colorHex || null, colorName: v.colorName || null, sizeValue: v.sizeValue || null, stock: numeroDaMatriz(v.stock) }));

  const bloqueio = removidasComEstoque.length > 0 && !confirmar
    ? { mensagem: mensagemDaRemocao(removidasComEstoque), removidas: removidasComEstoque }
    : null;

  return { atualizar, criar, remover, duplicadas, removidasComEstoque, bloqueio };
}

module.exports = { planejarGrade, mensagemDaRemocao, chaveNormalizada };
