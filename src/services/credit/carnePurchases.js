// ============================================================
// AURA. — Carnê: "O que foi comprado" (10/10/2026)
//
// O carnê impresso passa a listar os produtos que o cronograma cobra. O
// caminho óbvio (parcela -> venda -> itens) não serve: a parcela muitas vezes
// NÃO aponta para a venda (credit_installments.sale_id nulo — a loja vende no
// Caixa e depois parcela pela renegociação). Quem sabe o que foi comprado é o
// débito do razão (customer_credit_transactions type='debit'), que carrega o
// sale_id e o account_id (carnê).
//
// Regra (decidida com o dono do produto): a lista traz só as compras DAQUELE
// carnê. Para cada grupo de parcelas:
//   alvo  = soma de amount_due das parcelas NÃO canceladas do grupo
//   lista = débitos do mesmo account_id, do mais NOVO para o mais ANTIGO,
//           acumulando `amount` até atingir o alvo (o débito que cruza o alvo
//           entra inteiro).
// Por que do mais novo: os pagamentos quitam por FIFO, então o que o
// cronograma atual ainda cobra são as compras mais recentes. Um carnê antigo
// já quitado e renegociado não volta para o papel.
//
// Tudo aqui é função pura: sem banco, sem relógio. A rota (print.js) consulta
// e despacha.
// ============================================================
'use strict';

/** Chave do grupo de parcelas/débitos sem carnê (account_id nulo). */
const NO_ACCOUNT_KEY = '__none__';

/** Tolerância de centavos na comparação com o alvo. */
const CENT_TOLERANCE = 0.005;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function groupKey(accountId) {
  return accountId || NO_ACCOUNT_KEY;
}

function timeOf(v) {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Alvo de um grupo: soma do amount_due das parcelas não canceladas.
 * @param {Array<object>} installments parcelas JÁ filtradas para o grupo
 */
function groupTarget(installments) {
  return round2((installments || [])
    .filter(i => i && i.status !== 'cancelled')
    .reduce((s, i) => s + num(i.amount_due), 0));
}

/**
 * Escolhe os débitos que o cronograma do grupo cobre.
 *
 * @param {Array<object>} debits débitos JÁ filtrados para o grupo
 *        ({ id, amount, created_at, ... }), em qualquer ordem
 * @param {number} target alvo em R$ (ver groupTarget)
 * @returns {Array<object>} os débitos escolhidos, em ordem CRONOLÓGICA
 */
function selectDebitsForTarget(debits, target) {
  const alvo = num(target);
  if (alvo <= CENT_TOLERANCE) return [];

  // Mais novo primeiro. Empate de data: mantém a ordem de chegada (sort
  // estável), para o resultado não depender de detalhe do motor.
  const ordenados = (debits || [])
    .filter(d => d && num(d.amount) > CENT_TOLERANCE)
    .slice()
    .sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at));

  const escolhidos = [];
  let acumulado = 0;
  for (const d of ordenados) {
    if (acumulado >= alvo - CENT_TOLERANCE) break;
    escolhidos.push(d);
    acumulado = round2(acumulado + num(d.amount));
  }
  return escolhidos.reverse();
}

/**
 * Transforma os débitos escolhidos nas linhas do papel.
 *   - débito com venda: uma linha por item da venda;
 *   - débito sem venda (lançamento manual etc.): uma linha com `notes`;
 *   - débito com venda cujos itens não vieram (venda apagada, consulta que
 *     falhou): uma linha só, com o valor do débito — melhor do que sumir com
 *     a compra do papel.
 *
 * @param {Array<object>} debits em ordem cronológica
 * @param {Object<string, Array<object>>} itemsBySale sale_id -> itens
 *        ({ product_name, quantity, unit_price, total_price })
 * @returns {Array<{date:any, description:string, quantity:number|null, amount:number, manual:boolean}>}
 */
function buildPurchaseLines(debits, itemsBySale) {
  const mapa = itemsBySale || {};
  const linhas = [];
  for (const d of debits || []) {
    const itens = d.sale_id ? (mapa[d.sale_id] || []) : [];
    if (itens.length) {
      for (const it of itens) {
        const qtd = num(it.quantity);
        linhas.push({
          date: d.created_at,
          description: String(it.product_name || 'Produto'),
          quantity: qtd > 0 ? qtd : null,
          amount: round2(it.total_price != null ? num(it.total_price) : num(it.unit_price) * qtd),
          manual: false,
        });
      }
      continue;
    }
    const nota = String(d.notes || '').trim();
    linhas.push({
      date: d.created_at,
      description: nota || (d.sale_id ? 'Compra' : 'Lançamento manual'),
      quantity: null,
      amount: round2(num(d.amount)),
      manual: !d.sale_id,
    });
  }
  return linhas;
}

/**
 * Lista de compras de cada grupo de parcelas do carnê.
 *
 * @param {object} args
 * @param {Array<object>} args.installments todas as parcelas do cliente
 *        ({ account_id, amount_due, status })
 * @param {Array<object>} args.debits todos os débitos do cliente
 *        ({ id, account_id, sale_id, amount, notes, created_at })
 * @param {Object<string, Array<object>>} [args.itemsBySale]
 * @returns {Object<string, {target:number, lines:Array<object>, total:number}>}
 *          chave = account_id ou NO_ACCOUNT_KEY. Grupo sem parcela viva (ou
 *          sem débito) não aparece.
 */
function purchasesByGroup({ installments = [], debits = [], itemsBySale = {} } = {}) {
  const parcelasPorGrupo = {};
  for (const inst of installments || []) {
    if (!inst) continue;
    const k = groupKey(inst.account_id);
    (parcelasPorGrupo[k] = parcelasPorGrupo[k] || []).push(inst);
  }
  const debitosPorGrupo = {};
  for (const d of debits || []) {
    if (!d) continue;
    const k = groupKey(d.account_id);
    (debitosPorGrupo[k] = debitosPorGrupo[k] || []).push(d);
  }

  const out = {};
  for (const k of Object.keys(parcelasPorGrupo)) {
    const target = groupTarget(parcelasPorGrupo[k]);
    const escolhidos = selectDebitsForTarget(debitosPorGrupo[k] || [], target);
    if (!escolhidos.length) continue;
    const lines = buildPurchaseLines(escolhidos, itemsBySale);
    out[k] = {
      target,
      lines,
      total: round2(lines.reduce((s, l) => s + l.amount, 0)),
    };
  }
  return out;
}

module.exports = {
  NO_ACCOUNT_KEY,
  CENT_TOLERANCE,
  groupKey,
  groupTarget,
  selectDebitsForTarget,
  buildPurchaseLines,
  purchasesByGroup,
};
