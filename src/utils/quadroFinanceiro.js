// ============================================================
// AURA. — Quadro do Financeiro (Kanban de lancamentos) · 28/09/2026
//
// Tres colunas por mes, para receitas ou despesas:
//   atrasado  pendente com data do lancamento antes de hoje (qualquer mes —
//             senao a divida de agosto sumiria na virada)
//   aberto    pendente de hoje em diante, dentro do mes escolhido
//   feito     confirmado, dentro do mes escolhido
//
// "Data do lancamento" e a mesma competencia do GET /transactions e do resumo
// do Financeiro — COALESCE(due_date, created_at SP) — para o total de
// Recebido bater com o "Entrou" da tela. "Atrasado" nao e gravado: sai da
// data, entao ninguem arrasta cartao para la.
//
// Fora do quadro nesta fase (decisao do Caio): tudo do crediario. O recebivel
// e o recebimento do crediario sao derivados das parcelas; dar baixa por aqui
// deixaria credit_installments para tras.
//
// Vendas do Caixa (pdv-sale-*) e taxas da maquininha (pdv-card-fee-*) sao
// centenas por mes: entram agrupadas por dia, sem cartao individual.
// ============================================================

const LIMITE_POR_COLUNA = 150;

// Competencia: mesma expressao de routes/transactions.js (dateClauseCompetencia).
const COMP = "COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date)";

// Crediario: categoria (com ou sem acento) ou chave do ledger/recebimento.
const SQL_E_CREDIARIO =
  "(category ILIKE 'credi_rio%' OR COALESCE(idempotency_key, '') ~* '^(pdv-credit-|credit-payment)')";

// Entram agrupados por dia na coluna "feito".
const SQL_E_AGRUPADO = "COALESCE(idempotency_key, '') ~* '^(pdv-sale-|pdv-card-fee-)'";

function eCrediario(tx) {
  if (!tx) return false;
  const cat = String(tx.category || '');
  const key = String(tx.idempotency_key || '');
  return /^credi.rio/i.test(cat) || /^(pdv-credit-|credit-payment)/i.test(key);
}

// Cartao que o lojista pode arrastar: lancado a mao ou importado de planilha.
// O resto (troca, pedido da vitrine, anuidade...) nasce e muda pelo fluxo de
// origem — aparece travado.
function podeMover(idempotencyKey) {
  if (!idempotencyKey) return true;
  return /^planilha-/i.test(String(idempotencyKey));
}

function hojeSP(agora) {
  return (agora || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// 'YYYY-MM' -> { inicio: 'YYYY-MM-01', fim: primeiro dia do mes seguinte }.
// Sem mes (ou invalido) usa o mes de hoje em SP.
function intervaloDoMes(mes, hoje) {
  let m = typeof mes === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(mes) ? mes : String(hoje).slice(0, 7);
  const ano = Number(m.slice(0, 4));
  const num = Number(m.slice(5, 7));
  const prox = num === 12 ? (ano + 1) + '-01' : ano + '-' + String(num + 1).padStart(2, '0');
  return { mes: m, inicio: m + '-01', fim: prox + '-01' };
}

// Cartoes das tres colunas numa consulta so (latencia cross-region: cada ida
// custa ~190 ms). count/total vem por janela, antes do corte por coluna.
function sqlDosCartoes() {
  return (
    'WITH base AS (' +
    '  SELECT id, description, category, amount, status, due_date, paid_at, created_at,' +
    '         payment_method, notes, employee_id, employee_name, recurrence_type, recurrence_index, idempotency_key,' +
    '         ' + COMP + ' AS comp' +
    '  FROM transactions' +
    "  WHERE company_id = $1 AND type = $2 AND status IN ('pending', 'confirmed')" +
    '    AND NOT ' + SQL_E_CREDIARIO +
    '), marcada AS (' +
    '  SELECT *,' +
    "    CASE WHEN status = 'pending' AND comp < $3::date THEN 'atrasado'" +
    "         WHEN status = 'pending' THEN 'aberto' ELSE 'feito' END AS coluna" +
    '  FROM base' +
    "  WHERE (status = 'pending' AND comp < $3::date)" +
    "     OR (status = 'pending' AND comp >= $3::date AND comp >= $4::date AND comp < $5::date)" +
    "     OR (status = 'confirmed' AND comp >= $4::date AND comp < $5::date AND NOT " + SQL_E_AGRUPADO + ')' +
    '), numerada AS (' +
    '  SELECT *,' +
    '    ROW_NUMBER() OVER (PARTITION BY coluna ORDER BY' +
    "      CASE WHEN coluna = 'feito' THEN NULL ELSE comp END ASC," +
    "      CASE WHEN coluna = 'feito' THEN comp END DESC, created_at DESC) AS ordem," +
    '    COUNT(*) OVER (PARTITION BY coluna) AS qtd_coluna,' +
    '    SUM(amount) OVER (PARTITION BY coluna) AS total_coluna' +
    '  FROM marcada' +
    ')' +
    ' SELECT * FROM numerada WHERE ordem <= ' + LIMITE_POR_COLUNA +
    ' ORDER BY coluna, ordem'
  );
}

// Vendas do Caixa / taxas da maquininha confirmadas no mes, por dia.
function sqlDosGrupos() {
  return (
    'SELECT ' + COMP + " AS dia," +
    "  CASE WHEN idempotency_key ~* '^pdv-card-fee-' THEN 'taxas' ELSE 'caixa' END AS origem," +
    '  COUNT(*) AS qtd, SUM(amount) AS total' +
    ' FROM transactions' +
    " WHERE company_id = $1 AND type = $2 AND status = 'confirmed'" +
    '   AND ' + SQL_E_AGRUPADO +
    '   AND ' + COMP + ' >= $3::date AND ' + COMP + ' < $4::date' +
    ' GROUP BY 1, 2 ORDER BY 1 DESC, 2'
  );
}

function dataISO(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  // pg devolve DATE como Date a meia-noite local do servidor; o dia vem das partes locais.
  const d = new Date(v);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function montarQuadro({ tipo, hoje, mes, cartoes, grupos }) {
  const colunas = {
    atrasado: { total: 0, count: 0, items: [] },
    aberto: { total: 0, count: 0, items: [] },
    feito: { total: 0, count: 0, items: [], grupos: [] },
  };
  for (const r of cartoes || []) {
    const col = colunas[r.coluna];
    if (!col) continue;
    col.count = Number(r.qtd_coluna) || 0;
    col.total = Number(r.total_coluna) || 0;
    col.items.push({
      id: r.id,
      description: r.description,
      category: r.category,
      amount: Number(r.amount) || 0,
      status: r.status,
      date: dataISO(r.comp),
      due_date: dataISO(r.due_date),
      paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null,
      payment_method: r.payment_method || null,
      notes: r.notes || null,
      employee_id: r.employee_id || null,
      employee_name: r.employee_name || null,
      recurrence_type: r.recurrence_type || null,
      recurrence_index: r.recurrence_index == null ? null : Number(r.recurrence_index),
      movable: podeMover(r.idempotency_key),
    });
  }
  for (const g of grupos || []) {
    const qtd = Number(g.qtd) || 0;
    const total = Number(g.total) || 0;
    colunas.feito.grupos.push({ date: dataISO(g.dia), origem: g.origem, count: qtd, total: total });
    colunas.feito.count += qtd;
    colunas.feito.total += total;
  }
  for (const k of Object.keys(colunas)) colunas[k].total = Math.round(colunas[k].total * 100) / 100;
  return { type: tipo, month: mes, today: hoje, limit_per_column: LIMITE_POR_COLUNA, columns: colunas };
}

module.exports = {
  LIMITE_POR_COLUNA,
  eCrediario,
  podeMover,
  hojeSP,
  intervaloDoMes,
  sqlDosCartoes,
  sqlDosGrupos,
  montarQuadro,
};
