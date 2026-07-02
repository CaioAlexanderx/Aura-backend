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

// ── Ordenação estável de faixas (hierarquia + grau de Dan) ─────
// O backend devolve um `rank` numérico por faixa para o FE ordenar de forma
// estável a lista "Praticantes por graduação". Hierarquia geral:
//   Branca < Amarela < Laranja < Verde < (Azul) < Roxa < Marrom < Preta(1°→2°→…)
// belt_level da preta é 'preta' (string) e o grau vem do belt_name
// ('Preta 1°', 'Preta 2°'…) — por isso ORDER BY belt_level sozinho NÃO separa
// os Dan. Vermelha (histórica) vai pro fim. Acento/caixa normalizados.
function normBeltLevel(level) {
  return String(level || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const BELT_ORDER = {
  branca: 10,
  amarela: 20,
  laranja: 30,
  verde: 40,
  azul_claro: 45, azulclaro: 45, 'azul claro': 45,
  azul: 50,
  azul_escuro: 55, azulescuro: 55, 'azul escuro': 55,
  roxa: 60, roxo: 60,
  marrom: 70,
  // preta tratada à parte (grau soma ao rank base)
  vermelha: 900, vermelho: 900, // histórica → fim
};

function beltRank(level, name) {
  const b = normBeltLevel(level);
  if (b === 'preta') {
    const grau = parseInt((String(name || '').match(/(\d+)/) || [])[1], 10) || 1;
    return 80 + grau; // 1º Dan=81, 2º Dan=82, …
  }
  if (b in BELT_ORDER) return BELT_ORDER[b];
  return 500; // desconhecida → antes da vermelha, depois das conhecidas
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

    // Cria a empresa-federação
    const insertRes = await client.query(
      `INSERT INTO companies
         (id, name, slug, vertical, owner_id, karate_logo_url, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, 'karate_federation', $4, $5, true, NOW(), NOW())
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
         WHERE federation_id = $1 AND vertical_active = 'karate_dojo'`,
        [federationId]
      ),
      db.query(
        `SELECT COUNT(*) AS practitioner_count FROM customers
         WHERE federation_id = $1`,
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
         AND c.vertical_active = 'karate_dojo'`,
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
    const beltRes = await db.query(
      `SELECT cb.belt_level, cb.belt_name, COUNT(*) AS count
       FROM karate_current_belt cb
       JOIN customers c ON c.id = cb.student_id
       WHERE c.federation_id = $1
       GROUP BY cb.belt_level, cb.belt_name
       ORDER BY cb.belt_level`,
      [federationId]
    );

    const beltDistribution = beltRes.rows
      .map(r => ({
        belt_level: r.belt_level,
        belt_name:  r.belt_name,
        count:      parseInt(r.count, 10),
        rank:       beltRank(r.belt_level, r.belt_name),
      }))
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

  try {
    const { rows } = await db.query(
      `SELECT cb.belt_level, cb.belt_name, COUNT(*) AS count
       FROM karate_current_belt cb
       JOIN customers c ON c.id = cb.student_id
       WHERE c.federation_id = $1
       GROUP BY cb.belt_level, cb.belt_name
       ORDER BY cb.belt_level`,
      [federationId]
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
      // Dojôs: busca por nome ou FPKT-ID
      db.query(
        `SELECT c.id, c.name, c.fpkt_affiliation_id, c.region,
                COUNT(cu.id)::int AS practitioner_count
         FROM companies c
         LEFT JOIN customers cu ON cu.dojo_id = c.id
         WHERE c.federation_id = $1
           AND c.vertical_active = 'karate_dojo'
           AND (c.name ILIKE $2 OR c.fpkt_affiliation_id ILIKE $2)
         GROUP BY c.id
         ORDER BY c.fpkt_affiliation_id ASC NULLS LAST, c.name ASC
         LIMIT 10`,
        [federationId, pattern]
      ),
      // Praticantes: busca por nome ou número de registro
      db.query(
        `SELECT cu.id, cu.name AS full_name, cu.karate_registration_number,
                dj.name AS dojo_name,
                cb.belt_name
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
        practitioner_count: d.practitioner_count || 0,
        _type: 'dojo',
      })),
      practitioners: practRes.rows.map(p => ({
        id: p.id,
        full_name: p.full_name,
        karate_registration_number: p.karate_registration_number || null,
        dojo_name: p.dojo_name || null,
        belt_name: p.belt_name || null,
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
