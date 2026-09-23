// ============================================================
// AURA. — Matcon M3: Profissionais Parceiros
//
// Montado em private.js sob /matcon/professionals. Schema: migration 353.
// Contrato: aura-app docs/CONTRACT_MATCON.md (M3); o client que esta rota
// espelha e aura-app services/matconApi.ts (Professional, ProfessionalDetail,
// ProfessionalListResponse).
//
// GET    /matcon/professionals?filter=active|inactive_60d|new|all&q=
//                                           → {professionals, summary}
// GET    /matcon/professionals/search?q=    → {professionals} (chip do Caixa)
// POST   /matcon/professionals              → 201 {professional}
// GET    /matcon/professionals/:pid         → {professional, ledger, last_referrals}
// PATCH  /matcon/professionals/:pid         → {professional}
// POST   /matcon/professionals/:pid/redeem  → {coupon_code, points_balance, coupon}
//
// GATE: pdv_settings.matcon_enabled lido do BANCO (o JWT nunca revalida) e
// so na ESCRITA — desligar o Matcon nao pode esconder da loja os pontos
// que os parceiros ja juntaram. Mesmo desenho do assertOticaEnabled.
// matcon_club_enabled NAO bloqueia aqui: ele desliga o chip do Caixa e o
// credito de pontos (src/services/matconProfessionals.js); resgatar o que
// ja foi ganho continua possivel.
//
// Multi-CNPJ: clientes sao do dono (qualquer loja dele), mas o parceiro e
// vinculo de UM cliente com UMA loja — tudo aqui filtra pela empresa da URL.
//
// Os pontos da VENDA indicada nao passam por aqui: creditReferredSale /
// reverseReferredSale no servico, chamados pela venda.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');
const { TRADES, loadClubSettings } = require('../services/matconProfessionals');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTERS = ['active', 'inactive_60d', 'new', 'all'];
const LIST_LIMIT = 500;
const SEARCH_LIMIT = 10;

// Inicio do mes no fuso da loja (Brasil), como timestamptz.
const MONTH_START_SQL = "(date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')";

// ─── Gate do modulo ──────────────────────────────────────────
function erroMatconDesligado() {
  const err = new Error('O módulo de material de construção está desligado. Ligue em Configurações para mexer nos parceiros.');
  err.status = 403;
  err.code = 'MATCON_DISABLED';
  return err;
}

async function assertMatconEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'matcon_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) {
    const err = new Error('Empresa não encontrada');
    err.status = 404;
    throw err;
  }
  if (rows[0].enabled !== 'true') throw erroMatconDesligado();
}

function falhar(res, err, contexto) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  // Migration 353 ainda nao aplicada: diz o que e, sem 500 generico.
  if (err && (err.code === '42P01' || err.code === '42703')) {
    return res.status(503).json({ error: 'Profissionais parceiros ainda não estão disponíveis nesta loja.', code: 'MATCON_SCHEMA_MISSING' });
  }
  console.error(`[matconProfessionals:${contexto}]`, err && err.message);
  return res.status(500).json({ error: 'Não deu para carregar os profissionais parceiros. Tente de novo.' });
}

// ─── Forma da resposta (espelha Professional do matconApi.ts) ─
const SELECT_PROFESSIONAL = `
  SELECT p.id, p.customer_id, cu.name AS customer_name, cu.phone AS customer_phone,
         p.trade, p.points_balance, p.points_earned_total, p.referrals_count,
         p.referred_sales_total, p.last_referral_at, p.active, p.created_at
    FROM matcon_professionals p
    JOIN customers cu ON cu.id = p.customer_id`;

function toProfessional(r) {
  return {
    id: r.id,
    customer_id: r.customer_id,
    customer_name: r.customer_name || '',
    customer_phone: r.customer_phone || null,
    trade: r.trade,
    points_balance: Number(r.points_balance) || 0,
    points_earned_total: Number(r.points_earned_total) || 0,
    referrals_count: Number(r.referrals_count) || 0,
    referred_sales_total: Number(r.referred_sales_total) || 0,
    last_referral_at: r.last_referral_at || null,
    active: r.active !== false,
    created_at: r.created_at,
  };
}

async function fetchProfessional(q, companyId, pid) {
  const { rows } = await q.query(
    `${SELECT_PROFESSIONAL} WHERE p.id = $1 AND p.company_id = $2`,
    [pid, companyId]
  );
  return rows.length ? toProfessional(rows[0]) : null;
}

// Busca por nome OU telefone. Telefone compara so digitos (o lojista digita
// "11 9 8765", o cadastro tem "(11) 98765-4321").
function buildSearch(q, params) {
  const termo = String(q || '').trim().slice(0, 80);
  if (!termo) return '';
  params.push(`%${termo}%`);
  const nameIdx = params.length;
  const digits = termo.replace(/\D/g, '');
  if (digits.length >= 3) {
    params.push(`%${digits}%`);
    return ` AND (cu.name ILIKE $${nameIdx} OR regexp_replace(COALESCE(cu.phone, ''), '\\D', '', 'g') LIKE $${params.length})`;
  }
  return ` AND cu.name ILIKE $${nameIdx}`;
}

// ─── GET / ── ranking + resumo do mes ────────────────────────
router.get('/', async function (req, res) {
  const cid = req.params.id;
  const filter = FILTERS.includes(String(req.query.filter || '')) ? String(req.query.filter) : 'all';

  try {
    const settings = await loadClubSettings(db, cid);
    if (!settings) return res.status(404).json({ error: 'Empresa não encontrada' });

    const params = [cid];
    let where = 'WHERE p.company_id = $1';
    if (filter === 'active') {
      where += ' AND p.active = true';
    } else if (filter === 'inactive_60d') {
      // "Sem compra ha 60 dias": parceiro ativo cuja ultima indicacao (ou a
      // marcacao, se nunca indicou) tem mais de 60 dias. Desativado nao
      // entra — nao faz sentido "chamar de volta" quem a loja desligou.
      where += " AND p.active = true AND COALESCE(p.last_referral_at, p.created_at) < NOW() - INTERVAL '60 days'";
    } else if (filter === 'new') {
      where += " AND p.created_at >= NOW() - INTERVAL '30 days'";
    }
    where += buildSearch(req.query.q, params);

    // Ranking do mes: quem mais trouxe venda este mes primeiro; depois
    // saldo (quem tem cupom pra gerar) e nome.
    const list = await db.query(
      `SELECT p.id, p.customer_id, cu.name AS customer_name, cu.phone AS customer_phone,
              p.trade, p.points_balance, p.points_earned_total, p.referrals_count,
              p.referred_sales_total, p.last_referral_at, p.active, p.created_at,
              COALESCE(m.total, 0) AS referred_total_month
         FROM matcon_professionals p
         JOIN customers cu ON cu.id = p.customer_id
         LEFT JOIN LATERAL (
           SELECT SUM(s.total_amount) AS total
             FROM sales s
            WHERE s.referred_by_professional_id = p.id
              AND s.company_id = p.company_id
              AND COALESCE(s.status, 'completed') <> 'cancelled'
              AND s.created_at >= ${MONTH_START_SQL}
         ) m ON true
        ${where}
        ORDER BY p.active DESC, referred_total_month DESC, p.points_balance DESC, cu.name ASC
        LIMIT ${LIST_LIMIT}`,
      params
    );

    // Resumo da loja inteira — nao depende do filtro nem da busca.
    const summary = await db.query(
      `SELECT
         (SELECT COALESCE(SUM(s.total_amount), 0)
            FROM sales s
            JOIN matcon_professionals p ON p.id = s.referred_by_professional_id
           WHERE s.company_id = $1 AND p.company_id = $1
             AND COALESCE(s.status, 'completed') <> 'cancelled'
             AND s.created_at >= ${MONTH_START_SQL}) AS referred_total_month,
         (SELECT COUNT(*) FROM matcon_professionals
           WHERE company_id = $1 AND active = true) AS active_count,
         (SELECT COUNT(*) FROM matcon_professionals
           WHERE company_id = $1 AND active = true AND points_balance >= $2) AS pending_redeems`,
      [cid, settings.matcon_points_to_coupon]
    );
    const sm = summary.rows[0] || {};

    res.json({
      professionals: list.rows.map((r) => ({
        ...toProfessional(r),
        // Aditivo (fora do tipo do front): quanto ele trouxe este mes.
        referred_total_month: Number(r.referred_total_month) || 0,
      })),
      summary: {
        referred_total_month: Number(sm.referred_total_month) || 0,
        active_count: Number(sm.active_count) || 0,
        pending_redeems: Number(sm.pending_redeems) || 0,
      },
    });
  } catch (err) {
    if (err && err.code === '42P01') {
      return res.json({ professionals: [], summary: { referred_total_month: 0, active_count: 0, pending_redeems: 0 } });
    }
    falhar(res, err, 'GET:list');
  }
});

// ─── GET /search ── chip "Indicado por" do Caixa ─────────────
// Antes de /:pid: rota estatica antes da parametrica.
router.get('/search', async function (req, res) {
  const cid = req.params.id;
  const termo = String(req.query.q || '').trim();
  if (!termo) return res.json({ professionals: [] });

  try {
    const params = [cid];
    const where = 'WHERE p.company_id = $1 AND p.active = true' + buildSearch(termo, params);
    const { rows } = await db.query(
      `${SELECT_PROFESSIONAL}
        ${where}
        ORDER BY p.last_referral_at DESC NULLS LAST, cu.name ASC
        LIMIT ${SEARCH_LIMIT}`,
      params
    );
    res.json({ professionals: rows.map(toProfessional) });
  } catch (err) {
    if (err && err.code === '42P01') return res.json({ professionals: [] });
    falhar(res, err, 'GET:search');
  }
});

// ─── POST / ── marca o cliente como parceiro ─────────────────
router.post('/', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};
  const customerId = String(body.customer_id || '');
  const trade = String(body.trade || '');

  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'Escolha o cliente que vai virar parceiro.' });
  if (!TRADES.includes(trade)) return res.status(400).json({ error: 'Escolha a profissão do parceiro.' });

  try {
    await assertMatconEnabled(cid);

    // Cliente de qualquer loja do mesmo dono (lista de clientes e unica).
    const ownerIds = await getOwnerScopedCompanyIds(cid);
    const cust = await db.query(
      'SELECT id FROM customers WHERE id = $1 AND company_id = ANY($2)',
      [customerId, ownerIds]
    );
    if (!cust.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const ins = await db.query(
      `INSERT INTO matcon_professionals (company_id, customer_id, trade)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, customer_id) DO NOTHING
       RETURNING id`,
      [cid, customerId, trade]
    );

    if (!ins.rows.length) {
      const existing = await db.query(
        'SELECT id, active FROM matcon_professionals WHERE company_id = $1 AND customer_id = $2',
        [cid, customerId]
      );
      const ex = existing.rows[0];
      if (ex && ex.active === false) {
        // Parceiro desligado antes: marcar de novo reativa, com saldo e
        // historico intactos (a ficha nao mostra parceiro desativado, entao
        // o "Marcar como parceiro" e o caminho natural de volta).
        await db.query(
          `UPDATE matcon_professionals SET active = true, trade = $1, updated_at = NOW()
            WHERE id = $2 AND company_id = $3`,
          [trade, ex.id, cid]
        );
        return res.json({ professional: await fetchProfessional(db, cid, ex.id), reactivated: true });
      }
      return res.status(409).json({
        error: 'Este cliente já é profissional parceiro da loja.',
        code: 'ALREADY_PROFESSIONAL',
        professional: ex ? await fetchProfessional(db, cid, ex.id) : null,
      });
    }

    res.status(201).json({ professional: await fetchProfessional(db, cid, ins.rows[0].id) });
  } catch (err) {
    falhar(res, err, 'POST');
  }
});

// ─── GET /:pid ── ficha + extrato + ultimas indicacoes ───────
router.get('/:pid', async function (req, res) {
  const { id: cid, pid } = req.params;
  if (!UUID_RE.test(pid)) return res.status(404).json({ error: 'Parceiro não encontrado.' });

  try {
    const professional = await fetchProfessional(db, cid, pid);
    if (!professional) return res.status(404).json({ error: 'Parceiro não encontrado.' });

    // delta 0 = venda indicada abaixo de R$ 100: conta como indicacao, mas
    // no extrato de pontos seria uma linha "+0" sem sentido.
    const ledger = await db.query(
      `SELECT id, sale_id, delta, reason, created_at
         FROM matcon_professional_points_ledger
        WHERE professional_id = $1 AND company_id = $2 AND delta <> 0
        ORDER BY created_at DESC
        LIMIT 20`,
      [pid, cid]
    );

    const referrals = await db.query(
      `SELECT s.id AS sale_id, cu.name AS customer_name, s.total_amount, s.created_at
         FROM sales s
         LEFT JOIN customers cu ON cu.id = s.customer_id
        WHERE s.referred_by_professional_id = $1 AND s.company_id = $2
          AND COALESCE(s.status, 'completed') <> 'cancelled'
        ORDER BY s.created_at DESC
        LIMIT 10`,
      [pid, cid]
    );

    res.json({
      professional,
      ledger: ledger.rows.map((r) => ({
        id: r.id,
        sale_id: r.sale_id || null,
        delta: Number(r.delta) || 0,
        reason: r.reason,
        created_at: r.created_at,
      })),
      last_referrals: referrals.rows.map((r) => ({
        sale_id: r.sale_id,
        customer_name: r.customer_name || null,
        total: Number(r.total_amount) || 0,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    falhar(res, err, 'GET:detail');
  }
});

// ─── PATCH /:pid ── profissao / ativo ────────────────────────
router.patch('/:pid', async function (req, res) {
  const { id: cid, pid } = req.params;
  const body = req.body || {};
  if (!UUID_RE.test(pid)) return res.status(404).json({ error: 'Parceiro não encontrado.' });

  const sets = [];
  const values = [];
  if (body.trade !== undefined) {
    if (!TRADES.includes(String(body.trade))) return res.status(400).json({ error: 'Escolha a profissão do parceiro.' });
    values.push(String(body.trade));
    sets.push(`trade = $${values.length}`);
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return res.status(400).json({ error: 'Diga se o parceiro fica ativo ou não.' });
    values.push(body.active);
    sets.push(`active = $${values.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada para mudar.' });

  try {
    await assertMatconEnabled(cid);
    values.push(pid, cid);
    const upd = await db.query(
      `UPDATE matcon_professionals SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length - 1} AND company_id = $${values.length}
        RETURNING id`,
      values
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Parceiro não encontrado.' });
    res.json({ professional: await fetchProfessional(db, cid, pid) });
  } catch (err) {
    falhar(res, err, 'PATCH');
  }
});

// ─── POST /:pid/redeem ── pontos → cupom ─────────────────────
//
// Cupom na tabela `coupons` de sempre, para funcionar no Caixa sem nada
// novo: valor fixo (matcon_coupon_value), uso unico (max_uses 1), NOMINAL
// ao cliente do parceiro (couponPolicy.checkCouponOwner barra outro
// cliente) e sem validade — os pontos nao vencem, o cupom tambem nao.
function couponCodeFor(name) {
  const first = String(name || '')
    .trim()
    .split(/\s+/)[0]
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 10) || 'PARCEIRO';
  // Sem 0/O/1/I: o codigo e ditado no balcao e lido no WhatsApp.
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let sufixo = '';
  for (let i = 0; i < 4; i++) sufixo += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  return `PARC-${first}-${sufixo}`;
}

function fmtReais(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}

router.post('/:pid/redeem', async function (req, res) {
  const { id: cid, pid } = req.params;
  if (!UUID_RE.test(pid)) return res.status(404).json({ error: 'Parceiro não encontrado.' });

  let client;
  try {
    await assertMatconEnabled(cid);
    const settings = await loadClubSettings(db, cid);
    if (!settings) return res.status(404).json({ error: 'Empresa não encontrada' });
    const cost = settings.matcon_points_to_coupon;
    const value = settings.matcon_coupon_value;
    if (!(value > 0)) {
      return res.status(400).json({ error: 'Defina o valor do cupom do parceiro em Configurações antes de gerar cupom.', code: 'COUPON_VALUE_MISSING' });
    }

    client = await db.connect();
    await client.query('BEGIN');

    const pro = await client.query(
      `SELECT p.id, p.customer_id, p.points_balance, cu.name AS customer_name
         FROM matcon_professionals p
         JOIN customers cu ON cu.id = p.customer_id
        WHERE p.id = $1 AND p.company_id = $2
        FOR UPDATE OF p`,
      [pid, cid]
    );
    if (!pro.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parceiro não encontrado.' });
    }
    const p = pro.rows[0];
    const balance = Number(p.points_balance) || 0;
    if (balance < cost) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Ainda não dá: ${p.customer_name || 'o parceiro'} tem ${balance} pontos e o cupom precisa de ${cost}. Faltam ${cost - balance}.`,
        code: 'INSUFFICIENT_POINTS',
        points_balance: balance,
        points_needed: cost,
      });
    }

    // Codigo repetido (23505) tenta de novo com outro sufixo; o SAVEPOINT
    // impede que o erro envenene a transacao.
    let coupon = null;
    for (let tentativa = 0; tentativa < 5 && !coupon; tentativa++) {
      const code = couponCodeFor(p.customer_name);
      await client.query('SAVEPOINT matcon_coupon');
      try {
        const ins = await client.query(
          `INSERT INTO coupons (company_id, code, description, discount_type, discount_value,
                                min_order_value, max_uses, expires_at, customer_id, source)
           VALUES ($1, $2, $3, 'fixed', $4, 0, 1, NULL, $5, 'matcon_professional')
           RETURNING id, code, discount_value`,
          [cid, code, `Resgate de pontos — parceiro ${p.customer_name || ''}`.trim(), value, p.customer_id]
        );
        await client.query('RELEASE SAVEPOINT matcon_coupon');
        coupon = ins.rows[0];
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT matcon_coupon');
        if (e.code !== '23505') throw e;
      }
    }
    if (!coupon) throw new Error('nao gerou codigo de cupom unico em 5 tentativas');

    await client.query(
      `INSERT INTO matcon_professional_points_ledger
              (company_id, professional_id, coupon_id, delta, reason, note)
       VALUES ($1, $2, $3, $4, 'redeem', $5)`,
      [cid, pid, coupon.id, -cost, `Cupom ${coupon.code} de ${fmtReais(value)}`]
    );
    const upd = await client.query(
      `UPDATE matcon_professionals
          SET points_balance = points_balance - $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING points_balance`,
      [cost, pid, cid]
    );

    await client.query('COMMIT');
    res.json({
      coupon_code: coupon.code,
      points_balance: Number(upd.rows[0] && upd.rows[0].points_balance) || 0,
      coupon: { id: coupon.id, code: coupon.code, value: Number(coupon.discount_value) || value },
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ja sem transacao */ } }
    falhar(res, err, 'POST:redeem');
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
module.exports.assertMatconEnabled = assertMatconEnabled;
module.exports.couponCodeFor = couponCodeFor;
