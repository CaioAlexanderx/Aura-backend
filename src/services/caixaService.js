// ============================================================
// AURA. — caixaService.js
// Lógica de negócio do módulo de Abertura/Fechamento de Caixa
//
// 07/05/2026:
// - abrir() aceita opcionalmente employeeId (responsavel operacional)
//   gravado em caixa_sessoes.opened_by_employee_id.
// - getStatus() prefere o nome do employee no header da sessao quando
//   houver vinculo; cai pro user.full_name caso contrario.
// - fechar() agora retorna metricas extras (sales_count,
//   new_customers_count, sessao_label, closed_at) usadas pelo PDF de
//   fechamento do aura-app.
//
// 08/05/2026 (hotfix):
// - abrir() agora valida employeeId contra a tabela employees antes do
//   INSERT. Previne FK violation caixa_sessoes_opened_by_employee_id_fkey
//   quando o front envia user.id (UUID auth) no lugar do employees.id.
//
// 09/05/2026 (CRITICAL FIX divergencia Davi 08/05):
// - calcularTotais agora EXCLUI transactions com idempotency_key começando
//   por 'pdv-sale-' ou 'pdv-troca-'. Antes, essas transactions (criadas
//   pelo proprio PDV em paralelo aos sale_payments) eram somadas em
//   total_outros, causando double-counting cada vez que uma venda
//   multi-payment gerava ambos os registros. total_outros agora reflete
//   apenas receitas verdadeiramente extras (income manual no Financeiro).
//
// 09/05/2026 (Opção A crediário):
// - calcularTotais também exclui 'pdv-credit-receivable-%'. Quando o
//   recebimento crediário é processado via /credit/customer/:cid/payment,
//   ele cria sale_payment + confirma a transaction A Receber. Sem o
//   filtro, o caixa contaria o valor 2× (uma via método, uma via outros).
// ============================================================

const pool = require('../config/database');
const AppError = require('../errors/AppError');

// ── Helpers ──────────────────────────────────────────────────────────────

async function assertCaixaEnabled(companyId) {
  const { rows } = await pool.query(
    `SELECT pdv_settings->>'caixa_enabled' AS caixa_enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) throw new AppError('Empresa não encontrada', 404);
  if (rows[0].caixa_enabled !== 'true') {
    throw new AppError(
      'Módulo de caixa não está habilitado. Ative em Configurações > PDV.',
      403
    );
  }
}

/**
 * Retorna a sessão aberta de uma empresa, ou null se não houver.
 * Faz LEFT JOIN com employees pra resolver o nome do operador
 * preferindo o employee escolhido no fluxo, caindo pro user autenticado.
 */
async function getSessaoAberta(companyId) {
  const { rows } = await pool.query(
    `SELECT cs.*,
            COALESCE(e.name, u.full_name) AS operator_name,
            CASE WHEN cs.opened_by_employee_id IS NOT NULL THEN cs.opened_by_employee_id
                 ELSE cs.opened_by
            END AS operator_id
     FROM caixa_sessoes cs
     JOIN users u ON u.id = cs.opened_by
     LEFT JOIN employees e ON e.id = cs.opened_by_employee_id
     WHERE cs.company_id = $1 AND cs.status = 'aberta'
     LIMIT 1`,
    [companyId]
  );
  return rows[0] || null;
}

async function calcularTotais(companyId, sessaoId, openedAt, closedAt) {
  const until = closedAt || new Date();

  const { rows: spRows } = await pool.query(
    `SELECT
       sp.method,
       COALESCE(SUM(sp.amount), 0)::numeric(12,2) AS total
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     WHERE sp.company_id = $1
       AND (
         sp.sessao_id = $2
         OR (
           sp.sessao_id IS NULL
           AND s.created_at >= $3
           AND s.created_at < $4
         )
       )
     GROUP BY sp.method`,
    [companyId, sessaoId, openedAt, until]
  );

  // 09/05/2026 FIX: exclui transactions criadas pelo PDV (já contabilizadas
  // em sale_payments). O filtro NOT LIKE 'pdv-sale-%'/'pdv-troca-%'/'pdv-credit-receivable-%'
  // deixa total_outros refletir apenas receitas verdadeiramente extras
  // (income manual lançado no Financeiro fora do fluxo PDV).
  //
  // 09/05/2026 (Opção A crediário): adicionado pdv-credit-receivable-* ao
  // filtro. Quando uma transaction "Crediário - A Receber" é confirmada
  // pelo POST /credit/customer/:cid/payment, paralelamente é criado um
  // sale_payment apontando para a sale original com a sessao_id ativa.
  // Sem este filtro, o caixa fechado contaria o recebimento DUAS vezes
  // (uma via sale_payments por método, outra via total_outros).
  const { rows: txRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total
     FROM transactions
     WHERE company_id = $1
       AND type = 'income'
       AND status = 'confirmed'
       AND paid_at >= $2
       AND paid_at < $3
       AND (
         idempotency_key IS NULL
         OR (
           idempotency_key NOT LIKE 'pdv-sale-%'
           AND idempotency_key NOT LIKE 'pdv-troca-%'
           AND idempotency_key NOT LIKE 'pdv-credit-receivable-%'
         )
       )`,
    [companyId, openedAt, until]
  );

  const totais = {
    pix:            0,
    cartao_debito:  0,
    cartao_credito: 0,
    dinheiro:       0,
    fiado:          0,
    outros:         parseFloat(txRows[0]?.total || 0),
  };

  for (const row of spRows) {
    const val = parseFloat(row.total);
    switch (row.method) {
      case 'pix':                          totais.pix            += val; break;
      case 'dinheiro':                     totais.dinheiro       += val; break;
      case 'cartao_debito':
      case 'debito':                       totais.cartao_debito  += val; break;
      case 'cartao_credito':
      case 'credito':
      case 'cartao':                       totais.cartao_credito += val; break;
      case 'fiado':                        totais.fiado          += val; break;
      default:                             totais.outros         += val; break;
    }
  }

  totais.geral = Object.values(totais).reduce((acc, v) => acc + v, 0);
  for (const k of Object.keys(totais)) {
    totais[k] = Math.round(totais[k] * 100) / 100;
  }
  return totais;
}

/**
 * Calcula metricas adicionais do dia (best-effort).
 * Retorna { sales_count, new_customers_count } com 0 em caso de erro.
 */
async function calcularMetricas(companyId, sessaoId, openedAt, closedAt) {
  const until = closedAt || new Date();
  const result = { sales_count: 0, new_customers_count: 0 };

  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT s.id)::int AS c
       FROM sales s
       JOIN sale_payments sp ON sp.sale_id = s.id
       WHERE s.company_id = $1
         AND (sp.sessao_id = $2
              OR (sp.sessao_id IS NULL
                  AND s.created_at >= $3 AND s.created_at < $4))
         AND COALESCE(s.status, 'active') = 'active'`,
      [companyId, sessaoId, openedAt, until]
    );
    result.sales_count = rows[0]?.c || 0;
  } catch (err) {
    // tabela ausente ou schema diferente — segue silenciosamente
  }

  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM customers
       WHERE company_id = $1
         AND created_at >= $2
         AND created_at < $3`,
      [companyId, openedAt, until]
    );
    result.new_customers_count = rows[0]?.c || 0;
  } catch (err) {
    // idem
  }

  return result;
}

// ── Operações públicas ────────────────────────────────────────────────────

/**
 * Abre uma nova sessão de caixa para a empresa.
 * @param {string|null} employeeId Funcionario operacional responsavel.
 *                                  Quando informado, valida contra a tabela
 *                                  employees antes do INSERT para evitar FK
 *                                  violation quando o front envia user.id
 *                                  (UUID do auth) em vez do employees.id.
 */
async function abrir(companyId, userId, trocoInicial = 0, employeeId = null) {
  await assertCaixaEnabled(companyId);

  const existente = await getSessaoAberta(companyId);
  if (existente) {
    throw new AppError(
      `Já existe um caixa aberto desde ${new Date(existente.opened_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. Feche-o antes de abrir um novo.`,
      409
    );
  }

  // Guard: verifica se employeeId é realmente um registro em employees.
  // Previne FK violation quando UI manda user.id (UUID do auth) no lugar
  // do employees.id. Se não encontrar, abre como opened_by apenas
  // (opened_by já registra quem abriu via auth UUID).
  let validEmployeeId = null;
  if (employeeId) {
    const { rows: empCheck } = await pool.query(
      'SELECT id FROM employees WHERE id = $1 AND company_id = $2',
      [employeeId, companyId]
    );
    validEmployeeId = empCheck.length ? employeeId : null;
  }

  const { rows } = await pool.query(
    `INSERT INTO caixa_sessoes (company_id, opened_by, opened_by_employee_id, troco_inicial)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [companyId, userId, validEmployeeId, trocoInicial]
  );

  return rows[0];
}

async function getStatus(companyId) {
  await assertCaixaEnabled(companyId);

  const sessao = await getSessaoAberta(companyId);
  if (!sessao) return { sessao_ativa: null };

  const totais = await calcularTotais(
    companyId,
    sessao.id,
    sessao.opened_at,
    null
  );

  return {
    sessao_ativa: {
      id:            sessao.id,
      opened_at:     sessao.opened_at,
      troco_inicial: parseFloat(sessao.troco_inicial),
      opened_by: {
        id:   sessao.operator_id,
        name: sessao.operator_name,
      },
      totais_ao_vivo: totais,
    },
  };
}

/**
 * Fecha a sessão aberta atual.
 * Retorna o snapshot enriquecido com:
 *   - sales_count, new_customers_count (metricas do dia)
 *   - sessao_label (#XXXXX baseado no UUID, util pra exibir/PDF)
 *   - closed_at (timestamp de fechamento)
 */
async function fechar(companyId, userId, dinheiroContado, observacao = null) {
  await assertCaixaEnabled(companyId);

  const sessao = await getSessaoAberta(companyId);
  if (!sessao) {
    throw new AppError('Nenhum caixa aberto para esta empresa.', 404);
  }

  const closedAt = new Date();
  const totais = await calcularTotais(
    companyId,
    sessao.id,
    sessao.opened_at,
    closedAt
  );

  const dinheiroEsperado =
    Math.round((parseFloat(sessao.troco_inicial) + totais.dinheiro) * 100) / 100;

  const client = await pool.connect();
  let snapshot;
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE caixa_sessoes
       SET status = 'fechada', closed_at = $1, closed_by = $2
       WHERE id = $3`,
      [closedAt, userId, sessao.id]
    );

    const { rows } = await client.query(
      `INSERT INTO caixa_fechamentos (
         sessao_id,
         dinheiro_esperado, dinheiro_contado,
         total_pix, total_cartao_debito, total_cartao_credito,
         total_fiado, total_dinheiro, total_outros, total_geral,
         observacao
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *, (dinheiro_contado - dinheiro_esperado) AS diferenca`,
      [
        sessao.id,
        dinheiroEsperado,
        dinheiroContado,
        totais.pix,
        totais.cartao_debito,
        totais.cartao_credito,
        totais.fiado,
        totais.dinheiro,
        totais.outros,
        totais.geral,
        observacao,
      ]
    );

    await client.query('COMMIT');
    snapshot = rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Metricas best-effort apos commit (nao impacta o snapshot)
  const metricas = await calcularMetricas(
    companyId,
    sessao.id,
    sessao.opened_at,
    closedAt
  );

  // sessao_label: '#' + 5 primeiros chars do UUID (estavel + curto)
  const sessao_label = '#' + String(sessao.id).replace(/-/g, '').slice(0, 5).toUpperCase();

  return {
    ...snapshot,
    closed_at: closedAt,
    sessao_label,
    sales_count: metricas.sales_count,
    new_customers_count: metricas.new_customers_count,
  };
}

async function getHistorico(companyId, { limit = 20, offset = 0, de, ate } = {}) {
  await assertCaixaEnabled(companyId);

  const params = [companyId, limit, offset];
  const dateFilter = [];

  if (de) {
    params.push(de);
    dateFilter.push(`cs.opened_at >= $${params.length}`);
  }
  if (ate) {
    params.push(ate);
    dateFilter.push(`cs.opened_at < $${params.length}`);
  }

  const where = dateFilter.length
    ? `AND ${dateFilter.join(' AND ')}`
    : '';

  const { rows } = await pool.query(
    `SELECT
       cs.id,
       cs.opened_at,
       cs.closed_at,
       cs.troco_inicial,
       cs.status,
       cs.observacao AS obs_sessao,
       COALESCE(e.name, u_open.full_name) AS opened_by_name,
       u_close.full_name AS closed_by_name,
       cf.dinheiro_esperado,
       cf.dinheiro_contado,
       cf.diferenca,
       cf.total_pix,
       cf.total_cartao_debito,
       cf.total_cartao_credito,
       cf.total_fiado,
       cf.total_dinheiro,
       cf.total_outros,
       cf.total_geral,
       cf.observacao AS obs_fechamento
     FROM caixa_sessoes cs
     JOIN users u_open  ON u_open.id  = cs.opened_by
     LEFT JOIN users u_close ON u_close.id = cs.closed_by
     LEFT JOIN employees e ON e.id = cs.opened_by_employee_id
     LEFT JOIN caixa_fechamentos cf ON cf.sessao_id = cs.id
     WHERE cs.company_id = $1
       AND cs.status = 'fechada'
       ${where}
     ORDER BY cs.opened_at DESC
     LIMIT $2 OFFSET $3`,
    params
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM caixa_sessoes
     WHERE company_id = $1 AND status = 'fechada'`,
    [companyId]
  );

  return { sessoes: rows, total: countRows[0].total };
}

async function getSessao(companyId, sessaoId) {
  await assertCaixaEnabled(companyId);

  const { rows } = await pool.query(
    `SELECT
       cs.*,
       COALESCE(e.name, u_open.full_name) AS opened_by_name,
       u_close.full_name AS closed_by_name,
       cf.dinheiro_esperado,
       cf.dinheiro_contado,
       cf.diferenca,
       cf.total_pix,
       cf.total_cartao_debito,
       cf.total_cartao_credito,
       cf.total_fiado,
       cf.total_dinheiro,
       cf.total_outros,
       cf.total_geral,
       cf.observacao AS obs_fechamento
     FROM caixa_sessoes cs
     JOIN users u_open  ON u_open.id  = cs.opened_by
     LEFT JOIN users u_close ON u_close.id = cs.closed_by
     LEFT JOIN employees e ON e.id = cs.opened_by_employee_id
     LEFT JOIN caixa_fechamentos cf ON cf.sessao_id = cs.id
     WHERE cs.id = $1 AND cs.company_id = $2`,
    [sessaoId, companyId]
  );

  if (!rows.length) throw new AppError('Sessão não encontrada', 404);
  return rows[0];
}

module.exports = { abrir, getStatus, fechar, getHistorico, getSessao };
