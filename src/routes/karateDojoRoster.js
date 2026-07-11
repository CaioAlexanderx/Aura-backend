// ============================================================
// AURA KARATÊ — Fase 4: Roster do dojô (status + financeiro)
// GET /federation/:id/dojos/:dojoId/members-standing
//
// Lista os praticantes de um dojô específico com dois badges:
//   - status (is_active): Ativo / Inativo
//   - financeiro: só se aplica a faixa-preta (is_black_belt=true).
//     Para os demais, financeiro='nao_aplicavel' (não exibir badge).
//
// Fonte: VIEW karate_member_standing (já existe no banco — sem migration
// nesta fase). Colunas relevantes:
//   student_id, federation_id, dojo_id, full_name,
//   karate_registration_number, is_active, belt_level, belt_name,
//   is_black_belt, financeiro ('nao_aplicavel'|'sem_cobranca'|'em_dia'|'atrasado'),
//   valor_em_aberto.
//
// Código defensivo (CLAUDE.md — armadilha_schema_pre_migration): se a view
// ainda não existir (42P01) ou alguma coluna estiver ausente (42703),
// degrada para { data: [] } em vez de 500.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

// ── GET /federation/:id/dojos/:dojoId/members-standing ─────
router.get('/:dojoId/members-standing', ...guards.read(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT student_id, full_name, karate_registration_number, is_active,
              belt_level, belt_name, is_black_belt, financeiro, valor_em_aberto
       FROM karate_member_standing
       WHERE federation_id = $1 AND dojo_id = $2
       ORDER BY is_active DESC, is_black_belt DESC, full_name ASC`,
      [federationId, dojoId]
    );

    res.json({ data: rows });
  } catch (err) {
    // View ainda não existe (42P01) ou coluna ausente (42703) — degrada em
    // vez de derrubar a rota (backend pode subir antes da migration/view
    // ser aplicada, mesmo padrão das demais rotas karate).
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateDojoRoster] view/coluna ausente (schema pendente):', err.message);
      return res.json({ data: [] });
    }
    console.error('[karateDojoRoster] members-standing error:', err.message);
    res.status(500).json({ error: 'Erro ao listar roster do dojô', detail: err.message });
  }
});

module.exports = router;
