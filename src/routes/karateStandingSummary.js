// ============================================================
// AURA KARATÊ — Fase 6: Painel + Saúde da rede refletindo o "standing"
// (ativo/inativo + em dia/atrasado + R$ em aberto).
// Montado em /federation/:id/standing/*
//
// Fonte de dados: VIEWs já existentes (não cria migration aqui):
//   - karate_member_standing(student_id, federation_id, dojo_id, is_active,
//     belt_level, is_black_belt, financeiro, valor_em_aberto)
//     financeiro ∈ {nao_aplicavel, sem_cobranca, em_dia, atrasado}; só
//     faz sentido (não-nulo) para faixa-preta (is_black_belt).
//   - karate_dojo_standing(dojo_id, federation_id, nome, is_active, financeiro)
//     financeiro ∈ {em_dia, atrasado, inativo}
//
// GET /federation/:id/standing/summary
//   {
//     praticantes: { ativos, inativos, total },
//     pretas:      { total (ATIVAS), inativas, em_dia, atrasado, sem_cobranca,
//                    valor_em_aberto },
//     dojos:       { ativos, em_dia, atrasado, inativos }
//   }
//   pretas.total === pretas.em_dia + pretas.atrasado + pretas.sem_cobranca SEMPRE
//   (invariante testada em __tests__/karate.blackBeltAggregatesGuard.test.js).
//
// Guards: FEDERATION_READ (guards.read()) — leitura nunca é bloqueada por
// plano (CLAUDE.md #3). Ambos Painel e Saúde da Rede consomem ESTE mesmo
// endpoint/fonte — nada é recomputado separadamente no cliente.
//
// Defensivo: se as views ainda não existirem (42P01) ou alguma coluna
// estiver ausente (42703) — deployment parcial — devolve zeros em vez de
// 500, seguindo a armadilha #1/#10 do CLAUDE.md do backend.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { blackBeltAggregatesSql } = require('../services/karateStandingQueries');

const EMPTY_SUMMARY = Object.freeze({
  praticantes: { ativos: 0, inativos: 0, total: 0 },
  pretas: { total: 0, inativas: 0, em_dia: 0, atrasado: 0, sem_cobranca: 0, valor_em_aberto: 0 },
  dojos: { ativos: 0, em_dia: 0, atrasado: 0, inativos: 0 },
});

// GET /federation/:id/standing/summary
router.get('/summary', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;

  try {
    // 1) Praticantes — total / ativos / inativos (karate_member_standing)
    const practRes = await db.query(
      `SELECT
         COUNT(*)::int                                  AS total,
         COUNT(*) FILTER (WHERE is_active)::int          AS ativos,
         COUNT(*) FILTER (WHERE NOT is_active)::int      AS inativos
       FROM karate_member_standing
       WHERE federation_id = $1`,
      [federationId]
    );
    const p = practRes.rows[0] || {};

    // 2) Faixas-pretas — total / em_dia / atrasado / sem_cobranca / valor_em_aberto
    //
    // ⚠️ BUGFIX (11/07/2026): `total` era um COUNT(*) cru sobre is_black_belt,
    // ou seja, contava faixas-pretas INATIVAS junto com as ativas (665 em vez
    // de 549 na FPKT). Como só faixa-preta ATIVA paga anuidade, esse total
    // nunca fechava com em_dia + atrasado (que a view já gateia por is_active,
    // devolvendo 'nao_aplicavel' para inativo). Não vazava para a UI hoje —
    // StandingCard só usa `total` como teste de "está vazio?" — mas a primeira
    // tela que exibisse o número mostraria 665 achando que era 549.
    // Agora `total` = pretas ATIVAS (o universo cobrável) e `inativas` expõe
    // o resto explicitamente, em vez de escondê-lo dentro do total.
    //
    // ⚠️ BUGFIX 2 (12/07/2026): esta mesma classe de bug reapareceu em
    // karateDojoRoster.js (139 vs 82 no dojô bb5e5cd9-...) porque a regra
    // "is_black_belt AND is_active" estava reimplementada à mão aqui e lá,
    // cada um com sua própria variação. Migrado para o fragmento SQL
    // compartilhado (karateStandingQueries.blackBeltAggregatesSql), que
    // TODO agregado de faixa-preta usa a partir de agora — nunca mais
    // reimplementar isto localmente. O WHERE externo `AND is_black_belt`
    // foi removido de propósito: os FILTERs abaixo já são autocontidos
    // (repetem is_black_belt AND is_active cada um), então não há mais
    // nenhuma dependência implícita de um WHERE externo para a contagem
    // fechar — a mesma armadilha que permitiu o bug se espalhar.
    // `sem_cobranca` é NOVO nesta correção: faixa-preta ativa sem anuidade
    // lançada na temporada ainda (não é inadimplência). Sem este bucket,
    // em_dia + atrasado nunca fechava com total quando havia pelo menos uma
    // preta ativa "sem_cobranca" (ex.: FPKT tinha 1 desses — 29 + 519 = 548,
    // não 549).
    const pretasRes = await db.query(
      `SELECT
         ${blackBeltAggregatesSql()},
         COALESCE(SUM(valor_em_aberto), 0)::numeric AS valor_em_aberto
       FROM karate_member_standing
       WHERE federation_id = $1`,
      [federationId]
    );
    const pt = pretasRes.rows[0] || {};

    // 3) Dojôs — ativos / em_dia / atrasado / inativos (karate_dojo_standing)
    const dojosRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE is_active)::int              AS ativos,
         COUNT(*) FILTER (WHERE financeiro = 'em_dia')::int   AS em_dia,
         COUNT(*) FILTER (WHERE financeiro = 'atrasado')::int AS atrasado,
         COUNT(*) FILTER (WHERE financeiro = 'inativo')::int  AS inativos
       FROM karate_dojo_standing
       WHERE federation_id = $1`,
      [federationId]
    );
    const d = dojosRes.rows[0] || {};

    res.json({
      praticantes: {
        ativos: parseInt(p.ativos || 0, 10),
        inativos: parseInt(p.inativos || 0, 10),
        total: parseInt(p.total || 0, 10),
      },
      pretas: {
        total: parseInt(pt.black_belt_total || 0, 10),           // pretas ATIVAS (universo cobrável)
        inativas: parseInt(pt.black_belt_inactive || 0, 10),     // pretas inativas (não geram cobrança)
        em_dia: parseInt(pt.black_belt_paid || 0, 10),
        atrasado: parseInt(pt.black_belt_overdue || 0, 10),
        sem_cobranca: parseInt(pt.black_belt_sem_cobranca || 0, 10),
        valor_em_aberto: Number(pt.valor_em_aberto || 0),
      },
      dojos: {
        ativos: parseInt(d.ativos || 0, 10),
        em_dia: parseInt(d.em_dia || 0, 10),
        atrasado: parseInt(d.atrasado || 0, 10),
        inativos: parseInt(d.inativos || 0, 10),
      },
    });
  } catch (err) {
    // 42P01 = view/tabela ausente; 42703 = coluna ausente (deployment parcial
    // das views). Em ambos os casos devolvemos zeros em vez de 500 — Painel e
    // Saúde da Rede continuam de pé mostrando "sem dados" em vez de quebrar.
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateStandingSummary] view/coluna ausente (' + err.code + '), devolvendo zeros:', err.message);
      return res.json(EMPTY_SUMMARY);
    }
    console.error('[karateStandingSummary] summary error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar resumo de standing' });
  }
});

module.exports = router;
