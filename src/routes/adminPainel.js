// ============================================================
// AURA. — Gestão Aura: painel de blocos (13/10/2026)
//
// Montado em /admin/painel (staff). A tela lê o que o job diário gravou
// (jobs/painelDiarioScheduler.js → painel_blocos_diarios); só calcula ao
// vivo quando o dia ainda não tem linha, e avisa com ao_vivo: true.
//
// GET  /admin/painel/hoje                   — cabeçalho, blocos (resumo) e alertas
// GET  /admin/painel/blocos/:id?periodo=    — card expandido (7 | 30 | 90 dias)
// GET  /admin/painel/clientes/:cid/ficha    — ficha da loja
// GET  /admin/painel/layout                 — blocos visíveis e ordem do usuário
// PUT  /admin/painel/layout                 — body: { blocos: [{ id, visivel }] }
// POST /admin/painel/recalcular             — roda o passo diário agora
// (conferência com a Asaas: routes/adminPainelAsaas.js, em /admin/painel/asaas)
//
// Exemplos reais de cada resposta: tests/fixtures/painel/*.json.
// ============================================================
'use strict';

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const { BLOCOS, POR_ID, PERIODOS } = require('../services/painelBlocos');
const base = require('../services/painelBlocos/_base');
const { usoPorModulo } = require('../services/painelBlocos/_uso');
const painel = require('../services/painelDiario');
const { calcularAlertas } = require('../services/painelAlertas');
const { listarClients360 } = require('../services/clients360');

const adminOnly = [requireAuth, requireRole('admin')];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Próximas 06:00 de Brasília (09:00 UTC), em ISO.
function proximoCalculo(agora = Date.now()) {
  const brt = new Date(agora - 3 * 3600000);
  const dia = brt.getUTCHours() < 6 ? brt : new Date(brt.getTime() + 86400000);
  return new Date(Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth(), dia.getUTCDate(), 9, 0, 0)).toISOString();
}

// O que o card fechado precisa (a lista e o detalhe ficam para /blocos/:id).
function resumoDoBloco(def, dados) {
  return {
    id: def.id,
    titulo: def.titulo,
    grupo: def.grupo,
    valor: dados.valor,
    unidade: dados.unidade || null,
    variacao: dados.variacao || null,
    serie: dados.serie || [],
    resumo: dados.resumo || null,
    fonte: dados.fonte || null,
  };
}

const formatarAlerta = (a) => ({
  tipo: a.tipo,
  company_id: a.company_id || null,
  titulo: a.titulo,
  detalhe: a.detalhe || null,
  verbo: a.verbo || null,
  bloco: a.bloco || null,
});

// ── GET /admin/painel/hoje ──────────────────────────────────────
router.get('/hoje', ...adminOnly, asyncHandler(async (req, res) => {
  const hoje = painel.hojeBRT();
  const gravados = await base.opcional(
    pool,
    `SELECT bloco, dados, calculado_em FROM painel_blocos_diarios WHERE dia = $1::date`,
    [hoje]
  );

  if (gravados.length) {
    const porBloco = new Map(gravados.map((g) => [g.bloco, g]));
    const alertas = await base.opcional(
      pool,
      `SELECT tipo, company_id, titulo, detalhe, verbo, bloco
         FROM painel_alertas WHERE dia = $1::date ORDER BY id`,
      [hoje]
    );
    return res.json({
      dia: hoje,
      calculado_em: gravados.reduce((m, g) => (g.calculado_em > m ? g.calculado_em : m), gravados[0].calculado_em),
      proximo_calculo: proximoCalculo(),
      ao_vivo: false,
      blocos: BLOCOS.filter((d) => porBloco.has(d.id)).map((d) => resumoDoBloco(d, porBloco.get(d.id).dados)),
      alertas: alertas.map(formatarAlerta),
    });
  }

  // O dia ainda não foi calculado (antes das 06h, ou job atrasado): calcula
  // agora, sem gravar — gravar é do job e do botão Recalcular.
  const { resultados, empresas } = await painel.calcularBlocos({ hoje });
  await painel.aplicarVariacao({ hoje, resultados });
  const alertas = await calcularAlertas({ hoje, empresas });
  res.json({
    dia: hoje,
    calculado_em: new Date().toISOString(),
    proximo_calculo: proximoCalculo(),
    ao_vivo: true,
    blocos: BLOCOS.filter((d) => resultados[d.id]).map((d) => resumoDoBloco(d, resultados[d.id])),
    alertas: alertas.map(formatarAlerta),
  });
}));

// ── GET /admin/painel/blocos/:id?periodo=7|30|90 ────────────────
router.get('/blocos/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const def = POR_ID.get(req.params.id);
  if (!def) throw new AppError('Bloco não encontrado', 404);

  let periodo = def.periodoPadrao;
  if (req.query.periodo !== undefined) {
    periodo = parseInt(req.query.periodo, 10);
    if (!PERIODOS.includes(periodo)) throw new AppError('periodo deve ser 7, 30 ou 90', 400);
  }

  const hoje = painel.hojeBRT();
  let dados = null;
  let calculadoEm = null;
  // Só o período padrão do bloco está gravado; outro período é ao vivo.
  if (periodo === def.periodoPadrao) {
    const rows = await base.opcional(
      pool,
      `SELECT dados, calculado_em FROM painel_blocos_diarios WHERE dia = $1::date AND bloco = $2`,
      [hoje, def.id]
    );
    if (rows.length) { dados = rows[0].dados; calculadoEm = rows[0].calculado_em; }
  }
  const aoVivo = !dados;
  if (aoVivo) {
    dados = await def.calcular({ hoje, periodo });
    calculadoEm = new Date().toISOString();
  }

  const detalhe = dados.detalhe || {};
  res.json({
    id: def.id,
    titulo: def.titulo,
    periodo,
    calculado_em: calculadoEm,
    ao_vivo: aoVivo,
    valor: dados.valor,
    unidade: dados.unidade || null,
    resumo: dados.resumo || null,
    fonte: dados.fonte || null,
    indicadores: detalhe.indicadores || [],
    listas: detalhe.listas || [],
    series: detalhe.series || [],
    insight: detalhe.insight || null,
  });
}));

// ── GET /admin/painel/clientes/:cid/ficha ───────────────────────
const TITULO_EVENTO = {
  venda: (e) => (e.detalhe === 'cancelled' ? 'Venda cancelada' : 'Venda'),
  login: (e) => (e.detalhe === 'switch_company' ? 'Entrou (troca de loja)' : 'Login'),
  pagamento: (e) => ({
    PAYMENT_RECEIVED: 'Pagamento recebido',
    PAYMENT_CONFIRMED: 'Pagamento confirmado',
    PAYMENT_OVERDUE: 'Pagamento atrasado',
    PAYMENT_DELETED: 'Cobrança apagada na Asaas',
  }[e.detalhe] || `Asaas: ${e.detalhe}`),
  nota: (e) => `NFC-e ${e.detalhe}`,
};

router.get('/clientes/:cid/ficha', ...adminOnly, asyncHandler(async (req, res) => {
  const { cid } = req.params;
  if (!UUID.test(cid)) throw new AppError('Empresa não encontrada', 404);

  const hoje = painel.hojeBRT();
  const [cliente] = await listarClients360({ companyId: cid });
  if (!cliente) throw new AppError('Empresa não encontrada', 404);

  const semanas = base.ultimasSemanas(hoje, 12);
  const [logins, asaas, linhaDoTempo, vendasSemana, alertas, modulos] = await Promise.all([
    base.consultar(
      pool,
      `SELECT COUNT(*) FILTER (WHERE action = 'login') AS logins,
              COUNT(DISTINCT (created_at AT TIME ZONE '${base.TZ}')::date) AS dias_ativos,
              MAX(created_at) AS ultimo
         FROM audit_log
        WHERE company_id = $2 AND action IN ${base.ACOES_ACESSO}
          AND created_at >= ${base.desde(30)}`,
      [hoje, cid]
    ),
    base.opcional(
      pool,
      `SELECT event, processed_at,
              NULLIF(${base.PAGAMENTO_ASAAS}->>'value', '')::numeric AS valor,
              ${base.PAGAMENTO_ASAAS}->>'dueDate' AS vencimento
         FROM webhook_logs
        WHERE company_id = $1 AND provider = 'asaas'
        ORDER BY processed_at DESC
        LIMIT 20`,
      [cid]
    ),
    base.consultar(
      pool,
      `SELECT tipo, quando, valor, detalhe FROM (
         (SELECT 'venda' AS tipo, created_at AS quando, total_amount AS valor, COALESCE(status, 'completed')::text AS detalhe
            FROM sales WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10)
         UNION ALL
         (SELECT 'login', created_at, NULL::numeric, action::text
            FROM audit_log WHERE company_id = $1 AND action IN ${base.ACOES_ACESSO} ORDER BY created_at DESC LIMIT 10)
         UNION ALL
         (SELECT 'pagamento', processed_at, NULLIF(${base.PAGAMENTO_ASAAS}->>'value', '')::numeric, event::text
            FROM webhook_logs WHERE company_id = $1 AND provider = 'asaas' ORDER BY processed_at DESC LIMIT 10)
         UNION ALL
         (SELECT 'nota', created_at, total_nfce, status::text
            FROM nfce_emissions WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10)
       ) eventos
       ORDER BY quando DESC
       LIMIT 10`,
      [cid]
    ),
    base.consultar(
      pool,
      `SELECT to_char(date_trunc('week', created_at AT TIME ZONE '${base.TZ}')::date, 'YYYY-MM-DD') AS semana,
              COUNT(*) AS vendas
         FROM sales
        WHERE company_id = $1 AND ${base.VENDA_VALIDA}
          AND created_at >= ($2::date::timestamp AT TIME ZONE '${base.TZ}')
        GROUP BY 1`,
      [cid, semanas[0]]
    ),
    base.opcional(
      pool,
      `SELECT tipo, company_id, titulo, detalhe, verbo, bloco
         FROM painel_alertas WHERE dia = $1::date AND company_id = $2 ORDER BY id`,
      [hoje, cid]
    ),
    usoPorModulo({ hoje, periodo: 30, companyId: cid }),
  ]);

  const l = logins[0] || {};
  const usados = modulos
    .map((m) => ({ id: m.id, nome: m.rotulo, uso: m.lojas.get(cid) }))
    .filter((m) => m.uso && m.uso.total > 0)
    .map((m) => ({
      id: m.id,
      nome: m.nome,
      usou_30d: m.uso.ep > 0,
      eventos_30d: m.uso.ep,
      ultimo_uso: m.uso.ultimo,
    }))
    .sort((x, y) => y.eventos_30d - x.eventos_30d);

  res.json({
    company_id: cid,
    nome: cliente.name || cliente.trade_name || cliente.legal_name,
    telefone: cliente.owner_phone || null,
    cliente,
    health: cliente.health_score === null ? null : {
      score: cliente.health_score,
      risk_level: cliente.risk_level,
      activity_score: cliente.activity_score,
      usage_score: cliente.usage_score,
      payment_score: cliente.payment_score,
      adoption_score: cliente.adoption_score,
    },
    logins: {
      ultimos_30d: base.num(l.logins),
      dias_ativos_30d: base.num(l.dias_ativos),
      ultimo_acesso: l.ultimo || cliente.last_login_at || null,
    },
    asaas: asaas.map((e) => ({
      evento: e.event,
      quando: e.processed_at,
      valor: e.valor === null || e.valor === undefined ? null : base.round2(e.valor),
      vencimento: e.vencimento || null,
    })),
    modulos: usados.map((m) => m.nome),
    modulos_detalhe: usados,
    vendas_por_semana: semanas.map((s) => ({
      rotulo: base.rotuloDia(s),
      valor: base.num((vendasSemana.find((v) => v.semana === s) || {}).vendas),
    })),
    alertas: alertas.map(formatarAlerta),
    linha_do_tempo: linhaDoTempo.map((e) => ({
      tipo: e.tipo,
      quando: e.quando,
      titulo: (TITULO_EVENTO[e.tipo] || (() => e.tipo))(e),
      valor: e.valor === null || e.valor === undefined ? null : base.round2(e.valor),
    })),
  });
}));

// ── Layout (blocos visíveis e ordem, por usuário) ───────────────
const LAYOUT_PADRAO = () => BLOCOS.map((b) => ({ id: b.id, visivel: true }));

// Junta o layout salvo com o catálogo atual: bloco que saiu do catálogo
// some; bloco novo entra no fim, visível.
function layoutCompleto(salvo) {
  const vistos = new Set();
  const out = [];
  for (const item of Array.isArray(salvo) ? salvo : []) {
    if (!item || !POR_ID.has(item.id) || vistos.has(item.id)) continue;
    vistos.add(item.id);
    out.push({ id: item.id, visivel: item.visivel !== false });
  }
  for (const b of BLOCOS) if (!vistos.has(b.id)) out.push({ id: b.id, visivel: true });
  return out;
}

const comTitulo = (blocos) => blocos.map((b) => ({ ...b, titulo: POR_ID.get(b.id).titulo, grupo: POR_ID.get(b.id).grupo }));

router.get('/layout', ...adminOnly, asyncHandler(async (req, res) => {
  const rows = await base.opcional(
    pool,
    'SELECT blocos, updated_at FROM painel_layout WHERE user_id = $1',
    [req.user.id]
  );
  const salvo = rows[0] || null;
  res.json({
    padrao: !salvo,
    atualizado_em: salvo ? salvo.updated_at : null,
    blocos: comTitulo(salvo ? layoutCompleto(salvo.blocos) : LAYOUT_PADRAO()),
  });
}));

router.put('/layout', ...adminOnly, asyncHandler(async (req, res) => {
  const blocos = req.body && req.body.blocos;
  if (!Array.isArray(blocos) || blocos.length > 100) {
    throw new AppError('blocos deve ser uma lista de { id, visivel }', 400);
  }
  const vistos = new Set();
  for (const item of blocos) {
    if (!item || typeof item.id !== 'string' || !POR_ID.has(item.id)) {
      throw new AppError(`Bloco desconhecido: ${item && item.id}`, 400);
    }
    if (vistos.has(item.id)) throw new AppError(`Bloco repetido: ${item.id}`, 400);
    vistos.add(item.id);
  }
  const completo = layoutCompleto(blocos);
  const { rows } = await pool.query(
    `INSERT INTO painel_layout (user_id, blocos, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET blocos = EXCLUDED.blocos, updated_at = NOW()
     RETURNING updated_at`,
    [req.user.id, JSON.stringify(completo)]
  );
  res.json({ padrao: false, atualizado_em: rows[0] ? rows[0].updated_at : null, blocos: comTitulo(completo) });
}));

// ── POST /admin/painel/recalcular ───────────────────────────────
// Mesmo passo do job das 06h, agora. Responde 200 também quando alguma etapa
// falha: o que falhou vem em `erros`, e o resto ficou gravado.
router.post('/recalcular', ...adminOnly, asyncHandler(async (req, res) => {
  const r = await painel.rodarPainelDiario();
  res.json({
    ok: r.ok,
    dia: r.dia,
    duracao_ms: r.duracao_ms,
    blocos: r.blocos,
    alertas: r.alertas,
    health_atualizados: r.health_atualizados,
    mrr_total: r.mrr_total,
    erros: r.erros,
  });
}));

module.exports = router;
module.exports.proximoCalculo = proximoCalculo;
module.exports.layoutCompleto = layoutCompleto;
