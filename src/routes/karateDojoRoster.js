// ============================================================
// AURA KARATÊ — Fase 4: Roster do dojô (status + financeiro)
// GET /federation/:id/dojos/:dojoId/members-standing
//
// Lista os praticantes de um dojô específico com dois badges:
//   - status (is_active): Ativo / Inativo
//   - financeiro: só se aplica a faixa-preta (is_black_belt=true).
//     Para os demais, financeiro='nao_aplicavel' (não exibir badge).
//
// PAGINAÇÃO NO SERVIDOR (11/07/2026) — dojôs grandes (um deles com ~400
// praticantes) faziam o detalhe do dojô baixar e renderizar o quadro inteiro:
//   ?status=all|active|inactive   (default: all)
//   ?page=1&pageSize=50           (default 50, máx 100)
//   ?q=texto                      (busca por nome ou matrícula, opcional)
//   ?all=1                        (desliga o LIMIT — lista completa)
//
// Contrato de resposta:
//   { data, total, page, pageSize, summary }
//   - total   → nº de linhas do RECORTE atual (status + q), para o pager
//   - summary → contagens do quadro INTEIRO do dojô (independem de status/q/página):
//       { total, active, inactive,
//         black_belt_total,        // faixas-pretas ATIVAS (universo cobrável)
//         black_belt_inactive,     // faixas-pretas inativas (nunca geram cobrança)
//         black_belt_paid, black_belt_overdue, black_belt_sem_cobranca }
//     black_belt_total === black_belt_paid + black_belt_overdue + black_belt_sem_cobranca
//     SEMPRE (ver src/services/karateStandingQueries.js — fonte única deste
//     agregado; guarda-corpo em __tests__/karate.blackBeltAggregatesGuard.test.js).
//     O detalhe do dojô usa summary para os KPIs (Total/Ativos/Inativos e o bloco
//     de faixas-pretas) sem precisar da lista inteira em memória.
//
// Compatibilidade: sem `page`/`pageSize` a rota mantém o comportamento antigo
// (lista completa, sem LIMIT) — clientes antigos / bundle em cache não quebram.
// `all=1` é o modo explícito usado pelo modal de Redistribuição, que precisa de
// TODOS os praticantes ativos de uma vez.
//
// Fonte: VIEW karate_member_standing (já existe no banco — sem migration).
// Colunas relevantes: student_id, federation_id, dojo_id, full_name,
//   karate_registration_number, is_active, belt_level, belt_name,
//   is_black_belt, financeiro ('nao_aplicavel'|'sem_cobranca'|'em_dia'|'atrasado'),
//   valor_em_aberto.
//
// Código defensivo (CLAUDE.md — schema antes da migration): se a view ainda
// não existir (42P01) ou alguma coluna estiver ausente (42703), degrada para
// uma página vazia em vez de 500.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { blackBeltAggregatesSql, EMPTY_BLACK_BELT_AGGREGATES } = require('../services/karateStandingQueries');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const EMPTY_SUMMARY = Object.freeze({
  total: 0,
  active: 0,
  inactive: 0,
  ...EMPTY_BLACK_BELT_AGGREGATES,
});

const isTruthy = (v) => v === '1' || v === 'true' || v === true;

// COUNT do recorte — usado quando a página volta vazia (OFFSET além do fim),
// caso em que COUNT(*) OVER() não tem linha onde vir.
async function countSlice(where, whereParams) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM karate_member_standing WHERE ${where}`,
    whereParams
  );
  return rows[0] ? rows[0].n : 0;
}

// ── GET /federation/:id/dojos/:dojoId/members-standing ─────
router.get('/:dojoId/members-standing', ...guards.read(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  // status: all (default) | active | inactive
  const statusRaw = String(req.query.status || 'all').toLowerCase();
  const status = statusRaw === 'active' || statusRaw === 'inactive' ? statusRaw : 'all';

  const q = String(req.query.q || '').trim();

  // Lista completa quando `all=1` (explícito) OU quando nenhum parâmetro de
  // paginação é enviado (compat com o cliente antigo).
  const wantsAll =
    isTruthy(req.query.all) ||
    (req.query.page === undefined && req.query.pageSize === undefined);

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE)
  );
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * pageSize;

  try {
    // ── WHERE dinâmico (recorte: status + busca) ──────────────
    const whereParams = [federationId, dojoId];
    let where = 'federation_id = $1 AND dojo_id = $2';

    if (status === 'active') where += ' AND is_active = true';
    if (status === 'inactive') where += ' AND is_active = false';

    if (q) {
      whereParams.push(`%${q}%`);
      where += ` AND (full_name ILIKE $${whereParams.length} OR karate_registration_number ILIKE $${whereParams.length})`;
    }

    // COUNT(*) OVER() devolve o total do recorte na MESMA query da página —
    // sem 2ª ida ao banco para o pager.
    const params = whereParams.slice();
    let sql = `SELECT student_id, full_name, karate_registration_number, is_active,
                      belt_level, belt_name, is_black_belt, financeiro, valor_em_aberto,
                      COUNT(*) OVER() AS total_count
               FROM karate_member_standing
               WHERE ${where}
               ORDER BY is_active DESC, is_black_belt DESC, full_name ASC`;

    if (!wantsAll) {
      params.push(pageSize, offset);
      sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }

    const { rows } = await db.query(sql, params);

    const total = rows.length
      ? parseInt(rows[0].total_count, 10) || 0
      : await countSlice(where, whereParams);

    // ── Sumário do quadro INTEIRO (ignora status / q / página) ────
    // Alimenta os KPIs da tela; agregado no banco, não em JS sobre a lista.
    // ⚠️ BUGFIX (12/07/2026): `black_belt_total` era um COUNT(*) cru sobre
    // is_black_belt — contava faixas-pretas INATIVAS junto (139 em vez de 82
    // no dojô bb5e5cd9-...). paid/overdue já vinham gateados por is_active
    // via `financeiro` (a view só popula financeiro para ativos; inativo →
    // 'nao_aplicavel'), então paid+overdue nunca fechava com o total. Mesma
    // classe do bug já corrigido em karateStandingSummary.js (665 vs 549) —
    // agora as duas rotas usam o MESMO fragmento SQL compartilhado
    // (karateStandingQueries.blackBeltAggregatesSql) para nunca mais
    // divergir. black_belt_inactive e black_belt_sem_cobranca expõem o
    // resto explicitamente em vez de escondê-lo dentro do total.
    const sumRes = await db.query(
      `SELECT COUNT(*)::int                          AS total,
              COUNT(*) FILTER (WHERE is_active)::int     AS active,
              COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive,
              ${blackBeltAggregatesSql()}
       FROM karate_member_standing
       WHERE federation_id = $1 AND dojo_id = $2`,
      [federationId, dojoId]
    );

    const data = rows.map(({ total_count, ...r }) => r);

    res.json({
      data,
      total,
      page: wantsAll ? 1 : page,
      pageSize: wantsAll ? data.length : pageSize,
      summary: sumRes.rows[0] || { ...EMPTY_SUMMARY },
    });
  } catch (err) {
    // View ainda não existe (42P01) ou coluna ausente (42703) — degrada em vez
    // de derrubar a rota (backend pode subir antes da view ser aplicada; mesmo
    // padrão das demais rotas karate).
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateDojoRoster] view/coluna ausente (schema pendente):', err.message);
      return res.json({
        data: [],
        total: 0,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        summary: { ...EMPTY_SUMMARY },
      });
    }
    console.error('[karateDojoRoster] members-standing error:', err.message);
    res.status(500).json({ error: 'Erro ao listar roster do dojô', detail: err.message });
  }
});

module.exports = router;
