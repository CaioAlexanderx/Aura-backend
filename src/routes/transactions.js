// ============================================================
// AURA. — Transactions CRUD + Recorrencia
//
// REGIME (revisao 27/04 noite — fechamento Finesse):
//   Filtro de periodo agora usa a "data do lancamento" que o usuario
//   preenche (campo due_date, default=hoje). Quando ela esta presente,
//   manda. Quando nao (cenario raro pos-022), cai em created_at SP.
//
//   summary.income/expenses = SUM(... WHERE status='confirmed') no periodo.
//   Saldo segue regime caixa (so confirmadas entram). pending_* exposto
//   separado pro frontend mostrar como badge informativo.
//
//   Anterior (commit 14:27 hoje): forcava created_at SP em tudo. Resultado:
//   despesa de Marco lancada em Abril aparecia em Abril (cliente reclamava).
//   Anterior ao anterior: COALESCE(due_date, created_at SP) — mesmo de agora.
//
// FIX DESPESAS 27/04 (mantido): filtro de data padronizado entre listing
// e summary. due_date eh date (nao timestamp), entao COALESCE com
// (created_at AT TIME ZONE SP)::date retorna sempre date.
//
// TIMEZONE FIX 13/05/2026: PATCH /:txId agora sincroniza due_date ->
// sales.created_at quando a transacao esta vinculada a uma venda PDV
// (idempotency_key = 'pdv-sale-*'). Permite corrigir a data de uma
// venda pelo modal "Editar lancamento" sem precisar de endpoint separado.
// Formula: due_date::date + INTERVAL '3 hours' = meia-noite SP (UTC-3).
// ============================================================
var router = require('express').Router({ mergeParams: true });
var db = require('../config/database');
var crypto = require('crypto');
var { resolveSaleLink } = require('../utils/saleLink');
var quadro = require('../utils/quadroFinanceiro');

function todayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function advanceDate(dateStr, type, steps) {
  var d = new Date(dateStr + 'T12:00:00');
  if (type === 'weekly') d.setDate(d.getDate() + (7 * steps));
  else if (type === 'monthly') d.setMonth(d.getMonth() + steps);
  else if (type === 'yearly') d.setFullYear(d.getFullYear() + steps);
  return d.toISOString().split('T')[0];
}

function extractSaleId(idempotencyKey) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;
  var m = idempotencyKey.match(/^pdv-sale-([0-9a-f-]+)$/i);
  return m ? m[1] : null;
}

var VALID_PAYMENTS = ['pix', 'cash', 'credit', 'debit', 'voucher', 'transfer', 'boleto'];
var RECURRENCE_DEFAULTS = { weekly: 4, monthly: 12, yearly: 3 };
var RECURRENCE_MAX = { weekly: 52, monthly: 24, yearly: 10 };
var RECURRENCE_LABELS = { weekly: 'semanal', monthly: 'mensal', yearly: 'anual' };

// Helper: clausula de data por "data do lancamento" (due_date com fallback
// pra created_at SP). Usado em todas as queries que filtram periodo
// (listing, summary, e dashboard.js — manter sincronizados).
function dateClauseCompetencia(op, paramIdx) {
  return "COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) " + op + ' $' + paramIdx;
}

router.get('/', async function(req, res) {
  var cid = req.params.id;
  var limit = Math.min(parseInt(req.query.limit) || 200, 10000);
  var offset = parseInt(req.query.offset) || 0;
  var type = req.query.type;
  var start = req.query.start;
  var end = req.query.end;
  try {
    // --- Listagem ---
    // Filtro por data do lancamento (due_date com fallback created_at SP).
    var where = 'WHERE company_id = $1';
    var params = [cid];
    // Lentidao do Studio (QA 04/09/2026): o app roda em us-west e o banco em
    // Sao Paulo, entao cada ida ao banco custa ~190ms mesmo com a consulta em
    // 1ms. Esta rota fazia TRES idas em sequencia (contagem, pagina, somas) e o
    // Financeiro a chama tres vezes em paralelo. Agora contagem e somas viajam
    // numa consulta so, em paralelo com a pagina: 3 idas viram 1. Os indices
    // de start/end sao guardados porque a clausula das somas reaproveita os
    // mesmos parametros da listagem (sem o filtro de type).
    var startIdx = null;
    var endIdx = null;
    if (type === 'income' || type === 'expense') { params.push(type); where += ' AND type = $' + params.length; }
    if (start) { params.push(start); startIdx = params.length; where += ' AND ' + dateClauseCompetencia('>=', startIdx); }
    if (end)   { params.push(end);   endIdx = params.length;   where += ' AND ' + dateClauseCompetencia('<=', endIdx); }
    var dataParams = params.concat([limit, offset]);
    var dataSql =
      'SELECT id, type, amount, description, category, status, notes, due_date, paid_at, created_at,' +
      '       recurrence_type, recurrence_group_id, recurrence_index,' +
      '       payment_method, employee_id, employee_name, idempotency_key, original_amount, receipt_filename' +
      ' FROM transactions ' + where +
      " ORDER BY COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC, created_at DESC" +
      ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);

    // --- Summary: income/expenses CONFIRMED + pending_* separado ---
    // Filtra por COALESCE(due_date, created_at SP) (mesmo do listing).
    // status='confirmed' alinha com dashboard.js (saldo regime caixa).
    // Pending exposto a parte como info — frontend pode mostrar badge.
    var defaultW = !start && !end
      ? " AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))::date" +
        " AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  (date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month')::date"
      : '';

    var sumW = 'WHERE company_id = $1';
    if (startIdx) sumW += ' AND ' + dateClauseCompetencia('>=', startIdx);
    if (endIdx)   sumW += ' AND ' + dateClauseCompetencia('<=', endIdx);
    sumW += defaultW;

    // A contagem da listagem (com filtro de type) entra como subconsulta
    // escalar na mesma ida das somas (sem filtro de type). Os dois blocos
    // referenciam $1..$N de `params`; o type, quando existe, e citado so
    // dentro da subconsulta — e basta ser citado uma vez.
    var aggSql =
      'SELECT' +
      '  (SELECT COUNT(*) FROM transactions ' + where + ') AS total,' +
      "  COALESCE(SUM(amount) FILTER (WHERE type = 'income'  AND status = 'confirmed'), 0) AS income," +
      "  COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND status = 'confirmed'), 0) AS expenses," +
      "  COALESCE(SUM(amount) FILTER (WHERE type = 'income'  AND status = 'pending'),   0) AS pending_income," +
      "  COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND status = 'pending'),   0) AS pending_expenses" +
      ' FROM transactions ' + sumW;

    var results = await Promise.all([
      db.query(aggSql, params),
      db.query(dataSql, dataParams),
    ]);
    var sumRes  = results[0];
    var dataRes = results[1];

    var income           = parseFloat(sumRes.rows[0]?.income)           || 0;
    var expenses         = parseFloat(sumRes.rows[0]?.expenses)         || 0;
    var pendingIncome    = parseFloat(sumRes.rows[0]?.pending_income)   || 0;
    var pendingExpenses  = parseFloat(sumRes.rows[0]?.pending_expenses) || 0;

    var transactions = dataRes.rows.map(function(r) {
      return {
        id: r.id, type: r.type, amount: parseFloat(r.amount) || 0,
        original_amount: r.original_amount == null ? null : parseFloat(r.original_amount),
        // F3: nome do comprovante anexado (o arquivo abre por GET /:txId/receipt).
        receipt_filename: r.receipt_filename || null,
        desc: r.description || '', description: r.description || '',
        category: r.category || 'Outros', status: r.status || 'confirmed',
        notes: r.notes || '',
        date: r.due_date
          ? new Date(r.due_date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
          : (r.created_at ? new Date(r.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }) : '--/--'),
        due_date: r.due_date, paid_at: r.paid_at, created_at: r.created_at,
        recurrence_type: r.recurrence_type || null,
        recurrence_label: r.recurrence_type ? RECURRENCE_LABELS[r.recurrence_type] : null,
        recurrence_group_id: r.recurrence_group_id || null,
        recurrence_index: r.recurrence_index || 0,
        payment_method: r.payment_method || null,
        employee_id: r.employee_id || null,
        employee_name: r.employee_name || null,
        idempotency_key: r.idempotency_key || null,
        source: r.idempotency_key && /^pdv-sale-/i.test(r.idempotency_key) ? 'pdv' : 'manual',
      };
    });

    res.json({
      transactions: transactions,
      total: parseInt(sumRes.rows[0]?.total) || 0,
      limit: limit, offset: offset,
      summary: {
        income:           income,           // confirmed no periodo (regime caixa)
        expenses:         expenses,         // confirmed no periodo (regime caixa)
        pending_income:   pendingIncome,    // pending no periodo (informativo, nao soma no saldo)
        pending_expenses: pendingExpenses,  // pending no periodo (informativo, nao soma no saldo)
      },
    });
  } catch (err) { console.error('[transactions] list:', err.message); res.status(500).json({ error: 'Erro ao listar lancamentos' }); }
});

// GET /board?type=income|expense&month=YYYY-MM — Quadro do Financeiro
// (Atrasado / A receber / Recebido). Regras em utils/quadroFinanceiro.js.
router.get('/board', async function(req, res) {
  var cid = req.params.id;
  var tipo = req.query.type === 'expense' ? 'expense' : 'income';
  var hoje = quadro.hojeSP();
  var mes = quadro.intervaloDoMes(req.query.month, hoje);
  try {
    var resultados = await Promise.all([
      db.query(quadro.sqlDosCartoes(), [cid, tipo, hoje, mes.inicio, mes.fim]),
      db.query(quadro.sqlDosGrupos(), [cid, tipo, mes.inicio, mes.fim]),
      db.query(quadro.sqlDaSemana(), [cid, hoje, tipo]),
    ]);
    res.json(quadro.montarQuadro({
      tipo: tipo, hoje: hoje, mes: mes.mes,
      cartoes: resultados[0].rows, grupos: resultados[1].rows, semana: resultados[2].rows[0],
    }));
  } catch (err) { console.error('[transactions] board:', err.message); res.status(500).json({ error: 'Erro ao carregar o quadro' }); }
});

// POST /baixa-em-lote — F2 do Quadro: pagar varios de uma vez (boletos
// atrasados). { items: [{ id, paid_amount? }], paid_at?, payment_method? }.
// Um UPDATE so; o que nao pode receber baixa (ja pago, crediario, venda) volta
// em `skipped` sem derrubar o resto.
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.post('/baixa-em-lote', async function(req, res) {
  var cid = req.params.id;
  var items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Escolha ao menos um lancamento' });
  if (items.length > 200) return res.status(400).json({ error: 'No maximo 200 lancamentos por vez' });
  var paidAt = req.body.paid_at || null;
  if (paidAt && !/^\d{4}-\d{2}-\d{2}$/.test(String(paidAt))) return res.status(400).json({ error: 'paid_at deve ser uma data (AAAA-MM-DD)' });
  var forma = req.body.payment_method || null;
  if (forma && VALID_PAYMENTS.indexOf(forma) === -1) return res.status(400).json({ error: 'payment_method invalido (aceitos: ' + VALID_PAYMENTS.join(', ') + ')' });
  var ids = [], pagos = [], vistos = {};
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    if (!UUID_RE.test(String(it.id || ''))) return res.status(400).json({ error: 'id invalido no item ' + (i + 1) });
    if (vistos[it.id]) continue;
    vistos[it.id] = true;
    var pago = null;
    if (it.paid_amount !== undefined && it.paid_amount !== null && it.paid_amount !== '') {
      pago = Math.round(parseFloat(it.paid_amount) * 100) / 100;
      if (!(pago > 0)) return res.status(400).json({ error: 'paid_amount deve ser maior que zero (item ' + (i + 1) + ')' });
    }
    ids.push(String(it.id)); pagos.push(pago);
  }
  try {
    var r = await db.query(quadro.sqlDaBaixaEmLote(), [cid, ids, paidAt, forma, pagos]);
    var feitos = r.rows.map(function(x) { return x.id; });
    var skipped = ids.filter(function(id) { return feitos.indexOf(id) === -1; });
    var total = r.rows.reduce(function(a, x) { return a + (parseFloat(x.amount) || 0); }, 0);
    res.json({ updated: feitos.length, skipped: skipped, total: Math.round(total * 100) / 100 });
  } catch (err) { console.error('[transactions] baixa em lote:', err.message); res.status(500).json({ error: 'Erro ao dar baixa nos lancamentos' }); }
});

router.post('/', async function(req, res) {
  var cid = req.params.id;
  var body = req.body;
  if (!body.type || (body.type !== 'income' && body.type !== 'expense')) return res.status(400).json({ error: 'type deve ser income ou expense' });
  if (!body.amount || parseFloat(body.amount) <= 0) return res.status(400).json({ error: 'amount deve ser maior que zero' });
  if (!body.description || !String(body.description).trim()) return res.status(400).json({ error: 'description e obrigatoria' });
  var finalStatus = (body.status === 'pending') ? 'pending' : 'confirmed';
  var dueDate = body.due_date || todayBR();
  var recurrenceType = body.recurrence_type || null;
  var recurrenceCount = parseInt(body.recurrence_count) || 0;
  if (recurrenceType && !RECURRENCE_DEFAULTS[recurrenceType]) return res.status(400).json({ error: 'recurrence_type deve ser weekly, monthly ou yearly' });
  if (recurrenceType) {
    if (recurrenceCount <= 0) recurrenceCount = RECURRENCE_DEFAULTS[recurrenceType];
    recurrenceCount = Math.min(recurrenceCount, RECURRENCE_MAX[recurrenceType]);
  }
  var paymentMethod = body.payment_method || null;
  if (paymentMethod && VALID_PAYMENTS.indexOf(paymentMethod) === -1) return res.status(400).json({ error: 'payment_method invalido (aceitos: ' + VALID_PAYMENTS.join(', ') + ')' });
  var employeeId = body.employee_id || null;
  var employeeName = body.employee_name || null;
  if (employeeId) {
    try {
      var empRes = await db.query('SELECT id, name FROM employees WHERE id = $1 AND company_id = $2', [employeeId, cid]);
      if (!empRes.rows.length) return res.status(404).json({ error: 'Funcionario nao encontrado' });
      employeeName = empRes.rows[0].name;
    } catch (err) { console.error('[transactions] validate employee:', err.message); }
  }
  // 28/09/2026 (valor pago): cadastrar "ja paguei" com a data e o valor pagos.
  // due_date continua sendo o vencimento; paid_at vira a data do pagamento
  // (meia-noite SP) e, se o valor pago for outro, amount = pago e
  // original_amount = valor do boleto. Sem paid_at, a baixa e agora (como antes).
  var paidAtDate = body.paid_at || null;
  if (paidAtDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(paidAtDate))) return res.status(400).json({ error: 'paid_at deve ser uma data (AAAA-MM-DD)' });
  var paidAmountBody = null;
  if (body.paid_amount !== undefined && body.paid_amount !== null && body.paid_amount !== '') {
    paidAmountBody = Math.round(parseFloat(body.paid_amount) * 100) / 100;
    if (!(paidAmountBody > 0)) return res.status(400).json({ error: 'paid_amount deve ser maior que zero' });
  }
  function valoresDaBaixa(status) {
    var valor = parseFloat(body.amount);
    if (status === 'confirmed' && paidAmountBody !== null && Math.abs(paidAmountBody - valor) >= 0.005) return { amount: paidAmountBody, original: valor };
    return { amount: valor, original: null };
  }
  // 29/09/2026 (hotfix): em producao status e o enum transaction_status. O
  // $8::text da F1 virava texto -> enum na coluna, que o Postgres nao converte
  // sozinho (42804), e todo cadastro dava 500. "Esta pago?" vai num booleano
  // proprio e o status segue sem cast, com o tipo que a coluna tiver.
  var PAID_AT_SQL = "CASE WHEN $15::boolean THEN COALESCE($13::date + INTERVAL '3 hours', NOW()) END";
  try {
    if (!recurrenceType) {
      var v = valoresDaBaixa(finalStatus);
      var result = await db.query(
        'INSERT INTO transactions (company_id, type, amount, description, category, notes, due_date, status, paid_at, created_by, payment_method, employee_id, employee_name, original_amount)' +
        ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ' + PAID_AT_SQL + ', $9, $10, $11, $12, $14)' +
        ' RETURNING id, type, amount, original_amount, description, category, status, due_date, paid_at, created_at, payment_method, employee_id, employee_name',
        [cid, body.type, v.amount, String(body.description).trim(), body.category || 'Outros',
         body.notes || null, dueDate, finalStatus, req.user?.id || null, paymentMethod, employeeId, employeeName,
         finalStatus === 'confirmed' ? paidAtDate : null, v.original, finalStatus === 'confirmed']
      );
      var tx = result.rows[0];
      return res.status(201).json({ id: tx.id, type: tx.type, amount: parseFloat(tx.amount), original_amount: tx.original_amount == null ? null : parseFloat(tx.original_amount), description: tx.description, category: tx.category, status: tx.status, due_date: tx.due_date, paid_at: tx.paid_at, created_at: tx.created_at, payment_method: tx.payment_method, employee_id: tx.employee_id, employee_name: tx.employee_name });
    }
    var groupId = crypto.randomUUID();
    var amount = parseFloat(body.amount); var description = String(body.description).trim();
    var category = body.category || 'Outros'; var notes = body.notes || null; var userId = req.user?.id || null;
    var created = [];
    for (var i = 0; i < recurrenceCount; i++) {
      var itemDueDate = advanceDate(dueDate, recurrenceType, i);
      var itemStatus = i === 0 ? finalStatus : 'pending';
      // Data e valor pagos so valem para a 1a ocorrencia (as outras nascem pendentes).
      var itemValores = valoresDaBaixa(itemStatus);
      // $16 citado sempre: parametro enviado e nao citado quebra o Postgres.
      var itemPaidAt = "CASE WHEN $18::boolean THEN COALESCE($16::date + INTERVAL '3 hours', NOW()) END";
      var r = await db.query(
        'INSERT INTO transactions (company_id, type, amount, description, category, notes, due_date, status, paid_at, created_by, recurrence_type, recurrence_group_id, recurrence_index, payment_method, employee_id, employee_name, original_amount)' +
        ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ' + itemPaidAt + ', $9, $10, $11, $12, $13, $14, $15, $17)' +
        ' RETURNING id, type, amount, description, category, status, due_date, recurrence_index',
        [cid, body.type, itemValores.amount, description, category, notes, itemDueDate, itemStatus, userId, recurrenceType, groupId, i, paymentMethod, employeeId, employeeName,
         itemStatus === 'confirmed' ? paidAtDate : null, itemValores.original, itemStatus === 'confirmed']
      );
      created.push(r.rows[0]);
    }
    res.status(201).json({
      recurrence: { type: recurrenceType, label: RECURRENCE_LABELS[recurrenceType], group_id: groupId, count: created.length, first_date: created[0]?.due_date, last_date: created[created.length - 1]?.due_date },
      transactions: created.map(function(tx) { return { id: tx.id, type: tx.type, amount: parseFloat(tx.amount), description: tx.description, category: tx.category, status: tx.status, due_date: tx.due_date, recurrence_index: tx.recurrence_index }; }),
    });
  } catch (err) { console.error('[transactions] create:', err.message); res.status(500).json({ error: 'Erro ao criar lancamento' }); }
});

router.patch('/:txId', async function(req, res) {
  var cid = req.params.id; var txId = req.params.txId;
  var fields = ['type', 'amount', 'description', 'category', 'status', 'notes', 'due_date', 'payment_method', 'employee_id', 'employee_name'];
  var updates = [], values = []; var idx = 1;
  if (req.body.payment_method !== undefined && req.body.payment_method !== null) {
    if (VALID_PAYMENTS.indexOf(req.body.payment_method) === -1) return res.status(400).json({ error: 'payment_method invalido (aceitos: ' + VALID_PAYMENTS.join(', ') + ')' });
  }
  if (req.body.employee_id !== undefined && req.body.employee_id !== null) {
    try {
      var empRes = await db.query('SELECT id, name FROM employees WHERE id = $1 AND company_id = $2', [req.body.employee_id, cid]);
      if (!empRes.rows.length) return res.status(404).json({ error: 'Funcionario nao encontrado' });
      req.body.employee_name = empRes.rows[0].name;
    } catch (err) { console.error('[transactions] validate employee:', err.message); }
  } else if (req.body.employee_id === null) { req.body.employee_name = null; }
  // 17/09/2026 (Finesse, venda 2307): o "A Receber" do crediario e derivado
  // das parcelas e das devolucoes. O modal "Editar lancamento" guardava o valor
  // de quando abriu; a lojista removeu um item (devolucao abateu 159,90) e o
  // Salvar regravou o valor antigo por cima do abatimento. Valor igual ao atual
  // passa (o modal sempre manda amount); valor diferente e recusado.
  // 28/09/2026 (Quadro do Financeiro): o quadro da baixa mandando status.
  // No crediario isso passaria por fora das parcelas (credit_installments) e
  // do saldo do cliente — a baixa do crediario e so pela tela do Crediario.
  if (req.body.paid_at !== undefined && req.body.paid_at !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.paid_at))) {
    return res.status(400).json({ error: 'paid_at deve ser uma data (AAAA-MM-DD)' });
  }
  // 28/09/2026 (valor pago): baixa com valor diferente do boleto. amount vira o
  // valor pago (o que saiu do caixa, e o que os relatorios ja somam) e o valor
  // do boleto fica em original_amount. Sem calculo de juros: a lojista digita
  // o que pagou.
  var paidAmount = null;
  if (req.body.paid_amount !== undefined && req.body.paid_amount !== null) {
    paidAmount = parseFloat(req.body.paid_amount);
    if (!(paidAmount > 0)) return res.status(400).json({ error: 'paid_amount deve ser maior que zero' });
    if (req.body.status !== 'confirmed') return res.status(400).json({ error: 'paid_amount so vale junto de status confirmed' });
    paidAmount = Math.round(paidAmount * 100) / 100;
    delete req.body.amount;
  }
  if (req.body.amount !== undefined || req.body.status !== undefined || paidAmount !== null) {
    try {
      var curRes = await db.query('SELECT amount, idempotency_key, category, status FROM transactions WHERE id = $1 AND company_id = $2', [txId, cid]);
      var cur = curRes.rows[0];
      if (cur && req.body.status !== undefined && cur.status !== undefined && req.body.status !== cur.status && quadro.eCrediario(cur)) {
        return res.status(409).json({
          error: 'O crediário tem baixa própria, parcela a parcela. Para registrar ou desfazer um recebimento, use a tela do Crediário.',
          code: 'CREDIT_STATUS_DERIVED',
        });
      }
      if (cur && paidAmount !== null && quadro.eCrediario(cur)) {
        return res.status(409).json({
          error: 'O crediário tem baixa própria, parcela a parcela. Para registrar ou desfazer um recebimento, use a tela do Crediário.',
          code: 'CREDIT_STATUS_DERIVED',
        });
      }
      var link = cur ? resolveSaleLink(cur.idempotency_key) : null;
      if (req.body.amount !== undefined && link && link.source === 'credit') {
        if (Math.abs(parseFloat(req.body.amount) - parseFloat(cur.amount)) > 0.005) {
          return res.status(409).json({
            error: 'O valor do crediário acompanha as parcelas e as devoluções e não pode ser editado aqui. Para mudar o valor, faça uma devolução ou troca.',
            code: 'CREDIT_AMOUNT_DERIVED',
            current_amount: parseFloat(cur.amount),
          });
        }
        delete req.body.amount;
      }
    } catch (err) { console.error('[transactions] check credit amount:', err.message); return res.status(500).json({ error: 'Erro ao atualizar lancamento' }); }
  }
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (req.body[f] !== undefined) { updates.push(f + ' = $' + idx); values.push(f === 'amount' ? parseFloat(req.body[f]) : req.body[f]); idx++; }
  }
  // Baixa com data escolhida (quadro): meia-noite SP, mesma convencao '+3h'
  // do sync de sales.created_at. Voltar para pendente limpa a data da baixa —
  // antes ficava gravada e o "desfazer" deixava rastro.
  if (req.body.status === 'pending') {
    updates.push('paid_at = NULL');
    // Desfazer a baixa devolve o valor do boleto (se a baixa tinha mudado o valor).
    if (req.body.amount === undefined) updates.push('amount = COALESCE(original_amount, amount)');
    updates.push('original_amount = NULL');
  } else if (req.body.status === 'confirmed' && req.body.paid_at) {
    updates.push("paid_at = ($" + idx + "::date + INTERVAL '3 hours')"); values.push(req.body.paid_at); idx++;
  } else if (req.body.status === 'confirmed') {
    updates.push('paid_at = COALESCE(paid_at, NOW())');
  }
  if (paidAmount !== null) {
    // O SET le a linha antiga: original_amount guarda o valor do boleto uma vez
    // so (corrigir o valor pago de novo nao perde o original); pagar
    // exatamente o valor do boleto limpa a coluna.
    updates.push('original_amount = CASE WHEN ABS($' + idx + '::numeric - COALESCE(original_amount, amount)) < 0.005 THEN NULL ELSE COALESCE(original_amount, amount) END');
    updates.push('amount = $' + idx + '::numeric');
    values.push(paidAmount); idx++;
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()'); values.push(txId, cid);
  try {
    var result = await db.query('UPDATE transactions SET ' + updates.join(', ') + ' WHERE id = $' + idx + ' AND company_id = $' + (idx + 1) + ' RETURNING *', values);
    if (!result.rows.length) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    var updated = result.rows[0];
    var saleId = extractSaleId(updated.idempotency_key);
    if (saleId) {
      var saleUpdates = [], saleValues = []; var saleIdx = 1;
      if (req.body.payment_method !== undefined) { saleUpdates.push('payment_method = $' + (saleIdx++)); saleValues.push(req.body.payment_method); }
      if (req.body.employee_id !== undefined) {
        saleUpdates.push('seller_id = $' + (saleIdx++)); saleValues.push(req.body.employee_id);
        saleUpdates.push('employee_id = $' + (saleIdx++)); saleValues.push(req.body.employee_id);
        saleUpdates.push('seller_name = $' + (saleIdx++)); saleValues.push(req.body.employee_name);
      }
      // TIMEZONE FIX 13/05/2026: sincroniza due_date -> sales.created_at (meia-noite SP).
      // Permite corrigir a data de uma venda PDV pelo modal "Editar lancamento".
      // date::date + INTERVAL '3 hours' = 03:00 UTC = meia-noite America/Sao_Paulo (UTC-3 fixo).
      if (req.body.due_date !== undefined && req.body.due_date) {
        saleUpdates.push("created_at = ($" + saleIdx + "::date + INTERVAL '3 hours')");
        saleValues.push(req.body.due_date);
        saleIdx++;
      }
      if (saleUpdates.length > 0) {
        saleUpdates.push('updated_at = NOW()'); saleValues.push(saleId, cid);
        await db.query('UPDATE sales SET ' + saleUpdates.join(', ') + ' WHERE id = $' + saleIdx + ' AND company_id = $' + (saleIdx + 1), saleValues).catch(function(err) { console.error('[transactions] sync sale:', err.message); });
      }
    }
    res.json(updated);
  } catch (err) { console.error('[transactions] update:', err.message); res.status(500).json({ error: 'Erro ao atualizar lancamento' }); }
});

router.delete('/:txId', async function(req, res) {
  var cid = req.params.id; var txId = req.params.txId;
  try {
    await db.query('UPDATE bank_statement_entries SET matched_transaction_id = NULL WHERE matched_transaction_id = $1', [txId]).catch(function() {});
    await db.query('UPDATE nfce_emissions SET transaction_id = NULL WHERE transaction_id = $1', [txId]).catch(function() {});
    var result = await db.query('DELETE FROM transactions WHERE id = $1 AND company_id = $2 RETURNING id, recurrence_group_id', [txId, cid]);
    if (!result.rows.length) return res.status(404).json({ error: 'Lancamento nao encontrado' });
    res.json({ deleted: true, id: txId, recurrence_group_id: result.rows[0].recurrence_group_id || null });
  } catch (err) {
    console.error('[transactions] delete:', err.message, err.code);
    if (err.code === '23503') return res.status(409).json({ error: 'Este lancamento esta vinculado a outros registros e nao pode ser excluido.', code: 'FK_VIOLATION' });
    res.status(500).json({ error: 'Erro ao deletar lancamento' });
  }
});

router.delete('/group/:groupId', async function(req, res) {
  var cid = req.params.id; var groupId = req.params.groupId;
  try {
    await db.query("UPDATE bank_statement_entries SET matched_transaction_id = NULL WHERE matched_transaction_id IN (SELECT id FROM transactions WHERE recurrence_group_id = $1 AND company_id = $2 AND status = 'pending')", [groupId, cid]).catch(function() {});
    var result = await db.query("DELETE FROM transactions WHERE recurrence_group_id = $1 AND company_id = $2 AND status = 'pending' RETURNING id", [groupId, cid]);
    res.json({ deleted: true, group_id: groupId, count: result.rows.length });
  } catch (err) { console.error('[transactions] delete group:', err.message); res.status(500).json({ error: 'Erro ao deletar grupo recorrente' }); }
});

module.exports = router;
