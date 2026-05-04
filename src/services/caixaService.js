// ============================================================
// AURA. — caixaService.js
// Lógica de negócio do módulo de Abertura/Fechamento de Caixa
// ============================================================

const pool = require('../config/database');
const AppError = require('../errors/AppError');

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Verifica se o caixa está habilitado para a empresa.
 * O toggle é armazenado em companies.pdv_settings.caixa_enabled (boolean).
 */
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
 */
async function getSessaoAberta(companyId) {
  const { rows } = await pool.query(
    `SELECT cs.*, 
            u.full_name AS opened_by_name
     FROM caixa_sessoes cs
     JOIN users u ON u.id = cs.opened_by
     WHERE cs.company_id = $1 AND cs.status = 'aberta'
     LIMIT 1`,
    [companyId]
  );
  return rows[0] || null;
}

/**
 * Calcula totais por forma de pagamento para uma sessão/período.
 *
 * Estratégia dupla:
 *   1. Pagamentos vinculados via sessao_id (preciso)
 *   2. Fallback por período (opened_at → closed_at/NOW) para pagamentos
 *      registrados antes de sessao_id ser preenchido.
 *
 * Fonte: sale_payments (PDV) + transactions income confirmadas.
 */
async function calcularTotais(companyId, sessaoId, openedAt, closedAt) {
  const until = closedAt || new Date();

  // -- Totais de sale_payments (PDV) por método
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

  // -- Receitas avulsas confirmadas em transactions (sem método, totaliza como "outros")
  const { rows: txRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total
     FROM transactions
     WHERE company_id = $1
       AND type = 'income'
       AND status = 'confirmed'
       AND paid_at >= $2
       AND paid_at < $3`,
    [companyId, openedAt, until]
  );

  // Montar objeto de totais
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

  // Arredondar tudo para 2 casas
  for (const k of Object.keys(totais)) {
    totais[k] = Math.round(totais[k] * 100) / 100;
  }

  return totais;
}

// ── Operações públicas ────────────────────────────────────────────────────

/**
 * Abre uma nova sessão de caixa para a empresa.
 * Rejeita se já houver uma sessão aberta (UNIQUE INDEX + check explícito).
 */
async function abrir(companyId, userId, trocoInicial = 0) {
  await assertCaixaEnabled(companyId);

  const existente = await getSessaoAberta(companyId);
  if (existente) {
    throw new AppError(
      `Já existe um caixa aberto desde ${new Date(existente.opened_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. Feche-o antes de abrir um novo.`,
      409
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO caixa_sessoes (company_id, opened_by, troco_inicial)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [companyId, userId, trocoInicial]
  );

  return rows[0];
}

/**
 * Retorna o status atual do caixa:
 * - sessao_ativa com totais ao vivo, se houver sessão aberta
 * - null caso contrário
 */
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
        id:   sessao.opened_by,
        name: sessao.opened_by_name,
      },
      totais_ao_vivo: totais,
    },
  };
}

/**
 * Fecha a sessão aberta atual.
 * Cria o snapshot em caixa_fechamentos e marca a sessão como 'fechada'.
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
  try {
    await client.query('BEGIN');

    // 1. Fechar a sessão
    await client.query(
      `UPDATE caixa_sessoes
       SET status = 'fechada', closed_at = $1, closed_by = $2
       WHERE id = $3`,
      [closedAt, userId, sessao.id]
    );

    // 2. Salvar o snapshot do fechamento
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
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lista o histórico de sessões fechadas com seus fechamentos.
 */
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
       u_open.full_name  AS opened_by_name,
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

/**
 * Retorna o detalhe de uma sessão específica pelo ID.
 */
async function getSessao(companyId, sessaoId) {
  await assertCaixaEnabled(companyId);

  const { rows } = await pool.query(
    `SELECT
       cs.*,
       u_open.full_name  AS opened_by_name,
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
     LEFT JOIN caixa_fechamentos cf ON cf.sessao_id = cs.id
     WHERE cs.id = $1 AND cs.company_id = $2`,
    [sessaoId, companyId]
  );

  if (!rows.length) throw new AppError('Sessão não encontrada', 404);
  return rows[0];
}

module.exports = { abrir, getStatus, fechar, getHistorico, getSessao };
