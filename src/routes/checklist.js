// ============================================================
// AURA. — CORE-02: Checklist Mensal Inteligente
// Gerado automaticamente por regime + vertical
// LINGUAGEM: sempre "estimativa"/"apoio" — nunca "declaração oficial"
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// ── Templates de itens por regime/vertical ────────────────────
// due_day: dia do mês do vencimento (null = sem vencimento fixo)
function buildChecklistItems(company, refMonth) {
  const { tax_regime, vertical_active } = company;
  // refMonth: Date object (primeiro dia do mês)
  const year  = refMonth.getFullYear();
  const month = refMonth.getMonth() + 1; // 1-12
  const pad   = (n) => String(n).padStart(2,'0');

  const items = [];
  let order = 0;

  // ── MEI ────────────────────────────────────────────────────
  if (tax_regime === 'mei') {
    items.push({
      code:         'DAS_MEI',
      category:     'fiscal',
      title:        'Pagar DAS-MEI',
      description:  `Boleto mensal do MEI referente a ${pad(month)}/${year}. Estimativa calculada pela Aura — valor oficial no portal Gov.br.`,
      due_date:     `${year}-${pad(month)}-20`,
      applies_to_regime: 'mei',
      is_required:  true,
      sort_order:   order++,
    });
    items.push({
      code:         'LIMITE_MEI',
      category:     'fiscal',
      title:        'Verificar limite de faturamento MEI',
      description:  'Acompanhe o faturamento acumulado. Limite anual: R$81.000. Se ultrapassar 20%, você pode precisar desenquadrar.',
      due_date:     null,
      applies_to_regime: 'mei',
      is_required:  true,
      sort_order:   order++,
    });
    // DASN-SIMEI só em maio
    if (month === 5) {
      items.push({
        code:         'DASN_SIMEI',
        category:     'fiscal',
        title:        'Entregar Declaração Anual DASN-SIMEI',
        description:  'Declaração anual do MEI com o faturamento do ano anterior. Vencimento: 31/05. A Aura consolida os dados — transmissão no portal Gov.br.',
        due_date:     `${year}-05-31`,
        applies_to_regime: 'mei',
        is_required:  true,
        sort_order:   order++,
      });
    }
    items.push({
      code:         'NFS_MEI',
      category:     'fiscal',
      title:        'Emitir notas fiscais das vendas para PJ',
      description:  'Para vendas acima de R$400 para pessoa jurídica, a emissão de NFS-e é obrigatória. A Aura pode emitir automaticamente.',
      due_date:     null,
      applies_to_regime: 'mei',
      is_required:  false,
      sort_order:   order++,
    });
  }

  // ── Simples Nacional (ME/EPP) ──────────────────────────────
  if (tax_regime === 'simples_nacional') {
    items.push({
      code:         'PGDAS_D',
      category:     'fiscal',
      title:        'Apurar e pagar PGDAS-D',
      description:  `Apuração mensal do Simples Nacional referente a ${pad(month)}/${year}. Vencimento: dia 20. A Aura calcula a estimativa — transmissão oficial via PGDAS no portal Receita Federal.`,
      due_date:     `${year}-${pad(month)}-20`,
      applies_to_regime: 'simples_nacional',
      is_required:  true,
      sort_order:   order++,
    });
    // DEFIS em março (declaração do exercício anterior)
    if (month === 3) {
      items.push({
        code:         'DEFIS',
        category:     'fiscal',
        title:        'Entregar DEFIS',
        description:  'Declaração de Informações Socioeconômicas e Fiscais do Simples Nacional. Vencimento: 31/03. Transmissão pelo seu contador ou analista.',
        due_date:     `${year}-03-31`,
        applies_to_regime: 'simples_nacional',
        is_required:  true,
        sort_order:   order++,
      });
    }
    items.push({
      code:         'RECEITA_BRUTA_SN',
      category:     'fiscal',
      title:        'Lançar receitas brutas do mês',
      description:  'Certifique-se de que todos os recebimentos foram lançados para que a estimativa do PGDAS-D seja precisa.',
      due_date:     `${year}-${pad(month)}-15`,
      applies_to_regime: 'simples_nacional',
      is_required:  true,
      sort_order:   order++,
    });
  }

  // ── Trabalhista (ambos os regimes se tem funcionários) ─────
  // Inserido condicionalmente — o GET verifica se há funcionários ativos
  items.push({
    code:         'FOLHA_PAGAMENTO',
    category:     'trabalhista',
    title:        'Fechar folha de pagamento',
    description:  `Calcular salários, INSS, IRRF e FGTS dos funcionários referente a ${pad(month)}/${year}. A Aura calcula automaticamente.`,
    due_date:     `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`, // último dia do mês
    applies_to_regime: null, // todos
    is_required:  false, // marcado required dinamicamente se há funcionários
    sort_order:   order++,
  });
  items.push({
    code:         'FGTS',
    category:     'trabalhista',
    title:        'Recolher FGTS',
    description:  'Vencimento: dia 7 do mês seguinte. Guia gerada automaticamente junto com a folha.',
    due_date:     (() => {
      const d = new Date(year, month, 7); // mês seguinte, dia 7
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-07`;
    })(),
    applies_to_regime: null,
    is_required:  false,
    sort_order:   order++,
  });
  items.push({
    code:         'ESOCIAL',
    category:     'trabalhista',
    title:        'Enviar S-1200 e S-1299 ao eSocial',
    description:  'Evento de remuneração e fechamento do mês no eSocial. Vencimento: dia 15. A Aura gera os XMLs — transmissão no portal Gov.br.',
    due_date:     `${year}-${pad(month)}-15`,
    applies_to_regime: null,
    is_required:  false,
    sort_order:   order++,
  });

  // ── Operacional (todos) ────────────────────────────────────
  items.push({
    code:         'CONTAS_RECEBER',
    category:     'operacional',
    title:        'Revisar contas a receber em aberto',
    description:  'Verificar cobranças pendentes e acionar clientes inadimplentes.',
    due_date:     null,
    applies_to_regime: null,
    is_required:  false,
    sort_order:   order++,
  });
  items.push({
    code:         'RETIRADA_SOCIO',
    category:     'operacional',
    title:        'Definir retirada do sócio',
    description:  'Com base no saldo do mês, defina o valor da sua retirada. A Aura calcula o valor seguro automaticamente.',
    due_date:     null,
    applies_to_regime: null,
    is_required:  false,
    sort_order:   order++,
  });

  // ── Verticais ─────────────────────────────────────────────
  if (vertical_active === 'odonto') {
    items.push({
      code:         'PRONTUARIOS_ODONTO',
      category:     'vertical',
      title:        'Verificar prontuários em dia',
      description:  'Certifique-se de que todos os pacientes atendidos no mês têm prontuário atualizado e assinado.',
      due_date:     `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`,
      applies_to_vertical: 'odonto',
      is_required:  true,
      sort_order:   order++,
    });
    items.push({
      code:         'BACKUP_PRONTUARIOS',
      category:     'vertical',
      title:        'Confirmar backup de prontuários',
      description:  'CFO exige guarda de prontuários por 20 anos. Verifique se o backup está ativo.',
      due_date:     null,
      applies_to_vertical: 'odonto',
      is_required:  false,
      sort_order:   order++,
    });
  }

  if (vertical_active === 'salao') {
    items.push({
      code:         'COMISSOES_SALAO',
      category:     'vertical',
      title:        'Fechar comissões dos profissionais',
      description:  'Calcular e registrar comissões de cabelereiros, manicures e demais profissionais do mês.',
      due_date:     `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`,
      applies_to_vertical: 'salao',
      is_required:  true,
      sort_order:   order++,
    });
  }

  if (vertical_active === 'food') {
    items.push({
      code:         'VIGILANCIA_SANITARIA',
      category:     'vertical',
      title:        'Verificar validade de licenças sanitárias',
      description:  'Confirme que o alvará sanitário e demais licenças estão válidos.',
      due_date:     null,
      applies_to_vertical: 'food',
      is_required:  false,
      sort_order:   order++,
    });
  }

  return items;
}

// ── Helper: gera checklist no banco ───────────────────────────
async function _generateChecklist(company, refMonthDate, client) {
  const refMonth = new Date(
    refMonthDate.getFullYear(), refMonthDate.getMonth(), 1
  );
  const refStr = refMonth.toISOString().slice(0,10); // YYYY-MM-01

  const items = buildChecklistItems(company, refMonth);

  // Verifica se há funcionários ativos para marcar itens trabalhistas como required
  const { rows: empRows } = await (client || db).query(
    `SELECT COUNT(*) AS cnt FROM employees WHERE company_id=$1 AND is_active=TRUE`,
    [company.id]
  );
  const hasEmployees = parseInt(empRows[0]?.cnt || 0) > 0;

  for (const item of items) {
    // Pula itens trabalhistas se não tem funcionários
    if (item.category === 'trabalhista' && !hasEmployees) continue;

    const required = item.is_required || (item.category === 'trabalhista' && hasEmployees);
    await (client || db).query(
      `INSERT INTO monthly_checklist
         (company_id, reference_month, code, category, title, description,
          due_date, applies_to_regime, applies_to_vertical, is_required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (company_id, reference_month, code) DO NOTHING`,
      [
        company.id, refStr,
        item.code, item.category, item.title, item.description || null,
        item.due_date || null,
        item.applies_to_regime || null,
        item.applies_to_vertical || null,
        required,
        item.sort_order,
      ]
    );
  }
  return items.length;
}

// ── ROTAS ─────────────────────────────────────────────────────

// GET /companies/:id/checklist?month=2026-03
// Retorna checklist do mês (gera automaticamente se não existir)
router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { month } = req.query; // formato YYYY-MM, padrão = mês atual

  let refDate;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    refDate = new Date(y, m - 1, 1);
  } else {
    const now = new Date();
    refDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const refStr = refDate.toISOString().slice(0, 10);

  try {
    // Busca empresa
    const { rows: companies } = await db.query(
      `SELECT id, tax_regime, vertical_active, legal_name, trade_name
       FROM companies WHERE id=$1 AND (owner_id=$2 OR id IN (
         SELECT company_id FROM company_members WHERE user_id=$2 AND is_active=TRUE
       ))`,
      [cid, req.user.id]
    );
    if (!companies.length) return res.status(403).json({ error: 'Acesso negado' });
    const company = companies[0];

    // Gera se ainda não tem itens para este mês
    const { rows: existing } = await db.query(
      `SELECT COUNT(*) AS cnt FROM monthly_checklist
       WHERE company_id=$1 AND reference_month=$2`,
      [cid, refStr]
    );
    if (parseInt(existing[0].cnt) === 0) {
      await _generateChecklist(company, refDate, null);
    }

    // Busca itens
    const { rows: items } = await db.query(
      `SELECT * FROM monthly_checklist
       WHERE company_id=$1 AND reference_month=$2
       ORDER BY sort_order, due_date NULLS LAST`,
      [cid, refStr]
    );

    // Calcular progresso e streak
    const total    = items.filter(i => i.is_required).length;
    const done     = items.filter(i => i.is_required && i.status === 'done').length;
    const overdue  = items.filter(i => {
      if (i.status !== 'pending') return false;
      if (!i.due_date) return false;
      return new Date(i.due_date) < new Date();
    }).length;

    // Streak: meses consecutivos com 100% de itens required concluídos
    const { rows: streakRows } = await db.query(
      `SELECT COUNT(*) AS streak FROM (
         SELECT reference_month,
           COUNT(*) FILTER (WHERE is_required) AS total_req,
           COUNT(*) FILTER (WHERE is_required AND status='done') AS done_req
         FROM monthly_checklist
         WHERE company_id=$1
         GROUP BY reference_month
         HAVING COUNT(*) FILTER (WHERE is_required) =
                COUNT(*) FILTER (WHERE is_required AND status='done')
         ORDER BY reference_month DESC
       ) sub`,
      [cid]
    );

    res.json({
      reference_month:  refStr,
      company_name:     company.trade_name || company.legal_name,
      tax_regime:       company.tax_regime,
      vertical_active:  company.vertical_active,
      progress: {
        total_required: total,
        done,
        pct: total > 0 ? Math.round(done / total * 100) : 100,
        overdue,
        streak_months: parseInt(streakRows[0]?.streak || 0),
      },
      items: items.map(i => ({
        id:               i.id,
        code:             i.code,
        category:         i.category,
        title:            i.title,
        description:      i.description,
        due_date:         i.due_date,
        status:           i.status,
        is_required:      i.is_required,
        done_at:          i.done_at,
        notes:            i.notes,
        is_overdue:       i.status === 'pending' && i.due_date && new Date(i.due_date) < new Date(),
        sort_order:       i.sort_order,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/checklist/history
// Histórico de meses com progresso
router.get('/history', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { months = 12 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT
         to_char(reference_month,'YYYY-MM')               AS month,
         COUNT(*) FILTER (WHERE is_required)              AS total_required,
         COUNT(*) FILTER (WHERE is_required AND status='done') AS done,
         COUNT(*) FILTER (WHERE status='overdue')         AS overdue
       FROM monthly_checklist
       WHERE company_id=$1
       GROUP BY reference_month
       ORDER BY reference_month DESC
       LIMIT $2`,
      [cid, months]
    );
    res.json(rows.map(r => ({
      month:          r.month,
      total_required: parseInt(r.total_required),
      done:           parseInt(r.done),
      pct:            r.total_required > 0 ? Math.round(r.done / r.total_required * 100) : 100,
      overdue:        parseInt(r.overdue),
      complete:       parseInt(r.total_required) === parseInt(r.done),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /companies/:id/checklist/:itemId
// Marcar item como feito / pendente / pulado
router.patch('/:itemId', requireAuth, async (req, res) => {
  const { status, notes } = req.body;
  const validStatuses = ['pending','done','skipped'];
  if (!status || !validStatuses.includes(status))
    return res.status(400).json({ error: `status deve ser: ${validStatuses.join(' | ')}` });

  try {
    const { rows } = await db.query(
      `UPDATE monthly_checklist
       SET status   = $1,
           done_at  = CASE WHEN $1='done' THEN NOW() ELSE NULL END,
           done_by  = CASE WHEN $1='done' THEN $2    ELSE NULL END,
           notes    = COALESCE($3, notes),
           updated_at = NOW()
       WHERE id=$4 AND company_id=$5
       RETURNING *`,
      [status, req.user.id, notes||null, req.params.itemId, req.params.id]
    );
    if (!rows.length)
      return res.status(404).json({ error: 'Item não encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/checklist/generate
// Força (re)geração do checklist de um mês
// Útil ao mudar regime ou vertical no meio do mês
router.post('/generate', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { month } = req.body;
  let refDate;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    refDate = new Date(y, m - 1, 1);
  } else {
    const now = new Date();
    refDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  try {
    const { rows: companies } = await db.query(
      `SELECT id, tax_regime, vertical_active FROM companies
       WHERE id=$1 AND owner_id=$2`,
      [cid, req.user.id]
    );
    if (!companies.length) return res.status(403).json({ error: 'Acesso negado' });

    const count = await _generateChecklist(companies[0], refDate, null);
    res.json({
      ok: true,
      month: refDate.toISOString().slice(0,7),
      items_generated: count,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/checklist/today
// Itens urgentes do dia (vencimento hoje ou atrasados)
router.get('/today', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT mc.*
       FROM monthly_checklist mc
       WHERE mc.company_id = $1
         AND mc.status = 'pending'
         AND mc.due_date <= NOW()::date + INTERVAL '3 days'
       ORDER BY mc.due_date ASC NULLS LAST
       LIMIT 10`,
      [cid]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { checklistRouter: router, generateChecklist: _generateChecklist };
