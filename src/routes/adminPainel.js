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
// GET  /admin/painel/contatos/:conversaId   — conversa do WhatsApp da Aura, com as mensagens
// POST /admin/painel/contatos               — Registrar contato (empresa OU lead)
// GET  /admin/painel/contatos?desde=        — contatos registrados desde um dia
// GET  /admin/painel/layout                 — blocos visíveis e ordem do usuário
// PUT  /admin/painel/layout                 — body: { blocos: [{ id, visivel }] }
// POST /admin/painel/recalcular             — roda o passo diário agora
// GET  /admin/painel/handshakes?estado=      — handshakes do cadastro (tq-66)
// POST /admin/painel/handshakes/:codigo/confirmar — confirma o AURA-XXXX à mão
// (o "Registrar contato" também confirma, com confirma_whatsapp: true)
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
const { calcularAlertas, alertasDeContatos } = require('../services/painelAlertas');
const { detalheDaConversa } = require('../services/contatosWhatsapp');
const { listarClients360 } = require('../services/clients360');
const contatos = require('../services/registrarContato');
const signupHandshake = require('../services/signupHandshake');
const canaryStatus = require('../services/canaryStatus');
const errosPorMinuto = require('../services/errosPorMinuto');

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

// Contato sem resposta depende do relógio (passou de 2h? é horário
// comercial?): o gravado às 06h nunca valeria, então vale o de agora. Falha
// aqui não derruba o painel.
async function alertasDeContatosAgora() {
  try {
    return await alertasDeContatos({ db: pool });
  } catch (err) {
    console.error('[painel] alerta de contatos falhou:', err.message);
    return [];
  }
}

// Bipe sintético: "há quanto tempo" e a disponibilidade valem agora, não às
// 06h do snapshot — o bloco Plataforma ganha o `canary` ao vivo. Dormente
// (sem envs) devolve null e a resposta sai como antes; falha na leitura cai
// no que o cálculo diário gravou.
async function canaryAoVivo(dados) {
  try {
    return await canaryStatus.resumo({ db: pool });
  } catch (err) {
    console.error('[painel] bipe sintético ao vivo falhou:', err.message);
    return (dados && dados.detalhe && dados.detalhe.canary) || null;
  }
}

// Erro na ponta do lojista (5xx e EMAXCONNSESSION dos últimos 60 minutos,
// services/errosPorMinuto): também vale agora, não às 06h. null quando
// dormente (sem a tabela da migration 381) — a resposta sai como antes.
async function errosAoVivo(dados) {
  try {
    return await errosPorMinuto.resumo({ db: pool });
  } catch (err) {
    console.error('[painel] erros por minuto ao vivo falhou:', err.message);
    return (dados && dados.detalhe && dados.detalhe.erros) || null;
  }
}

async function comCanary(blocos, dadosPorId) {
  if (!blocos.some((b) => b.id === 'plataforma')) return blocos;
  const dados = dadosPorId('plataforma');
  const [canary, erros] = await Promise.all([canaryAoVivo(dados), errosAoVivo(dados)]);
  if (!canary && !erros) return blocos;
  return blocos.map((b) => (b.id === 'plataforma'
    ? { ...b, ...(canary ? { canary } : {}), ...(erros ? { erros } : {}) }
    : b));
}

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
      blocos: await comCanary(
        BLOCOS.filter((d) => porBloco.has(d.id)).map((d) => resumoDoBloco(d, porBloco.get(d.id).dados)),
        (id) => porBloco.get(id) && porBloco.get(id).dados
      ),
      alertas: alertas
        .filter((a) => a.tipo !== 'contato_sem_resposta')
        .concat(await alertasDeContatosAgora())
        .map(formatarAlerta),
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
    blocos: await comCanary(
      BLOCOS.filter((d) => resultados[d.id]).map((d) => resumoDoBloco(d, resultados[d.id])),
      (id) => resultados[id]
    ),
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
  const canary = def.id === 'plataforma' ? await canaryAoVivo(dados) : null;
  const erros = def.id === 'plataforma' ? await errosAoVivo(dados) : null;
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
    ...(canary ? { canary } : {}),
    ...(erros ? { erros } : {}),
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
    PAYMENT_CREATED: 'Cobrança criada',
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
  const [logins, asaas, linhaDoTempo, vendasSemana, alertas, modulos, contatosDaLoja, checkinRows, handshake] = await Promise.all([
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
    // Contatos registrados pela equipe (migration 383). Consulta à parte: sem
    // as colunas novas devolve [] e a ficha continua igual.
    base.opcional(
      pool,
      `-- contatos:ficha
       SELECT n.id, n.created_at, n.body, n.canal, n.resultado, n.proximo_passo,
              to_char(n.proximo_passo_em, 'YYYY-MM-DD') AS proximo_passo_em,
              n.motivo, n.prorrogou_dias, n.marcador,
              COALESCE(u.full_name, u.email) AS autor
         FROM company_admin_notes n
         LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.company_id = $1
        ORDER BY n.created_at DESC
        LIMIT 20`,
      [cid]
    ),
    // Check-in (migration 384): o que o cliente respondeu e o que a equipe anotou.
    base.opcional(pool, `-- checkin:ficha
       SELECT checkin FROM companies WHERE id = $1`, [cid]),
    // Handshake do cadastro pelo WhatsApp (migration 402). Sem a tabela: null.
    signupHandshake.doCliente(pool, cid),
  ]);

  const l = logins[0] || {};

  const contatosFormatados = contatosDaLoja.map((c) => ({
    id: c.id,
    quando: c.created_at,
    titulo: contatos.tituloDoContato(c),
    body: c.body,
    canal: c.canal || null,
    resultado: c.resultado || null,
    proximo_passo: c.proximo_passo || null,
    proximo_passo_em: c.proximo_passo_em || null,
    motivo: c.motivo || null,
    prorrogou_dias: c.prorrogou_dias === null || c.prorrogou_dias === undefined ? null : c.prorrogou_dias,
    marcador: c.marcador || null,
    autor: c.autor || null,
  }));
  // Os eventos do sistema (10 mais recentes) e os contatos entram na mesma
  // linha do tempo, do mais recente ao mais antigo.
  const linhaDoTempoCompleta = linhaDoTempo
    .map((e) => ({
      tipo: e.tipo,
      quando: e.quando,
      titulo: (TITULO_EVENTO[e.tipo] || (() => e.tipo))(e),
      valor: e.valor === null || e.valor === undefined ? null : base.round2(e.valor),
    }))
    .concat(contatosFormatados.slice(0, 10).map((c) => ({
      tipo: 'contato', quando: c.quando, titulo: c.titulo, valor: null, contato: c,
    })))
    .sort((x, y) => new Date(y.quando).getTime() - new Date(x.quando).getTime())
    .slice(0, 15);

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
    // Contatos da equipe (do mais recente): o app mostra o último e o próximo
    // passo sem varrer a linha do tempo, que é cortada em 15 eventos.
    contatos: contatosFormatados.slice(0, 10),
    checkin: (checkinRows[0] && checkinRows[0].checkin) || null,
    // 21/10/2026 (tq-66): AURA-XXXX do cadastro e se a equipe já confirmou.
    whatsapp_handshake: signupHandshake.moldar(handshake),
    linha_do_tempo: linhaDoTempoCompleta,
  });
}));

// ── POST /admin/painel/contatos — Registrar contato ─────────────
// Body: { company_id | lead_id, canal, resultado, body, proximo_passo?,
//         proximo_passo_em?, motivo?, prorrogou_dias?, marcador?, checkin? }
//   canal      whatsapp | ligacao | email | presencial
//   resultado  respondeu | sem_resposta | pediu_tempo | combinou_ligacao |
//              quer_assinar | nao_quer (motivo obrigatório)
//   checkin    { como_chegou?, fiado?, quem_decide? } → companies.checkin
// Empresa grava em company_admin_notes; lead, em lead_interactions. → 201
// { id, created_at } (+ checkin_gravado quando veio checkin). Validação e SQL
// em services/registrarContato.js; enums idênticos aos CHECK da migration 383.
const PENDENTE_CONTATO = {
  error: 'Registrar contato indisponível (migration 383 pendente).',
  code: 'MIGRATION_PENDING',
};

router.post('/contatos', ...adminOnly, asyncHandler(async (req, res) => {
  const { erro, valor } = contatos.normalizar(req.body);
  if (erro) return res.status(400).json({ error: erro, code: 'CONTATO_INVALID' });
  // 21/10/2026 (tq-66): a mensagem com o AURA-XXXX chegou no WhatsApp da
  // Aura -> o mesmo "Registrar contato" confirma o handshake da empresa.
  const cw = req.body && req.body.confirma_whatsapp;
  if (cw !== undefined && cw !== null && typeof cw !== 'boolean') {
    return res.status(400).json({ error: 'confirma_whatsapp deve ser true ou false.', code: 'CONTATO_INVALID' });
  }
  const confirmaWhatsapp = cw === true;
  if (confirmaWhatsapp && !valor.alvo.company_id) {
    return res.status(400).json({ error: 'confirma_whatsapp só vale para empresa (company_id).', code: 'CONTATO_INVALID' });
  }

  let criado;
  try {
    if (valor.alvo.company_id) {
      criado = await contatos.registrarEmpresa(pool, req.user.id, valor);
      if (!criado) throw new AppError('Empresa não encontrada', 404);
    } else {
      const quem = await base.opcional(pool, 'SELECT COALESCE(full_name, email) AS nome FROM users WHERE id = $1', [req.user.id]);
      const autor = { id: req.user.id, nome: (quem[0] && quem[0].nome) || req.user.email || 'Staff' };
      criado = await contatos.registrarLead(pool, autor, valor);
      if (!criado) throw new AppError('Lead não encontrado', 404);
    }
  } catch (err) {
    if (contatos.migrationPendente(err)) return res.status(503).json(PENDENTE_CONTATO);
    throw err;
  }
  if (confirmaWhatsapp) {
    // O contato já entrou; o handshake é um extra que nunca derruba o registro.
    let handshake = null;
    try {
      const r = await signupHandshake.confirmarHandshake(pool, { companyId: valor.alvo.company_id, confirmadoPor: req.user.id, via: 'staff' });
      handshake = r ? { ...signupHandshake.moldar(r.handshake), ja_confirmado: r.ja_confirmado } : null;
    } catch (err) {
      if (!(err && (err.code === '42P01' || err.code === '42703'))) throw err;
    }
    return res.status(201).json({ ...criado, whatsapp_handshake: handshake });
  }
  res.status(201).json(criado);
}));

// ── Handshake do cadastro pelo WhatsApp (21/10/2026, tq-66) ─────
// Hoje NÃO há webhook de mensagem recebida (o número da Aura não está na
// API): quem confirma é a equipe, aqui. Confirmar é idempotente: o segundo
// pedido devolve 200 com ja_confirmado: true. A conta nunca dependeu disto.
const PENDENTE_HANDSHAKE = {
  error: 'Handshake do cadastro indisponível (migration 402 pendente).',
  code: 'MIGRATION_PENDING',
};

// GET /admin/painel/handshakes?estado=aguardando|confirmado (padrão aguardando)
router.get('/handshakes', ...adminOnly, asyncHandler(async (req, res) => {
  const estado = req.query.estado === undefined ? 'aguardando' : req.query.estado;
  if (estado !== 'aguardando' && estado !== 'confirmado') {
    return res.status(400).json({ error: 'estado deve ser aguardando ou confirmado.', code: 'HANDSHAKE_INVALID' });
  }
  const rows = await base.opcional(
    pool,
    `-- handshake:lista
     SELECT h.codigo, h.whatsapp, h.estado, h.confirmado_em, h.confirmado_via, h.criado_em,
            h.company_id, COALESCE(c.trade_name, c.legal_name) AS empresa, u.full_name AS pessoa
       FROM signup_handshakes h
       JOIN companies c ON c.id = h.company_id
       LEFT JOIN users u ON u.id = h.user_id
      WHERE h.estado = $1
      ORDER BY h.criado_em DESC
      LIMIT 100`,
    [estado]
  );
  res.json({
    estado,
    total: rows.length,
    handshakes: rows.map((r) => ({ ...signupHandshake.moldar(r), company_id: r.company_id, empresa: r.empresa || null, pessoa: r.pessoa || null })),
  });
}));

// POST /admin/painel/handshakes/:codigo/confirmar
router.post('/handshakes/:codigo/confirmar', ...adminOnly, asyncHandler(async (req, res) => {
  const codigo = signupHandshake.normalizarCodigo(req.params.codigo);
  if (!codigo) return res.status(400).json({ error: 'Código inválido. Formato: AURA-XXXX.', code: 'HANDSHAKE_INVALID' });
  let r;
  try {
    r = await signupHandshake.confirmarHandshake(pool, { codigo, confirmadoPor: req.user.id, via: 'staff' });
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) return res.status(503).json(PENDENTE_HANDSHAKE);
    throw err;
  }
  if (!r) throw new AppError('Código não encontrado', 404);
  res.status(200).json({ ...signupHandshake.moldar(r.handshake), company_id: r.handshake.company_id, ja_confirmado: r.ja_confirmado });
}));

// ── GET /admin/painel/contatos?desde=YYYY-MM-DD ─────────────────
// Contatos registrados desde o dia (Brasília), do mais recente ao mais
// antigo, empresas e leads juntos. Sem `desde`: os últimos 7 dias. É o que a
// Cassie lê na rodada das 7h30.
router.get('/contatos', ...adminOnly, asyncHandler(async (req, res) => {
  let desde = req.query.desde;
  if (desde === undefined || desde === '') {
    desde = base.somaDias(painel.hojeBRT(), -7);
  } else if (!contatos.diaValido(desde)) {
    throw new AppError('desde deve ser uma data YYYY-MM-DD', 400);
  }
  const r = await contatos.listarDesde(pool, desde);
  res.json({
    desde,
    total: r.contatos.length,
    ...(r.migration_pendente ? { migration_pendente: true } : {}),
    contatos: r.contatos,
  });
}));

// ── GET /admin/painel/contatos/:conversaId ──────────────────────
// A conversa do WhatsApp da Aura por inteiro (telefone completo, link wa.me,
// quem respondeu e as últimas 200 mensagens) — é o que a ficha do contato
// abre a partir de uma linha do bloco Contatos. `conversa_id` vem na lista.
router.get('/contatos/:conversaId', ...adminOnly, asyncHandler(async (req, res) => {
  const conversa = await detalheDaConversa({ db: pool, conversaId: req.params.conversaId });
  if (!conversa) throw new AppError('Conversa não encontrada', 404);
  res.json(conversa);
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
