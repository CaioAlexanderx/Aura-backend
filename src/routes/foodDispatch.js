// =======================================================
// AURA. - M ódulo Food Service
// FOOD-08 (Fase 8): Painel de Despacho (Motoboys)
// Montado em /companies/:id/food/dispatch/*
//
// GET  /board             - agregado ready+inRoute+deliverers
// ==========================================================
//
// Notas:
//   - requireAuth + requireCompanyAccess aplicados em private.js.
//   - Colgunas novas (dispatched_at, pin_verified_at) são defensivas
//     via cache module-level + tratamento 42703; exige migration 127
//     aplicada via Supabase MCP antes do merge.

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

const guard = [requirePlan('negocio', 'expansao')];

// Cache module-level pra colunas da migration 127 (armadilha_schema_pre_migration).
// Optimistic: assume true; vira false na primeira vez que 42703 estourar.
let HAS_DISPATCHED_AT_COL = true;
let HAS_DELIVERER_PIN_COL = true;
let HAS_LAST_PAYOUT_COL  = true;

// ==========================================================
// GET /board - agregado da tela de despacho
// ==========================================================
router.get('/board', guard, async (req, res) => {
  const companyId = req.params.id;

  // 1 Ready - pedidos prontos aguardando motoboy
  const readySql = `
    SELECT fo.id, fo.customer_name, fo.delivery_address AS customer_address,
           fo.total AS total_amount, fo.created_at, fo.ready_at,
           EXTRACT(EPOCH FROM (NOW() - COALESCE(fo.ready_at, fo.confirmed_at, fo.created_at))) / 60 AS waiting_min,
           COALESCE((SELECT STRING_AGG(foi.item_name, ', ' ORDER BY foi.id)
                    FROM food_order_items foi WHERE foi.order_id = fo.id), '') AS items_summary
    FROM food_orders fo
    WHERE fo.company_id = $1
      AND fo.status = 'ready'
      AND fo.channel IN ('delivery_proprio', 'whatsapp', 'online')
      AND fo.deliverer_id IS NULL
    ORDER BY fo.ready_at ASC NULLS LAST, fo.created_at ASC
    LIMIT 50`;

  // 2 In Route - pedidos despachados e ainda não entregues.
  // Usa dispatched_at se existe (HAS_DISPATCHED_AT_COL), senão fallback
  // pra status='ready' com deliverer_id NOT NULL.
  const inRouteSqlWithDispatched = `
    SELECT fo.id, fo.deliverer_id, fd.name AS deliverer_name,
           fo.customer_name, fo.delivery_address AS customer_address,
           fo.total AS total_amount,
           fo.dispatched_at, fo.estimated_ready_at AS eta_min,
           EXTRACT(EPOCH FROM (NOW() - fo.dispatched_at)) / 60 AS route_min
    FROM food_orders fo
    LEFT JOIN food_deliverers fd ON fd.id = fo.deliverer_id
    WHERE fo.company_id = $1
      AND fo.dispatched_at IS NOT NULL
      AND fo.delivered_at IS NULL
      AND fo.status NOT IN ('delivered', 'cancelled')
    ORDER BY fo.dispatched_at ASC
    LIMIT 50`;

  const inRouteSqlFallback = `
    SELECT fo.id, fo.deliverer_id, fd.name AS deliverer_name,
           fo.customer_name, fo.delivery_address AS customer_address,
           fo.total AS total_amount,
           NULL::timestamptz AS dispatched_at,
           fo.estimated_ready_at AS eta_min,
           0::numeric AS route_min
    FROM food_orders fo
    LEFT JOIN food_deliverers fd ON fd.id = fo.deliverer_id
    WHERE fo.company_id = $1
      AND fo.deliverer_id IS NOT NULL
      AND fo.status = 'ready'
    ORDER BY fo.created_at ASC
    LIMIT 50`;

  // 3 Deliverers - entregadores ativos + stats do dia.
  // current_orders_count = rotas abertas
  // today_deliveries_count + today_commission = delivered hoje
  const deliverersSql = `
    SELECT
      fd.id, fd.name, fd.phone, fd.vehicle_type,
      fd.commission_mode, fd.commission_pct, fd.commission_fixed,
      COALESCE((
        SELECT COUNT(*) FROM food_orders fo
         WHERE fo.deliverer_id = fd.id
           AND fo.company_id = $1
           AND fo.delivered_at IS NULL
           AND fo.status NOT IN ('delivered', 'cancelled')
      ), 0) AS current_orders_count,
      COALESCE((
        SELECT COUNT(*) FROM food_orders fo
         WHERE fo.deliverer_id = fd.id
           AND fo.company_id = $1
           AND fo.status = 'delivered'
           AND fo.delivered_at::date = NOW()::date
      ), 0) AS today_deliveries_count,
      COALESCE((
        SELECT SUM(fo.deliverer_commission) FROM food_orders fo
         WHERE fo.deliverer_id = fd.id
           AND fo.company_id = $1
           AND fo.status = 'delivered'
           AND fo.delivered_at::date = NOW()::date
      ), 0) AS today_commission
    FROM food_deliverers fd
    WHERE fd.company_id = $1 AND fd.is_active = TRUE
    ORDER BY fd.name`;

  try {
    // In-route: tenta sql com dispatched_at; cai no fallback se coluna ausente.
    const inRoutePromise = (async () => {
      if (HAS_DISPATCHED_AT_COL) {
        try {
          return (await db.query(inRouteSqlWithDispatched, [companyId])).rows;
        } catch (e) {
          if (e?.code === '42703') {
            HAS_DISPATCHED_AT_COL = false;
            console.warn('[food/dispatch/board] dispatched_at ausente - usando fallback');
            return (await db.query(inRouteSqlFallback, [companyId])).rows;
          }
          throw e;
        }
      }
      return (await db.query(inRouteSqlFallback, [companyId])).rows;
    })();

    const [readyArr, inRouteArr, deliverersArr] = await Promise.all([
      db.query(readySql,       [companyId]).then(r => r.rows),
      inRoutePromise,
      db.query(deliverersSql, [companyId]).then(r => r.rows),
    ]);

    res.json({
      ready: readyArr,
      inRoute: inRouteArr,
      deliverers: deliverersArr,
    });
  } catch (e) {
    console.error('[food/dispatch/board] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar board de despacho' });
  }
});

module.exports = router;
