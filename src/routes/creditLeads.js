// ============================================================
// AURA. -- Crediario: CREDITO LIVRE (GET /credit/leads)
//
// Lista clientes que JA compraram no crediario e hoje estao com saldo
// ZERO. Sao leads de venda: tem historico de pagamento, limite livre e
// relacionamento recente com a loja -- e hoje somem da tela, porque todo
// o modulo e construido em cima de balance > 0.
//
// Nao confundir com /reactivation (plano Expansao): aquele segmenta por
// dias desde a ultima VENDA (customers.last_purchase_at), entao quem
// acabou de quitar o carne cai como "ativo" e e justamente EXCLUIDO de
// la. Os publicos sao quase disjuntos. Nada aqui importa de
// customerReactivation.js, de proposito: esta rota e Negocio, e importar
// de la criaria dependencia acidental de Expansao.
//
// ------------------------------------------------------------
// "Zerado desde" NAO e "data em que pagou a ultima parcela"
// ------------------------------------------------------------
// A tentacao e derivar a quitacao de MAX(created_at) das transacoes de
// pagamento. Conferido em producao (02/08/2026): isso QUEBRA em contas
// regularizadas na mao. Existem clientes com o pagamento gravado em
// 2025 e o debito correspondente ("Lancamento manual") gravado em 2026 --
// o par zera, mas a ordem de created_at fica invertida e a tela mostraria
// "quitou em 2025" ao lado de "ultima compra em 2026".
//
// Por isso usamos cb.last_activity_at (MAX de QUALQUER transacao, ja
// pronto na view): e sempre >= todo movimento do cliente, nunca fica
// atras da ultima compra, e o nome honesto do que ele representa e
// "conta zerada desde", nao "quitou em".
//
// ------------------------------------------------------------
// Segmentacao por contato (?contacted=)
// ------------------------------------------------------------
// A fila util e a de quem AINDA NAO foi contatado. Se os contatados
// ficassem misturados, eles ocupariam o topo permanentemente (o score nao
// sabe de contato) e ainda consumiriam o LIMIT, encurtando a fila real.
// Por isso o corte e feito NO BANCO, com EXISTS, e nao no cliente.
//
// A tabela credit_lead_contacts nasce na migration 267, junto com esta
// rota. Ainda assim probamos a existencia dela (cache module-level, mesmo
// padrao do hasExchangeCols em employeesRanking.js): em deploy parcial a
// rota degrada pra "sem segmentacao" em vez de estourar 42P01.
//
// ------------------------------------------------------------
// Custo
// ------------------------------------------------------------
// customer_credit_balances e VIEW agregadora, nao materializada. O
// EXPLAIN em producao mostra o planner empurrando company_id para dentro
// dela e usando idx_credit_tx_company: a agregacao ja sai restrita a
// empresa (14ms na maior base). Escala com transacoes POR EMPRESA,
// igual a rota de carteira que ja esta no ar -- sem classe nova de custo.
// A janela padrao de 6 meses e recorte de PRODUTO (lead de 2 anos atras
// e frio), nao remendo de performance.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

// Tolerancia de centavos: saldo "zerado" inclui credito a favor do cliente.
const ZERO = 0.005;
const MONTHS = { '3': 3, '6': 6, '12': 12 };

async function assertCrediarioEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) { const e = new Error('Empresa nao encontrada'); e.status = 404; throw e; }
  if (rows[0].enabled !== 'true') {
    const e = new Error('Modulo de crediario nao esta habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.');
    e.status = 403; e.code = 'CREDIARIO_DISABLED'; throw e;
  }
}

// Probe da tabela de contatos (migration 267). Cache module-level de 60s,
// mesmo padrao do hasExchangeCols em employeesRanking.js.
let _contactsCheckedAt = 0;
let _contactsAvailable = null;
async function hasContactsTable() {
  const now = Date.now();
  if (_contactsAvailable !== null && (now - _contactsCheckedAt) < 60000) return _contactsAvailable;
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'credit_lead_contacts'`
    );
    _contactsAvailable = parseInt((r.rows[0] && r.rows[0].n) || '0', 10) > 0;
  } catch (e) {
    console.warn('[credit] probe credit_lead_contacts falhou:', e.message);
    _contactsAvailable = false;
  }
  _contactsCheckedAt = now;
  return _contactsAvailable;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Score do lead (0-100). Combina o que foi priorizado no spec:
// volume historico + bom pagador + zerou recentemente.
//
// Calculado em JS de proposito: a lista ja vem limitada por LIMIT, e a
// regra fica legivel e testavel em vez de enterrada num CASE gigante.
// Volume e relativo ao melhor cliente DA LISTA -- em loja pequena, R$ 500
// ja e um bom cliente; em loja grande, nao. Normalizar pelo topo local
// evita cravar um valor absoluto que so serve pra um perfil de loja.
function leadScore(row, maxDebited) {
  const volume = maxDebited > 0 ? clamp(row.total_debited / maxDebited, 0, 1) : 0;

  // Sem perfil de credito o cliente NAO e penalizado a ponto de sumir:
  // recebe 0.5 (neutro). Perfil ausente e comum em conta antiga.
  let payer = 0.5;
  if (row.credit_score != null) {
    // Faixa observada em producao: ~285 a ~729, com 500 como default.
    payer = clamp((row.credit_score - 300) / 450, 0, 1);
  }
  if (row.total_paid_count > 0) {
    const onTime = clamp(row.total_paid_on_time / row.total_paid_count, 0, 1);
    payer = payer * 0.6 + onTime * 0.4;
  }

  // Recencia: 1.0 hoje, ~0.5 aos 90 dias, cauda longa. Sem cliff.
  const recency = 1 / (1 + Math.max(0, row.days_since_activity) / 90);

  return Math.round((volume * 0.35 + payer * 0.35 + recency * 0.30) * 100);
}

// GET /leads?months=3|6|12|all&contacted=0|1|all&q=texto&limit=100
router.get('/leads', async (req, res) => {
  const companyId = req.params.id;
  const monthsRaw = req.query.months == null ? '6' : String(req.query.months);
  const months = monthsRaw === 'all' ? null : (MONTHS[monthsRaw] || 6);
  const q = req.query.q ? String(req.query.q).trim() : '';
  const limit = clamp(parseInt(req.query.limit, 10) || 100, 1, 500);

  // contacted: '0' = so nao contatados (fila util, default do app)
  //            '1' = so ja contatados
  //            'all' / ausente = sem segmentacao
  const contactedRaw = req.query.contacted == null ? 'all' : String(req.query.contacted);
  const contacted = contactedRaw === '0' || contactedRaw === 'false' ? 'pending'
                  : contactedRaw === '1' || contactedRaw === 'true' ? 'done'
                  : 'all';

  try {
    await assertCrediarioEnabled(companyId);
    const contactsOk = await hasContactsTable();

    // ---- Query principal: view + customers (+ EXISTS de contato) ----
    const conditions = [
      'cb.company_id = $1',
      `cb.balance <= ${ZERO}`,
      'cb.total_debited > 0',
      'COALESCE(c.marketing_opt_out, false) = false', // LGPD: no banco, nao na UI
    ];
    const params = [companyId];
    let i = 2;

    if (months != null) {
      conditions.push(`cb.last_activity_at >= NOW() - ($${i} || ' months')::interval`);
      params.push(String(months));
      i++;
    }
    if (q) {
      conditions.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.cpf_cnpj ILIKE $${i})`);
      params.push(`%${q}%`);
      i++;
    }

    // Segmentacao por contato -- no banco, pra o LIMIT valer sobre o
    // conjunto certo. Se a tabela ainda nao existir, ignora o filtro.
    const CONTACT_EXISTS = `EXISTS (
      SELECT 1 FROM credit_lead_contacts lc
       WHERE lc.company_id = cb.company_id AND lc.customer_id = cb.customer_id
    )`;
    if (contactsOk && contacted === 'pending') conditions.push(`NOT ${CONTACT_EXISTS}`);
    if (contactsOk && contacted === 'done') conditions.push(CONTACT_EXISTS);

    params.push(limit);

    const { rows } = await db.query(
      `SELECT c.id, c.name, c.phone, c.cpf_cnpj,
              cb.balance, cb.total_debited, cb.total_paid,
              cb.last_activity_at,
              EXTRACT(day FROM NOW() - cb.last_activity_at)::int AS days_since_activity
         FROM customer_credit_balances cb
         JOIN customers c ON c.id = cb.customer_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY cb.last_activity_at DESC NULLS LAST
        LIMIT $${i}`,
      params
    );

    const ids = rows.map((r) => r.id);

    // ---- Contagem dos dois segmentos (pra UI mostrar os dois numeros
    //      sem precisar de uma segunda chamada) ----
    let counts = { pending: null, contacted: null };
    if (contactsOk) {
      try {
        const countConds = [
          'cb.company_id = $1',
          `cb.balance <= ${ZERO}`,
          'cb.total_debited > 0',
          'COALESCE(c.marketing_opt_out, false) = false',
        ];
        const countParams = [companyId];
        if (months != null) {
          countConds.push(`cb.last_activity_at >= NOW() - ($2 || ' months')::interval`);
          countParams.push(String(months));
        }
        const { rows: cnt } = await db.query(
          `SELECT COUNT(*) FILTER (WHERE NOT ${CONTACT_EXISTS}) AS pending,
                  COUNT(*) FILTER (WHERE ${CONTACT_EXISTS})     AS contacted
             FROM customer_credit_balances cb
             JOIN customers c ON c.id = cb.customer_id
            WHERE ${countConds.join(' AND ')}`,
          countParams
        );
        counts = {
          pending: parseInt(cnt[0] && cnt[0].pending || '0', 10),
          contacted: parseInt(cnt[0] && cnt[0].contacted || '0', 10),
        };
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    // ---- Ultima compra no crediario (MAX debito) ----
    // Hoje nenhuma rota expoe isso. Nao da pra usar customers.last_purchase_at:
    // aquele campo e de QUALQUER venda, nao so crediario.
    const lastPurchase = {};
    if (ids.length) {
      try {
        const { rows: lp } = await db.query(
          `SELECT customer_id, MAX(created_at) AS last_credit_purchase_at
             FROM customer_credit_transactions
            WHERE company_id = $1 AND customer_id = ANY($2::uuid[]) AND type = 'debit'
            GROUP BY customer_id`,
          [companyId, ids]
        );
        for (const r of lp) lastPurchase[r.customer_id] = r.last_credit_purchase_at;
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    // ---- Perfil de credito (score / pontualidade) ----
    const profiles = {};
    if (ids.length) {
      try {
        const { rows: pr } = await db.query(
          `SELECT customer_id, credit_score, total_paid_count, total_paid_on_time,
                  avg_days_late, status
             FROM customer_credit_profiles
            WHERE company_id = $1 AND customer_id = ANY($2::uuid[])`,
          [companyId, ids]
        );
        for (const r of pr) profiles[r.customer_id] = r;
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    // ---- Ultimo contato (data, pro segmento "ja contatados") ----
    const lastContact = {};
    if (ids.length && contactsOk) {
      try {
        const { rows: lc } = await db.query(
          `SELECT customer_id, MAX(sent_at) AS last_contact_at
             FROM credit_lead_contacts
            WHERE company_id = $1 AND customer_id = ANY($2::uuid[])
            GROUP BY customer_id`,
          [companyId, ids]
        );
        for (const r of lc) lastContact[r.customer_id] = r.last_contact_at;
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    // ---- Deve em outro CNPJ do mesmo dono ----
    // Decisao: a lista e POR EMPRESA, mas sinaliza quem esta devendo na
    // loja irma -- oferecer venda a inadimplente do grupo e tiro no pe.
    const owesElsewhere = {};
    if (ids.length) {
      try {
        const { rows: oe } = await db.query(
          `SELECT DISTINCT cb.customer_id
             FROM customer_credit_balances cb
            WHERE cb.customer_id = ANY($2::uuid[])
              AND cb.balance > ${ZERO}
              AND cb.company_id <> $1
              AND cb.company_id IN (
                    SELECT id FROM companies
                     WHERE owner_id = (SELECT owner_id FROM companies WHERE id = $1)
                  )`,
          [companyId, ids]
        );
        for (const r of oe) owesElsewhere[r.customer_id] = true;
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    // ---- Monta, pontua, ordena ----
    const enriched = rows.map((r) => {
      const p = profiles[r.id] || {};
      return {
        id: r.id,
        name: r.name,
        phone: r.phone,
        cpf_cnpj: r.cpf_cnpj,
        balance: parseFloat(r.balance) || 0,
        total_debited: parseFloat(r.total_debited) || 0,
        total_paid: parseFloat(r.total_paid) || 0,
        // Nome honesto: e o ultimo movimento da conta, nao a data da
        // ultima parcela paga. Ver cabecalho do arquivo.
        zeroed_since: r.last_activity_at,
        days_since_activity: r.days_since_activity || 0,
        last_credit_purchase_at: lastPurchase[r.id] || null,
        credit_score: p.credit_score != null ? Number(p.credit_score) : null,
        total_paid_count: p.total_paid_count != null ? Number(p.total_paid_count) : 0,
        total_paid_on_time: p.total_paid_on_time != null ? Number(p.total_paid_on_time) : 0,
        avg_days_late: p.avg_days_late != null ? Number(p.avg_days_late) : null,
        profile_status: p.status || null,
        last_contact_at: lastContact[r.id] || null,
        owes_elsewhere: owesElsewhere[r.id] === true,
      };
    })
      // Cliente bloqueado no crediario nao e lead de venda.
      .filter((r) => r.profile_status !== 'blocked');

    const maxDebited = enriched.reduce((m, r) => Math.max(m, r.total_debited), 0);
    for (const r of enriched) r.score = leadScore(r, maxDebited);
    enriched.sort((a, b) => b.score - a.score || b.total_debited - a.total_debited);

    res.json({
      leads: enriched,
      total: enriched.length,
      window_months: months,
      segment: contacted,
      // Contagem dos dois segmentos na janela atual. null quando a tabela
      // de contatos ainda nao existe (deploy parcial).
      pending_count: counts.pending,
      contacted_count: counts.contacted,
      // Util pro front decidir se mostra "sem telefone" como aviso agregado.
      without_phone: enriched.filter((r) => !r.phone).length,
    });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message, code: err.code });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[credit] leads error:', err.message);
    res.status(500).json({ error: 'Erro ao listar leads de crediario' });
  }
});

// ============================================================
// FASE 3 -- cupom + registro de contato
//
// Ficam neste mesmo arquivo (e nao num creditLeadsActions.js) porque o
// mount `/credit -> creditLeads` ja cobre /leads/*: um arquivo novo
// exigiria mexer no private.js sem ganho nenhum de organizacao.
// ============================================================

// Mesma politica do birthday.js: cupom e dinheiro, entao criacao e
// owner/admin. O LOG de contato nao exige -- vendedora que fala com o
// cliente precisa conseguir registrar.
function requireOwnerOrAdmin(req, res, next) {
  if (req.companyRole !== 'owner' && req.companyRole !== 'admin') {
    return res.status(403).json({
      error: 'Apenas owner ou admin podem criar cupons',
      your_role: req.companyRole,
    });
  }
  next();
}

const COUPON_DEFAULTS = {
  discount_type:   'percent',
  discount_value:  10,
  validity_days:   15,   // maior que o de aniversario (7): aqui a janela
                         // de decisao do cliente e mais longa, nao ha data
  min_order_value: 0,
  max_uses:        1,
};

// VOLTA-<PRIMEIRONOME>-<YY>. Mesmo formato do ANIV- do aniversario, pra
// o lojista reconhecer a origem do cupom so de bater o olho no relatorio.
function generateLeadCode(customerName, attempt = 0) {
  const raw = String(customerName || 'CLIENTE')
    .trim()
    .split(/\s+/)[0]
    .normalize('NFD')
    // Sem o replace de combining marks que o birthday.js tem: depois do
    // NFD o acento vira caractere proprio, e o filtro [^A-Za-z0-9] abaixo
    // ja o remove. Conferido com Jose/Angela/Marcia/ção -- mesmo
    // resultado. Um regex a menos, e um cheio de caractere invisivel.
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
  const first = raw || 'CLIENTE';
  const yy = String(new Date().getFullYear()).slice(-2);
  const suffix = attempt > 0 ? `-${attempt + 1}` : '';
  return `VOLTA-${first}-${yy}${suffix}`;
}

// Carrega o cliente e CONFIRMA que ele e mesmo um lead (zerado, com
// historico). Sem isso daria pra carimbar source='credit_lead' em cupom
// de qualquer cliente, e a metrica de "cupom de lead que virou venda"
// nasceria suja.
//
// Tambem barra opt-out AQUI, no servidor. Hoje o marketing_opt_out so e
// respeitado na UI do aniversario; numa feature explicitamente de
// prospeccao isso nao basta.
async function loadLead(companyId, customerId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.phone, c.marketing_opt_out,
            cb.balance, cb.total_debited
       FROM customers c
       LEFT JOIN customer_credit_balances cb
              ON cb.customer_id = c.id AND cb.company_id = c.company_id
      WHERE c.id = $1 AND c.company_id = $2 AND c.is_active = true`,
    [customerId, companyId]
  );
  if (!rows.length) { const e = new Error('Cliente nao encontrado'); e.status = 404; throw e; }
  const r = rows[0];

  if (r.marketing_opt_out === true) {
    const e = new Error('Cliente optou por nao receber comunicacoes de marketing');
    e.status = 403; e.code = 'MARKETING_OPT_OUT'; throw e;
  }

  const balance = parseFloat(r.balance);
  const totalDebited = parseFloat(r.total_debited);
  if (!(totalDebited > 0)) {
    const e = new Error('Cliente nunca comprou no crediario');
    e.status = 409; e.code = 'NOT_A_LEAD'; throw e;
  }
  if (!(balance <= ZERO)) {
    const e = new Error('Cliente tem saldo em aberto no crediario');
    e.status = 409; e.code = 'HAS_OPEN_BALANCE'; throw e;
  }
  return { ...r, balance, total_debited: totalDebited };
}

// ── POST /leads/:customerId/coupon ─────────────────────────
// Body: { code?, description?, discount_type?, discount_value?,
//         validity_days?, min_order_value?, max_uses? }
router.post('/leads/:customerId/coupon', requireOwnerOrAdmin, async (req, res) => {
  const companyId = req.params.id;
  try {
    await assertCrediarioEnabled(companyId);
    const lead = await loadLead(companyId, req.params.customerId);

    const discount_type   = req.body.discount_type || COUPON_DEFAULTS.discount_type;
    const discount_value  = parseFloat(req.body.discount_value ?? COUPON_DEFAULTS.discount_value);
    const min_order_value = parseFloat(req.body.min_order_value ?? COUPON_DEFAULTS.min_order_value);
    const max_uses        = req.body.max_uses ?? COUPON_DEFAULTS.max_uses;
    const validity_days   = parseInt(req.body.validity_days ?? COUPON_DEFAULTS.validity_days, 10);
    const description     = req.body.description || `Credito livre - ${lead.name}`;

    if (isNaN(discount_value) || discount_value <= 0) {
      return res.status(400).json({ error: 'discount_value invalido' });
    }
    if (!['percent', 'fixed'].includes(discount_type)) {
      return res.status(400).json({ error: 'discount_type invalido' });
    }
    if (isNaN(validity_days) || validity_days <= 0 || validity_days > 365) {
      return res.status(400).json({ error: 'validity_days deve estar entre 1 e 365' });
    }

    const expires = new Date();
    expires.setDate(expires.getDate() + validity_days);
    expires.setHours(23, 59, 59, 999);

    let code = req.body.code
      ? String(req.body.code).toUpperCase().trim()
      : generateLeadCode(lead.name);

    let attempt = 0;
    while (attempt < 5) {
      const { rows: existing } = await db.query(
        `SELECT 1 FROM coupons WHERE company_id = $1 AND code = $2`,
        [companyId, code]
      );
      if (!existing.length) break;
      attempt++;
      code = generateLeadCode(lead.name, attempt);
    }

    const { rows } = await db.query(
      `INSERT INTO coupons (company_id, code, description, discount_type, discount_value,
                            min_order_value, max_uses, expires_at, customer_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'credit_lead')
       RETURNING *`,
      [companyId, code, description, discount_type, discount_value,
       min_order_value, max_uses, expires.toISOString(), lead.id]
    );

    res.status(201).json({
      coupon: rows[0],
      customer: { id: lead.id, name: lead.name, phone: lead.phone },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Nao foi possivel gerar codigo unico -- informe um manualmente' });
    }
    if (err.code === '23514') {
      // CHECK de coupons.source sem 'credit_lead' = migration 267 nao aplicada
      return res.status(503).json({ error: 'Migration pendente no banco (coupons.source)', code: 'MIGRATION_PENDING' });
    }
    console.error('[credit] lead coupon:', err.message);
    res.status(500).json({ error: 'Erro ao criar cupom do lead' });
  }
});

// ── POST /leads/:customerId/contact ────────────────────────
// Body: { coupon_id?, method='wa_link', message? }
//
// Idempotente por DIA (uq_credit_lead_contact_per_day): duplo-clique nao
// duplica, mas o lojista pode recontatar amanha e num segundo carne.
// Grava snapshot do saldo pra medir depois sem reconstruir o passado --
// o saldo do cliente muda assim que ele recompra.
router.post('/leads/:customerId/contact', async (req, res) => {
  const companyId = req.params.id;
  const { coupon_id, method = 'wa_link', message } = req.body || {};

  if (!['wa_link', 'wa_api', 'sms', 'email'].includes(method)) {
    return res.status(400).json({ error: 'method invalido' });
  }

  try {
    await assertCrediarioEnabled(companyId);
    // Revalida opt-out no registro tambem: o log e a prova de que houve
    // contato, entao nao pode existir pra quem pediu pra nao ser contatado.
    const lead = await loadLead(companyId, req.params.customerId);

    const { rows } = await db.query(
      `INSERT INTO credit_lead_contacts
         (company_id, customer_id, coupon_id, method, user_id, message,
          balance_at_contact, total_debited_at_contact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (company_id, customer_id, contact_day)
       DO UPDATE SET
         coupon_id = COALESCE(EXCLUDED.coupon_id, credit_lead_contacts.coupon_id),
         method    = EXCLUDED.method,
         message   = COALESCE(EXCLUDED.message, credit_lead_contacts.message),
         sent_at   = NOW()
       RETURNING *`,
      [companyId, lead.id, coupon_id || null, method,
       req.user?.id || null, message || null, lead.balance, lead.total_debited]
    );
    res.status(201).json({ contact: rows[0] });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Migration pendente no banco (credit_lead_contacts)', code: 'MIGRATION_PENDING' });
    }
    console.error('[credit] lead contact:', err.message);
    res.status(500).json({ error: 'Erro ao registrar contato' });
  }
});

module.exports = router;
