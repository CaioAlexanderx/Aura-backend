// ============================================================
// AURA. — Desconto da venda na NFC-e (13/11/2026)
//
// Defeito (revisao de 12/11): a NFC-e do Caixa ignorava o desconto da venda
// (cupom + desconto manual = sales.discount_amount). O app mandava os itens
// pelo preco cheio e o /nfce/emit somava so os itens. Pagamento unico: a nota
// saia pelo bruto (o cliente pagou menos). Pagamento dividido: a soma dos
// pagamentos nao fechava e o /emit devolvia 400 (nota nao saia).
//
// REGRA: a venda gravada e a fonte da verdade. Com sale_id e desconto gravado
// (> 0), os itens da nota saem de sale_items e o desconto e rateado entre as
// linhas, proporcional ao valor de cada linha:
//   - vDesc por item em centavos inteiros; a sobra do arredondamento vai para
//     a maior linha (empate: a primeira); se ela nao comportar, a seguinte;
//   - soma(vProd) - soma(vDesc) = total da venda, entao os pagamentos fecham;
//   - o lapis (sale_items.discount) ja esta no total da linha: entra no vDesc
//     do proprio item uma vez so, e a base do rateio e a linha JA com o lapis
//     (total_price) — nada e descontado duas vezes;
//   - frete (linha sem produto chamada "Frete", services/entregaDaVenda.js)
//     nao recebe desconto: o desconto e sobre produtos. Segue como linha da
//     nota, igual a hoje;
//   - servico (unit 'srv') entra no rateio como qualquer linha da venda; o
//     /emit tira o servico da nota depois (services/nfceSemServico.js) e os
//     pagamentos sao reduzidos na proporcao, como ja era;
//   - desconto que alcanca o valor dos produtos: a nota ficaria sem valor de
//     mercadoria. Recusa gentil antes de reservar numero (ver
//     MENSAGEM_DESCONTO_TOTAL).
//
// Sem venda gravada para conferir (sem sale_id, venda de outra loja, leitura
// falhou), vale o `discount_amount` que o app manda no corpo, rateado do
// mesmo jeito nos itens do corpo. Venda gravada vence o corpo sempre.
//
// Venda SEM desconto (discount_amount = 0) nao passa por aqui: o /emit usa os
// itens do corpo, exatamente como antes (payload e XML identicos, fixture em
// __tests__/fixtures/nfceDescontoDaVenda/golden.json).
//
// Funcoes puras + uma leitura (lerVendaParaNota). Usadas por routes/nfce.js.
// ============================================================
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ehUuid = (v) => typeof v === 'string' && UUID.test(v);

const NOME_DO_FRETE = 'frete';

/** Reais -> centavos inteiros (mesmo arredondamento do xmlBuilder.round2). */
function centavos(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function nomeNormalizado(it) {
  return String((it && (it.product_name || it.product_name_snapshot || it.name)) || '')
    .trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Linha de frete: sem produto do cadastro e chamada "Frete" (o Caixa manda
 *  product_id 'frete' no corpo; a venda gravada tem product_id NULL). */
function ehFrete(it) {
  return !!it && !ehUuid(it.product_id) && nomeNormalizado(it) === NOME_DO_FRETE;
}

/**
 * Rateia `descontoC` (centavos) entre as linhas elegiveis, proporcional a
 * `bases` (centavos). Parte inteira por linha (piso) e a sobra, centavo a
 * centavo, na maior linha; se ela nao comportar, na seguinte maior.
 * Nenhuma linha recebe mais que a propria base.
 *
 * @param {number[]} bases       valor de cada linha em centavos (>= 0)
 * @param {number} descontoC     desconto total em centavos (0 < d < soma)
 * @param {boolean[]} elegivel   false = linha fica fora (frete)
 * @returns {number[]} parte do desconto de cada linha, em centavos
 */
function ratearDesconto(bases, descontoC, elegivel) {
  const partes = bases.map(() => 0);
  const idx = bases.map((_, i) => i).filter((i) => elegivel[i] && bases[i] > 0);
  const soma = idx.reduce((s, i) => s + bases[i], 0);
  if (!(descontoC > 0) || soma <= 0) return partes;
  const d = BigInt(Math.min(descontoC, soma));
  const S = BigInt(soma);
  let distribuido = 0;
  for (const i of idx) {
    partes[i] = Number((BigInt(bases[i]) * d) / S); // piso, sem estouro de float
    distribuido += partes[i];
  }
  let sobra = Number(d) - distribuido;
  const maiores = [...idx].sort((a, b) => (bases[b] - bases[a]) || (a - b));
  for (const i of maiores) {
    if (sobra <= 0) break;
    const folga = bases[i] - partes[i];
    const add = Math.min(folga, sobra);
    partes[i] += add;
    sobra -= add;
  }
  return partes;
}

/**
 * Itens da nota a partir das linhas da venda + o desconto da venda.
 *
 * Cada linha: { product_id, product_name, quantity, unit_price, lapisC }
 * (lapisC = desconto proprio do item em centavos, ja dentro do total da
 * linha). Devolve os itens no formato do corpo do /emit, com `discount` =
 * lapis + parte do desconto da venda (vDesc do item), ou { erro } quando o
 * desconto alcanca o valor dos produtos.
 */
function aplicarDescontoNasLinhas(linhas, descontoVenda) {
  const descontoC = centavos(descontoVenda);
  const brutos = linhas.map((l) => centavos(Math.round(Number(l.quantity) * Number(l.unit_price) * 100) / 100));
  const lapis = linhas.map((l, i) => Math.min(Math.max(l.lapisC || 0, 0), brutos[i]));
  const bases = brutos.map((b, i) => b - lapis[i]);
  const elegivel = linhas.map((l) => !ehFrete(l));
  const somaProdutos = bases.reduce((s, b, i) => s + (elegivel[i] ? b : 0), 0);

  if (descontoC >= somaProdutos) {
    return {
      erro: 'desconto_total',
      descontoC,
      produtosC: somaProdutos,
    };
  }

  const partes = ratearDesconto(bases, descontoC, elegivel);
  const itens = linhas.map((l, i) => {
    const vDescC = lapis[i] + partes[i];
    const it = { ...l.original };
    it.product_id = l.product_id;
    it.product_name = l.product_name;
    it.quantity = Number(l.quantity);
    it.unit_price = Number(l.unit_price);
    delete it.price;
    if (vDescC > 0) it.discount = vDescC / 100; else delete it.discount;
    return it;
  });
  return { itens, descontoC, partes };
}

/** Linhas gravadas (sale_items) -> linhas do rateio. */
function linhasDaVendaGravada(saleItems) {
  return saleItems.map((r) => {
    const quantity = Number(r.quantity);
    const unit_price = Number(r.unit_price);
    const bruto = centavos(Math.round(quantity * unit_price * 100) / 100);
    // Lapis = o que o total da linha tem a menos que o bruto. Lido do total
    // gravado (e nao so de sale_items.discount) para a nota fechar no
    // centavo com o que a venda cobrou.
    const lapisC = Math.max(0, bruto - centavos(r.total_price));
    return {
      product_id: r.product_id || null,
      product_name: r.product_name_snapshot || r.product_name || 'Item',
      quantity, unit_price, lapisC,
      original: {},
    };
  });
}

/** Itens do corpo do /emit -> linhas do rateio (o discount do item e o lapis). */
function linhasDoCorpo(itens) {
  return (Array.isArray(itens) ? itens : []).map((it) => ({
    product_id: it.product_id,
    product_name: it.product_name || it.name,
    quantity: Number(it.quantity) || 1,
    unit_price: Number(it.unit_price !== undefined ? it.unit_price : it.price) || 0,
    lapisC: centavos(it.discount),
    original: { ...it },
  }));
}

// Atributos fiscais que o corpo pode trazer e a venda nao grava (ex.: NCM
// revisado na reemissao pela tela de Notas). Preco, quantidade e desconto
// NUNCA vem do corpo quando a venda gravada vale.
const CAMPOS_FISCAIS_DO_CORPO = ['ncm', 'cfop', 'unit', 'barcode', 'description', 'nota_fiscal'];

function chaveDoItem(it) {
  const pid = it && it.product_id != null ? String(it.product_id).split('__')[0] : '';
  return ehUuid(pid) ? `p:${pid.toLowerCase()}` : `n:${nomeNormalizado(it)}`;
}

/** Leva os atributos fiscais do corpo para as linhas da venda (pareando por
 *  produto, na ordem; linha sem produto pareia pelo nome). */
function levarCamposFiscais(linhas, itensDoCorpo) {
  const livres = new Map();
  for (const it of Array.isArray(itensDoCorpo) ? itensDoCorpo : []) {
    const k = chaveDoItem(it);
    if (!livres.has(k)) livres.set(k, []);
    livres.get(k).push(it);
  }
  for (const l of linhas) {
    const fila = livres.get(chaveDoItem(l));
    const par = fila && fila.shift();
    if (!par) continue;
    for (const c of CAMPOS_FISCAIS_DO_CORPO) {
      if (par[c] !== undefined && par[c] !== null && par[c] !== '') l.original[c] = par[c];
    }
  }
  return linhas;
}

/**
 * Le a venda desta loja (multi-CNPJ: company_id = a loja que emite).
 * null = nao achou / sem desconto a aplicar / leitura falhou (o /emit segue
 * com o corpo, como sempre). Nunca derruba a emissao.
 */
async function lerVendaParaNota(db, companyId, saleId) {
  if (!ehUuid(String(saleId || ''))) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, total_amount, discount_amount FROM sales WHERE id = $1 AND company_id = $2`,
      [saleId, companyId]
    );
    if (!rows.length) return null;
    const venda = rows[0];
    const descontoC = centavos(venda.discount_amount);
    if (!(descontoC > 0)) return { venda, descontoC: 0, itens: null };
    const { rows: itens } = await db.query(
      `SELECT product_id, variant_id, quantity, unit_price, discount, total_price, product_name_snapshot
         FROM sale_items WHERE sale_id = $1 ORDER BY id`,
      [saleId]
    );
    return { venda, descontoC, itens };
  } catch (e) {
    console.error('[nfce] leitura da venda para o desconto falhou (segue com o corpo):', e.message);
    return null;
  }
}

/**
 * Itens da nota com o desconto da venda.
 *
 * @returns {null | { itens: object[], descontoC: number, origem: string }
 *                | { erro: 'desconto_total', descontoC, produtosC }}
 *   null = nada a fazer: os itens do corpo seguem como vieram (venda sem
 *   desconto, venda nao achada, leitura falhou).
 */
async function itensComDescontoDaVenda(db, { companyId, saleId, itensDoCorpo, descontoDoCorpo }) {
  const lida = await lerVendaParaNota(db, companyId, saleId);
  if (!lida) {
    // Sem venda gravada para conferir (sem sale_id, venda nao achada nesta
    // loja ou leitura falhou): vale o desconto que o app mandou, rateado nos
    // itens do corpo. Sem desconto no corpo: nada muda.
    if (!(centavos(descontoDoCorpo) > 0)) return null;
    const r = aplicarDescontoNasLinhas(linhasDoCorpo(itensDoCorpo), Number(descontoDoCorpo));
    if (r.erro) return r;
    return { itens: r.itens, descontoC: r.descontoC, origem: 'corpo' };
  }
  if (!(lida.descontoC > 0)) return null;
  if (!Array.isArray(lida.itens) || lida.itens.length === 0) {
    console.warn(`[nfce] venda ${saleId} com desconto e sem itens gravados: segue com o corpo`);
    return null;
  }
  const linhas = levarCamposFiscais(linhasDaVendaGravada(lida.itens), itensDoCorpo);
  const r = aplicarDescontoNasLinhas(linhas, lida.descontoC / 100);
  if (r.erro) return r;

  // Conferencia: soma das linhas - desconto = total gravado. Diferenca so vai
  // pro log (a nota sai com o que a venda gravou em linhas e desconto).
  const somaC = linhas.reduce((s, l) => s + centavos(Math.round(l.quantity * l.unit_price * 100) / 100) - l.lapisC, 0);
  const totalC = centavos(lida.venda.total_amount);
  if (Math.abs(somaC - lida.descontoC - totalC) > 1) {
    console.warn(`[nfce] venda ${saleId}: linhas (${somaC}) - desconto (${lida.descontoC}) != total (${totalC}) em centavos`);
  }
  return { itens: r.itens, descontoC: lida.descontoC, origem: 'venda_gravada' };
}

const MENSAGEM_DESCONTO_TOTAL = 'O desconto desta venda cobre todo o valor dos produtos, '
  + 'entao a nota fiscal ficaria sem valor a pagar e nao pode ser emitida. '
  + 'A venda continua registrada normalmente. Se o cliente precisar de nota, '
  + 'registre a venda com o valor cobrado de fato.';

module.exports = {
  ehUuid, ehFrete, centavos,
  ratearDesconto, aplicarDescontoNasLinhas, linhasDaVendaGravada, linhasDoCorpo, levarCamposFiscais,
  lerVendaParaNota, itensComDescontoDaVenda,
  MENSAGEM_DESCONTO_TOTAL,
};
