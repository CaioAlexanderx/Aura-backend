// ============================================================
// AURA. — Preencher custos em massa (conferencia de estoque, 12/11/2026)
// Mount: /companies/:id/products  (ANTES de ./products, que tem /:pid curinga)
//
// Migration 448. Regras puras em src/services/custoEmMassa.js.
// Mockup aprovado: aura-app docs/mockups/conferencia-custo-em-massa.html.
//
//   GET  /cost-fills/contagem?count_id         { todos, desta_conferencia, sem_preco }
//   GET  /cost-fills/pendentes?filtro&count_id&busca&limit&offset
//                                              produtos sem custo da loja
//   POST /cost-fills                           previa (dry_run, padrao) ou gravar
//   GET  /cost-fills?limit&offset              ultimos preenchimentos da loja
//   GET  /cost-fills/:fillId                   um preenchimento com os itens
//   POST /cost-fills/:fillId/undo              desfazer em ate 7 dias
//
// Regras:
//   - POR LOJA (multi-CNPJ): so produto com company_id = :id, como a
//     conferencia. Compartilhado de OUTRA loja do grupo nao entra (volta
//     nao_encontrado); o compartilhado da propria loja entra e a resposta
//     diz em quantas lojas o custo vale (o custo e um so).
//   - "Sem custo" = custo medio e custo nulos ou zero (mesma conta da
//     conferencia); servico (unit 'srv') fica de fora.
//   - Grava SO products.cost_price (2 casas). Nunca recalcula o custo medio,
//     preco, estoque nem codigo.
//   - Gravar: transacao; conferencias em rascunho FOR SHARE e produtos FOR
//     UPDATE (mesma ordem do aplicar da conferencia: conferencia -> produto);
//     a conta e refeita com as linhas travadas. Produto que ganhou custo no
//     meio do caminho (entrada de mercadoria) fica com o custo novo e volta
//     em mudou_no_meio.
//   - Conferencias em RASCUNHO da loja: item com custo_no_bipe nulo desses
//     produtos passa a usar o custo novo, para o valor das diferencas sair
//     completo. Conferencia aplicada nao muda (o lancamento ja foi feito).
//   - Desfazer: 7 dias, uma vez. Volta so o produto cujo custo e custo
//     medio ainda sao os do preenchimento; os outros ficam como estao e
//     voltam em mudou_depois.
//   - audit_log depois do COMMIT.
//
// ACESSO: editar estoque (podeMexer) E ver custo (podeVerCusto). Quem nao
// tem os dois leva 403 em tudo (o app nem mostra a tela). Sem trava de
// plano: a conferencia e Essencial (decisao 4 do mockup).
//
// Antes da migration 448: 503 MIGRATION_PENDING (utils/custoEmMassaSchema).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { logAuditAction, contextoDaRequisicao } = require('../middleware/auditLog');
const { podeMexer } = require('../services/transferenciaDeEstoque');
const { podeVerCusto } = require('../middleware/estoqueSoConsulta');
const { hasCustoEmMassaSchema } = require('../utils/custoEmMassaSchema');
const svc = require('../services/custoEmMassa');

const { ErroDeCusto, UUID_RE, SQL_SEM_CUSTO, SQL_NAO_SERVICO } = svc;

const MSG_PENDENTE = 'O preenchimento de custos fica disponível em alguns minutos. Tente de novo daqui a pouco.';
const MSG_SEM_ACESSO = 'Só quem edita o estoque e vê o custo preenche custos. Peça ao dono da loja.';

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Uma query, so para membro (dono, admin e staff nao chegam a ela).
async function podePreencher(req) {
  if (!req.user || req.user.role === 'admin' || req.companyRole === 'owner' || req.companyRole === 'admin') return true;
  const sql =
    `SELECT (c.owner_id = $2) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE c.id = $1
      LIMIT 1`;
  const params = [req.params.id, req.user.id];
  const { rows } = await (typeof db.queryRetry === 'function' ? db.queryRetry(sql, params) : db.query(sql, params));
  const r = rows[0];
  if (!r) return false;
  const quem = { isOwner: r.is_owner, roleLabel: r.role_label, permissions: lerPermissoes(r.permissions) };
  return podeMexer(quem) && podeVerCusto(quem);
}

// Portao: migration, depois permissao.
router.use('/cost-fills', async (req, res, next) => {
  try {
    if (!(await hasCustoEmMassaSchema(db))) {
      return res.status(503).json({ error: MSG_PENDENTE, code: 'MIGRATION_PENDING' });
    }
    if (!(await podePreencher(req))) {
      return res.status(403).json({ error: MSG_SEM_ACESSO, code: 'SEM_PERMISSAO_DE_CUSTO' });
    }
    return next();
  } catch (err) {
    console.error('[costFills] acesso:', err && err.message);
    return res.status(503).json({ error: 'Instabilidade momentânea de conexão. Tente novamente.', code: 'DB_CONN_TRANSIENT' });
  }
});

function tratarErro(res, err, onde) {
  if (err instanceof ErroDeCusto) return res.status(err.status).json(err.body);
  if (err && (err.code === '42P01' || err.code === '42703')) {
    return res.status(503).json({ error: MSG_PENDENTE, code: 'MIGRATION_PENDING' });
  }
  if (err && (err.code === '40P01' || err.code === '40001' || err.code === '55P03')) {
    return res.status(409).json({ error: 'Os produtos mudaram enquanto os custos eram gravados. Tente de novo.', code: 'TENTE_DE_NOVO' });
  }
  console.error(`[costFills] ${onde}:`, err && err.message, err && err.code);
  return res.status(500).json({ error: 'Não deu para concluir agora. Tente de novo em instantes.' });
}

const cid = (req) => String(req.params.id).toLowerCase();
const uid = (req) => (req.user && req.user.id) || null;
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function lojasDoGrupo(q, companyId) {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $1
      )`,
    [companyId]
  );
  return rows[0] ? rows[0].n || 1 : 1;
}

// Itens da conferencia que ficaram fora da conta do valor: com diferenca e
// sem custo no bipe (mesma conta de services/conferenciaDeEstoque.diferencas).
// `n` = numero do parametro do count_id ($1 e sempre a loja).
function sqlDaConferencia(n) {
  return 'p.id IN (SELECT i.product_id FROM stock_count_items i' +
    ' JOIN stock_counts sc ON sc.id = i.stock_count_id AND sc.company_id = $1' +
    ` WHERE i.stock_count_id = $${n} AND i.custo_no_bipe IS NULL` +
    ' AND (CASE WHEN i.nao_contado THEN COALESCE(i.diferenca_aplicada, 0) ELSE i.contado - i.estoque_no_bipe END) <> 0)';
}

const SQL_BASE = `p.company_id = $1 AND p.is_active = true AND ${SQL_NAO_SERVICO} AND ${SQL_SEM_CUSTO}`;

function lerCountId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (!UUID_RE.test(s)) throw new ErroDeCusto(400, 'PEDIDO_INVALIDO', 'count_id inválido.');
  return s;
}

async function contagens(q, companyId, countId) {
  const { rows: [c] } = await q(
    `SELECT COUNT(*) FILTER (WHERE ${SQL_SEM_CUSTO})::int AS todos,
            COUNT(*) FILTER (WHERE ${SQL_SEM_CUSTO} AND COALESCE(p.price, 0) <= 0)::int AS sem_preco,
            ${countId ? `COUNT(*) FILTER (WHERE ${SQL_SEM_CUSTO} AND ${sqlDaConferencia(2)})::int` : 'NULL::int'} AS desta_conferencia,
            COUNT(*)::int AS produtos
       FROM products p
      WHERE p.company_id = $1 AND p.is_active = true AND ${SQL_NAO_SERVICO}`,
    countId ? [companyId, countId] : [companyId]
  );
  // `produtos`: ativos da loja que entram na conta (sem servico), para o
  // "Os N produtos da loja tem custo" da tela vazia.
  return { todos: c.todos, desta_conferencia: c.desta_conferencia, sem_preco: c.sem_preco, produtos: c.produtos };
}

// ─── GET /cost-fills/contagem ─────────────────────────────
router.get('/cost-fills/contagem', async (req, res) => {
  try {
    const countId = lerCountId(req.query.count_id);
    return res.json(await contagens((s, p) => db.query(s, p), cid(req), countId));
  } catch (err) { return tratarErro(res, err, 'contagem'); }
});

// ─── GET /cost-fills/pendentes ────────────────────────────
const FILTROS = ['todos', 'conferencia', 'sem_preco'];

router.get('/cost-fills/pendentes', async (req, res) => {
  try {
    const companyId = cid(req);
    const countId = lerCountId(req.query.count_id);
    const filtro = req.query.filtro ? String(req.query.filtro) : 'todos';
    if (!FILTROS.includes(filtro)) throw new ErroDeCusto(400, 'PEDIDO_INVALIDO', 'filtro deve ser todos, conferencia ou sem_preco.');
    if (filtro === 'conferencia' && !countId) throw new ErroDeCusto(400, 'PEDIDO_INVALIDO', 'O filtro da conferência precisa do count_id.');
    const lim = parseInt(req.query.limit, 10);
    const limit = Math.min(Number.isFinite(lim) && lim >= 0 ? lim : 50, 200);
    const off = parseInt(req.query.offset, 10);
    const offset = Number.isFinite(off) && off > 0 ? off : 0;
    const busca = String(req.query.busca || '').trim().slice(0, 100);

    const params = [companyId];
    let where = SQL_BASE;
    if (filtro === 'conferencia') {
      params.push(countId);
      where += ` AND ${sqlDaConferencia(params.length)}`;
    }
    if (filtro === 'sem_preco') where += ' AND COALESCE(p.price, 0) <= 0';
    if (busca) {
      params.push(`%${busca.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const n = params.length;
      where += ` AND (p.name ILIKE $${n} OR p.sku ILIKE $${n} OR p.barcode ILIKE $${n})`;
    }
    const nL = params.length + 1;
    const nO = params.length + 2;

    const q = (s, p) => db.query(s, p);
    const { rows } = await q(
      `SELECT p.id, p.name, p.sku, p.barcode, p.price, p.is_group_shared,
              v.n AS variantes, v.preco_min, v.preco_max
         FROM products p
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS n,
                  MIN(COALESCE(pv.price_override, p.price)) AS preco_min,
                  MAX(COALESCE(pv.price_override, p.price)) AS preco_max
             FROM product_variants pv
            WHERE pv.product_id = p.id AND pv.is_active = true
         ) v ON true
        WHERE ${where}
        ORDER BY p.name ASC, p.id
        LIMIT $${nL} OFFSET $${nO}`,
      [...params, limit, offset]
    );
    const { rows: [t] } = await q(`SELECT COUNT(*)::int AS n FROM products p WHERE ${where}`, params);
    const total = t ? t.n : rows.length;
    const grupo = await lojasDoGrupo(q, companyId);
    const conts = await contagens(q, companyId, countId);
    const { rows: ult } = await q(
      `SELECT shortcut_mode, shortcut_percent FROM product_cost_fills
        WHERE company_id = $1 AND shortcut_mode IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [companyId]
    );
    return res.json({
      itens: rows.map((r) => {
        const variantes = r.variantes || 0;
        const min = num(r.preco_min);
        const max = num(r.preco_max);
        const varia = variantes > 0 && min !== null && max !== null && min !== max;
        return {
          product_id: r.id,
          nome: r.name,
          codigo: (r.barcode && String(r.barcode).trim()) || (r.sku && String(r.sku).trim()) || null,
          preco: num(r.price) && num(r.price) > 0 ? num(r.price) : null,
          preco_min: varia ? min : null,
          preco_max: varia ? max : null,
          variantes,
          compartilhado: r.is_group_shared === true,
          lojas: r.is_group_shared === true ? grupo : 1,
        };
      }),
      total,
      limit,
      offset,
      filtro,
      contagens: conts,
      lojas_do_grupo: grupo,
      ultimo_atalho: ult[0]
        ? { modo: ult[0].shortcut_mode, percentual: num(ult[0].shortcut_percent) }
        : null,
    });
  } catch (err) { return tratarErro(res, err, 'pendentes'); }
});

// ─── POST /cost-fills ─────────────────────────────────────
async function lerProdutos(q, companyId, ids, travar) {
  const { rows } = await q(
    `SELECT p.id, p.name, p.price, p.cost_price, p.weighted_avg_cost, p.is_group_shared, p.unit, p.is_active
       FROM products p
      WHERE p.company_id = $1 AND p.id = ANY($2::uuid[])
      ORDER BY p.id
      ${travar ? 'FOR UPDATE OF p' : ''}`,
    [companyId, ids]
  );
  return rows;
}

function resposta(pedido, previa, extra = {}) {
  return {
    dry_run: pedido.dryRun,
    fill_id: null,
    atalho: pedido.atalho,
    count_id: pedido.countId,
    resumo: previa.resumo,
    itens: previa.itens.map(svc.itemPublico),
    ...extra,
  };
}

router.post('/cost-fills', async (req, res) => {
  const companyId = cid(req);
  let pedido;
  try { pedido = svc.lerPedido(req.body); } catch (e) { return tratarErro(res, e, 'pedido'); }
  const ids = pedido.itens.map((i) => i.productId);

  if (pedido.dryRun) {
    try {
      const q = (s, p) => db.query(s, p);
      const grupo = await lojasDoGrupo(q, companyId);
      const produtos = await lerProdutos(q, companyId, ids, false);
      return res.json(resposta(pedido, svc.montarPrevia({ produtos, pedido, lojasDoGrupo: grupo })));
    } catch (err) { return tratarErro(res, err, 'previa'); }
  }

  const client = await db.connect();
  let previa;
  let fill = null;
  let atualizados = 0;
  try {
    await client.query('BEGIN');
    const q = (s, p) => client.query(s, p);
    const grupo = await lojasDoGrupo(q, companyId);

    // 1. conferencias em rascunho que vao receber o custo (FOR SHARE: o
    //    aplicar da conferencia trava FOR UPDATE e espera, ou nos esperamos).
    const { rows: rascunhos } = await q(
      `SELECT sc.id FROM stock_counts sc
        WHERE sc.company_id = $1 AND sc.status = 'rascunho'
          AND EXISTS (SELECT 1 FROM stock_count_items i
                       WHERE i.stock_count_id = sc.id AND i.product_id = ANY($2::uuid[]) AND i.custo_no_bipe IS NULL)
        ORDER BY sc.id
        FOR SHARE OF sc`,
      [companyId, ids]
    );

    // 2. produtos travados e a conta refeita com eles.
    const produtos = await lerProdutos(q, companyId, ids, true);
    previa = svc.montarPrevia({ produtos, pedido, lojasDoGrupo: grupo });
    const grava = previa.itens.filter((i) => i.status === 'grava');
    if (grava.length === 0) {
      await client.query('ROLLBACK');
      return res.json(resposta(pedido, previa));
    }

    const s = previa.resumo;
    const { rows: [lote] } = await q(
      `INSERT INTO product_cost_fills
         (company_id, user_id, shortcut_mode, shortcut_percent, stock_count_id,
          products_count, typed_count, suggested_count, same_count, group_shared_count, changed_midway_count)
       VALUES ($1, $2, $3, $4,
               (SELECT id FROM stock_counts WHERE id = $5::uuid AND company_id = $1),
               $6, $7, $8, $9, $10, $11)
       RETURNING id, created_at, undo_deadline`,
      [companyId, uid(req), pedido.atalho ? pedido.atalho.modo : null, pedido.atalho ? pedido.atalho.percentual : null,
        pedido.countId, s.gravar, s.digitados, s.sugeridos, s.mesmo, s.compartilhados, s.mudou_no_meio]
    );
    fill = lote;

    // 3. so o custo.
    await q(
      `UPDATE products p
          SET cost_price = v.custo, updated_at = NOW()
         FROM unnest($1::uuid[], $2::numeric[]) AS v(id, custo)
        WHERE p.id = v.id AND p.company_id = $3`,
      [grava.map((i) => i.product_id), grava.map((i) => i._custoCentavos / 100), companyId]
    );

    // 4. itens das conferencias em rascunho sem custo no bipe.
    const porProduto = new Map();
    if (rascunhos.length) {
      const { rows: tocados } = await q(
        `UPDATE stock_count_items i
            SET custo_no_bipe = v.custo
           FROM unnest($1::uuid[], $2::numeric[]) AS v(id, custo)
          WHERE i.product_id = v.id AND i.custo_no_bipe IS NULL
            AND i.stock_count_id = ANY($3::uuid[])
         RETURNING i.id, i.product_id`,
        [grava.map((i) => i.product_id), grava.map((i) => i._custoCentavos / 100), rascunhos.map((r) => r.id)]
      );
      atualizados = tocados.length;
      for (const t of tocados) {
        const k = String(t.product_id).toLowerCase();
        if (!porProduto.has(k)) porProduto.set(k, []);
        porProduto.get(k).push(t.id);
      }
      if (atualizados) {
        await q(`UPDATE stock_counts SET updated_at = NOW() WHERE id = ANY($1::uuid[])`, [rascunhos.map((r) => r.id)]);
      }
    }

    await q(
      `INSERT INTO product_cost_fill_items
         (fill_id, product_id, name, origin, group_shared, price, cost_before, cost_after,
          weighted_avg_before, stock_count_item_ids)
       SELECT $1, v.pid, v.nome, v.origem, v.grp, v.preco, v.antes, v.depois, v.medio,
              COALESCE(string_to_array(NULLIF(v.itens, ''), ',')::uuid[], '{}'::uuid[])
         FROM unnest($2::uuid[], $3::text[], $4::text[], $5::boolean[], $6::numeric[], $7::numeric[],
                     $8::numeric[], $9::numeric[], $10::text[])
           AS v(pid, nome, origem, grp, preco, antes, depois, medio, itens)`,
      [fill.id,
        grava.map((i) => i.product_id), grava.map((i) => i.nome), grava.map((i) => i.origem),
        grava.map((i) => i.compartilhado), grava.map((i) => i.preco), grava.map((i) => i.custo_antes),
        grava.map((i) => i._custoCentavos / 100), grava.map((i) => i._medioAntes),
        grava.map((i) => (porProduto.get(i.product_id) || []).join(','))]
    );
    await q(`UPDATE product_cost_fills SET count_items_updated = $2 WHERE id = $1`, [fill.id, atualizados]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return tratarErro(res, err, 'gravar');
  } finally {
    if (client.release) client.release();
  }

  const s = previa.resumo;
  logAuditAction(
    uid(req), companyId, 'products.cost_filled',
    `Preencheu o custo de ${s.gravar} produtos`,
    {
      fill_id: fill.id, produtos: s.gravar, digitados: s.digitados, sugeridos: s.sugeridos, mesmo: s.mesmo,
      atalho: pedido.atalho, compartilhados: s.compartilhados, mudou_no_meio: s.mudou_no_meio,
      count_id: pedido.countId, itens_de_conferencia: atualizados,
    },
    contextoDaRequisicao(req)
  );

  return res.json(resposta(pedido, previa, {
    fill_id: fill.id,
    created_at: fill.created_at,
    undo_deadline: fill.undo_deadline,
    itens_de_conferencia_atualizados: atualizados,
  }));
});

// ─── historico ────────────────────────────────────────────
const LOTE_SELECT = `
  SELECT f.*, u.full_name AS user_name, ud.full_name AS undone_by_name, sc.numero AS count_numero,
         (f.undone_at IS NULL AND f.undo_deadline > NOW()) AS can_undo
    FROM product_cost_fills f
    LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN users ud ON ud.id = f.undone_by
    LEFT JOIN stock_counts sc ON sc.id = f.stock_count_id`;

function loteOut(r) {
  return {
    id: r.id,
    criado_em: r.created_at,
    por: r.user_id ? { id: r.user_id, nome: r.user_name || null } : null,
    atalho: r.shortcut_mode ? { modo: r.shortcut_mode, percentual: num(r.shortcut_percent) } : null,
    conferencia: r.stock_count_id ? { id: r.stock_count_id, numero: r.count_numero } : null,
    produtos: r.products_count,
    digitados: r.typed_count,
    sugeridos: r.suggested_count,
    mesmo: r.same_count,
    compartilhados: r.group_shared_count,
    mudou_no_meio: r.changed_midway_count,
    itens_de_conferencia_atualizados: r.count_items_updated,
    desfazer_ate: r.undo_deadline,
    pode_desfazer: !!r.can_undo,
    desfeito_em: r.undone_at,
    desfeito_por: r.undone_by ? { id: r.undone_by, nome: r.undone_by_name || null } : null,
    desfeitos: r.undo_restored_count,
    mudaram_depois: r.undo_changed_count,
  };
}

// ─── GET /cost-fills ──────────────────────────────────────
router.get('/cost-fills', async (req, res) => {
  const lim = parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isFinite(lim) && lim > 0 ? lim : 20, 100);
  const off = parseInt(req.query.offset, 10);
  const offset = Number.isFinite(off) && off > 0 ? off : 0;
  try {
    const { rows } = await db.query(
      `${LOTE_SELECT} WHERE f.company_id = $1 ORDER BY f.created_at DESC, f.id LIMIT $2 OFFSET $3`,
      [cid(req), limit, offset]
    );
    const { rows: [t] } = await db.query(
      `SELECT COUNT(*)::int AS total FROM product_cost_fills WHERE company_id = $1`, [cid(req)]
    );
    return res.json({ preenchimentos: rows.map(loteOut), total: t ? t.total : rows.length });
  } catch (err) { return tratarErro(res, err, 'lista'); }
});

// ─── GET /cost-fills/:fillId ──────────────────────────────
const naoAchado = () => new ErroDeCusto(404, 'NAO_ENCONTRADO', 'Não achamos esse preenchimento nesta loja.');

router.get('/cost-fills/:fillId', async (req, res) => {
  const { fillId } = req.params;
  try {
    if (!UUID_RE.test(String(fillId))) throw naoAchado();
    const { rows: [lote] } = await db.query(`${LOTE_SELECT} WHERE f.id = $1 AND f.company_id = $2`, [fillId, cid(req)]);
    if (!lote) throw naoAchado();
    const { rows: itens } = await db.query(
      `SELECT it.product_id, it.name, it.origin, it.group_shared, it.price, it.cost_before, it.cost_after,
              it.undo_status, p.cost_price AS cost_now
         FROM product_cost_fill_items it
         LEFT JOIN products p ON p.id = it.product_id
        WHERE it.fill_id = $1
        ORDER BY it.name, it.id`,
      [fillId]
    );
    return res.json({
      ...loteOut(lote),
      itens: itens.map((i) => ({
        product_id: i.product_id,
        nome: i.name,
        origem: i.origin,
        compartilhado: i.group_shared,
        preco: num(i.price),
        custo_antes: num(i.cost_before),
        custo_depois: num(i.cost_after),
        custo_agora: num(i.cost_now),
        desfazer: i.undo_status === 'restored' ? 'desfeito' : (i.undo_status === 'changed_after' ? 'mudou_depois' : null),
      })),
    });
  } catch (err) { return tratarErro(res, err, 'detalhe'); }
});

// ─── POST /cost-fills/:fillId/undo ────────────────────────
router.post('/cost-fills/:fillId/undo', async (req, res) => {
  const companyId = cid(req);
  const { fillId } = req.params;
  if (!UUID_RE.test(String(fillId))) return tratarErro(res, naoAchado(), 'desfazer');

  const client = await db.connect();
  let resultado;
  try {
    await client.query('BEGIN');
    const q = (s, p) => client.query(s, p);

    const { rows: [lote] } = await q(
      `SELECT id, undone_at, undo_deadline, undo_deadline > NOW() AS dentro_do_prazo
         FROM product_cost_fills
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [fillId, companyId]
    );
    if (!lote) throw naoAchado();
    if (lote.undone_at) {
      throw new ErroDeCusto(409, 'JA_DESFEITO', 'Este preenchimento já foi desfeito.', { desfeito_em: lote.undone_at });
    }
    if (!lote.dentro_do_prazo) {
      throw new ErroDeCusto(410, 'PRAZO_ENCERRADO', 'O prazo para desfazer (7 dias) já passou.', { desfazer_ate: lote.undo_deadline });
    }

    const { rows: itens } = await q(
      `SELECT id, product_id, name, cost_before, cost_after, weighted_avg_before, stock_count_item_ids
         FROM product_cost_fill_items WHERE fill_id = $1
        ORDER BY name, id`,
      [fillId]
    );
    const pids = [...new Set(itens.map((i) => String(i.product_id)))];
    const itensDeConferencia = [...new Set(itens.flatMap((i) => i.stock_count_item_ids || []).map(String))];

    // Mesma ordem do gravar: conferencias em rascunho, depois produtos.
    const { rows: rascunhos } = itensDeConferencia.length ? await q(
      `SELECT sc.id FROM stock_counts sc
        WHERE sc.company_id = $1 AND sc.status = 'rascunho'
          AND sc.id IN (SELECT stock_count_id FROM stock_count_items WHERE id = ANY($2::uuid[]))
        ORDER BY sc.id
        FOR SHARE OF sc`,
      [companyId, itensDeConferencia]
    ) : { rows: [] };
    const { rows: prods } = pids.length ? await q(
      `SELECT p.id, p.cost_price, p.weighted_avg_cost FROM products p
        WHERE p.company_id = $1 AND p.id = ANY($2::uuid[])
        ORDER BY p.id
        FOR UPDATE OF p`,
      [companyId, pids]
    ) : { rows: [] };
    const porId = new Map(prods.map((p) => [String(p.id).toLowerCase(), p]));

    const voltam = [];
    const mudaram = [];
    for (const i of itens) {
      const atual = porId.get(String(i.product_id).toLowerCase());
      const motivo = svc.mudouDepois(i, atual);
      if (motivo) {
        mudaram.push({
          item_id: i.id, product_id: i.product_id, nome: i.name,
          custo_gravado: num(i.cost_after), custo_agora: atual ? num(atual.cost_price) : null,
          motivo: motivo === 'not_found' ? 'nao_encontrado' : 'mudou',
        });
      } else {
        voltam.push(i);
      }
    }

    if (voltam.length) {
      await q(
        `UPDATE products p
            SET cost_price = v.antes, updated_at = NOW()
           FROM unnest($1::uuid[], $2::numeric[]) AS v(id, antes)
          WHERE p.id = v.id AND p.company_id = $3`,
        [voltam.map((i) => i.product_id), voltam.map((i) => i.cost_before), companyId]
      );
      await q(`UPDATE product_cost_fill_items SET undo_status = 'restored' WHERE id = ANY($1::uuid[])`,
        [voltam.map((i) => i.id)]);
      // Item de conferencia em rascunho volta a ficar sem custo no bipe,
      // so se ainda tem o custo que o preenchimento colocou.
      const pares = voltam.flatMap((i) => (i.stock_count_item_ids || []).map((x) => [x, i.cost_after]));
      if (pares.length && rascunhos.length) {
        await q(
          `UPDATE stock_count_items i
              SET custo_no_bipe = NULL
             FROM unnest($1::uuid[], $2::numeric[]) AS v(id, custo)
            WHERE i.id = v.id AND i.custo_no_bipe = v.custo
              AND i.stock_count_id = ANY($3::uuid[])`,
          [pares.map((x) => x[0]), pares.map((x) => x[1]), rascunhos.map((r) => r.id)]
        );
      }
    }
    if (mudaram.length) {
      await q(`UPDATE product_cost_fill_items SET undo_status = 'changed_after' WHERE id = ANY($1::uuid[])`,
        [mudaram.map((i) => i.item_id)]);
    }
    const { rows: [fechado] } = await q(
      `UPDATE product_cost_fills
          SET undone_at = NOW(), undone_by = $2, undo_restored_count = $3, undo_changed_count = $4
        WHERE id = $1
        RETURNING undone_at`,
      [fillId, uid(req), voltam.length, mudaram.length]
    );
    await client.query('COMMIT');

    resultado = {
      fill_id: fillId,
      desfeito_em: fechado.undone_at,
      desfeitos: voltam.length,
      mudaram_depois: mudaram.length,
      voltaram: voltam.map((i) => ({ product_id: i.product_id, nome: i.name })),
      mudou_depois: mudaram.map(({ item_id, ...resto }) => resto),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return tratarErro(res, err, 'desfazer');
  } finally {
    if (client.release) client.release();
  }

  logAuditAction(
    uid(req), companyId, 'products.cost_fill_undone',
    `Desfez preenchimento de custo: ${resultado.desfeitos} voltaram, ${resultado.mudaram_depois} mudaram depois`,
    { fill_id: fillId, desfeitos: resultado.desfeitos, mudaram_depois: resultado.mudaram_depois },
    contextoDaRequisicao(req)
  );
  return res.json(resultado);
});

module.exports = router;
