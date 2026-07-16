// ============================================================
// AURA KARATÊ — Fase 5: Financeiro (valores em aberto segmentados)
// GET /federation/:id/financial/open-items
//
// Duas correntes de cobrança DISTINTAS, retornadas SEGMENTADAS
// (nunca somadas num número só):
//   1) pretas    — faixas-pretas ativas com anuidade individual em atraso
//                  (karate_member_standing.financeiro = 'atrasado')
//   2) dojos     — dojôs filiados ativos com taxa administrativa 2026
//                  em atraso (karate_dojo_standing.financeiro = 'atrasado')
//
// Fonte: VIEWs já existentes (karate_member_standing, karate_dojo_standing).
// Nenhuma migration nova nesta fase.
//
// Correção 2 — a federação cobra POR DOJÔ (sensei), não preta a preta.
// pretas.items[] agora inclui dojo_id (além de dojo_nome/whatsapp já
// existentes) para o frontend agrupar a worklist por dojô.
//
// Guard: adminOnly() — financeiro é sensível (RBAC §7.3), mesmo padrão de
// karateAnnuities.js / karateFinancial.js.
//
// Defensivo 42P01/42703: se as VIEWs ainda não existirem no ambiente
// (deployment parcial), retorna estrutura vazia em vez de 500.
//
// Este endpoint é SOMENTE LEITURA. Não dispara e-mail nem qualquer ação
// irreversível — apenas expõe os dados para o workflow de cobrança do
// frontend (seleção + "preparar cobrança").
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

const EMPTY_RESULT = {
  pretas: { count: 0, total: 0, items: [] },
  dojos: { count: 0, items: [] },
};

// GET /federation/:id/financial/open-items
router.get('/open-items', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;

  try {
    const [pretasRes, dojosRes] = await Promise.all([
      db.query(
        `SELECT
           m.student_id,
           m.full_name,
           m.karate_registration_number,
           m.whatsapp,
           m.dojo_id,
           COALESCE(c.trade_name, c.legal_name) AS dojo_nome,
           m.valor_em_aberto,
           m.annuity_due_date
         FROM karate_member_standing m
         LEFT JOIN companies c ON c.id = m.dojo_id
         WHERE m.federation_id = $1 AND m.financeiro = 'atrasado'
         ORDER BY m.full_name`,
        [federationId]
      ),
      db.query(
        `SELECT dojo_id, nome
         FROM karate_dojo_standing
         WHERE federation_id = $1 AND financeiro = 'atrasado'
         ORDER BY nome`,
        [federationId]
      ),
    ]);

    const pretasItems = pretasRes.rows.map((r) => ({
      student_id: r.student_id,
      full_name: r.full_name,
      karate_registration_number: r.karate_registration_number,
      whatsapp: r.whatsapp,
      dojo_id: r.dojo_id,
      dojo_nome: r.dojo_nome,
      valor_em_aberto: r.valor_em_aberto != null ? parseFloat(r.valor_em_aberto) : 0,
      annuity_due_date: r.annuity_due_date,
    }));

    const pretasTotal = pretasItems.reduce((sum, it) => sum + (it.valor_em_aberto || 0), 0);

    const dojosItems = dojosRes.rows.map((r) => ({
      dojo_id: r.dojo_id,
      nome: r.nome,
    }));

    res.json({
      pretas: {
        count: pretasItems.length,
        total: pretasTotal,
        items: pretasItems,
      },
      dojos: {
        count: dojosItems.length,
        items: dojosItems,
      },
    });
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      // VIEW/coluna ainda não existe (deployment parcial) — fallback seguro.
      console.warn('[karateOpenItems] view/coluna ausente (', err.code, '), retornando vazio:', err.message);
      return res.json(EMPTY_RESULT);
    }
    console.error('[karateOpenItems] open-items error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar valores em aberto' });
  }
});

module.exports = router;
