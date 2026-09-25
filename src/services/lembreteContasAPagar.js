// ============================================================
// AURA. — Lembrete de contas a pagar no sininho (25/09/2026)
//
// Pedido do Caio (caso Geovana / GF Amorim, que importou o histórico de
// despesas): "as despesas futuras abram uma notificação no sininho 2 dias
// antes lembrando do pagamento. Notificação simples, visualizou, sumiu."
// Vale para todos os clientes (decisão de 25/09).
//
// Regras:
//   · Despesa = transactions type 'expense' com status 'pending' (é o que o
//     Financeiro chama de "a pagar"; ver financeiroInsights.fetchTimeline).
//   · "2 dias antes" = due_date igual a hoje + 2 no dia civil de São Paulo.
//   · UM aviso por empresa e dia de vencimento, não um por conta: a GF Amorim
//     tem 2–3 contas por dia e um card por conta vira ruído. O corpo lista
//     até 3 contas e o total.
//   · Dedupe 'loja:conta_vencendo:<empresa>:<vencimento>' — o job pode rodar
//     de novo (deploy, reinício) sem repetir aviso.
//   · Expira no fim do dia do vencimento: depois disso o lembrete não serve.
//   · O disparo passa por lojaEvents (tipo 'loja_conta_vencendo'): card de
//     evento, preferência para desligar e severidade "atencao".
// ============================================================
'use strict';

const db = require('../config/database');
// Objeto inteiro, não desestruturado: ponto de costura dos testes.
const lojaEvents = require('./lojaEvents');

const TYPE = 'loja_conta_vencendo';
const DIAS_ANTES = 2;
const MAX_NA_LISTA = 3;

const brl = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** AAAA-MM-DD → DD/MM (sem new Date: data pura viraria UTC). */
function diaMes(iso) {
  const [, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}`;
}

/** Texto curto da conta: a descrição, cortada. */
function rotulo(t) {
  const s = String(t.description || 'Despesa').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

/**
 * Agrupa as contas por empresa e vencimento e monta o aviso de cada grupo.
 * Pura (sem banco): testável.
 *
 * @param {Array<{company_id, id, description, amount, due_date}>} contas
 * @returns {Array<{company_id, due_date, title, body, dedupeSuffix, expiresAt}>}
 */
function montarLembretes(contas) {
  const grupos = new Map();
  for (const c of contas || []) {
    const due = String(c.due_date instanceof Date ? c.due_date.toISOString() : c.due_date).slice(0, 10);
    const k = `${c.company_id}:${due}`;
    if (!grupos.has(k)) grupos.set(k, { company_id: c.company_id, due_date: due, contas: [] });
    grupos.get(k).contas.push(c);
  }

  const out = [];
  for (const g of grupos.values()) {
    const contas = g.contas.slice().sort((a, b) => Number(b.amount) - Number(a.amount));
    const total = contas.reduce((acc, c) => acc + Number(c.amount || 0), 0);
    const n = contas.length;
    const dm = diaMes(g.due_date);
    let title;
    let body;
    if (n === 1) {
      title = `Conta a pagar vence em ${dm}`;
      body = `${rotulo(contas[0])} · ${brl(contas[0].amount)}. Vence em 2 dias.`;
    } else {
      title = `${n} contas a pagar vencem em ${dm}`;
      const lista = contas.slice(0, MAX_NA_LISTA).map((c) => `${rotulo(c)} (${brl(c.amount)})`).join('; ');
      const resto = n > MAX_NA_LISTA ? ` e mais ${n - MAX_NA_LISTA}` : '';
      body = `Total ${brl(total)}: ${lista}${resto}.`;
    }
    out.push({
      company_id: g.company_id,
      due_date: g.due_date,
      title,
      body,
      dedupeSuffix: `${g.company_id}:${g.due_date}`,
      // Fim do dia do vencimento em São Paulo.
      expiresAt: `${g.due_date}T23:59:59-03:00`,
    });
  }
  return out;
}

/**
 * Procura as contas que vencem em 2 dias (dia civil de SP) em todas as
 * empresas ativas e dispara um aviso por empresa/dia. Nunca lança.
 */
async function runLembretes() {
  let contas = [];
  try {
    const { rows } = await db.query(
      `SELECT t.company_id, t.id, t.description, t.amount, t.due_date::text AS due_date
         FROM transactions t
         JOIN companies c ON c.id = t.company_id AND c.is_active = true
        WHERE t.type = 'expense'
          AND t.status = 'pending'
          AND t.due_date = (now() AT TIME ZONE 'America/Sao_Paulo')::date + $1::int
        ORDER BY t.company_id, t.amount DESC`,
      [DIAS_ANTES]
    );
    contas = rows;
  } catch (err) {
    console.error('[lembreteContas] falha ao buscar contas:', err.message);
    return { contas: 0, avisos: 0, criados: 0 };
  }

  const lembretes = montarLembretes(contas);
  let criados = 0;
  for (const l of lembretes) {
    const row = await lojaEvents.emitLojaEvent(
      TYPE,
      { company_id: l.company_id, title: l.title, body: l.body },
      { dedupeSuffix: l.dedupeSuffix, body: l.body, expiresAt: l.expiresAt }
    );
    if (row) criados += 1;
  }
  return { contas: contas.length, avisos: lembretes.length, criados };
}

module.exports = { TYPE, DIAS_ANTES, montarLembretes, runLembretes, _brl: brl };
