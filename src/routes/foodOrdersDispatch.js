// ============================================================
// AURA. - Modulo Food Service
// FOOD-08 (Fase 8): Dispatch de motoboy + PIN entregador
//
// Este arquivo eh montado em /companies/:id/food/orders/* ANTES do
// foodOrders.js (em private.js), pra interceptar:
//   - POST   /:oid/dispatch     - novo: atribui entregador + gera PIN
//   - PATCH  /:oid/status       - middleware que valida PIN antes de delivered
//
// Demais rotas de /food/orders continuam servidas pelo foodOrders.js.
//
// Armadilhas:
//   - cache module-level pras 2 colunas novas (migration 127): HAS_DELIVERER_PIN_COL,
//     HAS_PIN_VERIFIED_AT_COL. Optimistic; vira false em 42703.
//   - PATCH status delivered SEM pin em pedido com deliverer_pin -> 422 PIN_REQUIRED.
//   - PATCH com pin_verified_at ja setado -> prossegue (idempotente).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

const guard = [requirePlan('negocio', 'expansao')];

// Cache module-level (armadilha_schema_pre_migration).
let HAS_DELIVERER_PIN_COL    = true;
let HAS_PIN_VERIFIED_AT_COL  = true;

// Gera PIN numerico de 4 digitos (1000-9999).
function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ============================================================
// POST /:oid/dispatch - atribui entregador + gera PIN
// ============================================================
// Body: { deliverer_id, pin? }
// Validacoes:
//   - pedido pertence a company
//   - pedido status='ready' (so despacha o que ja saiu do KDS)
//   - deliverer_id existe E is_active=true
// Update transacional:
//   - food_orders.deliverer_id, deliverer_pin, dispatched_at, deliverer_commission
//   - INSERT em food_dispatch_log (assigned)
// Retorna: { order_id, deliverer_pin, dispatched_at }
// PIN retornado UMA UNICA VEZ pro garcom mostrar ao motoboy.
router.post('/:oid/dispatch', guard, async (req, res) => {
  const { deliverer_id, pin: requestedPin } = req.body || {};
  if (!deliverer_id) return res.status(400).json({ error: 'deliverer_id obrigatorio' });

  // Valida pin enviado: 4 digitos numericos. Se invalido, gera novo.
  let pin = requestedPin && /^\d{4}$/.test(String(requestedPin))
    ? String(requestedPin)
    : generatePin();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: orders } = await client.query(
      `SELECT id, status, delivery_fee, deliverer_id AS prev_deliverer_id
       FROM food_orders
       WHERE id=$1 AND company_id=$2
       FOR UPDATE`,
      [req.params.oid, req.params.id]
    );
    if (!orders.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }
    const order = orders[0];
    if (order.status !== 'ready') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Pedido com status '${order.status}' nao pode ser despachado (apenas 'ready')`,
        code: 'INVALID_STATUS_FOR_DISPATCH',
      });
    }

    const { rows: deliverers } = await client.query(
      `SELECT id, name, commission_mode, commission_pct, commission_fixed
       FROM food_deliverers WHERE id=$1 AND company_id=$2 AND is_active=TRUE`,
      [deliverer_id, req.params.id]
    );
    if (!deliverers.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Entregador nao encontrado ou inativo' });
    }
    const deliverer = deliverers[0];

    // Calcula comissao do entregador.
    let commission = 0;
    if (deliverer.commission_mode === 'pct') {
      commission = parseFloat(((order.delivery_fee || 0) * (deliverer.commission_pct || 0) / 100).toFixed(2));
    } else {
      commission = parseFloat(deliverer.commission_fixed || 0);
    }

    // Log da substituicao se ja tinha um entregador.
    if (order.prev_deliverer_id && order.prev_deliverer_id !== deliverer_id) {
      await client.query(
        `INSERT INTO food_dispatch_log (order_id, company_id, deliverer_id, commission_calc, action, note)
         VALUES ($1,$2,$3,0,'unassigned','Substituido por novo entregador via /dispatch')`,
        [req.params.oid, req.params.id, order.prev_deliverer_id]
      );
    }

    // Update do pedido. Tenta com deliverer_pin; cai pra sem em 42703.
    let updateSql = `UPDATE food_orders
       SET deliverer_id=$1, deliverer_commission=$2,
           dispatched_at=COALESCE(dispatched_at, NOW()), updated_at=NOW()`;
    let updateParams = [deliverer_id, commission];

    if (HAS_DELIVERER_PIN_COL) {
      try {
        updateSql = `UPDATE food_orders
           SET deliverer_id=$1, deliverer_commission=$2, deliverer_pin=$3,
               dispatched_at=COALESCE(dispatched_at, NOW()), updated_at=NOW()
           WHERE id=$4 AND company_id=$5 RETURNING *`;
        updateParams = [deliverer_id, commission, pin, req.params.oid, req.params.id];
        await client.query(updateSql, updateParams);
      } catch (eUpd) {
        if (eUpd.code === '42703') {
          HAS_DELIVERER_PIN_COL = false;
          console.warn('[food/dispatch] deliverer_pin ausente (migration 127 pendente) - dispatch sem PIN');
          await client.query(
            `UPDATE food_orders
               SET deliverer_id=$1, deliverer_commission=$2,
                   dispatched_at=COALESCE(dispatched_at, NOW()), updated_at=NOW()
             WHERE id=$3 AND company_id=$4`,
            [deliverer_id, commission, req.params.oid, req.params.id]
          );
          pin = null;
        } else {
          throw eUpd;
        }
      }
    } else {
      await client.query(
        `UPDATE food_orders
           SET deliverer_id=$1, deliverer_commission=$2,
               dispatched_at=COALESCE(dispatched_at, NOW()), updated_at=NOW()
         WHERE id=$3 AND company_id=$4`,
        [deliverer_id, commission, req.params.oid, req.params.id]
      );
      pin = null;
    }

    await client.query(
      `INSERT INTO food_dispatch_log (order_id, company_id, deliverer_id, commission_calc, action, note)
       VALUES ($1,$2,$3,$4,'assigned',$5)`,
      [req.params.oid, req.params.id, deliverer_id, commission, 'Despacho via /food/orders/:oid/dispatch']
    );

    await client.query('COMMIT');
    res.json({
      order_id: req.params.oid,
      deliverer_id,
      deliverer_name: deliverer.name,
      deliverer_pin: pin,
      commission_calc: commission,
      dispatched_at: new Date().toISOString(),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[food/orders/dispatch] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao despachar pedido', detail: e.message });
  } finally {
    client.release();
  }
});

// ============================================================
// PATCH /:oid/status - middleware: valida PIN antes de 'delivered'
// ============================================================
// Se a transicao for pra 'delivered' e o pedido tem deliverer_pin setado:
//   - se pin_verified_at JA setado -> prossegue (next)
//   - se body.pin bater com deliverer_pin -> seta pin_verified_at, prossegue
//   - senao -> 422 PIN_REQUIRED
// Caso contrario (sem pin no pedido, ou status != delivered) -> prossegue.
//
// Importante: chama next() pra deixar o foodOrders.js fazer o resto (baixa
// de estoque, liberar mesa, WhatsApp, etc). NAO duplica nada.
router.patch('/:oid/status', guard, async (req, res, next) => {
  try {
    const { status, pin: requestPin } = req.body || {};
    if (status !== 'delivered') return next();

    // Se coluna nao existe ainda, segue sem validar (defensivo).
    if (!HAS_DELIVERER_PIN_COL && !HAS_PIN_VERIFIED_AT_COL) return next();

    // SELECT pin atual + verificado.
    let pinRow = null;
    try {
      const { rows } = await db.query(
        `SELECT deliverer_pin, pin_verified_at
         FROM food_orders WHERE id=$1 AND company_id=$2`,
        [req.params.oid, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
      pinRow = rows[0];
    } catch (eSel) {
      if (eSel.code === '42703') {
        HAS_DELIVERER_PIN_COL = false;
        HAS_PIN_VERIFIED_AT_COL = false;
        console.warn('[food/orders/status] colunas PIN ausentes (migration 127 pendente) - bypass');
        return next();
      }
      throw eSel;
    }

    // Pedido sem PIN -> nao exige (foi despachado antes da migration ou sem motoboy).
    if (!pinRow.deliverer_pin) return next();

    // PIN ja verificado anteriormente -> nao re-exige.
    if (pinRow.pin_verified_at) return next();

    // PIN necessario: valida match
    const submitted = requestPin ? String(requestPin).trim() : null;
    if (!submitted) {
      return res.status(422).json({
        error: 'PIN do entregador necessario',
        code: 'PIN_REQUIRED',
      });
    }
    if (submitted !== pinRow.deliverer_pin) {
      return res.status(422).json({
        error: 'PIN do entregador incorreto',
        code: 'PIN_INVALID',
      });
    }

    // Match - marca verificado e segue.
    try {
      await db.query(
        `UPDATE food_orders SET pin_verified_at=NOW() WHERE id=$1 AND company_id=$2`,
        [req.params.oid, req.params.id]
      );
    } catch (eUpd) {
      if (eUpd.code === '42703') {
        HAS_PIN_VERIFIED_AT_COL = false;
        console.warn('[food/orders/status] pin_verified_at ausente - bypass marcar');
      } else throw eUpd;
    }
    return next();
  } catch (e) {
    console.error('[food/orders/status PIN middleware] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao validar PIN', detail: e.message });
  }
});

module.exports = router;
