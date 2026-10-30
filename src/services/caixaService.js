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
//
// 13/06/2026 (contabilizar venda no crediário):
// - calcularTotais agora soma as VENDAS no crediário no bucket `fiado`.
//   A venda no crediário não gera sale_payments (vira "A Receber"), então
//   nunca aparecia no caixa. Lemos os débitos de venda
//   (customer_credit_transactions type='debit' com sale_id) na janela da
//   sessão. Entra no total_geral mas NÃO no dinheiro_esperado (não houve
//   entrada de caixa). Quando o cliente paga depois, o recebimento gera
//   sale_payments (dinheiro/pix) na sessão daquele dia — contabilizado lá,
//   sem dupla contagem (o débito fica preso à sessão da venda).
//
// 12/08/2026 (CRITICAL FIX fechamento × troca v2 — caso Davi 11/08):
// - calcularTotais agora EXCLUI os sale_payments NEGATIVOS de vendas
//   type='troca'. A trocaV2 grava uma row de -returnedValue (valor dos
//   itens devolvidos) para manter SUM(sale_payments) = faturamento líquido
//   em janelas longas (PR #55) — mas os paymentSplits da troca já são o
//   LÍQUIDO pago pelo cliente. Na visão POR SESSÃO, a row negativa
//   subtraía a devolução em dobro: fechamento da Villa Branca 11/08
//   imprimiu R$40 num dia com R$229,99 de entradas (pix -189,99 + pix
//   +100 + cartão 129,99); troca par-a-par na Matriz imprimiu -R$159,99.
//   O dinheiro do item devolvido entrou no caixa na sessão da VENDA
//   ORIGINAL — não sai do caixa de hoje, a menos que haja reembolso real.
// - Reembolso real ao cliente (troca_payouts) agora É descontado do
//   bucket do método (dinheiro/pix/estorno de cartão) — antes, devolver
//   dinheiro vivo ao cliente não reduzia o dinheiro_esperado.
//   'crediario_credito' não desconta (vira crédito na carteira do
//   cliente, nenhum dinheiro sai da gaveta).
// - calcularTotais e calcularMetricas agora ignoram vendas CANCELADAS
//   (sale_payments de venda cancelada contavam no fechamento).
// - calcularMetricas: sales_count filtrava status='active', mas vendas
//   usam 'completed'/'cancelled' — a contagem de vendas do PDF saía 0
//   desde sempre. Agora conta status <> 'cancelled'. Nova métrica
//   total_vendas (SUM sales.total_amount, fonte única de "vendas" —
//   ver fonte_unica_vendas_09mai2026) para o PDF separar "Vendas do
//   período" de "Entradas no caixa" (total_geral).
//
// 30/10/2026 (sangria e suprimento, migration 422):
// - caixa_movimentos: retirada (sangria) e reforço (suprimento) de dinheiro
//   da gaveta com o caixa aberto. Não são vendas: ficam fora de
//   totais.geral e só mexem no dinheiro esperado. getStatus devolve os dois
//   totais e dinheiro_em_caixa; fechar() desconta sangrias e soma
//   suprimentos no dinheiro_esperado e grava os totais no snapshot
//   (total_sangrias/total_suprimentos). Tudo defensivo à migration ausente
//   (42P01/42703, cache de módulo), como manda o CLAUDE.md.
// ============================================================

const pool = require('../config/database');
const AppError = require('../errors/AppError');

const TIPOS_DE_MOVIMENTO = ['sangria', 'suprimento'];
const MOTIVO_MAX = 200;
const MOVIMENTO_MAXIMO = 1000000;

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function brl(n) { return 'R$ ' + r2(n).toFixed(2).replace('.', ','); }

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

// ── Movimentações da sessão (30/10/2026, migration 422) ─────────────────
// null = ainda não sabemos se a migration 422 está no banco; false = não
// está (tabela/colunas ausentes), e as leituras seguem com zeros; true =
// está. O deploy roda a migration antes de subir o app, então o cache não
// precisa expirar.
let movimentosDisponiveis = null;

/** Só para testes. */
function _resetCache() { movimentosDisponiveis = null; }

async function calcularMovimentos(sessaoId) {
  const zero = { sangrias: 0, suprimentos: 0 };
  if (movimentosDisponiveis === false) return zero;
  try {
    const { rows } = await pool.query(
      `SELECT tipo, COALESCE(SUM(valor), 0)::numeric(12,2) AS total
         FROM caixa_movimentos
        WHERE sessao_id = $1
        GROUP BY tipo`,
      [sessaoId]
    );
    movimentosDisponiveis = true;
    const out = { ...zero };
    for (const row of rows) {
      const v = parseFloat(row.total) || 0;
      if (row.tipo === 'sangria') out.sangrias = r2(v);
      else if (row.tipo === 'suprimento') out.suprimentos = r2(v);
    }
    return out;
  } catch (err) {
    if (err.code === '42P01') { movimentosDisponiveis = false; return zero; }
    throw err;
  }
}

/** Dinheiro que deve estar na gaveta agora: troco + vendas em dinheiro
 *  (já líquidas de reembolso) + suprimentos − sangrias. */
function dinheiroEmCaixa(trocoInicial, totais, mov) {
  return r2(parseFloat(trocoInicial) + totais.dinheiro + mov.suprimentos - mov.sangrias);
}

/** Roda a consulta com as colunas da 422; se o banco ainda não as tem
 *  (42703/42P01), roda de novo sem elas e lembra. */
async function tentarComMovimentos(run) {
  if (movimentosDisponiveis === false) return run(false);
  try {
    const r = await run(true);
    movimentosDisponiveis = true;
    return r;
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') {
      movimentosDisponiveis = false;
      return run(false);
    }
    throw err;
  }
}

async function listarMovimentosDaSessao(sessaoId) {
  if (movimentosDisponiveis === false) return [];
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.tipo, m.valor, m.motivo, m.created_at,
              COALESCE(u.full_name, '') AS created_by_name
         FROM caixa_movimentos m
         LEFT JOIN users u ON u.id = m.created_by
        WHERE m.sessao_id = $1
        ORDER BY m.created_at DESC, m.id DESC`,
      [sessaoId]
    );
    movimentosDisponiveis = true;
    return rows.map((m) => ({ ...m, valor: parseFloat(m.valor) }));
  } catch (err) {
    if (err.code === '42P01') { movimentosDisponiveis = false; return []; }
    throw err;
  }
}

async function calcularTotais(companyId, sessaoId, openedAt, closedAt) {
  const until = closedAt || new Date();

  // 12/08/2026: dois filtros novos na fonte principal:
  //   1) COALESCE(s.status,'completed') <> 'cancelled' — pagamento de venda
  //      cancelada não pode contar no caixa.
  //   2) NOT (sp.amount < 0 AND s.type = 'troca') — a row negativa de
  //      -returnedValue que a trocaV2 grava é um artefato contábil de
  //      "faturamento líquido" entre sessões (compensa o payment da venda
  //      ORIGINAL, registrado na sessão do dia da venda original). Na
  //      visão por sessão ela subtraía a devolução em dobro, porque os
  //      splits positivos da troca já são só o líquido pago hoje.
  //      Reembolso real ao cliente sai do caixa via troca_payouts (abaixo).
  const { rows: spRows } = await pool.query(
    `SELECT
       sp.method,
       COALESCE(SUM(sp.amount), 0)::numeric(12,2) AS total
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     WHERE sp.company_id = $1
       AND COALESCE(s.status, 'completed') <> 'cancelled'
       AND NOT (sp.amount < 0 AND COALESCE(s.type, 'sale') = 'troca')
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

  // 13/06/2026: VENDA no crediário entra no fechamento como linha `fiado`.
  // A venda no crediário não gera sale_payments (vira "A Receber" pendente),
  // então lemos os débitos de venda do ledger de crédito
  // (customer_credit_transactions type='debit' com sale_id) na janela da
  // sessão. NÃO afeta o dinheiro_esperado (fechar() só usa totais.dinheiro).
  // Sem dupla contagem: quando o cliente paga depois, o recebimento gera
  // sale_payments (dinheiro/pix) na sessão daquele dia — o débito permanece
  // na sessão da venda. Defensivo a deploy parcial (42P01/42703).
  let fiadoVendas = 0;
  try {
    const { rows: fiadoRows } = await pool.query(
      `SELECT COALESCE(SUM(cct.amount), 0)::numeric(12,2) AS total
         FROM customer_credit_transactions cct
         JOIN sales s ON s.id = cct.sale_id
        WHERE cct.company_id = $1
          AND cct.type = 'debit'
          AND cct.sale_id IS NOT NULL
          AND cct.created_at >= $2
          AND cct.created_at < $3
          AND COALESCE(s.status, 'active') <> 'cancelled'`,
      [companyId, openedAt, until]
    );
    fiadoVendas = parseFloat(fiadoRows[0]?.total || 0);
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') throw err;
    fiadoVendas = 0;
  }

  const totais = {
    pix:            0,
    cartao_debito:  0,
    cartao_credito: 0,
    dinheiro:       0,
    fiado:          fiadoVendas,
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

  // 12/08/2026: reembolsos REAIS ao cliente (troca_payouts) saem do caixa
  // da sessão — descontam o bucket do método. 'crediario_credito' fica de
  // fora: vira crédito na carteira (customer_credit_transactions), nenhum
  // dinheiro sai da gaveta. Defensivo a deploy parcial (42P01/42703),
  // mesmo padrão do bloco de fiado acima.
  let devolucoes = 0;
  try {
    const { rows: poRows } = await pool.query(
      `SELECT tp.method,
              COALESCE(SUM(tp.amount), 0)::numeric(12,2) AS total
         FROM troca_payouts tp
        WHERE tp.company_id = $1
          AND (
            tp.sessao_id = $2
            OR (
              tp.sessao_id IS NULL
              AND tp.created_at >= $3
              AND tp.created_at < $4
            )
          )
        GROUP BY tp.method`,
      [companyId, sessaoId, openedAt, until]
    );
    for (const row of poRows) {
      const val = parseFloat(row.total);
      if (!Number.isFinite(val) || val <= 0) continue;
      switch (row.method) {
        case 'dinheiro':        totais.dinheiro       -= val; devolucoes += val; break;
        case 'pix':             totais.pix            -= val; devolucoes += val; break;
        case 'cartao_estorno':
        case 'cartao_credito':
        case 'credito':
        case 'cartao':          totais.cartao_credito -= val; devolucoes += val; break;
        case 'cartao_debito':
        case 'debito':          totais.cartao_debito  -= val; devolucoes += val; break;
        case 'crediario_credito': break; // crédito na carteira — não sai do caixa
        default:                totais.outros         -= val; devolucoes += val; break;
      }
    }
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') throw err;
  }

  totais.geral = Object.values(totais).reduce((acc, v) => acc + v, 0);
  for (const k of Object.keys(totais)) {
    totais[k] = Math.round(totais[k] * 100) / 100;
  }
  // Informativo (NÃO entra em totais.geral nem é persistido em
  // caixa_fechamentos — a tabela é snapshot imutável de colunas fixas).
  totais.devolucoes = Math.round(devolucoes * 100) / 100;
  return totais;
}

/**
 * Calcula metricas adicionais do dia (best-effort).
 * Retorna { sales_count, new_customers_count, total_vendas } com 0 em
 * caso de erro.
 *
 * total_vendas = SUM(sales.total_amount) da janela, status <> 'cancelled'
 * — a fonte única de "vendas" (regime competência), o MESMO número que a
 * tela de Vendas mostra. É deliberadamente DIFERENTE de totais.geral
 * (entradas no caixa por método): num dia com troca ou crediário os dois
 * divergem por design, e o PDF de fechamento mostra os dois com rótulos
 * distintos pra ninguém achar que "o caixa não bate".
 */
async function calcularMetricas(companyId, sessaoId, openedAt, closedAt) {
  const until = closedAt || new Date();
  const result = { sales_count: 0, new_customers_count: 0, total_vendas: 0 };

  try {
    // 12/08/2026: era COALESCE(s.status,'active') = 'active', mas vendas
    // usam 'completed'/'cancelled' — sales_count saía 0 em TODO fechamento.
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT s.id)::int AS c
       FROM sales s
       JOIN sale_payments sp ON sp.sale_id = s.id
       WHERE s.company_id = $1
         AND (sp.sessao_id = $2
              OR (sp.sessao_id IS NULL
                  AND s.created_at >= $3 AND s.created_at < $4))
         AND COALESCE(s.status, 'completed') <> 'cancelled'`,
      [companyId, sessaoId, openedAt, until]
    );
    result.sales_count = rows[0]?.c || 0;
  } catch (err) {
    // tabela ausente ou schema diferente — segue silenciosamente
  }

  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(s.total_amount), 0)::numeric(12,2) AS total
       FROM sales s
       WHERE s.company_id = $1
         AND s.created_at >= $2
         AND s.created_at < $3
         AND COALESCE(s.status, 'completed') <> 'cancelled'`,
      [companyId, openedAt, until]
    );
    result.total_vendas = parseFloat(rows[0]?.total || 0);
  } catch (err) {
    // idem
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
  const mov = await calcularMovimentos(sessao.id);

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
      // 30/10/2026 (422): o que saiu e entrou na gaveta fora das vendas, e
      // quanto deve estar nela agora.
      sangrias:         mov.sangrias,
      suprimentos:      mov.suprimentos,
      dinheiro_em_caixa: dinheiroEmCaixa(sessao.troco_inicial, totais, mov),
    },
  };
}

/**
 * Fecha a sessão aberta atual.
 * Retorna o snapshot enriquecido com:
 *   - sales_count, new_customers_count, total_vendas (metricas do dia)
 *   - total_devolucoes (reembolsos de troca que saíram do caixa)
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

  // 30/10/2026 (422): sangrias saem e suprimentos entram no esperado.
  const mov = await calcularMovimentos(sessao.id);
  const dinheiroEsperado = dinheiroEmCaixa(sessao.troco_inicial, totais, mov);

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

    // As colunas da 422 só entram quando a migration está no banco (a
    // tabela e as colunas chegam juntas). Dentro da transação não dá para
    // tentar e cair no fallback: um erro aborta a transação inteira.
    const comMovimentos = movimentosDisponiveis === true;
    const colunas = comMovimentos ? ', total_sangrias, total_suprimentos' : '';
    const valores = comMovimentos ? ', $12, $13' : '';
    const params = [
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
    ];
    if (comMovimentos) params.push(mov.sangrias, mov.suprimentos);

    const { rows } = await client.query(
      `INSERT INTO caixa_fechamentos (
         sessao_id,
         dinheiro_esperado, dinheiro_contado,
         total_pix, total_cartao_debito, total_cartao_credito,
         total_fiado, total_dinheiro, total_outros, total_geral,
         observacao${colunas}
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${valores})
       RETURNING *, (dinheiro_contado - dinheiro_esperado) AS diferenca`,
      params
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

  // Placar do dia no WhatsApp do dono (13/10/2026). Fire-and-forget: o
  // fechamento ja esta gravado e a resposta nao espera a fila. Desligado por
  // padrao; sem WhatsApp vira audit 'placar.sem_canal' e segue.
  try {
    require('./placarDoDia').dispararNoFechamento(companyId, { closedAt })
      .catch(() => {});
  } catch (_) { /* placar nunca derruba o fechamento */ }

  // sessao_label: '#' + 5 primeiros chars do UUID (estavel + curto)
  const sessao_label = '#' + String(sessao.id).replace(/-/g, '').slice(0, 5).toUpperCase();

  return {
    ...snapshot,
    closed_at: closedAt,
    sessao_label,
    sales_count: metricas.sales_count,
    new_customers_count: metricas.new_customers_count,
    total_vendas: metricas.total_vendas,
    total_devolucoes: totais.devolucoes,
    total_sangrias: mov.sangrias,
    total_suprimentos: mov.suprimentos,
  };
}

// ── Sangria e suprimento (30/10/2026, migration 422) ─────────────────────

/**
 * Registra uma retirada (sangria) ou um reforço (suprimento) na sessão
 * aberta. A sangria não pode passar do dinheiro que o sistema diz estar na
 * gaveta: acima disso é dedo errado ou venda que não foi lançada — e o
 * esperado do fechamento ficaria negativo.
 */
async function registrarMovimento(companyId, userId, { tipo, valor, motivo = null }) {
  if (!TIPOS_DE_MOVIMENTO.includes(tipo)) {
    throw new AppError('tipo deve ser sangria ou suprimento', 400);
  }
  const v = r2(valor);
  if (typeof valor !== 'number' || !Number.isFinite(valor) || v <= 0 || v > MOVIMENTO_MAXIMO) {
    throw new AppError('valor deve ser um número maior que zero', 400);
  }
  if (motivo !== null && motivo !== undefined && typeof motivo !== 'string') {
    throw new AppError('motivo deve ser texto', 400);
  }
  const motivoLimpo = motivo ? String(motivo).replace(/\s+/g, ' ').trim().slice(0, MOTIVO_MAX) : null;

  await assertCaixaEnabled(companyId);
  const sessao = await getSessaoAberta(companyId);
  if (!sessao) throw new AppError('Nenhum caixa aberto para esta empresa.', 404);

  const totais = await calcularTotais(companyId, sessao.id, sessao.opened_at, null);
  const antes = await calcularMovimentos(sessao.id);
  if (movimentosDisponiveis === false) {
    throw new AppError('Retiradas do caixa ainda não estão disponíveis neste ambiente.', 422);
  }
  const emCaixa = dinheiroEmCaixa(sessao.troco_inicial, totais, antes);
  if (tipo === 'sangria' && v > emCaixa + 0.004) {
    throw new AppError(
      `O caixa tem ${brl(emCaixa)} em dinheiro; não dá para retirar ${brl(v)}.`,
      422
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO caixa_movimentos (company_id, sessao_id, tipo, valor, motivo, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tipo, valor, motivo, created_at`,
    [companyId, sessao.id, tipo, v, motivoLimpo || null, userId]
  );
  const movimento = { ...rows[0], valor: parseFloat(rows[0].valor) };

  const depois = {
    sangrias:    r2(antes.sangrias + (tipo === 'sangria' ? v : 0)),
    suprimentos: r2(antes.suprimentos + (tipo === 'suprimento' ? v : 0)),
  };
  return {
    movimento,
    sangrias:          depois.sangrias,
    suprimentos:       depois.suprimentos,
    dinheiro_em_caixa: dinheiroEmCaixa(sessao.troco_inicial, totais, depois),
  };
}

/** As movimentações da sessão aberta (vazio sem caixa aberto). */
async function listarMovimentos(companyId) {
  await assertCaixaEnabled(companyId);
  const sessao = await getSessaoAberta(companyId);
  if (!sessao) return { sessao_id: null, movimentos: [], sangrias: 0, suprimentos: 0, dinheiro_em_caixa: 0 };
  const totais = await calcularTotais(companyId, sessao.id, sessao.opened_at, null);
  const mov = await calcularMovimentos(sessao.id);
  const movimentos = await listarMovimentosDaSessao(sessao.id);
  return {
    sessao_id:         sessao.id,
    movimentos,
    sangrias:          mov.sangrias,
    suprimentos:       mov.suprimentos,
    dinheiro_em_caixa: dinheiroEmCaixa(sessao.troco_inicial, totais, mov),
  };
}

/** Desfaz uma movimentação lançada errada — só enquanto a sessão dela
 *  está aberta (o fechamento congela o snapshot). */
async function removerMovimento(companyId, movimentoId) {
  await assertCaixaEnabled(companyId);
  const sessao = await getSessaoAberta(companyId);
  if (!sessao) throw new AppError('Nenhum caixa aberto para esta empresa.', 404);
  let rowCount = 0;
  try {
    const r = await pool.query(
      `DELETE FROM caixa_movimentos WHERE id = $1 AND company_id = $2 AND sessao_id = $3`,
      [movimentoId, companyId, sessao.id]
    );
    rowCount = r.rowCount;
  } catch (err) {
    if (err.code === '42P01' || err.code === '22P02') rowCount = 0;
    else throw err;
  }
  if (!rowCount) throw new AppError('Movimentação não encontrada nesta sessão.', 404);
  return listarMovimentos(companyId);
}

// LEITURA SEM GATE (07/10/2026): historico e detalhe mostram o que ja foi
// fechado mesmo com caixa_enabled desligado. A loja que desligou a chave
// depois de fechar caixas levava 403 aqui, e a aba "Fechamentos de caixa"
// — que consulta cada empresa do grupo — virava erro por inteiro. O gate
// continua em abrir, status e fechar.
async function getHistorico(companyId, { limit = 20, offset = 0, de, ate } = {}) {

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

  // 30/10/2026 (422): os totais de sangria/suprimento do snapshot, quando
  // o banco já os tem.
  const { rows } = await tentarComMovimentos((com) => pool.query(
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
       cf.observacao AS obs_fechamento${com ? ',\n       cf.total_sangrias,\n       cf.total_suprimentos' : ''}
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
  ));

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM caixa_sessoes
     WHERE company_id = $1 AND status = 'fechada'`,
    [companyId]
  );

  return { sessoes: rows, total: countRows[0].total };
}

async function getSessao(companyId, sessaoId) {
  const { rows } = await tentarComMovimentos((com) => pool.query(
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
       cf.observacao AS obs_fechamento${com ? ',\n       cf.total_sangrias,\n       cf.total_suprimentos' : ''}
     FROM caixa_sessoes cs
     JOIN users u_open  ON u_open.id  = cs.opened_by
     LEFT JOIN users u_close ON u_close.id = cs.closed_by
     LEFT JOIN employees e ON e.id = cs.opened_by_employee_id
     LEFT JOIN caixa_fechamentos cf ON cf.sessao_id = cs.id
     WHERE cs.id = $1 AND cs.company_id = $2`,
    [sessaoId, companyId]
  ));

  if (!rows.length) throw new AppError('Sessão não encontrada', 404);
  // 30/10/2026 (422): as movimentações da sessão, para o detalhe e o PDF.
  const movimentos = await listarMovimentosDaSessao(rows[0].id);
  return { ...rows[0], movimentos };
}

module.exports = {
  abrir, getStatus, fechar, getHistorico, getSessao,
  registrarMovimento, listarMovimentos, removerMovimento,
  _resetCache,
};
