// ============================================================
// AURA. — Entrada de mercadoria: contas puras (03/11/2026)
//
// Sem banco: as rotas (src/routes/productSuppliers.js) e os testes usam.
// ============================================================
'use strict';

const round = (n, casas) => {
  const f = 10 ** casas;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};

function numeroPositivo(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Custo médio ponderado depois de uma entrada.
 *
 * - O estoque NEGATIVO de antes não entra na média (vendeu sem ter; o custo
 *   daquelas peças nunca existiu): base = max(estoque, 0).
 * - Sem custo na entrada (quem não vê custo, ou não informou): a média não
 *   muda.
 * - Sem custo anterior, ou nada em estoque: a média é o custo da entrada.
 */
function custoMedioPonderado({ estoqueAntes, custoAtual, quantidade, custoUnitario }) {
  const q = numeroPositivo(quantidade);
  const c = numeroPositivo(custoUnitario);
  const atual = numeroPositivo(custoAtual);
  if (!q || !c) return atual === null ? null : round(atual, 4);
  const base = Math.max(Number(estoqueAntes) || 0, 0);
  if (atual === null || base === 0) return round(c, 4);
  return round((base * atual + q * c) / (base + q), 4);
}

/**
 * Normaliza o corpo do POST de entrada. Devolve { erro } ou
 * { itens: [{ variant_id|null, quantidade }], total, custoUnitario, ... }.
 */
function lerEntrada(body) {
  const b = body || {};
  let itens;
  if (Array.isArray(b.items) && b.items.length) {
    itens = [];
    for (const it of b.items) {
      const q = numeroPositivo(it && it.quantity);
      if (!q) continue;
      if (!it.variant_id) return { erro: 'Cada item da grade precisa da variante' };
      itens.push({ variant_id: String(it.variant_id), quantidade: q });
    }
    if (!itens.length) return { erro: 'Informe a quantidade que chegou' };
    const ids = itens.map((i) => i.variant_id);
    if (new Set(ids).size !== ids.length) return { erro: 'Variante repetida na entrada' };
  } else {
    const q = numeroPositivo(b.quantity);
    if (!q) return { erro: 'Informe a quantidade que chegou' };
    itens = [{ variant_id: null, quantidade: q }];
  }
  const total = round(itens.reduce((s, i) => s + i.quantidade, 0), 3);
  const nota = b.invoice_number ? String(b.invoice_number).trim().slice(0, 40) : null;
  return {
    itens,
    total,
    custoUnitario: numeroPositivo(b.unit_cost),
    nota: nota || null,
    atualizarCusto: b.update_cost !== false,
  };
}

/**
 * Normaliza a lista do PUT de fornecedores do produto. `cost` AUSENTE
 * (chave nem veio) = manter o custo gravado — quem não vê custo tem a chave
 * tirada do corpo pelo middleware e não pode apagar o custo dos outros.
 * Exatamente um principal: o marcado; se nenhum, o principal anterior se
 * continuar na lista; senão, o primeiro.
 */
function lerListaDeFornecedores(body, principalAnterior) {
  const lista = Array.isArray(body && body.suppliers) ? body.suppliers : null;
  if (!lista) return { erro: 'suppliers é obrigatório (pode ser lista vazia)' };
  const vistos = new Set();
  const itens = [];
  for (const it of lista) {
    if (!it || !it.supplier_id) return { erro: 'Cada linha precisa do fornecedor' };
    const id = String(it.supplier_id);
    if (vistos.has(id)) continue;
    vistos.add(id);
    const temCusto = Object.prototype.hasOwnProperty.call(it, 'cost');
    itens.push({
      supplier_id: id,
      temCusto,
      custo: temCusto ? numeroPositivo(it.cost) : null,
      codigo: it.supplier_code ? String(it.supplier_code).trim().slice(0, 60) || null : null,
      principal: it.is_main === true,
    });
  }
  if (itens.length > 30) return { erro: 'No máximo 30 fornecedores por produto' };
  if (itens.length) {
    let idx = itens.findIndex((i) => i.principal);
    if (idx < 0 && principalAnterior) idx = itens.findIndex((i) => i.supplier_id === String(principalAnterior));
    if (idx < 0) idx = 0;
    itens.forEach((i, k) => { i.principal = k === idx; });
  }
  return { itens };
}

module.exports = { custoMedioPonderado, lerEntrada, lerListaDeFornecedores, numeroPositivo, round };
