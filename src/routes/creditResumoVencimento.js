// ============================================================
// AURA. -- Crediario: resumo do que vence num periodo (card p-90)
//
//   GET /companies/:id/credit/installments/resumo-vencimento   (uma loja)
//   GET /me/credit/installments/resumo-vencimento              (todos os CNPJs)
//
// Query: de=YYYY-MM-DD & ate=YYYY-MM-DD (inclusivos). Sem eles, vale o
// janeiro do ANO QUE VEM no calendario de America/Sao_Paulo.
//
// SOMENTE LEITURA: so SELECT. Nao reaproveita GET /credit/installments,
// que sincroniza pending/overdue com UPDATE.
//
// Fonte: credit_installments (as PARCELAS dizem QUANDO vence; o razao so diz
// SE deve). Parcela conta quando esta ABERTA (pending/overdue), ainda tem
// saldo acima da tolerancia de arredondamento (a mesma da regra de atraso) e
// o cliente deve no razao (condicao 5 de services/credit/overdue.js -- sem
// isso entrariam parcelas orfas, sem divida). Paga e cancelada ficam de fora;
// parcela com pagamento parcial entra pelo que FALTA (amount_due - covered).
//
// Carne = account_id da parcela; parcelas antigas sem account_id caem na
// compra (sale_id). Nenhum dado de cliente final sai daqui: so contagens e
// valores.
// ============================================================
const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { getUserCompanyIds } = require('../utils/userCompanyIds');
const overdueRule = require('../services/credit/overdue');

const PLANOS = ['negocio', 'expansao'];
const MAX_DIAS = 400;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const int = (v) => parseInt(v || 0, 10) || 0;

function dataValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Janeiro do ano que vem, no dia-calendario de Sao Paulo. */
function janeiroDoAnoQueVem(agora) {
  const hoje = (agora || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const ano = Number(hoje.slice(0, 4)) + 1;
  return { de: `${ano}-01-01`, ate: `${ano}-01-31` };
}

/** { de, ate } validados, ou { erro }. Sem "ate", vale o fim do mes de "de". */
function resolvePeriodo(query, agora) {
  const q = query || {};
  const padrao = janeiroDoAnoQueVem(agora);
  const temDe = q.de !== undefined && q.de !== '';
  const temAte = q.ate !== undefined && q.ate !== '';
  const de = temDe ? q.de : padrao.de;
  let ate = temAte ? q.ate : padrao.ate;
  if (temDe && !temAte && dataValida(de)) {
    const [a, m] = de.split('-').map(Number);
    ate = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
  }
  if (!dataValida(de) || !dataValida(ate)) {
    return { erro: 'Datas invalidas. Use o formato AAAA-MM-DD em "de" e "ate".' };
  }
  if (de > ate) return { erro: 'A data inicial nao pode ser depois da final.' };
  const dias = (Date.parse(ate) - Date.parse(de)) / 86400000;
  if (dias > MAX_DIAS) return { erro: 'Periodo longo demais. Peca no maximo cerca de um ano por vez.' };
  return { de, ate };
}

// Parcelas que contam. $1 = lista de empresas, $2/$3 = periodo.
function filtroSql() {
  const tol = overdueRule.RESIDUE_TOLERANCE;
  return `ci.company_id = ANY($1::uuid[])
      AND ci.status IN ('pending','overdue')
      AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > ${tol}
      AND ci.due_date BETWEEN $2::date AND $3::date
      AND ${overdueRule.ledgerDebtSql({ alias: 'ci' })}`;
}

async function calcular(companyIds, periodo) {
  const params = [companyIds, periodo.de, periodo.ate];
  const where = filtroSql();

  const porLoja = await db.query(
    `SELECT ci.company_id,
            COUNT(*)                                                         AS parcelas,
            COALESCE(SUM(ci.amount_due - COALESCE(ci.covered_amount, 0)), 0) AS valor,
            COUNT(DISTINCT ci.customer_id)                                   AS clientes,
            COUNT(DISTINCT COALESCE(ci.account_id::text, ci.sale_id::text))  AS carnes
       FROM credit_installments ci
      WHERE ${where}
      GROUP BY ci.company_id`,
    params
  );

  const porSemana = await db.query(
    `SELECT DATE_TRUNC('week', ci.due_date)::date                            AS semana_inicio,
            COUNT(*)                                                         AS parcelas,
            COALESCE(SUM(ci.amount_due - COALESCE(ci.covered_amount, 0)), 0) AS valor
       FROM credit_installments ci
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1`,
    params
  );

  let nomes = {};
  if (companyIds.length > 1) {
    try {
      const n = await db.query(
        `SELECT id, COALESCE(trade_name, legal_name) AS nome FROM companies WHERE id = ANY($1::uuid[])`,
        [companyIds]
      );
      nomes = Object.fromEntries((n.rows || []).map((r) => [r.id, r.nome]));
    } catch (_) { nomes = {}; }
  }

  const mapa = new Map((porLoja.rows || []).map((r) => [r.company_id, r]));
  const empresas = companyIds.map((id) => {
    const r = mapa.get(id) || {};
    return {
      company_id: id,
      nome: nomes[id] || null,
      parcelas: int(r.parcelas),
      valor: r2(r.valor),
      clientes: int(r.clientes),
      carnes: int(r.carnes),
    };
  });

  // Cliente e carne pertencem a uma loja so, entao somar por loja nao repete ninguem.
  const total = empresas.reduce((t, e) => ({
    parcelas: t.parcelas + e.parcelas,
    valor: r2(t.valor + e.valor),
    clientes: t.clientes + e.clientes,
    carnes: t.carnes + e.carnes,
  }), { parcelas: 0, valor: 0, clientes: 0, carnes: 0 });

  return {
    periodo: { de: periodo.de, ate: periodo.ate },
    ...total,
    por_semana: (porSemana.rows || []).map((r) => ({
      semana_inicio: String(r.semana_inicio).slice(0, 10),
      parcelas: int(r.parcelas),
      valor: r2(r.valor),
    })),
    empresas,
  };
}

// ── Uma loja ────────────────────────────────────────────────
const companyRouter = express.Router({ mergeParams: true });

companyRouter.get('/installments/resumo-vencimento', async (req, res) => {
  const periodo = resolvePeriodo(req.query);
  if (periodo.erro) return res.status(400).json({ error: periodo.erro, code: 'PERIODO_INVALIDO' });
  const companyId = req.params.id;
  try {
    const c = await db.query(
      `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
      [companyId]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Empresa nao encontrada.' });
    if (c.rows[0].enabled !== 'true') {
      return res.status(403).json({
        error: 'Crediario nao habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.',
        code: 'CREDIARIO_DISABLED',
      });
    }
    const out = await calcular([companyId], periodo);
    out.consolidated = false;
    res.json(out);
  } catch (err) {
    console.error('GET /credit/installments/resumo-vencimento', err.message);
    res.status(500).json({ error: 'Nao foi possivel montar o resumo agora.' });
  }
});

// ── Todos os CNPJs do usuario ───────────────────────────────
const meRouter = express.Router();
meRouter.use(requireAuth);

meRouter.get('/installments/resumo-vencimento', async (req, res) => {
  const user = req.user || {};
  if (!PLANOS.includes(user.plan) && user.role !== 'admin') {
    return res.status(403).json({
      error: 'Plano atual nao inclui esta funcionalidade',
      required_plans: PLANOS,
      current_plan: user.plan,
    });
  }
  const periodo = resolvePeriodo(req.query);
  if (periodo.erro) return res.status(400).json({ error: periodo.erro, code: 'PERIODO_INVALIDO' });
  try {
    const todas = await getUserCompanyIds(user.id);
    // So lojas com o crediario ligado, como na rota de uma loja.
    let ids = [];
    if (todas.length) {
      const on = await db.query(
        `SELECT id FROM companies
          WHERE id = ANY($1::uuid[]) AND pdv_settings->>'crediario_enabled' = 'true'`,
        [todas]
      );
      ids = (on.rows || []).map((r) => r.id);
    }
    if (!ids.length) {
      return res.json({
        periodo, parcelas: 0, valor: 0, clientes: 0, carnes: 0,
        por_semana: [], empresas: [], consolidated: true, company_count: 0,
      });
    }
    const out = await calcular(ids, periodo);
    out.consolidated = true;
    out.company_count = ids.length;
    res.json(out);
  } catch (err) {
    console.error('GET /me/credit/installments/resumo-vencimento', err.message);
    res.status(500).json({ error: 'Nao foi possivel montar o resumo agora.' });
  }
});

module.exports = { companyRouter, meRouter, resolvePeriodo, janeiroDoAnoQueVem };
