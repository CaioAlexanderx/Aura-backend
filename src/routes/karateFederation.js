// ============================================================
// AURA KARATÊ — Rotas da Federação (Track A + Track P)
// POST /karate/federation/setup
// GET  /federation/:id/dashboard          (Track A + P alerts)
// GET  /federation/:id/belt-distribution
// GET  /federation/:id/search             (Track P: busca rápida)
// GET  /federation/:id/notifications      (Track P: notificações)
//
// Nota de roteamento: :id nos params é o federationId (reaproveitando
// requireCompanyAccess que lê req.params.id).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { guards } = require('../config/karateRoles');

// ── Ordenação estável de faixas — DELEGADA ao dicionário canônico ──
// O backend devolve um `rank` numérico por faixa para o FE ordenar de forma
// estável a lista "Praticantes por graduação". O rank é OPACO: só a ORDEM
// importa, nunca o valor absoluto.
//
// F8.0 (31/07/2026): este arquivo mantinha a TERCEIRA escala de faixa do
// backend — um mapa próprio (branca 10 … vermelha 900) com
// azul_claro=45, azul=50, azul_escuro=55, roxa=60. Ou seja, colocava Azul
// Escuro ANTES da Roxa, quando o Azul Escuro é 4º kyu e vem DEPOIS da Roxa
// (5º kyu). Era um erro DIFERENTE do da migration 229 (que invertia Roxa e
// Azul Claro) — duas escalas erradas, de dois jeitos, no mesmo backend.
// Curiosidade que confirma o diagnóstico: o scaffold KYU_ORDER logo abaixo
// (usado no dashboard) SEMPRE listou azul_claro → roxo → azul_escuro na
// ordem certa; o .sort(rank) é que reordenava errado depois.
//
// Agora tudo vem de src/utils/karateBeltScale.js. A escala de exibição
// preserva a ordem de grandeza que o FE já recebia (múltiplos de 10 por
// cor, vermelha 900, desconhecida 500).
const { COLOR_SCALE, beltDisplayRank } = require('../utils/karateBeltScale');

// Scaffold das faixas KYU canônicas (FPKT Shotokan) — DERIVADO de
// COLOR_SCALE, não mais uma quarta lista de faixas escrita à mão. Garante
// que toda faixa apareça no gráfico "Praticantes por graduação" mesmo com
// 0 praticantes (ex.: Amarela): sem isso o GROUP BY dropa a faixa vazia e
// a cliente pergunta "cadê a amarela?". Preta (belt_level 'preta', com o
// grau em belt_name) e Vermelha (legada) ficam de fora do scaffold e vêm
// dos dados como estão.
const KYU_SCAFFOLD = Object.freeze(
  COLOR_SCALE.filter((c) => c.kyus.length > 0).map((c) =>
    Object.freeze({ belt_level: c.level, belt_name: c.label })
  )
);

function beltRank(level, name) {
  return beltDisplayRank(level, name);
}

// ── Segmentação por is_active do PRATICANTE (customers.is_active) ──────
// Decisão de produto (Caio 21/07/2026, mesma citada em
// karateAnnuityService.js/dojoStatusToIsActiveValues): "não podemos cobrar e
// controlar os inativos [...] o mesmo para indicadores e números absolutos,
// sempre ativos primeiro." Aqui o filtro é sobre customers.is_active
// (PRATICANTE) — NÃO confundir com companies.is_active (dojô), que é outro
// campo (ver karateAnnuitySummary.js). Usado por "Praticantes por graduação"
// (dashboard) e por GET /belt-distribution — os dois DEVEM aceitar o mesmo
// parâmetro/mesmo default, senão o card do painel e o endpoint dedicado
// divergem no mesmo número (mesma classe de bug já vista em anuidades).
// Default 'active' (só ativos) — espelha Praticantes-federação, Dojôs e
// Anuidades, que já seguem essa premissa.
const PRACTITIONER_STATUS_VALUES = ['active', 'inactive', 'all'];

// String vazia/ausente => default 'active'. Retorna null se valor inválido
// (caller decide como reportar — aqui sempre 422).
function parsePractitionerStatus(raw) {
  const v = (raw !== undefined && raw !== null && String(raw).trim() !== '')
    ? String(raw).trim()
    : 'active';
  return PRACTITIONER_STATUS_VALUES.includes(v) ? v : null;
}

// Converte o status já parseado no array usado no SQL
// (`c.is_active = ANY($N::boolean[])`), ou null pra "sem filtro" ('all').
function practitionerStatusToIsActiveValues(status) {
  if (status === 'all') return null;
  if (status === 'inactive') return [false];
  return [true]; // 'active' (default)
}

// ── POST /karate/federation/setup ──────────────────────
router.post('/federation/setup', requireAuth, async (req, res) => {
  const { name, slug, logo_url } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(422).json({ error: 'Campo name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (!slug || !String(slug).trim()) {
    return res.status(422).json({ error: 'Campo slug é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const cleanSlug = String(slug).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cleanSlug) {
    return res.status(422).json({ error: 'Slug inválido (use apenas letras, números, hífens e underscores)', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotência por slug
    const existing = await client.query(
      `SELECT id, name, slug, vertical FROM companies WHERE slug = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [cleanSlug]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Federação com este slug já existe',
        code: 'CONFLICT',
        existing: { id: existing.rows[0].id, name: existing.rows[0].name, slug: existing.rows[0].slug },
      });
    }

    const newId = uuidv4();
    const ownerId = req.user.id;

    // Cria a empresa-federação.
    // companies exige legal_name (NOT NULL) — grava = name, como fazem os
    // INSERTs irmãos (karateDojos/karateImport). E grava vertical_active junto
    // de vertical: toda a listagem/contagem da federação filtra por
    // vertical_active; sem ele a federação nasceria invisível para si mesma.
    const insertRes = await client.query(
      `INSERT INTO companies
         (id, name, legal_name, trade_name, slug, vertical, vertical_active,
          owner_id, karate_logo_url, is_active, created_at, updated_at)
       VALUES ($1, $2, $2, $2, $3, 'karate_federation', 'karate_federation',
               $4, $5, true, NOW(), NOW())
       RETURNING id, name, slug, vertical`,
      [newId, String(name).trim(), cleanSlug, ownerId, logo_url || null]
    );

    const company = insertRes.rows[0];

    // Semeia os 12 critérios FPKT
    await client.query(
      `SELECT karate_seed_fpkt_requirements($1)`,
      [newId]
    );

    // Conta para confirmar os 12
    const countRes = await client.query(
      `SELECT COUNT(*) AS cnt FROM karate_belt_requirements WHERE federation_id = $1`,
      [newId]
    );
    const requirementsSeeded = parseInt(countRes.rows[0].cnt, 10);

    await client.query('COMMIT');

    res.status(201).json({
      id: company.id,
      name: company.name,
      slug: company.slug,
      vertical: company.vertical,
      requirements_seeded: requirementsSeeded,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateFederation] setup error:', err.message);
    res.status(500).json({ error: 'Erro ao criar federação', detail: err.message });
  } finally {
    client.release();
  }
});

// ── GET /federation/:id/dashboard ──────────────────────
// Track P extende o dashboard com alerts[] derivados de dados já existentes.
// Sem novas queries obrigatórias — as de tabelas novas são defensivas (42P01).
router.get('/dashboard', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const currentYear = new Date().getFullYear().toString();
  // belt_distribution: ?status=active|inactive|all (default 'active') — ver
  // parsePractitionerStatus/practitionerStatusToIsActiveValues acima. MESMO
  // parâmetro/MESMO default de GET /belt-distribution (endpoint dedicado),
  // pra card do painel e endpoint nunca divergirem no mesmo número.
  const practitionerStatus = parsePractitionerStatus(req.query.status);
  if (practitionerStatus === null) {
    return res.status(422).json({
      error: `status inválido. Valores aceitos: ${PRACTITIONER_STATUS_VALUES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  const practitionerActiveValues = practitionerStatusToIsActiveValues(practitionerStatus);

  try {
    // ── 1. KPIs principais (paralelo) ────────────────────────
    // dojo_count = TODOS os dojôs da federação (vertical_active = karate_dojo),
    // sem filtro de is_active — coerente com a página Dojôs (karateDojos.js) e
    // Saúde da Rede (karateNetworkHealth.js), que contam todos. Dojô inativo
    // continua sendo um dojô filiado da federação. `vertical` é o marcador de
    // identidade permanente; `vertical_active` reflete se o módulo karatê
    // segue ativo para aquele dojô — é esse último que define a contagem.
    const [dojoRes, practRes, revenueRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS dojo_count FROM companies
         WHERE federation_id = $1 AND vertical_active = 'karate_dojo'
           AND karate_dojo_linked_at IS NOT NULL`,
        [federationId]
      ),
      db.query(
        `SELECT COUNT(*) AS practitioner_count FROM customers
         WHERE federation_id = $1 AND is_guest = false`,
        [federationId]
      ),
      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS revenue_ytd
         FROM transactions
         WHERE company_id = $1
           AND type = 'income'
           AND EXTRACT(YEAR FROM due_date) = EXTRACT(YEAR FROM NOW())
           AND status = 'confirmed'`,
        [federationId]
      ),
    ]);

    const dojoCount = parseInt(dojoRes.rows[0].dojo_count, 10);
    const practCount = parseInt(practRes.rows[0].practitioner_count, 10);
    const revenueYtd = parseFloat(revenueRes.rows[0].revenue_ytd) || 0;

    // ── 2. Status de anuidade dos dojôs ────────────────────────
    // Regra: dojô SEM cobrança (sem registro de anuidade, ou registro sem
    // due_date) é um estado NEUTRO ('no_charge') — ausência de cobrança NÃO é
    // inadimplência. 'suspended' passa a significar apenas "tinha cobrança e
    // venceu há mais de 180 dias".
    const annuityRes = await db.query(
      `WITH latest_annuity AS (
         SELECT DISTINCT ON (h.dojo_id)
           h.dojo_id,
           h.amount,
           h.due_date,
           h.status AS raw_status,
           GREATEST(0, EXTRACT(DAY FROM (NOW() - h.due_date))::int) AS days_since_due
         FROM karate_dojo_annuity_history h
         JOIN companies c ON c.id = h.dojo_id
           AND c.federation_id = $1
           AND c.vertical_active = 'karate_dojo'
           AND c.karate_dojo_linked_at IS NOT NULL
         ORDER BY
           h.dojo_id,
           CASE WHEN h.reference_period = $2 THEN 0 ELSE 1 END,
           h.reference_period DESC
       )
       SELECT
         c.id                  AS dojo_id,
         c.name,
         la.amount,
         la.due_date,
         la.days_since_due,
         CASE
           WHEN la.dojo_id IS NULL                          THEN 'no_charge'
           WHEN la.raw_status = 'paid'                      THEN 'paid'
           WHEN la.due_date IS NULL                         THEN 'no_charge'
           WHEN la.due_date >= NOW()                        THEN 'due'
           WHEN la.days_since_due <= 90                     THEN 'overdue'
           WHEN la.days_since_due <= 180                    THEN 'defaulting'
           ELSE                                                  'suspended'
         END                   AS annuity_status
       FROM companies c
       LEFT JOIN latest_annuity la ON la.dojo_id = c.id
       WHERE c.federation_id = $1
         AND c.vertical_active = 'karate_dojo'
         AND c.karate_dojo_linked_at IS NOT NULL`,
      [federationId, currentYear]
    );

    const allDojos = annuityRes.rows;
    const OVERDUE_STATUSES = ['overdue', 'defaulting', 'suspended'];
    // Dojô COM cobrança = tem um status de anuidade real (não 'no_charge').
    // Inadimplência só faz sentido entre os que têm cobrança lançada.
    const chargedDojos = allDojos.filter(d => d.annuity_status !== 'no_charge');

    const overdueDojosDetail = allDojos
      .filter(d => OVERDUE_STATUSES.includes(d.annuity_status))
      .map(d => ({
        dojo_id:      d.dojo_id,
        name:         d.name,
        amount:       parseFloat(d.amount) || 0,
        days_overdue: parseInt(d.days_since_due, 10) || 0,
      }));

    // overdue_rate sobre a base COM cobrança; 0 quando ninguém tem cobrança
    // (evita divisão por zero e evita contar ausência de cobrança como atraso).
    const overdueRate = chargedDojos.length > 0
      ? parseFloat((overdueDojosDetail.length / chargedDojos.length).toFixed(4))
      : 0;

    // C7: teto defensivo na lista de alerta (front pagina/linka o resto).
    const OVERDUE_CAP = 50;
    const overdueDojosCapped = overdueDojosDetail.slice(0, OVERDUE_CAP);

    // Upcoming events (stub — events table a implementar na Fase 2)
    const upcomingEvents = [];

    // ── 3. Distribuição de faixas ───────────────────────────
    // Ordenada por `rank` numérico estável (hierarquia + grau de Dan), calculado
    // no backend via beltRank(). belt_level da preta é 'preta' (string) e ORDER BY
    // belt_level sozinho NÃO separaria os Dan — por isso o rank vai no payload e a
    // lista já sai pré-ordenada. (A distribuição continua incluindo a Vermelha
    // aqui; quem oculta a Vermelha é o FE.)
    const beltParams = practitionerActiveValues ? [federationId, practitionerActiveValues] : [federationId];
    const beltRes = await db.query(
      `SELECT cb.belt_level, cb.belt_name, COUNT(*) AS count
       FROM karate_current_belt cb
       JOIN customers c ON c.id = cb.student_id
       WHERE c.federation_id = $1
         ${practitionerActiveValues ? 'AND c.is_active = ANY($2::boolean[])' : ''}
       GROUP BY cb.belt_level, cb.belt_name
       ORDER BY cb.belt_level`,
      beltParams
    );

    const KYU_ORDER = KYU_SCAFFOLD; // ver KYU_SCAFFOLD no topo (F8.0)
    const kyuLevels = new Set(KYU_ORDER.map(k => k.belt_level));
    const countByLevel = {};
    for (const r of beltRes.rows) {
      countByLevel[r.belt_level] = (countByLevel[r.belt_level] || 0) + parseInt(r.count, 10);
    }
    const kyuDistribution = KYU_ORDER.map(k => ({
      belt_level: k.belt_level,
      belt_name:  k.belt_name,
      count:      countByLevel[k.belt_level] || 0,
      rank:       beltRank(k.belt_level, k.belt_name),
    }));
    const otherDistribution = beltRes.rows
      .filter(r => !kyuLevels.has(r.belt_level))
      .map(r => ({
        belt_level: r.belt_level,
        belt_name:  r.belt_name,
        count:      parseInt(r.count, 10),
        rank:       beltRank(r.belt_level, r.belt_name),
      }));
    const beltDistribution = [...kyuDistribution, ...otherDistribution]
      .sort((a, b) => a.rank - b.rank);

    // ── 4. Track P: Alertas (derivados de dados já existentes) ──
    // Cada alert: { type, severity, title, count, action_path }
    // Defensivos: qualquer 42P01 retorna o alerta com count=0.
    const alerts = [];

    // 4a. Anuidades vencidas (já temos overdueDojosDetail)
    if (overdueDojosDetail.length > 0) {
      alerts.push({
        type: 'overdue_annuities',
        severity: overdueDojosDetail.length > 5 ? 'danger' : 'warn',
        title: `${overdueDojosDetail.length} dojô${overdueDojosDetail.length > 1 ? 's' : ''} com anuidade em atraso`,
        count: overdueDojosDetail.length,
        action_path: '/karate/financeiro/anuidades?status=overdue',
      });
    }

    // 4b. Conexões pendentes de aprovação (karate_dojo_connections)
    try {
      const connRes = await db.query(
        `SELECT COUNT(*) AS cnt
         FROM karate_dojo_connections
         WHERE federation_id = $1 AND status = 'pending'`,
        [federationId]
      );
      const pendingConns = parseInt(connRes.rows[0].cnt, 10);
      if (pendingConns > 0) {
        alerts.push({
          type: 'pending_connections',
          severity: 'info',
          title: `${pendingConns} solicitação${pendingConns > 1 ? 'ões' : ''} de conexão aguardando aprovação`,
          count: pendingConns,
          action_path: '/karate/conexoes',
        });
      }
    } catch (e) {
      if (e.code !== '42P01') console.warn('[karateFederation] alert connections:', e.message);
    }

    // 4c. Eventos de sync com falha recente (karate_sync_events)
    try {
      const syncRes = await db.query(
        `SELECT COUNT(*) AS cnt
         FROM karate_sync_events kse
         JOIN karate_dojo_connections kdc ON kdc.id = kse.connection_id
         WHERE kdc.federation_id = $1
           AND kse.status = 'failed'
           AND kse.created_at > NOW() - INTERVAL '7 days'`,
        [federationId]
      );
      const failedSync = parseInt(syncRes.rows[0].cnt, 10);
      if (failedSync > 0) {
        alerts.push({
          type: 'failed_sync_events',
          severity: 'warn',
          title: `${failedSync} evento${failedSync > 1 ? 's' : ''} de sincronização com falha nos últimos 7 dias`,
          count: failedSync,
          action_path: '/karate/conexoes',
        });
      }
    } catch (e) {
      if (e.code !== '42P01') console.warn('[karateFederation] alert sync:', e.message);
    }

    // 4d. Lembretes com erro recente (karate_reminder_log)
    try {
      const reminderRes = await db.query(
        `SELECT COUNT(*) AS cnt
         FROM karate_reminder_log
         WHERE federation_id = $1
           AND status = 'error'
           AND created_at > NOW() - INTERVAL '7 days'`,
        [federationId]
      );
      const reminderErrors = parseInt(reminderRes.rows[0].cnt, 10);
      if (reminderErrors > 0) {
        alerts.push({
          type: 'reminder_errors',
          severity: 'warn',
          title: `${reminderErrors} lembrete${reminderErrors > 1 ? 's' : ''} de cobrança com erro nos últimos 7 dias`,
          count: reminderErrors,
          action_path: '/karate/financeiro/lembretes',
        });
      }
    } catch (e) {
      if (e.code !== '42P01') console.warn('[karateFederation] alert reminders:', e.message);
    }

    res.json({
      kpis: {
        dojo_count:        dojoCount,
        // T1: número-destaque = TOTAL real de praticantes da federação
        // (COUNT(*) customers WHERE federation_id), NÃO a soma das faixas
        // visíveis. practitioner_count já é esse total; practitioner_total é
        // um alias explícito para o FE não cair na soma de belt_distribution.
        practitioner_count: practCount,
        practitioner_total: practCount,
        revenue_ytd:       revenueYtd,
        overdue_rate:      overdueRate,
      },
      upcoming_events:  upcomingEvents,
      overdue_dojos:    overdueDojosCapped,
      belt_distribution: beltDistribution,
      // Status aplicado ao belt_distribution acima (mesmo default/mesmo
      // parâmetro de GET /belt-distribution) — o FE usa pra refletir o
      // toggle ativo/inativo/todos no card do painel.
      belt_distribution_status: practitionerStatus,
      alerts,  // Track P: novo campo aditivo
    });
  } catch (err) {
    console.error('[karateFederation] dashboard error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// ── GET /federation/:id/belt-distribution ──────────────────
router.get('/belt-distribution', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;

  // ?status=active|inactive|all (default 'active') — MESMO parâmetro/MESMO
  // default do card "Praticantes por graduação" no dashboard (ver
  // parsePractitionerStatus acima), pra nunca divergir do mesmo número.
  const practitionerStatus = parsePractitionerStatus(req.query.status);
  if (practitionerStatus === null) {
    return res.status(422).json({
      error: `status inválido. Valores aceitos: ${PRACTITIONER_STATUS_VALUES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  const practitionerActiveValues = practitionerStatusToIsActiveValues(practitionerStatus);

  try {
    const beltParams = practitionerActiveValues ? [federationId, practitionerActiveValues] : [federationId];
    const { rows } = await db.query(
      `SELECT cb.belt_level, cb.belt_name, COUNT(*) AS count
       FROM karate_current_belt cb
       JOIN customers c ON c.id = cb.student_id
       WHERE c.federation_id = $1
         ${practitionerActiveValues ? 'AND c.is_active = ANY($2::boolean[])' : ''}
       GROUP BY cb.belt_level, cb.belt_name
       ORDER BY cb.belt_level`,
      beltParams
    );

    res.json(rows
      .map(r => ({
        belt_level: r.belt_level,
        belt_name:  r.belt_name,
        count:      parseInt(r.count, 10),
        rank:       beltRank(r.belt_level, r.belt_name),
      }))
      .sort((a, b) => a.rank - b.rank));
  } catch (err) {
    console.error('[karateFederation] belt-distribution error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar distribuição de faixas' });
  }
});

// ── GET /federation/:id/search?q= (Track P) ────────────────
// Busca rápida federation-wide: dojôs + praticantes (paralelo).
// Reusa as queries existentes de karateDojos + karatePractitioners.
// Limite: 10 resultados por categoria (busca é quick-search, não paginação).
router.get('/search', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const q = String(req.query.q || '').trim();

  if (!q || q.length < 2) {
    return res.json({ dojos: [], practitioners: [] });
  }

  const pattern = `%${q}%`;

  try {
    const [dojoRes, practRes] = await Promise.all([
      // Dojôs: busca por nome ou FPKT-ID. is_active exposto (não filtrado
      // — busca é pontual/baixo impacto) pra o FE marcar visualmente "inativo".
      db.query(
        `SELECT c.id, c.name, c.fpkt_affiliation_id, c.region, c.is_active,
                COUNT(cu.id)::int AS practitioner_count
         FROM companies c
         LEFT JOIN customers cu ON cu.dojo_id = c.id
         WHERE c.federation_id = $1
           AND c.vertical_active = 'karate_dojo'
           AND c.karate_dojo_linked_at IS NOT NULL
           AND (c.name ILIKE $2 OR c.fpkt_affiliation_id ILIKE $2)
         GROUP BY c.id
         ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC
         LIMIT 10`,
        [federationId, pattern]
      ),
      // Praticantes: busca por nome ou número de registro. is_active exposto
      // (mesmo motivo acima — não filtra, só marca).
      db.query(
        `SELECT cu.id, cu.name AS full_name, cu.karate_registration_number,
                dj.name AS dojo_name,
                cb.belt_name, cu.is_active
         FROM customers cu
         LEFT JOIN companies dj ON dj.id = cu.dojo_id
         LEFT JOIN karate_current_belt cb ON cb.student_id = cu.id AND cb.federation_id = $1
         WHERE cu.federation_id = $1
           AND (cu.name ILIKE $2 OR cu.karate_registration_number ILIKE $2)
         ORDER BY cu.karate_registration_number ASC NULLS LAST, cu.name ASC
         LIMIT 10`,
        [federationId, pattern]
      ),
    ]);

    res.json({
      q,
      dojos: dojoRes.rows.map(d => ({
        id: d.id,
        name: d.name,
        fpkt_affiliation_id: d.fpkt_affiliation_id || null,
        region: d.region || null,
        is_active: d.is_active !== false,
        practitioner_count: d.practitioner_count || 0,
        _type: 'dojo',
      })),
      practitioners: practRes.rows.map(p => ({
        id: p.id,
        full_name: p.full_name,
        karate_registration_number: p.karate_registration_number || null,
        dojo_name: p.dojo_name || null,
        belt_name: p.belt_name || null,
        is_active: p.is_active !== false,
        _type: 'practitioner',
      })),
    });
  } catch (err) {
    console.error('[karateFederation] search error:', err.message);
    res.status(500).json({ error: 'Erro na busca' });
  }
});

// ── GET /federation/:id/notifications (Track P) ────────────
// Notificações derivadas de dados já existentes:
//   - Lembretes enviados recentemente (karate_reminder_log)
//   - Conexões de dojô pendentes (karate_dojo_connections)
//   - Eventos de sync com falha (karate_sync_events)
// Defensivo: 42P01 retorna array vazio para cada fonte.
router.get('/notifications', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const notifications = [];

  // Fonte 1: últimos lembretes (Track I — karate_reminder_log)
  try {
    const { rows } = await db.query(
      `SELECT id, dojo_id, channel, rule_code, status, error, created_at
       FROM karate_reminder_log
       WHERE federation_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [federationId, Math.floor(limit / 3)]
    );
    for (const r of rows) {
      notifications.push({
        id: `reminder-${r.id}`,
        type: r.status === 'error' ? 'reminder_error' : 'reminder_sent',
        severity: r.status === 'error' ? 'warn' : 'info',
        title: r.status === 'error'
          ? `Falha ao enviar lembrete via ${r.channel}`
          : `Lembrete de anuidade enviado via ${r.channel}`,
        detail: r.error || r.rule_code || null,
        reference_type: 'dojo',
        reference_id: r.dojo_id || null,
        created_at: r.created_at,
      });
    }
  } catch (e) {
    if (e.code !== '42P01') console.warn('[karateFederation] notif reminders:', e.message);
  }

  // Fonte 2: conexões pendentes (Track F — karate_dojo_connections)
  try {
    const { rows } = await db.query(
      `SELECT kdc.id, kdc.dojo_id, kdc.via, kdc.created_at,
              c.name AS dojo_name
       FROM karate_dojo_connections kdc
       LEFT JOIN companies c ON c.id = kdc.dojo_id
       WHERE kdc.federation_id = $1 AND kdc.status = 'pending'
       ORDER BY kdc.created_at DESC
       LIMIT $2`,
      [federationId, Math.floor(limit / 3)]
    );
    for (const r of rows) {
      notifications.push({
        id: `conn-${r.id}`,
        type: 'pending_connection',
        severity: 'info',
        title: `Dojô ${r.dojo_name || r.dojo_id} solicitou conexão via ${r.via}`,
        detail: null,
        reference_type: 'connection',
        reference_id: r.id,
        action_path: `/karate/conexoes`,
        created_at: r.created_at,
      });
    }
  } catch (e) {
    if (e.code !== '42P01') console.warn('[karateFederation] notif connections:', e.message);
  }

  // Fonte 3: eventos de sync com falha recente (Track F — karate_sync_events)
  try {
    const { rows } = await db.query(
      `SELECT kse.id, kse.connection_id, kse.event_type, kse.error, kse.created_at,
              c.name AS dojo_name
       FROM karate_sync_events kse
       JOIN karate_dojo_connections kdc ON kdc.id = kse.connection_id AND kdc.federation_id = $1
       LEFT JOIN companies c ON c.id = kdc.dojo_id
       WHERE kse.status = 'failed'
         AND kse.created_at > NOW() - INTERVAL '7 days'
       ORDER BY kse.created_at DESC
       LIMIT $2`,
      [federationId, Math.floor(limit / 3)]
    );
    for (const r of rows) {
      notifications.push({
        id: `sync-${r.id}`,
        type: 'sync_failure',
        severity: 'warn',
        title: `Falha de sync (${r.event_type}) — ${r.dojo_name || 'Dojô desconhecido'}`,
        detail: r.error || null,
        reference_type: 'connection',
        reference_id: r.connection_id,
        action_path: `/karate/conexoes`,
        created_at: r.created_at,
      });
    }
  } catch (e) {
    if (e.code !== '42P01') console.warn('[karateFederation] notif sync:', e.message);
  }

  // Ordena por data desc e entrega
  notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    total: notifications.length,
    items: notifications.slice(0, limit),
  });
});

module.exports = router;
