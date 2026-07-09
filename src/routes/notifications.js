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
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// GET — Banners ativos (não lidos) + pedidos recentes das últimas 24h
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    // 1. Banners ativos não lidos por esta empresa
    // Nota: companies.plan é do tipo plan_type (enum); fazemos cast ::text
    // para comparar com a coluna target_plan TEXT da app_notifications.
    const { rows: banners } = await db.query(`
      SELECT n.id, n.type, n.title, n.body, n.html_content,
             n.cta_label, n.cta_url, n.cta_route, n.created_at
      FROM app_notifications n
      WHERE n.is_active = true
        AND (n.expires_at IS NULL OR n.expires_at > NOW())
        AND (n.target_company_id IS NULL OR n.target_company_id = $1)
        AND (n.target_plan IS NULL OR n.target_plan = (
              SELECT plan::text FROM companies WHERE id = $1 LIMIT 1
            ))
        AND NOT EXISTS (
          SELECT 1 FROM notification_reads r
          WHERE r.notification_id = n.id AND r.company_id = $1
        )
      ORDER BY n.created_at DESC
      LIMIT 20
    `, [cid]);

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
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 10
      `, [cid]);
      studioOrders = rows;
    } catch (_) { /* view studio_orders não disponível neste ambiente */ }

    // Mescla e ordena por data desc
    const orders = [...digitalOrders, ...studioOrders]
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

// POST /read-all-banners — marca todos os banners ativos como lidos para esta empresa
router.post('/read-all-banners', async (req, res) => {
  const cid = req.params.id;
  try {
    await db.query(`
      INSERT INTO notification_reads (notification_id, company_id)
      SELECT n.id, $1
      FROM app_notifications n
      WHERE n.is_active = true
        AND (n.target_company_id IS NULL OR n.target_company_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM notification_reads r
          WHERE r.notification_id = n.id AND r.company_id = $1
        )
      ON CONFLICT (notification_id, company_id) DO NOTHING
    `, [cid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read-all error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar todas como lidas' });
  }
});

module.exports = router;
