// ============================================================
// AURA KARATÊ — Track L: Saúde da Rede
// Montado em /federation/:id/network-health/*
//
// Indicadores institucionais derivados de dados que a FEDERAÇÃO
// possui (afiliações, anuidades, exames, competições, geografia).
// SEM métricas internas de dojô (churn de praticante, presença).
//
// Endpoints:
//   GET  /summary          — KPI band (5 números) + todos indicadores
//   GET  /afiliacao        — dojôs afiliados + evolução anual
//   GET  /renovacao        — taxa de renovação no período
//   GET  /cobertura        — densidade por região administrativa SP
//   GET  /inadimplencia    — status anuidades de dojô
//   GET  /projecao-receita — receita projetada por mês de vencimento
//   GET  /dormencia        — dojôs ativos × dormentes (sem exam/comp na season)
//   GET  /concentracao     — concentração top-5 dojôs (praticantes + receita)
//   GET  /graduacoes       — exames Kyu→Dan registrados (mensal)
//   GET  /relacao-faixas   — distribuição atual de atletas por faixa
//   POST /report/send      — compõe e envia relatório periódico por e-mail (adminOnly)
//
// Todos os GET aceitam ?export=csv para download.
// Guards: FEDERATION_READ para leitura; adminOnly para report/send.
// Defensive 42P01: safe to deploy antes de qualquer nova migration.
// Não requer migration — tudo derivado de tabelas existentes.
//
// NOTA DE COERÊNCIA DE MÉTRICAS (24/06): "Dojôs afiliados" da Saúde usa a
// BASE TOTAL de dojôs da federação (todos vertical_active = karate_dojo, sem
// filtro de is_active), igual à página Dojôs e ao Painel. As "novas filiações
// no ano" continuam disponíveis, mas como métrica SEPARADA (new_affiliations_
// year), nunca como o número de "afiliados". Inadimplência: dojô SEM cobrança
// lançada não é inadimplente — o denominador são as anuidades efetivamente
// lançadas; sem cobranças → inadimplência 0%.
//
// NOTA DE AFILIAÇÃO (25/06): "novas filiações no ano" e a evolução anual contam
// por companies.affiliation_since (ano de filiação real), null-safe: dojô SEM
// affiliation_since NÃO entra na contagem e NÃO usa created_at como proxy
// (created_at é a data da IMPORTAÇÃO da base FPKT, não a data de filiação). Com
// affiliation_since NULL em toda a base hoje, o indicador mostra 0 — correto; a
// federação preenche "Filiação desde" na ficha do dojô. O total de filiados
// (base total de dojôs) é independente disso.
//
// COBERTURA (Item 5, 25/06): a COBERTURA geográfica é a ÚNICA exceção à base
// total — usa só dojôs CADASTRADOS E ATIVOS (is_active IS NOT FALSE), pois é
// um retrato da presença real da rede no território. Não mexe em afiliados/
// inadimplência (coerência #239). As "lacunas de cobertura" (regiões sem dojô)
// foram REMOVIDAS: não são pendência a corrigir.
//
// NOTA DE GRADUAÇÕES (25/06): "Graduações Registradas" conta karate_belt_history
// INDEPENDENTE de exam_id (as graduações importadas têm exam_id NULL e DEVEM
// aparecer). Janela = YTD (date_trunc('year', CURRENT_DATE) até CURRENT_DATE),
// excluindo a sentinela graduated_at = '1900-01-01' (backfill) e datas futuras
// (typos da planilha). Gráfico, tabela e KPI usam a MESMA janela/fonte.
//
// NOTA DE CATEGORIZAÇÃO DE FAIXA (24/06): na "Relação de faixas" o belt_level
// da faixa preta é 'preta' (o belt_name carrega o grau: 'Preta 1°', 'Preta 2°'…),
// e NÃO '1dan'/'2dan'. A categorização antiga procurava keys como '1dan' e por
// isso ~600 pretas caíam em nenhum bucket → Dan aparecia 0. Agora normalizamos
// acento/caixa do belt_level e roteamos qualquer 'preta' para Dan (1º Dan por
// padrão; 2º+ quando o grau no belt_name for >= 2). A Vermelha (histórica) NÃO
// entra nos buckets ativos.
//
// NOTA DE SCHEMA (23/06): correções de colunas inexistentes que faziam as
// telas 500 contra uma federação com dados reais:
//   - companies.karate_region NÃO existe → coluna correta é companies.region
//   - karate_dojo_annuity_history NÃO tem season_year (nem season) → a "season"
//     é derivada de due_date via EXTRACT(YEAR FROM due_date)::int
//   - karate_belt_history NÃO tem exam_date/dojo_id/new_belt_level/old_belt_level/
//     examiner_name → usa graduated_at; dojo_id vem de customers (student_id);
//     o histórico guarda só a faixa CONQUISTADA (belt_level/belt_name).
//   - karate_dojo_annuity_history.status é TEXTO (não o enum transaction_status):
//     'paid'/'pending'/'overdue' são valores legítimos e foram mantidos.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { sendKarateEmail } = require('../services/karateMailer');

// ── helpers ────────────────────────────────────────────────────

function safeQuery(sql, params) {
  return db.query(sql, params).catch((err) => {
    // 42P01 = table undefined → return empty gracefully
    if (err.code === '42P01') return { rows: [] };
    throw err;
  });
}

function currentSeason() {
  return new Date().getFullYear();
}

function fmtBRL(v) {
  const n = Number(v || 0);
  return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Normaliza belt_level: minúsculo, sem acento, sem espaços nas bordas.
// 'Preta', 'PRETA', 'roxa'/'roxo' caem todos no mesmo token.
function normBelt(level) {
  return String(level || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Categoriza uma faixa (belt_level + belt_name) num bucket da pirâmide.
// belt_level='preta' (qualquer grau) é Dan; o grau vem do belt_name
// ('Preta 1°' → 1º Dan, 'Preta 2°'+ → 2º Dan ou acima). Tokens '1dan'..'9dan'
// (caso o schema use esse formato) também são reconhecidos. Vermelha = null
// (histórica, fora dos buckets ativos).
function beltBucketKey(level, name) {
  const b = normBelt(level);
  if (!b) return null;
  if (b === 'vermelha' || b === 'vermelho') return null; // histórica, não infla ativos
  if (b === 'branca' || b === 'amarela' || b === 'laranja') return 'kyu_ini';
  if (b === 'verde' || b === 'azul_claro' || b === 'azulclaro' || b === 'roxo' || b === 'roxa') return 'kyu_int';
  if (b === 'azul_escuro' || b === 'azulescuro' || b === 'marrom') return 'kyu_av';
  // Faixa preta / Dan
  if (b === 'preta') {
    const grau = parseInt((String(name || '').match(/(\d+)/) || [])[1], 10);
    return grau >= 2 ? 'dan2' : 'dan1';
  }
  const danMatch = b.match(/^(\d+)\s*dan$/);
  if (danMatch) {
    return parseInt(danMatch[1], 10) >= 2 ? 'dan2' : 'dan1';
  }
  return null;
}

// Regiões administrativas do estado de SP usadas no heatmap.
// col/row drive a posição no grid 5x4 do mockup.
const SP_REGIONS = [
  { regiao: 'Capital — São Paulo',               short: 'Capital',     col: 4, row: 3 },
  { regiao: 'Grande SP — ABC / Osasco / Guarulhos', short: 'Grande SP',  col: 5, row: 3 },
  { regiao: 'Campinas',                           short: 'Campinas',    col: 4, row: 2 },
  { regiao: 'Vale do Paraíba',                    short: 'Vale',        col: 5, row: 2 },
  { regiao: 'Sorocaba',                           short: 'Sorocaba',    col: 3, row: 3 },
  { regiao: 'Baixada Santista',                   short: 'Baixada',     col: 4, row: 4 },
  { regiao: 'Ribeirão Preto',                     short: 'Ribeirão',    col: 3, row: 1 },
  { regiao: 'Bauru',                              short: 'Bauru',       col: 2, row: 2 },
  { regiao: 'Litoral Norte',                      short: 'Litoral N.',  col: 5, row: 4 },
  { regiao: 'Marília',                            short: 'Marília',     col: 1, row: 3 },
  { regiao: 'Pres. Prudente',                     short: 'P. Prudente', col: 1, row: 2 },
  { regiao: 'Barretos',                           short: 'Barretos',    col: 2, row: 1 },
  { regiao: 'Franca',                             short: 'Franca',      col: 4, row: 1 },
  { regiao: 'Araraquara — Central',               short: 'Central',     col: 3, row: 2 },
];

// Municipalities count per region (reference, static — no IBGE table dependency).
const SP_MUN_TOTAL = {
  'Capital — São Paulo': 1,
  'Grande SP — ABC / Osasco / Guarulhos': 39,
  'Campinas': 90,
  'Vale do Paraíba': 39,
  'Sorocaba': 79,
  'Baixada Santista': 9,
  'Ribeirão Preto': 25,
  'Bauru': 39,
  'Litoral Norte': 4,
  'Marília': 51,
  'Pres. Prudente': 53,
  'Barretos': 18,
  'Franca': 23,
  'Araraquara — Central': 32,
};

// Build CSV string from cols + rows.
function buildCsv(cols, rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /["\\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = cols.map((c) => esc(c.label)).join(';');
  const body = rows.map((r) => cols.map((c) => esc(r[c.key])).join(';')).join('\r\n');
  return '﻿' + head + '\r\n' + body;
}

function sendCsv(res, filename, cols, rows) {
  const csv = buildCsv(cols, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="saude-rede_${filename}.csv"`);
  res.send(csv);
}

// ── Afiliação da rede ─────────────────────────────────────────
// Deriva de companies (karate_dojo) + karate_dojo_annuity_history.
// Conta dojôs por ano de FILIAÇÃO (affiliation_since) para evolução anual.
router.get('/afiliacao', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const exportCsv = req.query.export === 'csv';
  try {
    // BASE TOTAL de dojôs da federação (sem filtro de is_active) — coerente
    // com a página Dojôs e o Painel. Um dojô inativo continua filiado.
    // affiliated_since = companies.affiliation_since (data real de filiação;
    // pode ser NULL — a importação FPKT não trouxe essa data).
    const dojosRes = await safeQuery(
      `SELECT c.id, COALESCE(c.trade_name, c.legal_name) AS name,
              c.city, c.region,
              c.affiliation_since::date AS affiliated_since
       FROM companies c
       WHERE c.federation_id = $1
         AND c.vertical_active = 'karate_dojo'
       ORDER BY c.affiliation_since ASC NULLS LAST, c.created_at ASC`,
      [fedId]
    );
    const dojos = dojosRes.rows;

    // Evolução anual: conta novas filiações por ANO DE FILIAÇÃO (affiliation_since).
    // Null-safe: dojô sem affiliation_since NÃO entra (não vira ano 0 nem usa
    // created_at como proxy — created_at é a data da importação, não da filiação).
    const yearlyRes = await safeQuery(
      `SELECT EXTRACT(YEAR FROM c.affiliation_since)::int AS ano, COUNT(*)::int AS new_affiliations
       FROM companies c
       WHERE c.federation_id = $1
         AND c.vertical_active = 'karate_dojo'
         AND c.affiliation_since IS NOT NULL
       GROUP BY ano
       ORDER BY ano ASC`,
      [fedId]
    );

    // Anuidades do ano corrente para detectar renovações
    const season = currentSeason();
    const annuityRes = await safeQuery(
      `SELECT dojo_id, status, paid_at
       FROM karate_dojo_annuity_history
       WHERE federation_id = $1
         AND EXTRACT(YEAR FROM due_date)::int = $2`,
      [fedId, season]
    );
    const annuityBydojo = {};
    for (const r of annuityRes.rows) annuityBydojo[r.dojo_id] = r;

    const totalNow = dojos.length;
    // Novas filiações DO ANO — por affiliation_since (métrica SEPARADA, nunca
    // confundida com "afiliados"). Null-safe: dojô sem affiliation_since não conta.
    const newAffiliationsYear = dojos.filter((d) => {
      if (!d.affiliated_since) return false;
      const y = new Date(d.affiliated_since).getFullYear();
      return y === season;
    }).length;

    // Não renovaram: anuidade da season pendente/overdue
    const naoRenov = annuityRes.rows.filter((a) =>
      ['pending', 'overdue'].includes(a.status)
    ).length;

    if (exportCsv) {
      const cols = [
        { key: 'name', label: 'Dojô' },
        { key: 'city', label: 'Cidade' },
        { key: 'region', label: 'Região' },
        { key: 'affiliated_since', label: 'Filiado desde' },
        { key: 'annuity_status', label: 'Anuidade' },
      ];
      const rows = dojos.map((d) => ({
        name: d.name,
        city: d.city || '',
        region: d.region || '',
        affiliated_since: d.affiliated_since ? String(d.affiliated_since).slice(0, 10) : '',
        annuity_status: annuityBydojo[d.id] ? annuityBydojo[d.id].status : 'sem registro',
      }));
      return sendCsv(res, 'afiliacao', cols, rows);
    }

    res.json({
      season,
      total_now: totalNow,
      // Campo novo, nomeado sem ambiguidade. Mantém-se novas_affiliacoes como
      // alias legado pelo mesmo valor para não quebrar o front existente.
      new_affiliations_year: newAffiliationsYear,
      novas_affiliacoes: newAffiliationsYear,
      nao_renovaram: naoRenov,
      yearly: yearlyRes.rows,
      dojos: dojos.map((d) => ({
        id: d.id,
        name: d.name,
        city: d.city || null,
        region: d.region || null,
        affiliated_since: d.affiliated_since ? String(d.affiliated_since).slice(0, 10) : null,
        annuity_status: annuityBydojo[d.id] ? annuityBydojo[d.id].status : null,
      })),
    });
  } catch (err) {
    console.error('[networkHealth] afiliacao error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar afiliação' });
  }
});

// ── Taxa de renovação ─────────────────────────────────────────
// % de dojôs cuja anuidade venceu no período que renovaram (paid).
router.get('/renovacao', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const season = parseInt(req.query.season) || currentSeason();
  try {
    const r = await safeQuery(
      `SELECT
         COUNT(*)                                            AS total_due,
         COUNT(*) FILTER (WHERE status = 'paid')            AS renewed,
         COUNT(*) FILTER (WHERE status IN ('pending','overdue')) AS not_renewed
       FROM karate_dojo_annuity_history
       WHERE federation_id = $1 AND EXTRACT(YEAR FROM due_date)::int = $2`,
      [fedId, season]
    );
    const row = r.rows[0] || {};
    const totalDue = parseInt(row.total_due || 0, 10);
    const renewed = parseInt(row.renewed || 0, 10);
    const notRenewed = parseInt(row.not_renewed || 0, 10);
    const rate = totalDue > 0 ? Number((renewed / totalDue * 100).toFixed(1)) : null;

    res.json({ season, total_due: totalDue, renewed, not_renewed: notRenewed, renewal_rate_pct: rate });
  } catch (err) {
    console.error('[networkHealth] renovacao error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular taxa de renovação' });
  }
});

// ── Cobertura geográfica ──────────────────────────────────────
// Agrupa dojôs por region; mapeia para o grid de regiões de SP.
router.get('/cobertura', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const exportCsv = req.query.export === 'csv';
  try {
    // Cobertura = dojôs CADASTRADOS E ATIVOS (Item 5). "Ativo" segue o critério
    // do app (computeDojoStatus): inativo só quando is_active = false. Por isso
    // is_active IS NOT FALSE (true OU null contam como ativo). NOTA: isto muda
    // SÓ a base da cobertura; afiliados/inadimplência (coerência #239) seguem
    // usando a base total em seus próprios endpoints.
    const r = await safeQuery(
      `SELECT c.region,
              COUNT(DISTINCT c.id)::int AS dojos,
              COUNT(DISTINCT c.city) AS mun_covered,
              COUNT(cu.id)::int AS practitioners
       FROM companies c
       LEFT JOIN customers cu ON cu.dojo_id = c.id AND cu.federation_id = $1
       WHERE c.federation_id = $1
         AND c.vertical_active = 'karate_dojo'
         AND c.is_active IS NOT FALSE
       GROUP BY c.region`,
      [fedId]
    );

    const byRegion = {};
    for (const row of r.rows) {
      if (row.region) byRegion[row.region] = row;
    }

    const regions = SP_REGIONS.map((reg) => {
      const data = byRegion[reg.regiao] || { dojos: 0, mun_covered: 0, practitioners: 0 };
      return {
        regiao: reg.regiao,
        short: reg.short,
        col: reg.col,
        row: reg.row,
        dojos: parseInt(data.dojos || 0, 10),
        mun_covered: parseInt(data.mun_covered || 0, 10),
        mun_total: SP_MUN_TOTAL[reg.regiao] || 0,
        practitioners: parseInt(data.practitioners || 0, 10),
      };
    });

    if (exportCsv) {
      const cols = [
        { key: 'regiao', label: 'Região' },
        { key: 'dojos', label: 'Dojôs' },
        { key: 'mun_covered', label: 'Mun. c/ dojô' },
        { key: 'mun_total', label: 'Mun. na região' },
        { key: 'practitioners', label: 'Praticantes' },
        { key: 'situacao', label: 'Situação' },
      ];
      const rows = regions.map((r) => ({
        ...r,
        situacao: r.dojos === 0 ? 'Sem dojô' : r.dojos < 3 ? 'Cobertura baixa' : 'Coberta',
      }));
      return sendCsv(res, 'cobertura', cols, rows);
    }

    // Item 5: "lacunas de cobertura" (regiões sem dojô) removidas — não é
    // pendência a corrigir; a tela mostra só a densidade dos dojôs ativos.
    res.json({
      regions,
    });
  } catch (err) {
    console.error('[networkHealth] cobertura error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar cobertura' });
  }
});

// ── Inadimplência da rede ─────────────────────────────────────
// Status das anuidades de afiliação dos dojôs (em dia / vencendo / vencido).
// REGRA: dojô SEM cobrança lançada não entra na conta — o denominador são as
// anuidades efetivamente registradas. Sem cobranças → inadimplência 0%.
router.get('/inadimplencia', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const season = parseInt(req.query.season) || currentSeason();
  const exportCsv = req.query.export === 'csv';
  try {
    const r = await safeQuery(
      `SELECT h.dojo_id,
              COALESCE(c.trade_name, c.legal_name) AS dojo_name,
              c.city,
              h.due_date, h.amount, h.status, h.paid_at
       FROM karate_dojo_annuity_history h
       JOIN companies c ON c.id = h.dojo_id
       WHERE h.federation_id = $1 AND EXTRACT(YEAR FROM h.due_date)::int = $2
       ORDER BY
         CASE h.status WHEN 'overdue' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
         h.due_date ASC`,
      [fedId, season]
    );

    const rows = r.rows;
    const total = rows.length;
    const emDia = rows.filter((r) => r.status === 'paid').length;
    const vencendo = rows.filter((r) => {
      if (r.status !== 'pending') return false;
      const diff = r.due_date ? (new Date(r.due_date) - new Date()) / 86400000 : 999;
      return diff >= 0 && diff <= 7;
    }).length;
    const vencido = rows.filter((r) => r.status === 'overdue').length;
    // total aqui = anuidades lançadas. Sem cobranças → total 0 → inadPct 0.
    const inadPct = total > 0 ? Number((vencido / total * 100).toFixed(1)) : 0;

    if (exportCsv) {
      const cols = [
        { key: 'dojo_name', label: 'Dojô' },
        { key: 'city', label: 'Cidade' },
        { key: 'due_date', label: 'Vencimento' },
        { key: 'amount', label: 'Valor' },
        { key: 'status', label: 'Status' },
      ];
      const csvRows = rows.map((r) => ({
        dojo_name: r.dojo_name,
        city: r.city || '',
        due_date: r.due_date ? String(r.due_date).slice(0, 10) : '',
        amount: fmtBRL(r.amount),
        status: r.status,
      }));
      return sendCsv(res, 'inadimplencia', cols, csvRows);
    }

    res.json({
      season,
      total,
      em_dia: emDia,
      vencendo,
      vencido,
      inad_pct: inadPct,
      rows: rows.map((r) => ({
        dojo_id: r.dojo_id,
        dojo_name: r.dojo_name,
        city: r.city || null,
        due_date: r.due_date ? String(r.due_date).slice(0, 10) : null,
        amount: Number(r.amount || 0),
        status: r.status,
        paid_at: r.paid_at ? String(r.paid_at).slice(0, 10) : null,
      })),
    });
  } catch (err) {
    console.error('[networkHealth] inadimplencia error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar inadimplência' });
  }
});

// ── Projeção de receita ───────────────────────────────────────
// Agrupa anuidades por mês de vencimento do mês corrente até dezembro do ano
// corrente (inclusive). kind: 'real' (already paid) | 'proj' (pending/future)
router.get('/projecao-receita', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const exportCsv = req.query.export === 'csv';
  // Janela: mês atual → dezembro do ano corrente (independe de quantos meses faltam).
  const now = new Date();
  const currentYear = now.getFullYear();
  // Quantos meses na série: de mês atual (0-based) até dezembro (11) inclusive.
  const monthsInWindow = 12 - now.getMonth(); // ex: junho (5) → 7 meses (jun..dez)
  try {
    const r = await safeQuery(
      `SELECT
         DATE_TRUNC('month', due_date)        AS month_start,
         SUM(amount)                          AS total,
         SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) AS realized,
         SUM(CASE WHEN status != 'paid' THEN amount ELSE 0 END) AS projected,
         COUNT(*)::int                        AS annuities
       FROM karate_dojo_annuity_history
       WHERE federation_id = $1
         AND due_date >= DATE_TRUNC('month', CURRENT_DATE)
         AND due_date <  MAKE_DATE($2::int, 12, 31) + INTERVAL '1 day'
       GROUP BY month_start
       ORDER BY month_start ASC`,
      [fedId, currentYear]
    );

    const data = r.rows.map((row) => {
      const d = new Date(row.month_start);
      const mes = d.toLocaleString('pt-BR', { month: 'short' }).replace('.', '');
      const ano = String(d.getFullYear()).slice(2);
      return {
        month: String(row.month_start).slice(0, 7),
        mes,
        ano,
        total: Number(row.total || 0),
        realized: Number(row.realized || 0),
        projected: Number(row.projected || 0),
        annuities: row.annuities,
        kind: Number(row.realized || 0) > 0 && Number(row.projected || 0) === 0 ? 'real' : 'proj',
      };
    });

    const totalProj = data.reduce((s, d) => s + d.projected, 0);
    const totalReal = data.reduce((s, d) => s + d.realized, 0);

    if (exportCsv) {
      const cols = [
        { key: 'month', label: 'Mês de vencimento' },
        { key: 'annuities', label: 'Anuidades vencendo' },
        { key: 'realized_fmt', label: 'Realizado' },
        { key: 'projected_fmt', label: 'Projetado' },
        { key: 'total_fmt', label: 'Total' },
      ];
      const csvRows = data.map((d) => ({
        month: d.month,
        annuities: d.annuities,
        realized_fmt: fmtBRL(d.realized),
        projected_fmt: fmtBRL(d.projected),
        total_fmt: fmtBRL(d.total),
      }));
      return sendCsv(res, 'projecao-receita', cols, csvRows);
    }

    res.json({
      months_in_window: monthsInWindow,
      total_realized: totalReal,
      total_projected: totalProj,
      data,
    });
  } catch (err) {
    console.error('[networkHealth] projecao-receita error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar projeção de receita' });
  }
});

// ── Dojô ativo × dormente ─────────────────────────────────────
// Dojô ativo na season: registrou >= 1 exame OU >= 1 inscrição em competição.
// Dojô dormente: nenhuma dessas ações.
router.get('/dormencia', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const season = parseInt(req.query.season) || currentSeason();
  const exportCsv = req.query.export === 'csv';
  try {
    // Base TOTAL de dojôs afiliados (sem is_active)
    const dojosRes = await safeQuery(
      `SELECT c.id, COALESCE(c.trade_name, c.legal_name) AS name, c.city, c.region
       FROM companies c
       WHERE c.federation_id = $1
         AND c.vertical_active = 'karate_dojo'`,
      [fedId]
    );

    // Dojôs que tiveram pelo menos uma graduação na season.
    // karate_belt_history não tem dojo_id nem exam_date → dojo via customers,
    // data via graduated_at.
    const examRes = await safeQuery(
      `SELECT DISTINCT cu.dojo_id
       FROM karate_belt_history bh
       JOIN customers cu ON cu.id = bh.student_id
       WHERE bh.federation_id = $1
         AND EXTRACT(YEAR FROM bh.graduated_at)::int = $2
         AND cu.dojo_id IS NOT NULL`,
      [fedId, season]
    );
    const examActive = new Set(examRes.rows.map((r) => r.dojo_id));

    // Dojôs que tiveram pelo menos uma inscrição em competição na season
    const compRes = await safeQuery(
      `SELECT DISTINCT e.dojo_id
       FROM karate_competition_entries e
       JOIN karate_competitions c ON c.id = e.competition_id
       WHERE c.federation_id = $1 AND c.season = $2
         AND e.dojo_id IS NOT NULL`,
      [fedId, season]
    );
    const compActive = new Set(compRes.rows.map((r) => r.dojo_id));

    const result = dojosRes.rows.map((d) => {
      const hasExam = examActive.has(d.id);
      const hasComp = compActive.has(d.id);
      return {
        id: d.id,
        name: d.name,
        city: d.city || null,
        region: d.region || null,
        has_exam: hasExam,
        has_comp: hasComp,
        active: hasExam || hasComp,
      };
    });

    const total = result.length;
    const ativos = result.filter((d) => d.active).length;
    const dormentes = total - ativos;

    if (exportCsv) {
      const cols = [
        { key: 'name', label: 'Dojô' },
        { key: 'city', label: 'Cidade' },
        { key: 'region', label: 'Região' },
        { key: 'has_exam', label: 'Exame na season' },
        { key: 'has_comp', label: 'Comp. na season' },
        { key: 'active', label: 'Ativo' },
      ];
      const csvRows = result.map((d) => ({
        ...d,
        has_exam: d.has_exam ? 'Sim' : 'Não',
        has_comp: d.has_comp ? 'Sim' : 'Não',
        active: d.active ? 'Ativo' : 'Dormente',
      }));
      return sendCsv(res, 'dormencia', cols, csvRows);
    }

    res.json({
      season,
      total,
      ativos,
      dormentes,
      pct_ativos: total > 0 ? Number((ativos / total * 100).toFixed(1)) : null,
      dojos: result,
    });
  } catch (err) {
    console.error('[networkHealth] dormencia error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular dormência' });
  }
});

// ── Concentração ──────────────────────────────────────────────
// Share dos top-5 dojôs em praticantes e receita de anuidade.
router.get('/concentracao', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const season = parseInt(req.query.season) || currentSeason();
  const exportCsv = req.query.export === 'csv';
  try {
    // Praticantes por dojô — base TOTAL de dojôs (sem is_active)
    const practRes = await safeQuery(
      `SELECT c.id, COALESCE(c.trade_name, c.legal_name) AS name,
              COUNT(cu.id)::int AS practitioners
       FROM companies c
       LEFT JOIN customers cu ON cu.dojo_id = c.id AND cu.federation_id = $1
       WHERE c.federation_id = $1
         AND c.vertical_active = 'karate_dojo'
       GROUP BY c.id, c.trade_name, c.legal_name
       ORDER BY practitioners DESC`,
      [fedId]
    );

    // Receita de anuidade por dojô (season)
    const revRes = await safeQuery(
      `SELECT dojo_id, SUM(amount) AS revenue
       FROM karate_dojo_annuity_history
       WHERE federation_id = $1 AND EXTRACT(YEAR FROM due_date)::int = $2 AND status = 'paid'
       GROUP BY dojo_id`,
      [fedId, season]
    );
    const revByDojo = {};
    for (const r of revRes.rows) revByDojo[r.dojo_id] = Number(r.revenue || 0);

    const dojos = practRes.rows.map((d) => ({
      id: d.id,
      name: d.name,
      practitioners: d.practitioners,
      revenue: revByDojo[d.id] || 0,
    }));

    const totalPract = dojos.reduce((s, d) => s + d.practitioners, 0);
    const totalRev = dojos.reduce((s, d) => s + d.revenue, 0);
    const top5 = dojos.slice(0, 5);
    const top5Pract = top5.reduce((s, d) => s + d.practitioners, 0);
    const top5Rev = top5.reduce((s, d) => s + d.revenue, 0);

    if (exportCsv) {
      const cols = [
        { key: 'name', label: 'Dojô' },
        { key: 'practitioners', label: 'Praticantes' },
        { key: 'pct_pract', label: '% praticantes' },
        { key: 'revenue_fmt', label: 'Receita anuidade' },
        { key: 'pct_rev', label: '% receita' },
      ];
      const csvRows = dojos.map((d) => ({
        name: d.name,
        practitioners: d.practitioners,
        pct_pract: totalPract > 0 ? (d.practitioners / totalPract * 100).toFixed(1) + '%' : '0%',
        revenue_fmt: fmtBRL(d.revenue),
        pct_rev: totalRev > 0 ? (d.revenue / totalRev * 100).toFixed(1) + '%' : '0%',
      }));
      return sendCsv(res, 'concentracao', cols, csvRows);
    }

    res.json({
      season,
      total_dojos: dojos.length,
      total_practitioners: totalPract,
      total_revenue: totalRev,
      top5_pct_practitioners: totalPract > 0 ? Number((top5Pract / totalPract * 100).toFixed(1)) : null,
      top5_pct_revenue: totalRev > 0 ? Number((top5Rev / totalRev * 100).toFixed(1)) : null,
      top5,
      all: dojos,
    });
  } catch (err) {
    console.error('[networkHealth] concentracao error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular concentração' });
  }
});

// ── Graduações registradas ────────────────────────────────────
// Exames Kyu→Dan registrados na federação, agrupados por mês.
// karate_belt_history guarda só a faixa CONQUISTADA (belt_level/belt_name) e
// a data em graduated_at; o dojô vem de customers (student_id).
// Dan = faixa preta (belt_level 'preta', qualquer grau) OU tokens '1dan'..'9dan';
// o restante é Kyu. Normaliza acento/caixa.
// JANELA: YTD (1º jan do ano corrente → hoje). Conta INDEPENDENTE de exam_id
// (graduações importadas têm exam_id NULL e DEVEM aparecer). Exclui a sentinela
// 1900-01-01 e datas futuras. Gráfico (monthRes), tabela (listRes) e o KPI de
// /summary usam a MESMA janela/fonte. (`months` mantido por compat de API, mas
// a janela é YTD; o rótulo "YTD" e i18n de datas são do FE.)
router.get('/graduacoes', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const months = parseInt(req.query.months) || 8;
  const exportCsv = req.query.export === 'csv';
  try {
    // Mensal. Dan reconhecido por belt_level 'preta' (sem acento) ou '%dan%'.
    const monthRes = await safeQuery(
      `SELECT
         DATE_TRUNC('month', graduated_at) AS month_start,
         TO_CHAR(DATE_TRUNC('month', graduated_at), 'YYYY-MM') AS ym,
         COUNT(*) FILTER (
           WHERE translate(lower(belt_level), 'áàâãéêíóôõúç', 'aaaaeeiooouc') !~ 'preta|dan'
         ) AS kyu_count,
         COUNT(*) FILTER (
           WHERE translate(lower(belt_level), 'áàâãéêíóôõúç', 'aaaaeeiooouc') ~ 'preta|dan'
         ) AS dan_count,
         COUNT(*)::int AS total
       FROM karate_belt_history
       WHERE federation_id = $1
         AND graduated_at >= date_trunc('year', CURRENT_DATE)
         AND graduated_at <= CURRENT_DATE
         AND graduated_at <> DATE '1900-01-01'
       GROUP BY month_start
       ORDER BY month_start ASC`,
      [fedId]
    );

    // Lista detalhada — MESMA janela/fonte do gráfico (YTD, sem exam_id filter,
    // sem sentinela/datas futuras).
    const listRes = await safeQuery(
      `SELECT bh.id, bh.graduated_at, bh.student_id,
              cu.name AS student_name,
              COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
              bh.belt_level, bh.belt_name
       FROM karate_belt_history bh
       JOIN customers cu ON cu.id = bh.student_id
       LEFT JOIN companies dj ON dj.id = cu.dojo_id
       WHERE bh.federation_id = $1
         AND bh.graduated_at >= date_trunc('year', CURRENT_DATE)
         AND bh.graduated_at <= CURRENT_DATE
         AND bh.graduated_at <> DATE '1900-01-01'
       ORDER BY bh.graduated_at DESC`,
      [fedId]
    );

    // Rótulo do mês derivado da string 'YYYY-MM' (TO_CHAR no SQL), NUNCA de
    // new Date(month_start) — evita o shift de -1 mês por fuso (01/02 UTC virava
    // 31/01 local → "jan"). Mesma classe dos bugs -1 dia já corrigidos.
    const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const months_data = monthRes.rows.map((r) => {
      const ym = r.ym || String(r.month_start).slice(0, 7);
      const [yy, mm] = ym.split('-');
      return {
        month: ym,
        mes: MESES_PT[parseInt(mm, 10) - 1] || '',
        ano: String(yy).slice(2),
        kyu: parseInt(r.kyu_count || 0, 10),
        dan: parseInt(r.dan_count || 0, 10),
        total: parseInt(r.total || 0, 10),
      };
    });

    const gradKyu = months_data.reduce((s, m) => s + m.kyu, 0);
    const gradDan = months_data.reduce((s, m) => s + m.dan, 0);

    if (exportCsv) {
      const cols = [
        { key: 'graduated_at', label: 'Data' },
        { key: 'dojo_name', label: 'Dojô' },
        { key: 'student_name', label: 'Candidato' },
        { key: 'belt_level', label: 'Faixa' },
        { key: 'belt_name', label: 'Nome da faixa' },
      ];
      const csvRows = listRes.rows.map((r) => ({
        graduated_at: r.graduated_at ? String(r.graduated_at).slice(0, 10) : '',
        dojo_name: r.dojo_name || '',
        student_name: r.student_name || '',
        belt_level: r.belt_level || '',
        belt_name: r.belt_name || '',
      }));
      return sendCsv(res, 'graduacoes-registradas', cols, csvRows);
    }

    res.json({
      months,
      total: gradKyu + gradDan,
      kyu: gradKyu,
      dan: gradDan,
      monthly: months_data,
      list: listRes.rows.map((r) => ({
        id: r.id,
        exam_date: r.graduated_at ? String(r.graduated_at).slice(0, 10) : null,
        student_id: r.student_id,
        student_name: r.student_name,
        dojo_name: r.dojo_name || null,
        to_belt: r.belt_level || null,
        to_belt_name: r.belt_name || null,
        examiner: null,
      })),
    });
  } catch (err) {
    console.error('[networkHealth] graduacoes error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar graduações' });
  }
});

// ── Relação de faixas (snapshot/pirâmide) ─────────────────────
// Distribuição atual de atletas por faixa em toda a rede.
// Caveat explícito: snapshot, não funil de coorte.
router.get('/relacao-faixas', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const exportCsv = req.query.export === 'csv';
  try {
    const r = await safeQuery(
      `SELECT cb.belt_level, cb.belt_name,
              COUNT(*)::int AS count
       FROM karate_current_belt cb
       WHERE cb.federation_id = $1
       GROUP BY cb.belt_level, cb.belt_name
       ORDER BY cb.belt_level ASC`,
      [fedId]
    );

    const rows = r.rows;

    // Buckets da pirâmide (mockup). A categorização real é feita por
    // beltBucketKey(belt_level, belt_name): belt_level='preta' (qualquer grau)
    // conta como Dan (1º Dan por padrão; 2º+ quando o grau no belt_name >= 2),
    // acento/caixa normalizados. Vermelha (histórica) fica FORA dos buckets.
    const BUCKETS = [
      { key: 'kyu_ini', faixa: 'Kyu iniciante',     long: '9º–7º Kyu · iniciante' },
      { key: 'kyu_int', faixa: 'Kyu intermediário', long: '6º–4º Kyu · intermediário' },
      { key: 'kyu_av',  faixa: 'Kyu avançado',      long: '3º–1º Kyu · avançado' },
      { key: 'dan1',    faixa: '1º Dan',            long: '1º Dan · faixa preta' },
      { key: 'dan2',    faixa: '2º Dan ou acima',   long: '2º Dan ou acima' },
    ];

    const counts = { kyu_ini: 0, kyu_int: 0, kyu_av: 0, dan1: 0, dan2: 0 };
    // total = só praticantes que caem em algum bucket ativo (Vermelha excluída).
    let total = 0;
    for (const row of rows) {
      const k = beltBucketKey(row.belt_level, row.belt_name);
      if (!k || !(k in counts)) continue; // Vermelha / faixa desconhecida → fora
      counts[k] += row.count;
      total += row.count;
    }

    const buckets = BUCKETS.map((b) => {
      const n = counts[b.key] || 0;
      return { faixa: b.faixa, long: b.long, n, pct: total > 0 ? Number((n / total * 100).toFixed(1)) : 0 };
    });

    const danN = counts.dan1 + counts.dan2;
    const kyuN = counts.kyu_ini + counts.kyu_int + counts.kyu_av;
    const danPct = total > 0 ? Number((danN / total * 100).toFixed(1)) : 0;

    if (exportCsv) {
      const cols = [
        { key: 'long', label: 'Faixa de graduação' },
        { key: 'n', label: 'Praticantes' },
        { key: 'pct', label: '% do total' },
      ];
      const csvRows = buckets.map((b) => ({ ...b, pct: b.pct + '%' }));
      return sendCsv(res, 'relacao-faixas', cols, csvRows);
    }

    res.json({
      total,
      kyu: kyuN,
      dan: danN,
      dan_pct: danPct,
      buckets,
      raw: rows,
      _note: 'Snapshot da distribuição atual — não é um funil de coorte. Vermelha (histórica) fora dos buckets ativos.',
    });
  } catch (err) {
    console.error('[networkHealth] relacao-faixas error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar relação de faixas' });
  }
});

// ── Sumário (KPI band + todos indicadores agregados) ──────────
// Um único endpoint para o painel carregar os 5 KPIs do topo.
router.get('/summary', ...guards.read(), async (req, res) => {
  const fedId = req.params.id;
  const season = parseInt(req.query.season) || currentSeason();
  try {
    // 1. Dojôs afiliados — BASE TOTAL (sem is_active), coerente com Painel/Dojôs.
    const dojosRes = await safeQuery(
      `SELECT COUNT(*)::int AS total FROM companies
       WHERE federation_id = $1 AND vertical_active = 'karate_dojo'`,
      [fedId]
    );
    const dojoCount = parseInt(dojosRes.rows[0]?.total || 0, 10);

    // 1b. Novas filiações no ano — por affiliation_since (métrica SEPARADA, não
    //     é "afiliados"). Null-safe: dojô sem affiliation_since não conta (NÃO
    //     usa created_at, que é a data da importação). Todos NULL agora → 0.
    const newAffRes = await safeQuery(
      `SELECT COUNT(*)::int AS total FROM companies
       WHERE federation_id = $1 AND vertical_active = 'karate_dojo'
         AND affiliation_since IS NOT NULL
         AND EXTRACT(YEAR FROM affiliation_since)::int = $2`,
      [fedId, season]
    );
    const newAffiliationsYear = parseInt(newAffRes.rows[0]?.total || 0, 10);

    // 2. Praticantes registrados
    const practRes = await safeQuery(
      `SELECT COUNT(*)::int AS total FROM customers
       WHERE federation_id = $1`,
      [fedId]
    );
    const practCount = parseInt(practRes.rows[0]?.total || 0, 10);

    // 3. Inadimplência % — denominador = anuidades lançadas; dojô sem cobrança
    //    não entra. Sem cobranças → total 0 → inadPct 0 (não divide por zero).
    const inadRes = await safeQuery(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'overdue')::int AS vencido
       FROM karate_dojo_annuity_history
       WHERE federation_id = $1 AND EXTRACT(YEAR FROM due_date)::int = $2`,
      [fedId, season]
    );
    const inadTotal = parseInt(inadRes.rows[0]?.total || 0, 10);
    const inadVencido = parseInt(inadRes.rows[0]?.vencido || 0, 10);
    const inadPct = inadTotal > 0 ? Number((inadVencido / inadTotal * 100).toFixed(1)) : 0;

    // 4. Graduações no ano (YTD) — independente de exam_id (graduações
    //    importadas têm exam_id NULL e DEVEM contar). Exclui a sentinela
    //    1900-01-01 (backfill) e datas futuras (typos da planilha).
    const gradRes = await safeQuery(
      `SELECT COUNT(*)::int AS total FROM karate_belt_history
       WHERE federation_id = $1
         AND graduated_at >= date_trunc('year', CURRENT_DATE)
         AND graduated_at <= CURRENT_DATE
         AND graduated_at <> DATE '1900-01-01'`,
      [fedId]
    );
    const gradTotal = parseInt(gradRes.rows[0]?.total || 0, 10);

    // 5. Receita projetada próximos 90 dias
    const projRes = await safeQuery(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM karate_dojo_annuity_history
       WHERE federation_id = $1
         AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'
         AND status != 'paid'`,
      [fedId]
    );
    const projTotal = Number(projRes.rows[0]?.total || 0);

    // 1c. Dojôs FILIADOS EM DIA — decisão de produto (02/07): o KPI de topo da
    //     Saúde da Rede conta apenas dojôs com anuidade de filiação PAGA na
    //     temporada (status='paid'). Difere da base total (dojoCount), que segue
    //     coerente com Painel/Dojôs. Dojô sem anuidade lançada NÃO é "em dia".
    const emDiaRes = await safeQuery(
      `SELECT COUNT(DISTINCT c.id)::int AS total
         FROM companies c
         JOIN karate_dojo_annuity_history a ON a.dojo_id = c.id
        WHERE c.federation_id = $1 AND c.vertical_active = 'karate_dojo'
          AND EXTRACT(YEAR FROM a.due_date)::int = $2
          AND a.status = 'paid'`,
      [fedId, season]
    );
    const filiadosEmDia = parseInt(emDiaRes.rows[0]?.total || 0, 10);

    res.json({
      season,
      dojo_total: dojoCount,
      new_affiliations_year: newAffiliationsYear,
      kpis: [
        { key: 'dojos', label: 'Dojôs filiados', value: filiadosEmDia, unit: '' },
        { key: 'praticantes', label: 'Praticantes registrados', value: practCount, unit: '' },
        { key: 'inadimplencia', label: 'Inadimplência', value: inadPct, unit: '%' },
        { key: 'graduacoes', label: 'Graduações YTD', value: gradTotal, unit: '' },
        { key: 'receita_proj_90d', label: 'Receita proj. · 90 d', value: projTotal, unit: 'BRL' },
      ],
    });
  } catch (err) {
    console.error('[networkHealth] summary error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar sumário' });
  }
});

// ── Relatório periódico ──────────────────────────────────────
// Compõe um resumo da rede e envia por e-mail ao admin da federação.
// POST /report/send — trigger manual; scheduler pode chamar o mesmo handler.
router.post('/report/send', ...guards.adminOnly(), async (req, res) => {
  const fedId = req.params.id;
  const season = parseInt(req.query.season) || currentSeason();
  try {
    // Fetch federation info
    const fedRes = await db.query(
      `SELECT COALESCE(trade_name, legal_name) AS name,
              email, karate_logo_url, wa_phone_display
       FROM companies WHERE id = $1 LIMIT 1`,
      [fedId]
    );
    if (!fedRes.rows.length) {
      return res.status(404).json({ error: 'Federação não encontrada' });
    }
    const fed = fedRes.rows[0];
    const toEmail = req.body.to || fed.email;
    if (!toEmail) {
      return res.status(422).json({ error: 'Nenhum e-mail de destino. Passe { to: "email@..." } no body.' });
    }

    // Gather summary data (re-uses safe queries)
    const [dojosRes, inadRes, gradRes, dormRes] = await Promise.all([
      safeQuery(
        `SELECT COUNT(*)::int AS total FROM companies
         WHERE federation_id = $1 AND vertical_active = 'karate_dojo'`,
        [fedId]
      ),
      safeQuery(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'overdue')::int AS vencido,
                COUNT(*) FILTER (WHERE status = 'paid')::int AS paid
         FROM karate_dojo_annuity_history
         WHERE federation_id = $1 AND EXTRACT(YEAR FROM due_date)::int = $2`,
        [fedId, season]
      ),
      safeQuery(
        `SELECT COUNT(*)::int AS total FROM karate_belt_history
         WHERE federation_id = $1
           AND graduated_at >= CURRENT_DATE - INTERVAL '30 days'`,
        [fedId]
      ),
      safeQuery(
        `SELECT
           COUNT(DISTINCT cu.dojo_id) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM karate_belt_history bh
               WHERE bh.federation_id = $1
                 AND bh.student_id = cu.id
                 AND EXTRACT(YEAR FROM bh.graduated_at)::int = $2
             ) OR EXISTS (
               SELECT 1 FROM karate_competition_entries e
               JOIN karate_competitions kc ON kc.id = e.competition_id
               WHERE kc.federation_id = $1 AND kc.season = $2
                 AND e.student_id = cu.id
             )
           )::int AS active_dojos
         FROM customers cu
         WHERE cu.federation_id = $1`,
        [fedId, season]
      ),
    ]);

    const dojoCount = parseInt(dojosRes.rows[0]?.total || 0, 10);
    const inadTotal = parseInt(inadRes.rows[0]?.total || 0, 10);
    const inadVencido = parseInt(inadRes.rows[0]?.vencido || 0, 10);
    const inadPaid = parseInt(inadRes.rows[0]?.paid || 0, 10);
    const renewalPct = inadTotal > 0 ? Math.round(inadPaid / inadTotal * 100) : null;
    const inadPct = inadTotal > 0 ? Math.round(inadVencido / inadTotal * 100) : null;
    const gradLast30 = parseInt(gradRes.rows[0]?.total || 0, 10);
    const activeDojos = parseInt(dormRes.rows[0]?.active_dojos || 0, 10);
    const dormenteDojos = dojoCount - activeDojos;

    const fedName = fed.name || 'Federação';
    const dateStr = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });

    const bodyHtml = `
      <p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 18px;">
        Relatório de Saúde da Rede · Temporada ${season} · ${dateStr}
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="border-collapse:collapse;margin-bottom:18px;">
        <tr>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:13px;color:#44403c;">
            Dojôs filiados
          </td>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:14px;font-weight:700;color:#1c1917;text-align:right;">
            ${dojoCount}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:13px;color:#44403c;">
            Taxa de renovação (${season})
          </td>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:14px;font-weight:700;color:#15803d;text-align:right;">
            ${renewalPct !== null ? renewalPct + '%' : '—'}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:13px;color:#44403c;">
            Inadimplência (${season})
          </td>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:14px;font-weight:700;color:${inadVencido > 0 ? '#b02a2a' : '#15803d'};text-align:right;">
            ${inadPct !== null ? inadPct + '%' : '—'}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:13px;color:#44403c;">
            Dojôs dormentes (${season})
          </td>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:14px;font-weight:700;color:${dormenteDojos > 0 ? '#b45309' : '#15803d'};text-align:right;">
            ${dormenteDojos}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:13px;color:#44403c;">
            Graduações registradas (últimos 30 d)
          </td>
          <td style="padding:10px 14px;border:1px solid #e6e0d4;font-size:14px;font-weight:700;color:#1c1917;text-align:right;">
            ${gradLast30}
          </td>
        </tr>
      </table>
      <p style="font-size:12px;color:#78716c;line-height:18px;margin:0;">
        Acesse o painel completo em Aura Karatê para detalhes por indicador e exportação CSV.
      </p>`;

    await sendKarateEmail(toEmail, {
      subject: `Saúde da Rede ${fedName} · ${dateStr}`,
      heading: `Saúde da Rede — ${fedName}`,
      bodyHtml,
      federationName: fedName,
      federationLogoUrl: fed.karate_logo_url || null,
      federationWhatsapp: fed.wa_phone_display || null,
    });

    res.json({
      sent: true,
      to: toEmail,
      season,
      summary: { dojoCount, renewalPct, inadPct, dormenteDojos, gradLast30 },
    });
  } catch (err) {
    console.error('[networkHealth] report/send error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar relatório', detail: err.message });
  }
});

module.exports = router;
