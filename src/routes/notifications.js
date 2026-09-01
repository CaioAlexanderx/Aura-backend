// ============================================================
// AURA. — Notificações do App (empresa)
// GET  /companies/:id/notifications                        — banners + pedidos recentes
// POST /companies/:id/notifications/banners/:nid/read     — marca banner como lido
// POST /companies/:id/notifications/read-all-banners      — marca todos como lidos
//
// Criado: 13/06/2026
// Fix    13/06/2026: companies.plan é enum plan_type; target_plan é TEXT.
//   Postgres recusa "text = plan_type" sem cast explícito → plan::text.
// Fix    24/06/2026: o bloco de pedidos do Studio selecionava colunas que NÃO
//   existem na VIEW studio_orders (`order_number`, `total`). A view expõe
//   `total_amount` e, como rótulo, `display_name` — não há número de pedido.
//   A query antiga lançava `column "order_number" does not exist` a cada poll
//   de /notifications (30s) de TODA empresa, floodando os logs do Postgres; e
//   por rodar dentro de um catch silencioso, as notificações de pedido do
//   Studio nunca apareciam. Agora usamos as colunas reais e expomos
//   display_name (ou o id curto) como order_number pro card do app.
//
// 18/08/2026 — EXPANSÃO PARA AURA DOJÔ / KARATÊ / STUDIO (migration 285).
//   Esta rota já respondia para os três shells (é montada em private.js para
//   TODA empresa, sem gate de plano), mas o banner só sabia segmentar por
//   empresa e por plano. Sem alvo de shell, um aviso do Aura Dojô aparecia
//   também na loja de varejo. Agora o banner casa com o SHELL da empresa:
//
//     shell = COALESCE(vertical_active, vertical, 'negocio')
//
//   e `target_vertical IS NULL` segue significando "todos os shells" — o
//   comportamento de todo banner que já existe. Lista de shells válidos:
//   src/services/appNotifications.js (SHELLS), que é também por onde o
//   BACKEND dispara banner sem passar pela Gestão Aura.
//
//   `vertical_active` é o campo que a Gestão Aura liga (adminVertical.js) e
//   `vertical` é o do cadastro do dojô/federação (auth.js) — daí o COALESCE
//   nessa ordem. O único Studio da base hoje tem vertical NULL e
//   vertical_active 'studio'; os dojôs têm os dois preenchidos.
//
//   Defensivo (CLAUDE.md, armadilha 1): antes da migration 285 a coluna
//   target_vertical não existe. Em 42703 a query cai na forma antiga e o
//   cache module-level evita repetir o try/catch a cada poll de 30s.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// null = ainda não sabemos; true/false = decidido para o resto do processo.
let hasTargetVertical = null;

// Filtro de alvo compartilhado pelo GET e pelo read-all — o write path tem
// que enxergar exatamente os mesmos banners que o read path (CLAUDE.md,
// armadilha 7), senão "marcar todas como lidas" cria linha de leitura para
// banner de outro shell e ele some se um dia for redirecionado.
function targetFilter(withVertical) {
  return `
        AND (n.expires_at IS NULL OR n.expires_at > NOW())
        AND (n.target_company_id IS NULL OR n.target_company_id = $1)
        AND (n.target_plan IS NULL OR n.target_plan = (
              SELECT plan::text FROM companies WHERE id = $1 LIMIT 1
            ))
        ${withVertical ? `AND (n.target_vertical IS NULL OR n.target_vertical = (
              SELECT COALESCE(vertical_active, vertical, 'negocio')
                FROM companies WHERE id = $1 LIMIT 1
            ))` : ''}`;
}

function bannersSql(withVertical) {
  return `
      SELECT n.id, n.type, n.title, n.body, n.html_content,
             n.cta_label, n.cta_url, n.cta_route, n.created_at
             ${withVertical ? ', n.target_vertical' : ''}
      FROM app_notifications n
      WHERE n.is_active = true
        ${targetFilter(withVertical)}
        AND NOT EXISTS (
          SELECT 1 FROM notification_reads r
          WHERE r.notification_id = n.id AND r.company_id = $1
        )
      ORDER BY n.created_at DESC
      LIMIT 20`;
}

function readAllSql(withVertical) {
  return `
      INSERT INTO notification_reads (notification_id, company_id)
      SELECT n.id, $1
      FROM app_notifications n
      WHERE n.is_active = true
        ${targetFilter(withVertical)}
        AND NOT EXISTS (
          SELECT 1 FROM notification_reads r
          WHERE r.notification_id = n.id AND r.company_id = $1
        )
      ON CONFLICT (notification_id, company_id) DO NOTHING`;
}

// Roda a query na forma nova e, só em 42703 (migration 285 ausente),
// repete na forma antiga — memorizando a decisão.
async function runWithVerticalFallback(sqlFor, params) {
  try {
    const res = await db.query(sqlFor(hasTargetVertical !== false), params);
    if (hasTargetVertical === null) hasTargetVertical = true;
    return res;
  } catch (err) {
    if (err.code !== '42703') throw err;
    hasTargetVertical = false;
    return db.query(sqlFor(false), params);
  }
}

// GET — Banners ativos (não lidos) + pedidos recentes das últimas 24h
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    // 1. Banners ativos não lidos por esta empresa, filtrados por empresa,
    // plano e shell. Nota: companies.plan é do tipo plan_type (enum); fazemos
    // cast ::text para comparar com a coluna target_plan TEXT.
    const { rows: banners } = await runWithVerticalFallback(bannersSql, [cid]);

    // 2. Pedidos recentes do Canal Digital (últimas 24h)
    let digitalOrders = [];
    try {
      const { rows } = await db.query(`
        SELECT id, order_number, customer_name, total, status, created_at,
               'canal_digital' AS source
        FROM digital_orders
        WHERE company_id = $1
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 10
      `, [cid]);
      digitalOrders = rows;
    } catch (_) { /* plano sem Canal Digital ou tabela não existe */ }

    // 3. Pedidos recentes do Studio (últimas 24h)
    // fix (24/06/2026): a VIEW studio_orders não tem `order_number` nem `total`
    // — tem `total_amount` e `display_name`. A query antiga floodava os logs
    // com `column "order_number" does not exist`. Usamos as colunas reais e
    // expomos display_name (ou o id curto) como order_number pro card do app.
    //
    // 31/08/2026: source <> 'pdv'. Notificação avisa do que chegou DE FORA
    // (Canal Digital, pedido digital/marketplace do Studio). Venda de balcão
    // com produto personalizável entra na view via trigger (pending_art) —
    // certo pro KDS, que é fila de produção e continua mostrando — mas o
    // operador acabou de registrá-la com as próprias mãos; notificar é ruído.
    let studioOrders = [];
    try {
      const { rows } = await db.query(`
        SELECT id,
               COALESCE(display_name, LEFT(id::text, 8)) AS order_number,
               customer_name,
               total_amount AS total,
               status,
               created_at,
               'studio' AS source
        FROM studio_orders
        WHERE company_id = $1
          AND source <> 'pdv'
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 10
      `, [cid]);
      studioOrders = rows;
    } catch (_) { /* view studio_orders não disponível neste ambiente */ }

    // Mescla e ordena por data desc.
    //
    // 31/08/2026 — dedup por id: um pedido de digital_orders com
    // vertical 'studio' vem nas DUAS queries — direto do bloco 2 e via
    // view studio_orders (primeiro ramo da view é digital_orders WHERE
    // vertical = 'studio'), com o MESMO id. O card do app usa key
    // id+source, então não colide — o pedido só aparece duplicado na
    // gaveta e conta dobrado no unread_count. Deduplicamos aqui (e não
    // com WHERE vertical <> 'studio' no bloco 2) porque a criação da
    // view é condicional (208: "deferida" sem marketplace_orders) — num
    // ambiente sem a view, o filtro SQL faria o pedido sumir do feed.
    // O card 'studio' vence por vir primeiro: roteia pro fluxo de
    // produção, o destino certo de um pedido do Studio.
    const byId = new Map();
    for (const o of [...studioOrders, ...digitalOrders]) {
      if (!byId.has(o.id)) byId.set(o.id, o);
    }
    const orders = [...byId.values()]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 15);

    // unread_count: banners não lidos + pedidos com menos de 2h
    const threshold = Date.now() - 2 * 60 * 60 * 1000;
    const newOrderCount = orders.filter(o => new Date(o.created_at).getTime() > threshold).length;
    const unread_count = banners.length + newOrderCount;

    res.json({ banners, orders, unread_count });
  } catch (err) {
    console.error('[notifications] list error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar notificações' });
  }
});

// POST /banners/:nid/read — marca banner como lido (idempotente)
router.post('/banners/:nid/read', async (req, res) => {
  const { id: cid, nid } = req.params;
  try {
    await db.query(`
      INSERT INTO notification_reads (notification_id, company_id)
      VALUES ($1, $2)
      ON CONFLICT (notification_id, company_id) DO NOTHING
    `, [nid, cid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

// POST /read-all-banners — marca como lidos os banners que esta empresa
// de fato VÊ (mesmo filtro do GET: empresa + plano + shell + validade).
router.post('/read-all-banners', async (req, res) => {
  const cid = req.params.id;
  try {
    await runWithVerticalFallback(readAllSql, [cid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read-all error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar todas como lidas' });
  }
});

module.exports = router;
