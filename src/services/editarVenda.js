// ============================================================
// AURA. — Editar venda (09/11/2026, mockup aprovado pelo Caio)
//
// Muda TRÊS coisas de uma venda já feita: forma de pagamento, vendedor(a) e
// cliente. Produtos, valores e estoque NUNCA mudam por aqui.
//
// Contrato (PATCH /companies/:id/sales/:sale_id, routes/sales.js):
//   seller_id       employee id | null           (ausente = não mexe)
//   customer_id     customer id | null           (ausente = não mexe)
//   payments        [{ method, amount }]         (soma = total da venda)
//   installments    nº de parcelas da parte no crediário
//   first_due_date  'AAAA-MM-DD', 1ª parcela
//   reason          motivo (opcional)
//   dry_run         true = devolve o plano e não grava nada
//
// Três peças:
//   carregarContexto  UMA consulta (banco em SP, backend nos EUA: cada ida
//                     custa ~190 ms) com tudo o que a venda tem: formas,
//                     débito do crediário, parcelas, A Receber, receita do
//                     Financeiro, taxa da maquininha, devoluções ativas, NFC-e
//                     autorizada e a sessão de caixa.
//   planejar          só LÊ. Valida, aplica as travas e escreve em texto
//                     simples o que vai acontecer. É o que o dry_run devolve.
//   aplicar           grava o plano, dentro da transação de quem chamou.
//
// Regras (fechadas com o Caio em 09/11/2026):
//   - venda cancelada, troca e devolução: sem edição (como hoje);
//   - venda com devolução ou troca ATIVA: só o vendedor(a) muda;
//   - crediário com qualquer pagamento (parcela coberta, A Receber baixado):
//     forma e cliente travados — o caminho é "Devolver";
//   - entrar no crediário exige cliente, respeita o bloqueio manual e nasce
//     num carnê novo ("Compra de DD/MM") pelo createCreditSale de sempre;
//     sair usa o cancelCreditSale de sempre (razão e parcelas juntos);
//   - NFC-e autorizada: a nota não muda; crediário fica desligado;
//   - caixa já fechado: pode editar; caixa_fechamentos (snapshot) não é
//     tocado; os sale_payments mudam na MESMA sessão de antes;
//   - forma e cliente: dono, acesso total e Financeiro. Vendedor(a): quem
//     pode vender.
// ============================================================
'use strict';

const db = require('../config/database');
const creditLedger = require('./creditLedger');
const carneAuto = require('./credit/carneAuto');
const { resolvePeriod, dueDateForIndex, MAX_INSTALLMENTS_CEILING, round2, validateFirstDueDate } = require('./credit/terms');
const { CARD_FEE_KEY, insertCardFeeExpense } = require('./taxaDaMaquininha');
const { findOwnerScopedCustomer } = require('../utils/customerScope');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;
const SP_TZ = 'America/Sao_Paulo';

// Campos que o PATCH aceita. Qualquer outro é 400 (nunca sucesso calado):
// o Editar venda do Studio mandava items/discount_amount, o backend
// ignorava, gravava vendedor NULO e respondia ok.
const CAMPOS_ACEITOS = ['seller_id', 'customer_id', 'payments', 'installments', 'first_due_date', 'reason', 'dry_run'];

class EdicaoError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = Object.assign({ error: message, code }, extra || {});
  }
}

// ── Formas de pagamento ──────────────────────────────────────
// O caixa fala português (sale_payments.method). Aceitamos os apelidos que já
// existem na base e no Financeiro e gravamos sempre o termo do caixa.
const METODOS = {
  dinheiro: 'dinheiro', cash: 'dinheiro',
  pix: 'pix',
  debito: 'debito', 'débito': 'debito', cartao_debito: 'debito', debit: 'debito',
  cartao: 'cartao', credito: 'cartao', 'crédito': 'cartao', cartao_credito: 'cartao', credit: 'cartao',
  crediario: 'crediario', 'crediário': 'crediario', fiado: 'crediario',
};
const ORDEM = ['dinheiro', 'pix', 'debito', 'cartao', 'crediario'];
const NOME = { dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Débito', cartao: 'Crédito', crediario: 'Crediário' };
const NO = { dinheiro: 'em dinheiro', pix: 'no Pix', debito: 'no débito', cartao: 'no crédito', crediario: 'no crediário' };
// Termo do Financeiro (transactions.payment_method), o mesmo do "Editar lancamento".
const NO_FINANCEIRO = { dinheiro: 'cash', pix: 'pix', debito: 'debit', cartao: 'credit' };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function normalizarMetodo(m) {
  const k = String(m || '').trim().toLowerCase();
  return METODOS[k] || null;
}
function nomeDaForma(m) {
  return NOME[m] || (m ? String(m).charAt(0).toUpperCase() + String(m).slice(1) : 'Outra');
}
function brl(v) {
  const n = round2(v);
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return (n < 0 ? '-' : '') + 'R$ ' + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
}
function ddmm(dia) {
  const m = DIA_RE.exec(String(dia || ''));
  return m ? dia.slice(8, 10) + '/' + dia.slice(5, 7) : '';
}
function mesDe(dia) {
  const m = DIA_RE.exec(String(dia || ''));
  return m ? MESES[parseInt(dia.slice(5, 7), 10) - 1] : '';
}
function somarMes(dia, n) {
  return dueDateForIndex(dia, 'month', 1, n);
}
// 'AAAA-MM-DD' que existe no calendário (2026-02-31 não passa).
function diaReal(v) {
  const m = DIA_RE.exec(String(v || ''));
  if (!m) return false;
  const d = new Date(String(v) + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === String(v);
}
function hojeEmSaoPaulo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: SP_TZ });
}
function listaPorForma(lista) {
  const partes = lista.map((p) => brl(p.amount) + ' ' + (NO[p.method] || ('em ' + nomeDaForma(p.method))));
  if (partes.length <= 1) return partes.join('');
  return partes.slice(0, -1).join(', ') + ' e ' + partes[partes.length - 1];
}
function num(v) { return round2(parseFloat(v) || 0); }

// Mapa forma -> valor, na ordem do caixa. Formas repetidas somam.
function agrupar(lista) {
  const mapa = new Map();
  for (const p of lista || []) {
    const m = normalizarMetodo(p.method) || String(p.method || '').toLowerCase();
    mapa.set(m, round2((mapa.get(m) || 0) + num(p.amount)));
  }
  return [...mapa.entries()]
    .filter(([, v]) => v > 0.005)
    .sort((a, b) => {
      const ia = ORDEM.indexOf(a[0]); const ib = ORDEM.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map(([method, amount]) => ({ method, amount }));
}
function mesmaLista(a, b) {
  const x = agrupar(a); const y = agrupar(b);
  if (x.length !== y.length) return false;
  return x.every((p, i) => p.method === y[i].method && Math.abs(p.amount - y[i].amount) < 0.005);
}

// ── Sondagens de coluna (CI não tem as colunas que a produção tem) ──
// Rodam pelo pool, FORA da transação: um 42703 dentro dela abortaria a edição.
const _colunas = new Map(); // tabela -> { at, set }
async function colunasDe(tabela) {
  const hit = _colunas.get(tabela);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.set;
  let set = new Set();
  try {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [tabela]
    );
    set = new Set((rows || []).map((r) => r.column_name));
  } catch (e) {
    console.warn('[editarVenda] sondagem de colunas falhou:', tabela, e.message);
  }
  _colunas.set(tabela, { at: Date.now(), set });
  return set;
}

let _logOk = null; let _logAt = 0;
async function registroDisponivel() {
  if (_logOk === true) return true;
  if (_logOk === false && Date.now() - _logAt < 60000) return false;
  try {
    const { rows } = await db.query(`SELECT to_regclass('public.sale_edits') IS NOT NULL AS ok`);
    // Só a resposta "a tabela não existe" fica em cache (60 s). Uma falha
    // passageira de conexão não pode travar as edições por um minuto.
    _logOk = !!(rows && rows[0] && rows[0].ok);
    _logAt = Date.now();
    return _logOk;
  } catch (e) {
    console.warn('[editarVenda] sondagem de sale_edits falhou (sem cache):', e.message);
    return false;
  }
}

function _resetCache() { _colunas.clear(); _logOk = null; _logAt = 0; }

// ── Quem pode o quê ──────────────────────────────────────────
// Mesma semântica de routes/myPermissions.js e services/destinatariosDoAviso:
// dono, papel admin, staff e permissions NULL = acesso total; chave só vale
// quando é true.
async function permissoesDeEdicao(q, { companyId, user, companyRole }) {
  const tudo = { vendedor: true, dinheiro: true };
  if (!user) return { vendedor: false, dinheiro: false };
  if (user.role === 'admin' || companyRole === 'owner' || companyRole === 'admin') return tudo;
  const { rows } = await q.query(
    `SELECT (c.owner_id = $2) AS is_owner, cm.role_label, cm.permissions, (cm.user_id IS NOT NULL) AS membro
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE c.id = $1
      LIMIT 1`,
    [companyId, user.id]
  );
  const r = rows && rows[0];
  if (!r) return { vendedor: false, dinheiro: false };
  if (r.is_owner === true || r.role_label === 'owner' || r.role_label === 'admin') return tudo;
  if (!r.membro) return { vendedor: false, dinheiro: false };
  let p = r.permissions;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = {}; } }
  if (p == null) return tudo;
  const dinheiro = p.financeiro === true;
  return { vendedor: dinheiro || p.pdv === true || p.vendas === true, dinheiro };
}

// ── Contexto: tudo o que a venda tem, numa consulta ─────────
const SQL_CONTEXTO = (comSnapshot) => `
SELECT s.id, s.company_id, s.sale_number, s.customer_id, s.seller_id, s.employee_id, s.seller_name,
       s.total_amount, s.payment_method, s.status, COALESCE(s.type, 'sale') AS type, s.created_at,
       to_char(s.created_at AT TIME ZONE '${SP_TZ}', 'YYYY-MM-DD') AS dia,
       c.name AS customer_name, e.name AS employee_name,
       ${comSnapshot ? 's.credit_plan_snapshot' : 'NULL::jsonb'} AS credit_plan_snapshot,
       (SELECT COALESCE(json_agg(json_build_object('id', sp.id, 'method', sp.method, 'amount', sp.amount,
                                                   'sessao_id', sp.sessao_id, 'created_at', sp.created_at)
                                 ORDER BY sp.created_at, sp.id), '[]'::json)
          FROM sale_payments sp WHERE sp.sale_id = s.id) AS pagamentos,
       (SELECT COALESCE(json_agg(json_build_object('id', d.id, 'customer_id', d.customer_id, 'amount', d.amount,
                                                   'account_id', d.account_id, 'account_name', ca.name,
                                                   'terms', ca.terms_snapshot)), '[]'::json)
          FROM customer_credit_transactions d
          LEFT JOIN credit_accounts ca ON ca.id = d.account_id
         WHERE d.sale_id = s.id AND d.company_id = s.company_id AND d.type = 'debit') AS debitos,
       (SELECT COALESCE(json_agg(json_build_object('id', t.id, 'amount', t.amount, 'status', t.status,
                                                   'key', t.idempotency_key)), '[]'::json)
          FROM transactions t
         WHERE t.company_id = s.company_id
           AND t.idempotency_key >= 'pdv-credit-receivable-' || s.id
           AND t.idempotency_key <  'pdv-credit-receivable-' || s.id || 'z') AS recebiveis,
       (SELECT COALESCE(json_agg(json_build_object('id', ci.id, 'n', ci.installment_number, 'total', ci.total_installments,
                                                   'amount_due', ci.amount_due, 'due_date', to_char(ci.due_date, 'YYYY-MM-DD'),
                                                   'status', ci.status, 'covered', ci.covered_amount)
                                 ORDER BY ci.installment_number), '[]'::json)
          FROM credit_installments ci
         WHERE ci.sale_id = s.id AND ci.company_id = s.company_id AND ci.status <> 'cancelled') AS parcelas,
       -- Renegociação / unificação (services/credit/reschedule.js, unify.js):
       -- as parcelas da venda são canceladas e o cronograma novo nasce com
       -- sale_id NULL no carnê. (a) parcela cancelada da própria venda, no
       -- carnê atual do débito; (b) parcela sem venda no carnê do débito.
       (SELECT COUNT(*)::int FROM credit_installments ci
         WHERE ci.sale_id = s.id AND ci.company_id = s.company_id AND ci.status = 'cancelled'
           AND ci.account_id IS NOT DISTINCT FROM (
             SELECT d.account_id FROM customer_credit_transactions d
              WHERE d.sale_id = s.id AND d.company_id = s.company_id AND d.type = 'debit' LIMIT 1)) AS parcelas_canceladas,
       (SELECT COUNT(*)::int FROM credit_installments ci
         WHERE ci.company_id = s.company_id AND ci.sale_id IS NULL
           AND ci.account_id IN (
             SELECT d.account_id FROM customer_credit_transactions d
              WHERE d.sale_id = s.id AND d.company_id = s.company_id AND d.type = 'debit' AND d.account_id IS NOT NULL)) AS parcelas_sem_venda,
       (SELECT json_build_object('id', t.id, 'amount', t.amount, 'description', t.description)
          FROM transactions t
         WHERE t.idempotency_key = 'pdv-sale-' || s.id AND t.company_id = s.company_id LIMIT 1) AS receita,
       (SELECT t.amount FROM transactions t
         WHERE t.idempotency_key = 'pdv-card-fee-' || s.id AND t.company_id = s.company_id LIMIT 1) AS taxa,
       (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
          SELECT DISTINCT ts.id, ts.sale_number, COALESCE(ts.type, 'sale') AS type
            FROM troca_returned_items tri
            JOIN sales ts ON ts.id = tri.troca_sale_id
           WHERE tri.original_sale_id = s.id AND ts.company_id = s.company_id
             AND COALESCE(ts.status, 'completed') <> 'cancelled') x) AS devolucoes,
       (SELECT json_build_object('id', n.id, 'numero', n.numero, 'authorized_at', n.authorized_at, 'tipo', COALESCE(n.tipo, 'nfce'))
          FROM nfce_emissions n
         WHERE n.sale_id = s.id AND COALESCE(n.tipo, 'nfce') IN ('nfce', 'nfe') AND n.status = 'autorizada'
         ORDER BY n.created_at DESC LIMIT 1) AS nfce,
       (SELECT COALESCE(json_agg(z.nm), '[]'::json) FROM (
          SELECT COALESCE(si.product_name_snapshot, p.name) AS nm
            FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
           WHERE si.sale_id = s.id ORDER BY si.id LIMIT 3) z) AS produtos,
       (SELECT json_build_object('id', cs.id, 'status', cs.status, 'contado', cf.dinheiro_contado)
          FROM caixa_sessoes cs
          LEFT JOIN caixa_fechamentos cf ON cf.sessao_id = cs.id
         WHERE cs.company_id = s.company_id
           AND (cs.id = (SELECT sp.sessao_id FROM sale_payments sp
                          WHERE sp.sale_id = s.id AND sp.sessao_id IS NOT NULL
                          ORDER BY sp.created_at LIMIT 1)
                OR (NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.sessao_id IS NOT NULL)
                    AND cs.opened_at <= s.created_at
                    AND (cs.closed_at IS NULL OR cs.closed_at > s.created_at)))
         ORDER BY cs.opened_at DESC LIMIT 1) AS caixa,
       (SELECT co.pdv_settings FROM companies co WHERE co.id = s.company_id) AS pdv_settings
  FROM sales s
  LEFT JOIN customers c ON c.id = s.customer_id
  LEFT JOIN employees e ON e.id = s.employee_id
 WHERE s.id = $1 AND s.company_id = $2`;

function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch (_) { return []; } }
  return [];
}
function obj(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return null;
}

/**
 * Como a venda foi paga, a partir do que está gravado. Pura (testada sem banco).
 *
 * O crediário não gera sale_payments: a parte fiada é o A Receber da venda
 * (pdv-credit-receivable-<id>, que soma o principal mesmo depois de dividido
 * em "-rest-"). Os sale_payments que vêm DEPOIS da entrada são recebimentos de
 * parcela (applyPayment) — por isso a entrada é lida em ordem até fechar
 * total - principal.
 */
function derivarPagamentos({ total, pagamentos, debitos, recebiveis, parcelas }) {
  total = num(total);
  const pg = arr(pagamentos).filter((p) => num(p.amount) > 0);
  const deb = arr(debitos);
  const rec = arr(recebiveis);
  const par = arr(parcelas);
  const temCredito = deb.length > 0;
  let principal = 0;
  if (temCredito) {
    principal = rec.length ? round2(rec.reduce((a, r) => a + num(r.amount), 0)) : 0;
    if (!(principal > 0)) principal = round2(Math.max(0, total - pg.reduce((a, p) => a + num(p.amount), 0)));
    principal = Math.min(principal, total);
  }
  const entradaTotal = round2(total - principal);
  let entradaRows = pg;
  if (temCredito) {
    entradaRows = [];
    let soma = 0;
    for (const p of pg) {
      if (soma >= entradaTotal - 0.005) break;
      entradaRows.push(p);
      soma = round2(soma + num(p.amount));
    }
  }
  const entrada = agrupar(entradaRows);
  const somaPagamentos = round2(pg.reduce((a, p) => a + num(p.amount), 0));
  const pagoNasParcelas = round2(par.reduce((a, p) => a + num(p.covered), 0));
  const pagoNoFinanceiro = round2(rec.filter((r) => r.status !== 'pending').reduce((a, r) => a + num(r.amount), 0));
  const pagoNoCrediario = temCredito && (
    par.some((p) => p.status === 'paid' || num(p.covered) > 0.005) ||
    rec.some((r) => r.status !== 'pending') ||
    rec.some((r) => /-rest-/.test(String(r.key || ''))) ||
    // Recebimento só de encargos não baixa A Receber nem cobre parcela, mas
    // grava sale_payments na venda: o que passa da entrada é recebimento.
    somaPagamentos > entradaTotal + 0.005
  );
  const credito = temCredito ? {
    amount: principal,
    installments: par.length ? (parseInt(par[0].total, 10) || par.length) : 1,
    first_due_date: par.length ? par[0].due_date : null,
    account_id: deb[0].account_id || null,
    account_name: deb[0].account_name || null,
    paid: !!pagoNoCrediario,
    paid_amount: Math.max(pagoNasParcelas, pagoNoFinanceiro, round2(somaPagamentos - entradaTotal)),
    terms: obj(deb[0].terms) || null,
  } : null;
  const lista = entrada.slice();
  if (credito && credito.amount > 0) lista.push({ method: 'crediario', amount: credito.amount, installments: credito.installments });
  return { entrada, entrada_ids: entradaRows.map((p) => p.id).filter(Boolean), credito, lista, sessao_id: (pg.find((p) => p.sessao_id) || {}).sessao_id || null, primeiro_em: pg.length ? pg[0].created_at : null };
}

async function carregarContexto(q, { companyId, saleId, lock = false }) {
  if (!UUID_RE.test(String(saleId || ''))) return null;
  // A trava vem ANTES, num comando só dela. Em READ COMMITTED um FOR UPDATE
  // dentro da consulta grande não protege as subconsultas: elas continuam
  // vendo o retrato de antes, e duas edições juntas criavam dois débitos.
  if (lock) {
    const t = await q.query(`SELECT 1 FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE`, [saleId, companyId]);
    if (!t.rows || !t.rows.length) return null;
  }
  const colSales = await colunasDe('sales');
  const { rows } = await q.query(SQL_CONTEXTO(colSales.has('credit_plan_snapshot')), [saleId, companyId]);
  const r = rows && rows[0];
  if (!r) return null;
  const total = num(r.total_amount);
  const pag = derivarPagamentos({
    total, pagamentos: r.pagamentos, debitos: r.debitos, recebiveis: r.recebiveis, parcelas: r.parcelas,
  });
  return {
    sale: {
      id: r.id, company_id: r.company_id, sale_number: r.sale_number == null ? null : parseInt(r.sale_number, 10),
      customer_id: r.customer_id || null, seller_id: r.seller_id || null, employee_id: r.employee_id || null,
      seller_name: r.seller_name || null, total_amount: total, payment_method: r.payment_method || null,
      status: r.status || 'completed', type: r.type || 'sale', created_at: r.created_at, dia: r.dia,
    },
    customer: r.customer_id ? { id: r.customer_id, name: r.customer_name || 'Cliente' } : null,
    seller: (r.employee_id || r.seller_name)
      ? { id: r.employee_id || null, name: r.seller_name || r.employee_name || null }
      : null,
    pagamentos: pag,
    parcelas: arr(r.parcelas),
    receita: obj(r.receita),
    taxa: r.taxa == null ? null : num(r.taxa),
    devolucoes: arr(r.devolucoes),
    nfce: obj(r.nfce),
    produtos: arr(r.produtos).filter(Boolean),
    renegociada: arr(r.debitos).length > 0 && ((parseInt(r.parcelas_canceladas, 10) || 0) > 0 || (parseInt(r.parcelas_sem_venda, 10) || 0) > 0),
    credit_plan_snapshot: obj(r.credit_plan_snapshot),
    caixa: obj(r.caixa),
    pdv_settings: obj(r.pdv_settings) || {},
  };
}

// ── Travas ───────────────────────────────────────────────────
function travaDaVenda(ctx) {
  const s = ctx.sale;
  if (s.status === 'cancelled') {
    return { code: 'SALE_CANCELLED', message: 'Esta venda foi cancelada. Venda cancelada não é editada.' };
  }
  if (s.type === 'troca') {
    return { code: 'SALE_TYPE_LOCKED', message: 'A troca não tem “Editar venda”. Para corrigir, use “Cancelar troca” e faça de novo.' };
  }
  if (s.type !== 'sale') {
    return { code: 'SALE_TYPE_LOCKED', message: 'A devolução não tem “Editar venda”. Para corrigir, cancele a devolução e faça de novo.' };
  }
  return null;
}

function travaDoDinheiro(ctx, perms) {
  if (ctx.devolucoes.length) {
    const d = ctx.devolucoes[0];
    const nome = d.type === 'troca' ? 'a troca' : 'a devolução';
    const n = d.sale_number ? ' #' + d.sale_number : '';
    return {
      code: 'SALE_HAS_ACTIVE_RETURN', status: 409,
      message: `Esta venda tem ${nome}${n} registrada, então a forma e o cliente ficam como estão. Para mudar, desfaça ${nome} primeiro.`,
      returns: ctx.devolucoes,
    };
  }
  if (ctx.renegociada) {
    return {
      code: 'CREDIT_RENEGOTIATED', status: 409,
      message: 'Este crediário foi renegociado ou juntado a outro carnê, então a forma e o cliente ficam como estão. Se o produto vai voltar, use “Devolver”.',
    };
  }
  const c = ctx.pagamentos.credito;
  if (c && c.paid) {
    const quanto = c.paid_amount > 0 ? ` (${brl(c.paid_amount)})` : '';
    return {
      code: 'CREDIT_HAS_PAYMENT', status: 409,
      message: `Já entrou pagamento neste crediário${quanto}. Para não bagunçar o que já foi pago, a forma e o cliente ficam como estão. Se o produto vai voltar, use “Devolver”.`,
      paid_amount: c.paid_amount,
    };
  }
  if (String(ctx.sale.payment_method || '').toLowerCase() === 'sinal') {
    return {
      code: 'SIGNAL_SALE', status: 409,
      message: 'Venda com sinal: a forma e o cliente ficam como estão. O saldo é baixado pelo pedido.',
    };
  }
  if (perms && !perms.dinheiro) {
    return {
      code: 'FORBIDDEN_FIELD', status: 403,
      message: 'Forma de pagamento e cliente só são mudados por quem cuida do Financeiro (dono, acesso total ou Financeiro).',
    };
  }
  return null;
}

function infoNfce(ctx, agora = Date.now()) {
  if (!ctx.nfce) return null;
  const prazo = parseInt(process.env.NFCE_CANCEL_DEADLINE_MIN || '30', 10);
  const aut = ctx.nfce.authorized_at ? new Date(ctx.nfce.authorized_at).getTime() : null;
  const ate = aut ? new Date(aut + prazo * 60000) : null;
  const tipo = ctx.nfce.tipo === 'nfe' ? 'nfe' : 'nfce';
  return {
    id: ctx.nfce.id,
    tipo,
    rotulo: tipo === 'nfe' ? 'NF-e' : 'NFC-e',
    numero: ctx.nfce.numero,
    authorized_at: ctx.nfce.authorized_at,
    cancel_until: ate ? ate.toISOString() : null,
    can_cancel: !!(ate && agora < ate.getTime()),
  };
}

function infoCaixa(ctx) {
  if (!ctx.caixa) return null;
  return {
    sessao_id: ctx.caixa.id,
    status: ctx.caixa.status === 'fechada' ? 'fechada' : 'aberta',
    dinheiro_contado: ctx.caixa.contado == null ? null : num(ctx.caixa.contado),
  };
}

// O que a tela de edição precisa ANTES de o usuário mexer em qualquer campo.
function resumoParaEdicao(ctx, perms) {
  const trava = travaDaVenda(ctx);
  const tDinheiro = trava ? null : travaDoDinheiro(ctx, perms);
  return {
    sale: {
      id: ctx.sale.id, sale_number: ctx.sale.sale_number, total_amount: ctx.sale.total_amount,
      created_at: ctx.sale.created_at, dia: ctx.sale.dia, type: ctx.sale.type, status: ctx.sale.status,
      payment_method: ctx.sale.payment_method, company_id: ctx.sale.company_id,
    },
    editable: !trava,
    locked: trava,
    current: {
      payments: ctx.pagamentos.lista,
      credit: ctx.pagamentos.credito,
      seller: ctx.seller,
      customer: ctx.customer,
    },
    locks: {
      money: tDinheiro ? { code: tDinheiro.code, message: tDinheiro.message } : null,
      seller: perms && !perms.vendedor
        ? { code: 'FORBIDDEN_FIELD', message: 'Este acesso não muda o vendedor(a) da venda.' }
        : null,
    },
    permissions: { seller: !!(perms && perms.vendedor), money: !!(perms && perms.dinheiro) },
    nfce: infoNfce(ctx),
    caixa: infoCaixa(ctx),
  };
}

// ── Prévia das parcelas (só lê) ──────────────────────────────
async function configDoCrediario(q, companyId) {
  try {
    const { rows } = await q.query(`SELECT * FROM credit_plan_configs WHERE company_id = $1`, [companyId]);
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

// Mesma conta do createCreditSale (services/credit/ledger.js): juros FLAT sobre
// o valor, parcelas iguais, o resto dos centavos na última.
function previaDasParcelas({ amount, installments, firstDueDate, config }) {
  const n = Math.max(1, parseInt(installments, 10) || 1);
  if (!(n > 1 || firstDueDate)) return [];
  const rate = parseFloat(config && config.interest_rate) || 0;
  const total = rate > 0 ? parseFloat((amount * (1 + rate)).toFixed(2)) : amount;
  const base = Math.floor((total / n) * 100) / 100;
  const resto = Math.round((total - base * n) * 100) / 100;
  const period = resolvePeriod(null, null, config);
  const due1 = firstDueDate;
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      installment_number: i,
      amount_due: round2(i === n ? base + resto : base),
      due_date: due1 ? dueDateForIndex(due1, period.unit, period.count, i - 1) : null,
    });
  }
  return out;
}

async function nomeDoCarneNovo(q, { companyId, customerId, dia }) {
  const base = 'Compra de ' + carneAuto.carneDayLabel(dia);
  try {
    const { rows } = await q.query(
      `SELECT name FROM credit_accounts
        WHERE company_id = $1 AND customer_id = $2 AND status = 'open' AND name ILIKE $3`,
      [companyId, customerId, base.replace(/[\\%_]/g, '\\$&') + '%']
    );
    return carneAuto.dedupeCarneName(base, rows.map((r) => r.name));
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return base;
    throw e;
  }
}

async function clienteBloqueado(q, { companyId, customerId }) {
  try {
    const { rows } = await q.query(
      `SELECT status, blocked_reason FROM customer_credit_profiles WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
    return rows[0] && rows[0].status === 'blocked' ? (rows[0].blocked_reason || 'Bloqueio manual') : null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

// Taxa da maquininha que a venda TERIA com estas formas (mesma conta de
// services/taxaDaMaquininha.js, sem gravar).
function baseDoCartao(lista) {
  // Pix entra na base sempre; só vira taxa se a loja preencheu
  // card_fee_pix_pct (Aura-backend#974).
  const b = { cartao: 0, debito: 0, pix: 0 };
  for (const p of lista || []) {
    if (p.method === 'cartao' || p.method === 'debito' || p.method === 'pix') b[p.method] = round2(b[p.method] + num(p.amount));
  }
  return b;
}
function baseMudou(a, b) {
  return ['cartao', 'debito', 'pix'].some((k) => Math.abs((a[k] || 0) - (b[k] || 0)) > 0.005);
}
function taxaPrevista(settings, base) {
  if (!settings || !settings.card_fee_enabled) return 0;
  const clamp = (v) => Math.min(Math.max(parseFloat(v) || 0, 0), 100);
  return round2(
    base.cartao * clamp(settings.card_fee_credit_pct) / 100 +
    base.debito * clamp(settings.card_fee_debit_pct) / 100 +
    (base.pix || 0) * clamp(settings.card_fee_pix_pct) / 100
  );
}

// Termos da venda que já estava no crediário: o snapshot gravado pelo
// createCreditSale (credit_plan_snapshot) e, por cima, o terms_snapshot do
// carnê. Só os campos que o cronograma usa. null quando a venda não guardou
// termo nenhum.
function termosDaVenda(ctx) {
  const snap = ctx.credit_plan_snapshot || {};
  const carne = (ctx.pagamentos.credito && ctx.pagamentos.credito.terms) || {};
  const t = {};
  const rate = carne.interest_rate != null ? carne.interest_rate : snap.interest_rate;
  if (rate != null && rate !== '') t.interest_rate = parseFloat(rate) || 0;
  const unit = carne.period_unit || snap.period_unit;
  if (unit) t.period_unit = unit;
  const count = carne.period_count != null ? carne.period_count : snap.period_count;
  if (count != null) t.period_count = parseInt(count, 10) || 1;
  // Sem snapshot nem termos no carnê (venda 1x do Caixa, sem cronograma):
  // null, e o createCreditSale usa a configuração da loja, como o PDV faz.
  return Object.keys(t).length ? t : null;
}

// ── Plano ────────────────────────────────────────────────────
/**
 * Lê o corpo, aplica as regras e devolve o que VAI acontecer. Não grava nada:
 * só SELECT. É a resposta do dry_run e a entrada do aplicar.
 */
async function planejar(q, ctx, body, perms) {
  const s = ctx.sale;
  const trava = travaDaVenda(ctx);
  if (trava) throw new EdicaoError(409, trava.code, trava.message);

  const efeitos = [];
  const avisos = [];
  const changes = [];
  const before = { payments: ctx.pagamentos.lista, seller: ctx.seller, customer: ctx.customer };
  const after = { payments: ctx.pagamentos.lista, seller: ctx.seller, customer: ctx.customer };

  // Vendedor(a) ────────────────────────────────────────────
  let vendedor = null;
  if (Object.prototype.hasOwnProperty.call(body, 'seller_id')) {
    const novoId = body.seller_id || null;
    if (novoId !== null && !UUID_RE.test(String(novoId))) {
      throw new EdicaoError(400, 'INVALID_SELLER', 'Vendedor(a) inválido.');
    }
    let novo = null;
    if (novoId) {
      const { rows } = await q.query(
        `SELECT id, name FROM employees WHERE id = $1 AND company_id = $2`,
        [novoId, s.company_id]
      );
      if (!rows.length) throw new EdicaoError(404, 'SELLER_NOT_FOUND', 'Vendedor(a) não encontrado nesta empresa.');
      novo = { id: rows[0].id, name: rows[0].name };
    }
    const atualId = s.employee_id || null;
    if (String(novoId || '') !== String(atualId || '')) {
      if (!perms.vendedor) throw new EdicaoError(403, 'FORBIDDEN_FIELD', 'Este acesso não muda o vendedor(a) da venda.');
      vendedor = { from: ctx.seller, to: novo };
      changes.push('seller');
      after.seller = novo;
      const mes = mesDe(s.dia);
      const de = ctx.seller && ctx.seller.name;
      if (de && novo) efeitos.push({ code: 'COMMISSION_MOVES', text: `A comissão desta venda (${mes}) sai de ${de} e passa para ${novo.name}.` });
      else if (novo) efeitos.push({ code: 'COMMISSION_MOVES', text: `A comissão desta venda (${mes}) passa a ser de ${novo.name}.` });
      else efeitos.push({ code: 'COMMISSION_MOVES', text: `A venda fica sem vendedor(a): a comissão de ${mes} sai de ${de || 'quem vendeu'}.` });
    }
  }

  // Cliente ─────────────────────────────────────────────────
  let cliente = null;
  if (Object.prototype.hasOwnProperty.call(body, 'customer_id')) {
    const novoId = body.customer_id || null;
    if (novoId !== null && !UUID_RE.test(String(novoId))) {
      throw new EdicaoError(400, 'INVALID_CUSTOMER', 'Cliente inválido.');
    }
    let novo = null;
    if (novoId) {
      const found = await findOwnerScopedCustomer(q, s.company_id, novoId, 'id, name');
      if (!found) throw new EdicaoError(404, 'CUSTOMER_NOT_FOUND', 'Cliente não encontrado nesta empresa.');
      novo = { id: found.id, name: found.name || 'Cliente' };
    }
    if (String(novoId || '') !== String(s.customer_id || '')) {
      cliente = { from: ctx.customer, to: novo };
      changes.push('customer');
      after.customer = novo;
    }
  }

  // Forma de pagamento ──────────────────────────────────────
  const credAtual = ctx.pagamentos.credito;
  const credAntes = credAtual ? credAtual.amount : 0;
  let novaLista = null;
  let credDepois = credAntes;
  let parcelas = credAtual ? credAtual.installments : 1;
  let primeira = credAtual ? credAtual.first_due_date : null;
  const temPayments = Object.prototype.hasOwnProperty.call(body, 'payments');
  if (!temPayments && (body.installments !== undefined || body.first_due_date !== undefined)) {
    throw new EdicaoError(400, 'INSTALLMENTS_WITHOUT_PAYMENTS', 'Parcelas só mudam junto com a forma de pagamento (payments).');
  }
  if (temPayments) {
    if (!Array.isArray(body.payments) || !body.payments.length) {
      throw new EdicaoError(400, 'INVALID_PAYMENTS', 'Informe as formas de pagamento da venda.');
    }
    const lista = [];
    for (const p of body.payments) {
      const m = normalizarMetodo(p && p.method);
      if (!m) throw new EdicaoError(400, 'INVALID_METHOD', `Forma de pagamento não aceita: ${p && p.method}. Use dinheiro, pix, debito, cartao ou crediario.`);
      const v = round2(parseFloat(p.amount != null ? p.amount : p.value));
      if (!(v > 0)) throw new EdicaoError(400, 'INVALID_AMOUNT', 'Cada forma de pagamento precisa de um valor maior que zero.');
      lista.push({ method: m, amount: v });
    }
    novaLista = agrupar(lista);
    const soma = round2(novaLista.reduce((a, p) => a + p.amount, 0));
    if (Math.abs(soma - s.total_amount) > 0.005) {
      throw new EdicaoError(422, 'PAYMENTS_SUM_MISMATCH',
        `A soma das formas (${brl(soma)}) precisa dar o total da venda (${brl(s.total_amount)}).`,
        { total_amount: s.total_amount, payments_sum: soma });
    }
    const cred = novaLista.find((p) => p.method === 'crediario');
    credDepois = cred ? cred.amount : 0;
    if (credDepois > 0) {
      if (body.installments !== undefined && body.installments !== null) {
        const n = parseInt(body.installments, 10);
        if (!(n >= 1 && n <= MAX_INSTALLMENTS_CEILING)) throw new EdicaoError(400, 'INVALID_INSTALLMENTS', 'Número de parcelas inválido.');
        parcelas = n;
      } else if (!credAtual) {
        parcelas = 1;
      }
      if (body.first_due_date !== undefined && body.first_due_date !== null && body.first_due_date !== '') {
        const pedida = String(body.first_due_date).trim();
        if (!diaReal(pedida)) throw new EdicaoError(400, 'INVALID_FIRST_DUE_DATE', 'Data da 1ª parcela inválida (AAAA-MM-DD).');
        // A mesma 1ª parcela de hoje passa como está (o cronograma não muda
        // de data). Data nova segue a regra do crediário: nem no passado,
        // nem além do teto (services/credit/terms.validateFirstDueDate).
        if (!(credAtual && pedida === String(credAtual.first_due_date || ''))) {
          const v = validateFirstDueDate(pedida);
          if (!v.ok) throw new EdicaoError(v.status || 422, v.code || 'INVALID_FIRST_DUE_DATE', v.code === 'FIRST_DUE_DATE_PAST' ? 'A 1ª parcela não pode vencer no passado.' : v.error);
        }
        primeira = pedida;
      } else if (!credAtual) {
        // Nunca no passado: venda antiga editada hoje começa a pagar daqui a um mês.
        const hoje = hojeEmSaoPaulo();
        primeira = parcelas > 1 ? somarMes(s.dia > hoje ? s.dia : hoje, 1) : null;
      }
    } else {
      parcelas = 1; primeira = null;
    }
  }

  const entradaAntes = ctx.pagamentos.entrada;
  const entradaDepois = novaLista ? novaLista.filter((p) => p.method !== 'crediario') : entradaAntes;
  const caixaMudou = !mesmaLista(entradaAntes, entradaDepois);
  const credValorMudou = Math.abs(credDepois - credAntes) > 0.005;
  const credTermosMudaram = !!(credAtual && credDepois > 0 && (
    parcelas !== credAtual.installments || String(primeira || '') !== String(credAtual.first_due_date || '')
  ));
  const formaMudou = !!novaLista && (caixaMudou || credValorMudou || credTermosMudaram);
  if (formaMudou) {
    changes.push('payments');
    after.payments = novaLista.map((p) => (p.method === 'crediario' ? { method: p.method, amount: p.amount, installments: parcelas } : p));
  }

  const dinheiroMudou = formaMudou || !!cliente;
  if (dinheiroMudou) {
    const t = travaDoDinheiro(ctx, perms);
    if (t) throw new EdicaoError(t.status, t.code, t.message, t.returns ? { returns: t.returns } : (t.paid_amount != null ? { paid_amount: t.paid_amount } : undefined));
  }

  // Crediário: entra, sai, é refeito ou muda de cliente ───────
  const clienteFinal = cliente ? cliente.to : ctx.customer;
  const refazCredito = credValorMudou || credTermosMudaram || (!!cliente && (credAntes > 0 || credDepois > 0));
  let credito = null;
  if (refazCredito) {
    if (credDepois > 0 && !clienteFinal) {
      throw new EdicaoError(422, 'CREDIARIO_REQUIRES_CUSTOMER',
        credAntes > 0 && !formaMudou
          ? 'Venda no crediário precisa de cliente. Para tirar a cliente, tire a venda do crediário primeiro.'
          : 'Escolha a cliente para lançar no crediário.');
    }
    const nf = infoNfce(ctx);
    if (nf && credDepois > 0 && (credAntes <= 0 || credValorMudou)) {
      throw new EdicaoError(422, 'NFCE_AUTHORIZED_NO_CREDIARIO',
        `A ${nf.rotulo} ${nf.numero || ''} já foi autorizada como pagamento à vista, então esta venda não vai para o crediário.`.replace('  ', ' '));
    }
    let acao;
    if (credAntes > 0 && credDepois > 0) acao = (!credValorMudou && !credTermosMudaram && cliente) ? 'move' : 'recreate';
    else if (credAntes > 0) acao = 'leave';
    else acao = 'enter';

    let novoCarne = null;
    let previa = [];
    let termos = null;
    if (credDepois > 0) {
      const bloqueio = await clienteBloqueado(q, { companyId: s.company_id, customerId: clienteFinal.id });
      if (bloqueio) {
        throw new EdicaoError(422, 'CUSTOMER_BLOCKED', `Cliente com crédito bloqueado. Motivo: ${bloqueio}.`, { reason: bloqueio });
      }
      const config = await configDoCrediario(q, s.company_id);
      const maxN = parseInt(config && config.max_installments, 10) || MAX_INSTALLMENTS_CEILING;
      if (parcelas > maxN) {
        throw new EdicaoError(422, 'MAX_INSTALLMENTS_EXCEEDED',
          `Máximo de ${maxN} parcelas configurado para esta loja (pedido: ${parcelas}x). Ajuste em Crediário > Configurações.`,
          { max_installments: maxN, requested: parcelas });
      }
      novoCarne = await nomeDoCarneNovo(q, { companyId: s.company_id, customerId: clienteFinal.id, dia: s.dia });
      // Venda que já estava no crediário mantém os termos dela (juros e
      // periodicidade do credit_plan_snapshot / carnê), não os da loja de hoje.
      termos = credAntes > 0 ? termosDaVenda(ctx) : null;
      previa = previaDasParcelas({
        amount: credDepois, installments: parcelas, firstDueDate: primeira,
        config: termos ? Object.assign({}, config || {}, termos) : config,
      });
    }
    credito = {
      action: acao,
      cancel: credAntes > 0,
      create: credDepois > 0,
      from: credAtual ? { amount: credAntes, installments: credAtual.installments, first_due_date: credAtual.first_due_date, account_name: credAtual.account_name, customer: ctx.customer } : null,
      to: credDepois > 0 ? { amount: credDepois, installments: parcelas, first_due_date: primeira, account_name: novoCarne, customer: clienteFinal, schedule: previa, terms: termos } : null,
    };
  }

  // Textos ──────────────────────────────────────────────────
  const dia = ddmm(s.dia);
  const caixa = infoCaixa(ctx);
  if (caixaMudou) {
    const tiraTudo = entradaDepois.length === 0;
    if (tiraTudo) {
      const ant = entradaAntes;
      efeitos.push({
        code: 'CASH_REMOVED',
        text: ant.length === 1
          ? `O ${nomeDaForma(ant[0].method)} de ${brl(ant[0].amount)} sai do Financeiro e do caixa de ${dia}.`
          : `${listaPorForma(ant).replace(/^./, (c) => c.toUpperCase())} saem do Financeiro e do caixa de ${dia}.`,
      });
    } else {
      efeitos.push({ code: 'CASH_CHANGED', text: `O Financeiro e o caixa de ${dia} passam a mostrar ${listaPorForma(entradaDepois)}.` });
    }
    const din = (l) => round2(l.filter((p) => p.method === 'dinheiro').reduce((a, p) => a + p.amount, 0));
    const delta = round2(din(entradaDepois) - din(entradaAntes));
    if (caixa && caixa.status === 'aberta' && Math.abs(delta) > 0.005) {
      efeitos.push({ code: 'DRAWER_CHANGES', text: `O dinheiro esperado na gaveta ${delta < 0 ? 'cai' : 'sobe'} ${brl(Math.abs(delta))}.` });
    }
    const taxaAntes = ctx.taxa || 0;
    const baseAntes = baseDoCartao(entradaAntes);
    const baseDepois = baseDoCartao(entradaDepois);
    if (baseMudou(baseAntes, baseDepois)) {
      const taxaDepois = taxaPrevista(ctx.pdv_settings, baseDepois);
      if (Math.abs(taxaDepois - taxaAntes) > 0.005) {
        efeitos.push({
          code: 'CARD_FEE_CHANGES',
          text: taxaDepois > 0
            ? `A taxa da maquininha passa de ${brl(taxaAntes)} para ${brl(taxaDepois)}.`
            : `A taxa da maquininha (${brl(taxaAntes)}) sai do Financeiro.`,
        });
      }
    }
  }
  if (credito) {
    const nomeCli = (c) => (c && c.name) || 'a cliente';
    if (credito.action === 'enter') {
      const p = credito.to;
      efeitos.push({
        code: 'CREDIT_ENTERS',
        text: `Nasce um carnê “${p.account_name}” para ${nomeCli(p.customer)}, ` +
          (p.schedule.length
            ? `com ${p.installments} ${p.installments === 1 ? 'parcela' : 'parcelas'} a partir de ${ddmm(p.schedule[0].due_date)}.`
            : `com ${brl(p.amount)} em aberto.`),
      });
    } else if (credito.action === 'leave') {
      const f = credito.from;
      efeitos.push({
        code: 'CREDIT_LEAVES',
        text: (f.account_name ? `O carnê “${f.account_name}” de ${nomeCli(f.customer)} sai da ficha` : `A dívida de ${brl(f.amount)} de ${nomeCli(f.customer)} sai do crediário`) +
          ` e ${f.installments === 1 ? 'a parcela é cancelada' : `as ${f.installments} parcelas são canceladas`}.`,
      });
    } else if (credito.action === 'move') {
      efeitos.push({
        code: 'CREDIT_MOVES',
        text: `A dívida de ${brl(credito.from.amount)} passa de ${nomeCli(credito.from.customer)} para ${nomeCli(credito.to.customer)}, num carnê novo, “${credito.to.account_name}”.`,
      });
    } else {
      const p = credito.to;
      efeitos.push({
        code: 'CREDIT_RECREATED',
        text: `O carnê antigo sai da ficha e nasce “${p.account_name}” para ${nomeCli(p.customer)}: ${brl(p.amount)} em ${p.installments}x` +
          (p.schedule.length && p.schedule[0].due_date ? ` a partir de ${ddmm(p.schedule[0].due_date)}.` : '.'),
      });
    }
    if (credito.action === 'enter') {
      efeitos.push({ code: 'GOES_TO_RECEIVABLE', text: `Os ${brl(credito.to.amount)} passam para A Receber.` });
    }
  }
  if (cliente) {
    const a = cliente.from && cliente.from.name;
    const b = cliente.to && cliente.to.name;
    let t;
    if (a && b) t = `A compra sai do histórico de ${a} e entra no de ${b}.`;
    else if (b) t = `A compra entra no histórico de ${b}.`;
    else t = `A compra sai do histórico de ${a || 'quem estava na venda'}.`;
    efeitos.push({ code: 'CUSTOMER_HISTORY', text: t + ' O vale-troca do cupom continua valendo.' });
  }
  if (changes.length) efeitos.push({ code: 'NO_STOCK_CHANGE', text: 'Os produtos e o estoque não mudam.' });

  if (formaMudou && caixa) {
    if (caixa.status === 'fechada') {
      avisos.push({ code: 'CAIXA_CLOSED', text: `O caixa de ${dia} já foi fechado. O fechamento continua como foi conferido; a correção aparece nos relatórios por forma de pagamento.` });
    } else {
      avisos.push({ code: 'CAIXA_OPEN', text: 'A conferência do caixa aberto já mostra a forma nova.' });
    }
  }
  const nf = infoNfce(ctx);
  if (nf && dinheiroMudou) {
    avisos.push({
      code: 'NFCE_KEEPS_ORIGINAL',
      text: `A ${nf.rotulo} ${nf.numero || ''} já foi autorizada e continua com os dados originais. O que mudar aqui vale para o Financeiro, o caixa e a comissão.`.replace('  ', ' '),
    });
  }

  let confirmacao = null;
  if (credito && credito.action === 'enter') {
    const p = credito.to;
    confirmacao = {
      title: 'Lançar no crediário?',
      text: `${(p.customer && p.customer.name) || 'A cliente'} fica devendo ${brl(p.amount)} em ${p.installments} ${p.installments === 1 ? 'parcela' : 'parcelas'}. Se precisar desfazer, é só editar de novo enquanto nenhuma parcela for paga.`,
      confirm_label: 'Sim, lançar',
    };
  } else if (credito && credito.action === 'leave') {
    const f = credito.from;
    confirmacao = {
      title: 'Tirar do crediário?',
      text: `A dívida de ${brl(f.amount)} de ${(f.customer && f.customer.name) || 'a cliente'} sai do crediário e as parcelas são canceladas.`,
      confirm_label: 'Sim, tirar',
    };
  } else if (credito && credito.action === 'move') {
    confirmacao = {
      title: 'Passar a dívida para outra cliente?',
      text: `A dívida de ${brl(credito.from.amount)} sai de ${(credito.from.customer && credito.from.customer.name) || 'quem estava na venda'} e vai para ${(credito.to.customer && credito.to.customer.name) || 'a cliente nova'}, num carnê novo, com as mesmas parcelas.`,
      confirm_label: 'Sim, passar',
    };
  } else if (credito && credito.action === 'recreate') {
    const p = credito.to;
    confirmacao = {
      title: 'Refazer o carnê?',
      text: `O carnê de hoje sai da ficha e nasce outro: ${brl(p.amount)} em ${p.installments} ${p.installments === 1 ? 'parcela' : 'parcelas'} para ${(p.customer && p.customer.name) || 'a cliente'}.`,
      confirm_label: 'Sim, refazer',
    };
  }

  return {
    sale_id: s.id,
    sale_number: s.sale_number,
    company_id: s.company_id,
    changes,
    before,
    after,
    effects: efeitos,
    warnings: avisos,
    seller: vendedor,
    customer: cliente,
    payments: formaMudou ? {
      from: entradaAntes, to: entradaDepois, cash_changed: caixaMudou,
      cash_amount: round2(entradaDepois.reduce((a, p) => a + p.amount, 0)),
    } : null,
    credit: credito,
    requires_confirmation: !!confirmacao,
    confirmation: confirmacao,
    nfce: nf,
    caixa,
  };
}

// ── Aplicar ──────────────────────────────────────────────────
async function recalcularCliente(q, customerId, companyId) {
  if (!customerId) return;
  // Mesma conta da trigger trg_sale_update_customer (migration 311). A trigger
  // só dispara em UPDATE OF status; trocar o cliente não a aciona.
  await q.query(
    `UPDATE customers SET
       total_purchases   = (SELECT COUNT(*) FROM sales WHERE customer_id = $1 AND company_id = $2 AND COALESCE(status, 'completed') != 'cancelled'),
       total_spent       = (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE customer_id = $1 AND company_id = $2 AND COALESCE(status, 'completed') != 'cancelled'),
       last_purchase_at  = (SELECT MAX(created_at) FROM sales WHERE customer_id = $1 AND company_id = $2 AND COALESCE(status, 'completed') != 'cancelled'),
       first_purchase_at = (SELECT MIN(created_at) FROM sales WHERE customer_id = $1 AND company_id = $2 AND COALESCE(status, 'completed') != 'cancelled'),
       updated_at        = NOW()
     WHERE id = $1`,
    [customerId, companyId]
  );
}

async function comSavepoint(q, nome, fn) {
  await q.query(`SAVEPOINT ${nome}`);
  try {
    await fn();
    await q.query(`RELEASE SAVEPOINT ${nome}`);
  } catch (e) {
    await q.query(`ROLLBACK TO SAVEPOINT ${nome}`);
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
}

// Trava parcelas e A Receber da venda e confere de novo, já com a trava, que
// nada foi pago (inclusive recebimento só de encargos, que só deixa
// sale_payment na venda).
async function conferirQueNadaFoiPago(q, ctx) {
  const saleId = ctx.sale.id;
  const companyId = ctx.sale.company_id;
  const par = await q.query(
    `SELECT id, status, covered_amount FROM credit_installments
      WHERE sale_id = $1 AND company_id = $2 AND status <> 'cancelled' FOR UPDATE`,
    [saleId, companyId]
  );
  const rec = await q.query(
    `SELECT id, status, idempotency_key FROM transactions
      WHERE company_id = $2
        AND idempotency_key >= 'pdv-credit-receivable-' || $1::text
        AND idempotency_key <  'pdv-credit-receivable-' || $1::text || 'z'
      FOR UPDATE`,
    [saleId, companyId]
  );
  const sp = await q.query(
    `SELECT COALESCE(SUM(amount), 0) AS soma FROM sale_payments WHERE sale_id = $1 AND amount > 0`,
    [saleId]
  );
  // Renegociação que gravou entre a leitura e a trava: as mesmas regras (a)/(b)
  // do CREDIT_RENEGOTIATED, de novo, já com as parcelas travadas.
  const reneg = await q.query(
    `WITH deb AS (
       SELECT account_id FROM customer_credit_transactions
        WHERE sale_id = $1 AND company_id = $2 AND type = 'debit' LIMIT 1
     )
     SELECT
       (SELECT COUNT(*)::int FROM credit_installments ci
         WHERE ci.sale_id = $1 AND ci.company_id = $2 AND ci.status = 'cancelled'
           AND ci.account_id IS NOT DISTINCT FROM (SELECT account_id FROM deb)) AS canceladas,
       (SELECT COUNT(*)::int FROM credit_installments ci
         WHERE ci.company_id = $2 AND ci.sale_id IS NULL
           AND ci.account_id IN (SELECT account_id FROM deb WHERE account_id IS NOT NULL)) AS sem_venda,
       EXISTS (SELECT 1 FROM deb) AS tem_debito`,
    [saleId, companyId]
  );
  const rn = (reneg.rows && reneg.rows[0]) || {};
  if (rn.tem_debito && ((parseInt(rn.canceladas, 10) || 0) > 0 || (parseInt(rn.sem_venda, 10) || 0) > 0)) {
    throw new EdicaoError(409, 'CREDIT_RENEGOTIATED',
      'Este crediário acabou de ser renegociado ou juntado a outro carnê, então a forma e o cliente ficam como estão. Se o produto vai voltar, use “Devolver”.');
  }
  const entrada = round2((ctx.pagamentos.entrada || []).reduce((a, p) => a + num(p.amount), 0));
  const pago =
    (par.rows || []).some((p) => p.status === 'paid' || num(p.covered_amount) > 0.005) ||
    (rec.rows || []).some((r) => r.status !== 'pending' || /-rest-/.test(String(r.idempotency_key || ''))) ||
    num(sp.rows && sp.rows[0] && sp.rows[0].soma) > entrada + 0.005;
  if (pago) {
    throw new EdicaoError(409, 'CREDIT_HAS_PAYMENT',
      'Entrou um pagamento neste crediário agora há pouco. Para não bagunçar o que foi pago, a forma e o cliente ficam como estão. Se o produto vai voltar, use “Devolver”.');
  }
}

// Apaga um lançamento do Financeiro soltando antes o que aponta para ele
// (conciliação bancária e nota), como o DELETE /transactions/:txId.
async function apagarLancamento(q, { companyId, key }) {
  const { rows } = await q.query(
    `SELECT id FROM transactions WHERE idempotency_key = $1 AND company_id = $2`,
    [key, companyId]
  );
  for (const r of rows || []) {
    await comSavepoint(q, 'solta_conciliacao', async () => {
      // A linha do extrato volta a "pendente": sem isso ficaria conciliada
      // sem lançamento nenhum.
      await q.query(
        `UPDATE bank_statement_entries
            SET matched_transaction_id = NULL, match_status = 'pendente', matched_at = NULL
          WHERE matched_transaction_id = $1`,
        [r.id]
      );
    });
    await comSavepoint(q, 'solta_nota', async () => {
      await q.query('UPDATE nfce_emissions SET transaction_id = NULL WHERE transaction_id = $1', [r.id]);
    });
    await q.query(`DELETE FROM transactions WHERE id = $1 AND company_id = $2`, [r.id, companyId]);
  }
}

function rotuloDaForma(lista) {
  return lista.map((p) => p.method).join(' + ');
}
function descricaoNova(antiga, lista, produtos) {
  const rot = rotuloDaForma(lista);
  if (antiga && /\([^()]*\)\s*$/.test(antiga)) return antiga.replace(/\([^()]*\)\s*$/, '(' + rot + ')');
  if (antiga) return antiga + ' (' + rot + ')';
  return `Venda PDV - ${(produtos || []).slice(0, 3).join(', ') || 'Venda'} (${rot})`;
}
function formaPrincipal(lista) {
  // Mesma convenção do Caixa (useCart: a 1ª forma da venda dividida), com a
  // entrada na frente do crediário.
  const naoCred = lista.filter((p) => p.method !== 'crediario');
  if (naoCred.length) return naoCred[0].method;
  return lista.length ? lista[0].method : null;
}

/**
 * Grava o plano. Chamar DENTRO de uma transação, com a venda travada
 * (carregarContexto com lock). Devolve o resultado (carnê criado, parcelas,
 * registro da edição).
 */
async function aplicar(q, ctx, plan, { userId = null, userName = null, reason = null } = {}) {
  const s = ctx.sale;
  const companyId = s.company_id;
  const saleId = s.id;
  const resultado = { credit: null, edit: null };
  const colTx = await colunasDe('transactions');
  const colEmp = await colunasDe('employees');
  const colSales = await colunasDe('sales');

  // 1. Vendedor(a): sales.employee_id é o que a comissão lê
  //    (services/commission.js). seller_id é quem operou o Caixa (users.id);
  //    só acompanha quando já guardava um funcionário (PATCH antigo).
  if (plan.seller) {
    const novo = plan.seller.to;
    await q.query(
      `UPDATE sales SET
         seller_id = CASE WHEN seller_id IS NOT NULL
                           AND (seller_id = employee_id OR EXISTS (SELECT 1 FROM employees x WHERE x.id = sales.seller_id))
                          THEN $3::uuid ELSE seller_id END,
         employee_id = $3::uuid, seller_name = $4, updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [saleId, companyId, novo ? novo.id : null, novo ? novo.name : null]
    );
    if (colEmp.has('total_sales') && colEmp.has('total_revenue')) {
      if (s.employee_id) {
        await q.query(
          `UPDATE employees SET total_sales = GREATEST(COALESCE(total_sales, 0) - 1, 0),
                  total_revenue = GREATEST(COALESCE(total_revenue, 0) - $1, 0), updated_at = NOW()
            WHERE id = $2 AND company_id = $3`,
          [s.total_amount, s.employee_id, companyId]
        );
      }
      if (novo) {
        await q.query(
          `UPDATE employees SET total_sales = COALESCE(total_sales, 0) + 1,
                  total_revenue = COALESCE(total_revenue, 0) + $1, updated_at = NOW()
            WHERE id = $2 AND company_id = $3`,
          [s.total_amount, novo.id, companyId]
        );
      }
    }
  }

  // 1b. Venda no crediário: trava as parcelas e o A Receber dela e confere de
  //     novo que nada foi pago. O applyPayment não trava a venda; sem isto,
  //     um recebimento que entrasse entre a leitura e o cancelamento seria
  //     apagado junto (A Receber baixado, parcela paga, sale_payment).
  if (ctx.pagamentos.credito && (plan.payments || plan.customer || plan.credit)) {
    await conferirQueNadaFoiPago(q, ctx);
  }

  // 2. Crediário sai (antes de trocar o cliente: o cancelCreditSale lê o
  //    cliente da venda para recalcular o saldo dele).
  if (plan.credit && plan.credit.cancel) {
    resultado.credit_cancelled = await creditLedger.cancelCreditSale(q, { companyId, saleId });
    if (colSales.has('is_installment') && colSales.has('total_installments') && colSales.has('credit_plan_snapshot')) {
      await q.query(
        `UPDATE sales SET is_installment = false, total_installments = NULL, credit_plan_snapshot = NULL
          WHERE id = $1 AND company_id = $2`,
        [saleId, companyId]
      );
    }
  }

  // 3. Cliente.
  if (plan.customer) {
    const novo = plan.customer.to;
    await q.query(
      `UPDATE sales SET customer_id = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
      [saleId, companyId, novo ? novo.id : null]
    );
    const antigo = plan.customer.from;
    if (antigo && antigo.id) await recalcularCliente(q, antigo.id, companyId);
    if (novo && novo.id) await recalcularCliente(q, novo.id, companyId);
  }

  // 4. Formas que entraram no caixa.
  if (plan.payments) {
    const entrada = plan.payments.to;
    const dinheiroNaHora = plan.payments.cash_amount;
    if (plan.payments.cash_changed) {
      // Só as linhas da ENTRADA desta venda. Recebimento do crediário que
      // gravou sale_payment na venda fica onde está.
      const ids = ctx.pagamentos.entrada_ids || [];
      if (ids.length) {
        await q.query(
          `DELETE FROM sale_payments WHERE id = ANY($1::uuid[]) AND sale_id = $2 AND company_id = $3`,
          [ids, saleId, companyId]
        );
      }
      // Mesma sessão de antes (o caixa de 07/11 continua sendo o de 07/11) e
      // o mesmo instante: relatório por dia não muda de dia.
      const sessaoId = ctx.pagamentos.sessao_id || (ctx.caixa && ctx.caixa.id) || null;
      const quando = ctx.pagamentos.primeiro_em || s.created_at;
      for (const p of entrada) {
        await q.query(
          `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [saleId, companyId, p.method, p.amount, sessaoId, quando]
        );
      }
    }

    // Receita da venda no Financeiro (pdv-sale-<id>): o que entrou na hora.
    const receita = ctx.receita;
    const formaFin = entrada.length === 1 ? (NO_FINANCEIRO[entrada[0].method] || null) : null;
    if (dinheiroNaHora > 0.005) {
      const desc = descricaoNova(receita && receita.description, entrada, ctx.produtos);
      if (receita) {
        await q.query(
          `UPDATE transactions SET amount = $3, description = $4${colTx.has('payment_method') ? ', payment_method = $5' : ''}, updated_at = NOW()
            WHERE id = $1 AND company_id = $2`,
          colTx.has('payment_method') ? [receita.id, companyId, dinheiroNaHora, desc, formaFin] : [receita.id, companyId, dinheiroNaHora, desc]
        );
      } else {
        await q.query(
          `INSERT INTO transactions
             (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
           VALUES ($1, 'income', 'confirmed', $2, $3, 'Vendas', $4::date, $5, $6, $7)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [companyId, dinheiroNaHora, desc, s.dia, s.created_at, userId, 'pdv-sale-' + saleId]
        );
        if (colTx.has('payment_method') && formaFin) {
          await q.query(
            `UPDATE transactions SET payment_method = $3 WHERE idempotency_key = $1 AND company_id = $2`,
            ['pdv-sale-' + saleId, companyId, formaFin]
          );
        }
      }
    } else if (receita) {
      await apagarLancamento(q, { companyId, key: 'pdv-sale-' + saleId });
    }

    // Taxa da maquininha: só refaz quando a base no cartão mudou.
    const bA = baseDoCartao(plan.payments.from);
    const bD = baseDoCartao(entrada);
    if (baseMudou(bA, bD)) {
      await apagarLancamento(q, { companyId, key: CARD_FEE_KEY(saleId) });
      resultado.card_fee = await insertCardFeeExpense(q, {
        companyId, saleId, cardBase: bD, createdBy: userId, saleDate: s.dia,
        itemsSummary: (ctx.produtos || []).slice(0, 3).join(', '),
      });
    }

    const principal = formaPrincipal(plan.after.payments);
    if (principal) {
      await q.query(`UPDATE sales SET payment_method = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2`, [saleId, companyId, principal]);
    }
  }

  // 5. Crediário entra (carnê novo, como a venda no Caixa).
  if (plan.credit && plan.credit.create) {
    const to = plan.credit.to;
    const carne = await carneAuto.createAutoCarne(q, { companyId, customerId: to.customer.id, prefix: 'Compra', date: s.dia });
    // Venda que já estava no crediário (troca de cliente, carnê refeito): o
    // carnê novo leva os termos dela, e o cronograma também.
    const termos = to.terms || null;
    if (carne && termos) {
      await comSavepoint(q, 'termos_do_carne', async () => {
        await q.query(`UPDATE credit_accounts SET terms_snapshot = $3::jsonb WHERE id = $1 AND company_id = $2`, [carne.id, companyId, JSON.stringify(termos)]);
      });
    }
    const r = await creditLedger.createCreditSale(q, {
      companyId,
      customerId: to.customer.id,
      saleId,
      amount: to.amount,
      accountId: carne ? carne.id : null,
      installments: to.installments,
      firstDueDate: to.first_due_date || null,
      enforceCreditBlock: true,
      productNames: ctx.produtos || [],
      createdBy: userId,
      ...(termos ? {
        interestRate: termos.interest_rate != null ? termos.interest_rate : 0,
        periodUnit: termos.period_unit || null,
        periodCount: termos.period_count || null,
      } : {}),
    });
    // O débito e o A Receber são da VENDA, não de hoje: com o instante da
    // venda, o fiado cai no caixa do dia dela (caixaService.calcularTotais)
    // e o A Receber fica na ordem certa do FIFO do applyPayment.
    await q.query(
      `UPDATE customer_credit_transactions SET created_at = $3
        WHERE sale_id = $1 AND company_id = $2 AND type = 'debit'`,
      [saleId, companyId, s.created_at]
    );
    await q.query(
      `UPDATE transactions SET created_at = $3
        WHERE company_id = $2 AND status = 'pending'
          AND idempotency_key >= 'pdv-credit-receivable-' || $1::text
          AND idempotency_key <  'pdv-credit-receivable-' || $1::text || 'z'`,
      [saleId, companyId, s.created_at]
    );
    resultado.credit = {
      account_id: carne ? carne.id : null,
      account_name: carne ? carne.name : null,
      amount: to.amount,
      installments: r.schedule || [],
    };
  }

  // 6. Vendedor(a) no Financeiro: as linhas da venda passam a mostrar quem
  //    vendeu (inclusive as que esta edição acabou de criar).
  if ((plan.seller || plan.payments || plan.credit) && colTx.has('employee_id') && colTx.has('employee_name')) {
    const vend = plan.seller ? plan.seller.to : ctx.seller;
    if (plan.seller || (vend && vend.id)) {
      await q.query(
        `UPDATE transactions SET employee_id = $3, employee_name = $4, updated_at = NOW()
          WHERE company_id = $1
            AND (idempotency_key = 'pdv-sale-' || $2
                 OR (idempotency_key >= 'pdv-credit-receivable-' || $2 AND idempotency_key < 'pdv-credit-receivable-' || $2 || 'z'))`,
        [companyId, saleId, vend ? vend.id : null, vend ? vend.name : null]
      );
    }
  }

  // 7. Registro.
  const reg = await q.query(
    `INSERT INTO sale_edits (company_id, sale_id, edited_by, edited_by_name, changes, before, after, effects, reason)
     VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7::jsonb, $8::jsonb, $9)
     RETURNING id, created_at`,
    [companyId, saleId, userId, userName, plan.changes,
     JSON.stringify(plan.before), JSON.stringify(plan.after), JSON.stringify(plan.effects),
     reason ? String(reason).trim().slice(0, 500) || null : null]
  );
  resultado.edit = { id: reg.rows[0].id, created_at: reg.rows[0].created_at, edited_by_name: userName };
  return resultado;
}

// Última edição, para o detalhe ("Editada em dd/mm por Fulano").
async function ultimaEdicao(q, saleId) {
  try {
    const { rows } = await q.query(
      `SELECT id, edited_by_name, created_at, changes, reason FROM sale_edits
        WHERE sale_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [saleId]
    );
    if (!rows.length) return null;
    return { id: rows[0].id, by_name: rows[0].edited_by_name || null, at: rows[0].created_at, changes: rows[0].changes || [], reason: rows[0].reason || null };
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

module.exports = {
  CAMPOS_ACEITOS,
  EdicaoError,
  UUID_RE,
  normalizarMetodo,
  brl,
  agrupar,
  derivarPagamentos,
  previaDasParcelas,
  permissoesDeEdicao,
  registroDisponivel,
  carregarContexto,
  travaDaVenda,
  travaDoDinheiro,
  resumoParaEdicao,
  planejar,
  aplicar,
  ultimaEdicao,
  _resetCache,
};
