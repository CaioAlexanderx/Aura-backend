// ============================================================
// AURA. — Ordem de Servico
//
// Montado em private.js sob /service-orders. Schema: migration 313.
//
// GET    /service-orders?status=&days=&limit=&customer_id=&q=  → {orders}
// POST   /service-orders                                       → {order} (status 'aberta')
// GET    /service-orders/:osId                                 → {order, items}
// PATCH  /service-orders/:osId                                 → {order}
// PUT    /service-orders/:osId/items                           → {order, items}
// POST   /service-orders/:osId/approve                         → {order}
// POST   /service-orders/:osId/status                          → {order}
// DELETE /service-orders/:osId                                 → {deleted:true}
//
// A OS NASCE ANTES DA VENDA (decisao de produto, 31/08/2026): ela e aberta na
// ENTRADA do equipamento, quando ainda nao ha venda nenhuma, e so encosta numa
// venda ao ser entregue. Por isso nao ha nada aqui pendurado no fluxo do PDV —
// e o contrario, a venda e que aparece no fim da vida da OS.
//
// GATE: os_enabled em companies.pdv_settings. Gate so na ESCRITA — ver
// comentario em assertOsEnabled().
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// ─── Gate do modulo ──────────────────────────────────────────
//
// Le do BANCO, nunca do JWT: o token carrega plano/modulos de quando foi
// emitido e nunca revalida, entao uma loja que acabou de ativar a OS ficaria
// sem o modulo ate deslogar (armadilha #9 do CLAUDE.md).
//
// So na escrita, de proposito. Se a loja desligar o toggle depois de ter 40 OS
// abertas, bloquear o GET tambem esconderia dela os aparelhos que estao no
// balcao — dado que ela ja cadastrou e ainda precisa ver pra devolver. Mesmo
// raciocinio da armadilha #3: gate em criacao, nunca em leitura.
async function assertOsEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'os_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) {
    const err = new Error('Empresa nao encontrada');
    err.status = 404;
    throw err;
  }
  if (rows[0].enabled !== 'true') {
    const err = new Error('Ordem de Servico nao esta habilitada. Ative em Configuracoes > PDV.');
    err.status = 403;
    err.code = 'OS_DISABLED';
    throw err;
  }
}

// ─── Maquina de status ───────────────────────────────────────
//
// 'pronta' -> 'em_execucao' existe porque retrabalho existe: o tecnico marca
// pronta, o cliente vem buscar, testa no balcao e o defeito continua la. Sem
// essa aresta a loja seria obrigada a cancelar e abrir OS nova, perdendo o
// historico do aparelho — que e justamente o que importa num retrabalho.
const TRANSICOES = {
  aberta:      ['em_execucao', 'cancelada'],
  em_execucao: ['pronta', 'cancelada'],
  pronta:      ['entregue', 'em_execucao', 'cancelada'],
  entregue:    [],
  cancelada:   [],
};

const STATUS_VALIDOS = Object.keys(TRANSICOES);

// Campos que o PATCH aceita. Whitelist: qualquer coisa fora daqui e ignorada
// em silencio, entao um front mandando company_id ou os_number nao reescreve
// identidade nem numeracao.
const CAMPOS_EDITAVEIS = [
  'equipment_type', 'equipment_brand', 'equipment_model', 'equipment_serial',
  'equipment_condition', 'equipment_accessories',
  'reported_issue', 'diagnosis', 'solution',
  'technician_id', 'promised_at', 'warranty_days', 'notes',
  'intake_signature_url',
];

function somaItens(items) {
  return items.reduce((acc, it) => {
    const q = parseFloat(it.quantity);
    const p = parseFloat(it.unit_price);
    return acc + (Number.isFinite(q) ? q : 0) * (Number.isFinite(p) ? p : 0);
  }, 0);
}

function validarItens(items) {
  if (!Array.isArray(items)) return 'items deve ser array';
  for (const [i, it] of items.entries()) {
    if (!it || !String(it.description || '').trim()) {
      return `items[${i}].description obrigatorio`;
    }
    if (it.kind != null && !['servico', 'peca'].includes(it.kind)) {
      return `items[${i}].kind deve ser 'servico' ou 'peca'`;
    }
    if (!(parseFloat(it.quantity) > 0)) {
      return `items[${i}].quantity deve ser > 0`;
    }
    if (!(parseFloat(it.unit_price) >= 0)) {
      return `items[${i}].unit_price deve ser >= 0`;
    }
  }
  return null;
}

// SELECT unico da OS com os nomes que a tela precisa. COALESCE no nome da
// empresa nao entra aqui (nao ha join em companies), mas cliente e tecnico sim.
const SELECT_OS = `
  SELECT so.*,
         c.name  AS customer_name,
         c.phone AS customer_phone,
         e.name  AS technician_name
    FROM service_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN employees e ON e.id = so.technician_id
`;

async function carregarOs(osId, companyId) {
  const { rows } = await db.query(
    `${SELECT_OS} WHERE so.id = $1 AND so.company_id = $2`,
    [osId, companyId]
  );
  return rows[0] || null;
}

async function carregarItens(osId) {
  const { rows } = await db.query(
    `SELECT id, service_order_id, kind, description, product_id,
            quantity, unit_price, total_price, sort_order, created_at
       FROM service_order_items
      WHERE service_order_id = $1
      ORDER BY sort_order, created_at`,
    [osId]
  );
  return rows;
}

function falhar(res, err, contexto) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[service-orders:${contexto}]`, err.message);
  return res.status(500).json({ error: 'Erro ao processar ordem de servico' });
}

// ─── GET /service-orders ─────────────────────────────────────
// Sem gate: ver assertOsEnabled().
router.get('/', async function (req, res) {
  const cid = req.params.id;
  const { status, customer_id, q } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const days  = Math.min(parseInt(req.query.days, 10) || 180, 730);

  const params = [cid];
  let where = 'so.company_id = $1';

  if (status) {
    if (!STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ error: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
    }
    params.push(status);
    where += ` AND so.status = $${params.length}`;
  }
  if (customer_id) {
    params.push(customer_id);
    where += ` AND so.customer_id = $${params.length}`;
  }
  if (q && String(q).trim()) {
    // Busca do balcao: numero da OS, nome do cliente, ou marca/modelo/serie do
    // aparelho — que e como o cliente se identifica quando esqueceu o papel.
    //
    // Dois parametros de proposito: o ILIKE precisa dos %, e a comparacao por
    // numero precisa do termo CRU. Reusar o parametro com % faria
    // CAST(os_number AS TEXT) = '%12%', que nunca casa com nada — a busca por
    // numero simplesmente nao existiria, e em silencio.
    const termo = String(q).trim();
    params.push(`%${termo}%`);
    const pLike = `$${params.length}`;
    params.push(termo);
    const pRaw = `$${params.length}`;
    where += ` AND (c.name ILIKE ${pLike}
                 OR so.equipment_brand ILIKE ${pLike}
                 OR so.equipment_model ILIKE ${pLike}
                 OR so.equipment_serial ILIKE ${pLike}
                 OR CAST(so.os_number AS TEXT) = ${pRaw})`;
  }

  params.push(String(days));
  where += ` AND so.created_at >= NOW() - ($${params.length} || ' days')::interval`;
  params.push(limit);

  try {
    const { rows } = await db.query(
      `${SELECT_OS} WHERE ${where} ORDER BY so.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ orders: rows });
  } catch (err) {
    // 42P01: migration 313 ainda nao aplicada neste ambiente. Lista vazia e
    // melhor que 500 — a tela abre e diz "nenhuma OS", que e a verdade.
    if (err.code === '42P01') return res.json({ orders: [] });
    falhar(res, err, 'GET');
  }
});

// ─── POST /service-orders ────────────────────────────────────
// Abre a OS na entrada do equipamento. Nasce em 'aberta', sem venda.
router.post('/', async function (req, res) {
  const cid = req.params.id;
  const {
    customer_id, reported_issue, items = [],
    equipment_type, equipment_brand, equipment_model, equipment_serial,
    equipment_condition, equipment_accessories, equipment_photos,
    technician_id, promised_at, warranty_days, notes,
    intake_signature_url,
  } = req.body || {};

  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id obrigatorio: sem cliente nao ha pra quem devolver o aparelho' });
  }
  if (!String(reported_issue || '').trim()) {
    return res.status(400).json({ error: 'reported_issue obrigatorio' });
  }
  const erroItens = validarItens(items);
  if (erroItens) return res.status(400).json({ error: erroItens });

  const wDays = warranty_days == null ? 0 : parseInt(warranty_days, 10);
  if (!Number.isFinite(wDays) || wDays < 0) {
    return res.status(400).json({ error: 'warranty_days deve ser inteiro >= 0' });
  }

  let client;
  try {
    await assertOsEnabled(cid);

    // Cliente tem que ser DESTA empresa — sem isso, um customer_id de outra
    // empresa passaria pela FK (que so olha customers.id) e a OS nasceria
    // apontando pra fora do tenant.
    const cust = await db.query(
      'SELECT id FROM customers WHERE id = $1 AND company_id = $2',
      [customer_id, cid]
    );
    if (!cust.rows.length) {
      return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });
    }
    if (technician_id) {
      const tec = await db.query(
        'SELECT id FROM employees WHERE id = $1 AND company_id = $2',
        [technician_id, cid]
      );
      if (!tec.rows.length) {
        return res.status(404).json({ error: 'Tecnico nao encontrado nesta empresa' });
      }
    }

    client = await db.connect();
    await client.query('BEGIN');

    const total = somaItens(items);
    const { rows } = await client.query(
      `INSERT INTO service_orders
         (company_id, customer_id, status, reported_issue,
          equipment_type, equipment_brand, equipment_model, equipment_serial,
          equipment_condition, equipment_accessories, equipment_photos,
          technician_id, promised_at, warranty_days, notes,
          intake_signature_url, intake_signed_at,
          estimated_amount, created_by)
       VALUES ($1,$2,'aberta',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        cid, customer_id, String(reported_issue).trim(),
        equipment_type || null, equipment_brand || null,
        equipment_model || null, equipment_serial || null,
        equipment_condition || null, equipment_accessories || null,
        JSON.stringify(Array.isArray(equipment_photos) ? equipment_photos : []),
        technician_id || null,
        promised_at || null,
        wDays,
        notes || null,
        intake_signature_url || null,
        intake_signature_url ? new Date() : null,
        total.toFixed(2),
        req.user?.id || null,
      ]
    );
    const os = rows[0];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity);
      const price = parseFloat(it.unit_price);
      await client.query(
        `INSERT INTO service_order_items
           (service_order_id, kind, description, product_id,
            quantity, unit_price, total_price, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          os.id, it.kind || 'servico', String(it.description).trim(),
          it.product_id || null, qty, price, (qty * price).toFixed(2),
          it.sort_order != null ? parseInt(it.sort_order, 10) : i,
        ]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ order: await carregarOs(os.id, cid), items: await carregarItens(os.id) });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    falhar(res, err, 'POST');
  } finally {
    if (client) client.release();
  }
});

// ─── GET /service-orders/:osId ───────────────────────────────
router.get('/:osId', async function (req, res) {
  try {
    const os = await carregarOs(req.params.osId, req.params.id);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    res.json({ order: os, items: await carregarItens(os.id) });
  } catch (err) {
    falhar(res, err, 'GET:id');
  }
});

// ─── PATCH /service-orders/:osId ─────────────────────────────
router.patch('/:osId', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};

  try {
    await assertOsEnabled(cid);

    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    if (os.status === 'entregue' || os.status === 'cancelada') {
      return res.status(409).json({
        error: `OS ${os.status} nao pode mais ser editada`,
        code: 'OS_FECHADA',
      });
    }

    if (body.technician_id) {
      const tec = await db.query(
        'SELECT id FROM employees WHERE id = $1 AND company_id = $2',
        [body.technician_id, cid]
      );
      if (!tec.rows.length) {
        return res.status(404).json({ error: 'Tecnico nao encontrado nesta empresa' });
      }
    }
    if (body.warranty_days != null) {
      const w = parseInt(body.warranty_days, 10);
      if (!Number.isFinite(w) || w < 0) {
        return res.status(400).json({ error: 'warranty_days deve ser inteiro >= 0' });
      }
    }
    if ('reported_issue' in body && !String(body.reported_issue || '').trim()) {
      return res.status(400).json({ error: 'reported_issue nao pode ficar vazio' });
    }

    const sets = [];
    const params = [];
    for (const campo of CAMPOS_EDITAVEIS) {
      if (!(campo in body)) continue;
      params.push(body[campo] === '' ? null : body[campo]);
      sets.push(`${campo} = $${params.length}`);
    }
    if (Array.isArray(body.equipment_photos)) {
      params.push(JSON.stringify(body.equipment_photos));
      sets.push(`equipment_photos = $${params.length}::jsonb`);
    }
    // Assinatura de entrada carimba a hora sozinha — quem assina e o cliente
    // no balcao, nao o front escolhendo o timestamp.
    if (body.intake_signature_url && !os.intake_signed_at) {
      sets.push('intake_signed_at = NOW()');
    }
    if (!sets.length) return res.json({ order: os, items: await carregarItens(os.id) });

    params.push(req.params.osId, cid);
    const { rows } = await db.query(
      `UPDATE service_orders SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND company_id = $${params.length}
        RETURNING id`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });

    res.json({ order: await carregarOs(req.params.osId, cid), items: await carregarItens(req.params.osId) });
  } catch (err) {
    falhar(res, err, 'PATCH');
  }
});

// ─── PUT /service-orders/:osId/items ─────────────────────────
// Substitui a lista inteira e recalcula estimated_amount.
router.put('/:osId/items', async function (req, res) {
  const cid = req.params.id;
  const { items } = req.body || {};

  const erroItens = validarItens(items);
  if (erroItens) return res.status(400).json({ error: erroItens });

  let client;
  try {
    await assertOsEnabled(cid);

    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    if (os.status === 'entregue' || os.status === 'cancelada') {
      return res.status(409).json({ error: `OS ${os.status} nao pode mais ser editada`, code: 'OS_FECHADA' });
    }
    // Orcamento aprovado e um acordo, nao um rascunho. Mexer no valor depois
    // que o cliente aprovou tem que passar por nova aprovacao — senao a loja
    // troca o preco por baixo de um "sim" que ja foi dado.
    if (os.approved_at) {
      return res.status(409).json({
        error: 'Orcamento ja aprovado pelo cliente. Reabra a aprovacao antes de alterar os itens.',
        code: 'ORCAMENTO_APROVADO',
      });
    }

    client = await db.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM service_order_items WHERE service_order_id = $1', [os.id]);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity);
      const price = parseFloat(it.unit_price);
      await client.query(
        `INSERT INTO service_order_items
           (service_order_id, kind, description, product_id,
            quantity, unit_price, total_price, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          os.id, it.kind || 'servico', String(it.description).trim(),
          it.product_id || null, qty, price, (qty * price).toFixed(2),
          it.sort_order != null ? parseInt(it.sort_order, 10) : i,
        ]
      );
    }

    await client.query(
      'UPDATE service_orders SET estimated_amount = $1 WHERE id = $2',
      [somaItens(items).toFixed(2), os.id]
    );
    await client.query('COMMIT');

    res.json({ order: await carregarOs(os.id, cid), items: await carregarItens(os.id) });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    falhar(res, err, 'PUT:items');
  } finally {
    if (client) client.release();
  }
});

// ─── POST /service-orders/:osId/approve ──────────────────────
// Cliente aprovou o orcamento. Idempotente: reaprovar nao move a data.
router.post('/:osId/approve', async function (req, res) {
  const cid = req.params.id;
  const { note } = req.body || {};

  try {
    await assertOsEnabled(cid);

    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    if (os.status === 'cancelada') {
      return res.status(409).json({ error: 'OS cancelada nao pode ser aprovada', code: 'OS_FECHADA' });
    }
    if (os.approved_at) {
      return res.json({ order: os, items: await carregarItens(os.id) });
    }

    await db.query(
      `UPDATE service_orders SET approved_at = NOW(), approved_note = $1
        WHERE id = $2 AND company_id = $3`,
      [note || null, os.id, cid]
    );
    res.json({ order: await carregarOs(os.id, cid), items: await carregarItens(os.id) });
  } catch (err) {
    falhar(res, err, 'POST:approve');
  }
});

// ─── POST /service-orders/:osId/status ───────────────────────
// Transicao validada. `entregue` e o unico ponto em que a OS toca numa venda.
router.post('/:osId/status', async function (req, res) {
  const cid = req.params.id;
  const { status, sale_id, pickup_signature_url, cancel_reason, solution } = req.body || {};

  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  try {
    await assertOsEnabled(cid);

    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });

    if (status === os.status) {
      return res.json({ order: os, items: await carregarItens(os.id) });
    }
    if (!TRANSICOES[os.status].includes(status)) {
      return res.status(409).json({
        error: `Transicao invalida: ${os.status} -> ${status}`,
        code: 'TRANSICAO_INVALIDA',
        permitidas: TRANSICOES[os.status],
      });
    }

    const sets = ['status = $1'];
    const params = [status];

    if (status === 'entregue') {
      // sale_id e OPCIONAL: existe entrega sem venda (garantia, retrabalho,
      // cortesia). Ver decisao (b) da migration 313 — por isso status e campo
      // proprio e nao "tem venda => entregue".
      if (sale_id) {
        const venda = await db.query(
          'SELECT id FROM sales WHERE id = $1 AND company_id = $2',
          [sale_id, cid]
        );
        if (!venda.rows.length) {
          return res.status(404).json({ error: 'Venda nao encontrada nesta empresa' });
        }
        params.push(sale_id);
        sets.push(`sale_id = $${params.length}`);
      }
      sets.push('delivered_at = NOW()');
      if (pickup_signature_url) {
        params.push(pickup_signature_url);
        sets.push(`pickup_signature_url = $${params.length}`, 'pickup_signed_at = NOW()');
      }
    }

    if (status === 'cancelada') {
      params.push(cancel_reason || null);
      sets.push(`cancel_reason = $${params.length}`, 'cancelled_at = NOW()');
    }

    // Retrabalho: voltar pra execucao limpa a entrega anterior, senao a OS
    // ficaria "em execucao" carimbada como entregue em algum momento do
    // passado, e o relatorio de prazo mentiria.
    if (status === 'em_execucao' && os.status === 'pronta') {
      sets.push('delivered_at = NULL');
    }

    if (solution != null) {
      params.push(String(solution));
      sets.push(`solution = $${params.length}`);
    }

    params.push(os.id, cid);
    await db.query(
      `UPDATE service_orders SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND company_id = $${params.length}`,
      params
    );

    res.json({ order: await carregarOs(os.id, cid), items: await carregarItens(os.id) });
  } catch (err) {
    falhar(res, err, 'POST:status');
  }
});

// ─── DELETE /service-orders/:osId ────────────────────────────
// So OS recem-aberta e sem venda. Depois que o aparelho entrou em execucao a
// OS e historico do que aconteceu com um bem de terceiro — cancela, nao apaga.
router.delete('/:osId', async function (req, res) {
  const cid = req.params.id;
  try {
    await assertOsEnabled(cid);

    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    if (os.status !== 'aberta' || os.sale_id) {
      return res.status(409).json({
        error: 'So OS aberta e sem venda pode ser excluida. Use o cancelamento.',
        code: 'OS_NAO_EXCLUIVEL',
      });
    }

    await db.query('DELETE FROM service_orders WHERE id = $1 AND company_id = $2', [os.id, cid]);
    res.json({ deleted: true });
  } catch (err) {
    falhar(res, err, 'DELETE');
  }
});

module.exports = router;
module.exports.TRANSICOES = TRANSICOES;
