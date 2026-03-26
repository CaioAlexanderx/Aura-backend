// ============================================================
// AURA. — FOOD-06: Integração iFood (simulada + preparada)
// Import CSV de pedidos do iFood · estrutura compatível com API oficial
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');

const guard = [requireAuth, requirePlan(['negocio','expansao'])];

// ── MAPEAMENTO iFood → Aura ──────────────────────────────────
// Status iFood:  PLACED → CONFIRMED → PREPARATION_STARTED → READY_TO_PICKUP
//                → DISPATCHED → CONCLUDED | CANCELLED
const IFOOD_STATUS_MAP = {
  PLACED:               'pending',
  CONFIRMED:            'confirmed',
  PREPARATION_STARTED:  'preparing',
  READY_TO_PICKUP:      'ready',
  DISPATCHED:           'ready',
  CONCLUDED:            'delivered',
  CANCELLED:            'cancelled',
};

// Canal mapeado como 'ifood' nos food_orders

// ── PARSER CSV iFood ─────────────────────────────────────────
// Colunas esperadas no export do iFood Admin:
// Número do pedido, Data, Cliente, Itens, Subtotal, Taxa entrega, Total,
// Status, Forma pagamento, Endereço de entrega
function parseIfoodCSV(csvText) {
  const lines  = csvText.trim().split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('CSV vazio ou sem dados');

  // Detecta delimitador: ponto-e-vírgula (padrão iFood BR) ou vírgula
  const delimiter = lines[0].includes(';') ? ';' : ',';
  const headers   = lines[0].split(delimiter).map(h => h.trim().replace(/"/g, '').toLowerCase());

  // Índices das colunas — aceita variações de nome
  const col = (aliases) => {
    for (const a of aliases) {
      const idx = headers.findIndex(h => h.includes(a));
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const idx = {
    orderId:   col(['número', 'numero', 'pedido', 'order']),
    date:      col(['data', 'date']),
    customer:  col(['cliente', 'customer', 'nome']),
    items:     col(['itens', 'items', 'produtos']),
    subtotal:  col(['subtotal']),
    delivery:  col(['entrega', 'taxa', 'frete', 'delivery']),
    total:     col(['total']),
    status:    col(['status']),
    payment:   col(['pagamento', 'payment', 'forma']),
    address:   col(['endereço', 'endereco', 'address']),
  };

  return lines.slice(1).map((line, lineNum) => {
    const cols = splitCSVLine(line, delimiter);
    const get  = (i) => (i !== -1 && cols[i]) ? cols[i].trim().replace(/^"|"$/g,'') : null;

    const externalId = get(idx.orderId);
    const rawStatus  = (get(idx.status) || 'CONCLUDED').toUpperCase();
    const status     = IFOOD_STATUS_MAP[rawStatus] || 'delivered';
    const total      = parseFloat((get(idx.total) || '0').replace(/[^0-9,.]/g,'').replace(',','.')) || 0;
    const subtotal   = parseFloat((get(idx.subtotal)||'0').replace(/[^0-9,.]/g,'').replace(',','.')) || 0;
    const deliveryFee= parseFloat((get(idx.delivery)||'0').replace(/[^0-9,.]/g,'').replace(',','.')) || 0;
    const rawDate    = get(idx.date);
    const createdAt  = rawDate ? _parseDate(rawDate) : new Date();

    // Parse simples dos itens (texto livre do export iFood)
    const rawItems = get(idx.items) || '';
    const parsedItems = rawItems.split(/[,;|]+/).filter(Boolean).map(s => ({
      item_name:  s.trim(),
      quantity:   1,
      unit_price: 0,
      total_price: 0,
    }));

    return {
      external_id:      externalId,
      channel:          'ifood',
      source:           'csv_import',
      status,
      customer_name:    get(idx.customer),
      payment_method:   get(idx.payment),
      delivery_address: get(idx.address) ? { raw: get(idx.address) } : null,
      subtotal,
      delivery_fee:     deliveryFee,
      discount:         0,
      total,
      created_at:       createdAt,
      items:            parsedItems.length ? parsedItems : [{ item_name: 'Pedido iFood', quantity:1, unit_price: total, total_price: total }],
      _line: lineNum + 2,
    };
  }).filter(r => r.external_id); // ignora linhas sem ID de pedido
}

function splitCSVLine(line, delimiter) {
  const result = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === delimiter && !inQ) { result.push(cur); cur = ''; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function _parseDate(s) {
  // Tenta formatos: DD/MM/YYYY HH:MM, DD/MM/YYYY, YYYY-MM-DD
  if (s.includes('/')) {
    const [d, m, yRest] = s.split('/');
    const [y, time] = (yRest||'').split(' ');
    return new Date(`${y}-${m}-${d}${time ? 'T'+time : ''}`);
  }
  return new Date(s);
}

// ── ROTAS ────────────────────────────────────────────────────

// POST /companies/:id/food/ifood/import
// Body: { csv: '<texto do CSV>' } ou multipart (futuro)
router.post('/import', guard, async (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'Campo csv obrigatório no body' });

  let parsed;
  try { parsed = parseIfoodCSV(csv); }
  catch (e) { return res.status(400).json({ error: `Erro ao ler CSV: ${e.message}` }); }

  if (!parsed.length) return res.status(400).json({ error: 'Nenhum pedido encontrado no CSV' });

  const batchId  = require('crypto').randomUUID();
  const results  = { imported: 0, skipped: 0, errors: [] };
  const client   = await db.pool.connect();

  try {
    await client.query('BEGIN');

    for (const order of parsed) {
      // Verifica se external_id já existe para esta empresa
      const { rows: exists } = await client.query(
        `SELECT id FROM food_orders WHERE company_id=$1 AND external_id=$2`,
        [req.params.id, order.external_id]
      );
      if (exists.length) { results.skipped++; continue; }

      try {
        const { rows: inserted } = await client.query(
          `INSERT INTO food_orders
             (company_id, channel, source, status, external_id,
              customer_name, payment_method, delivery_address,
              subtotal, discount, delivery_fee, total,
              created_at, updated_at, imported_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,NOW())
           RETURNING id`,
          [req.params.id, 'ifood', 'csv_import', order.status, order.external_id,
           order.customer_name, order.payment_method,
           order.delivery_address ? JSON.stringify(order.delivery_address) : null,
           order.subtotal, 0, order.delivery_fee, order.total,
           isNaN(order.created_at) ? new Date() : order.created_at]
        );

        // Inserir itens
        for (const item of order.items) {
          await client.query(
            `INSERT INTO food_order_items
               (order_id, item_name, quantity, unit_price, total_price)
             VALUES ($1,$2,$3,$4,$5)`,
            [inserted[0].id, item.item_name, item.quantity, item.unit_price, item.total_price]
          );
        }
        results.imported++;
      } catch (rowErr) {
        results.errors.push({ line: order._line, external_id: order.external_id, error: rowErr.message });
      }
    }

    await client.query('COMMIT');
    res.status(201).json({
      batch_id: batchId,
      total_in_csv: parsed.length,
      ...results,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// GET /companies/:id/food/ifood/orders?limit=50&offset=0
// Lista pedidos importados do iFood
router.get('/orders', guard, async (req, res) => {
  const { limit = 50, offset = 0, status } = req.query;
  const conds = ["fo.company_id=$1", "fo.source='csv_import'", "fo.channel='ifood'"];
  const vals  = [req.params.id];
  let i = 2;
  if (status) { conds.push(`fo.status=$${i++}`); vals.push(status); }
  try {
    const { rows } = await db.query(
      `SELECT fo.*, json_agg(foi.*) AS items
       FROM food_orders fo
       LEFT JOIN food_order_items foi ON foi.order_id = fo.id
       WHERE ${conds.join(' AND ')}
       GROUP BY fo.id
       ORDER BY fo.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...vals, limit, offset]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/food/ifood/stats
// Comparativo iFood vs canal próprio
router.get('/stats', guard, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        source,
        channel,
        COUNT(*) FILTER (WHERE status NOT IN ('cancelled')) AS orders,
        SUM(total) FILTER (WHERE status='delivered')        AS revenue,
        ROUND(AVG(total) FILTER (WHERE status='delivered')::NUMERIC, 2) AS avg_ticket
      FROM food_orders
      WHERE company_id=$1
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY source, channel
      ORDER BY revenue DESC NULLS LAST`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/food/ifood/template
// Retorna modelo de CSV compatível para o cliente preencher manualmente
router.get('/template', guard, (_req, res) => {
  const csv = [
    'Número do pedido;Data;Cliente;Itens;Subtotal;Taxa entrega;Total;Status;Forma pagamento;Endereço de entrega',
    '1234567;25/03/2026 12:30;João Silva;"X-Burguer, Fritas G";32,00;5,00;37,00;CONCLUDED;Pix;"Rua das Flores 123, Centro"',
    '1234568;25/03/2026 13:15;Maria Costa;"Pizza Margherita";45,00;5,00;50,00;CONCLUDED;Cartão;"Av. Brasil 456, Jardim"',
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-ifood-aura.csv"');
  res.send('\uFEFF' + csv); // BOM para Excel reconhecer UTF-8
});

module.exports = router;
