// ============================================================
// AURA. — Primeiros passos da frente (05/10/2026)
//
// GET  /companies/:id/onboarding/first-steps
//      → { segment, dismissed, steps: [{ key, done }] }
// POST /companies/:id/onboarding/first-steps/dismiss
//      → { dismissed: true, dismissed_at }
//
// Montado em private.js (requireAuth + requireCompanyAccess vem de la).
// Por empresa (por CNPJ): cada empresa tem a sua frente e os seus passos.
// A conta nasce vazia (sem dados de exemplo); no primeiro acesso o app
// mostra os TRES primeiros passos da frente. Sem texto de interface aqui:
// o app tem os rotulos, o backend so devolve chaves estaveis.
//
// CHAVES (estaveis — o app depende delas):
//   otica:
//     laboratorio_cadastrado     optical_labs ativo da empresa
//     primeira_receita           optical_prescriptions da empresa
//     primeiro_pedido_de_lente   service_orders kind='otica' nao cancelada
//   matcon:
//     produtos_cadastrados       >= 1 produto ativo (proprio ou do grupo)
//     primeiro_orcamento         matcon_quotes da empresa
//     entrega_configurada        >= 1 matcon_deliveries da empresa. Nao ha
//                                "config de entrega" inequivoca: o prazo
//                                padrao (pdv_settings.matcon_default_delivery_days)
//                                tem default 2 e o PUT de Configuracoes grava
//                                todos os defaults, entao a presenca da chave
//                                nao prova que a loja configurou nada.
//   assistencia:
//     primeira_os                service_orders kind='reparo' (qualquer status)
//     termo_de_garantia_preenchido  pdv_settings.warranty_terms preenchido
//                                OU >= 1 garantia emitida (warranties)
//     pecas_ou_servicos_cadastrados >= 1 produto ativo (proprio ou do grupo)
//   studio:
//     catalogo_montado           >= 1 produto personalizavel ativo
//                                OU >= 1 studio_templates ativo
//     primeiro_orcamento         studio_quotes da empresa
//     primeiro_item_em_producao  pedido na esteira de producao:
//                                sales/digital_orders com
//                                studio_production_status preenchido
//   varejo / outro / NULL:
//     produtos_cadastrados       >= 1 produto ativo (proprio ou do grupo)
//     primeira_venda             sales nao cancelada
//     cliente_cadastrado         customers da empresa
//
// `done` e sempre um EXISTS (barato, para no primeiro registro).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

// Produto ativo da empresa ou compartilhado pelo grupo (multi-CNPJ), mesma
// regra de listVisibilityWhere em routes/products.js.
const PRODUCT_EXISTS = `EXISTS (
  SELECT 1 FROM products p
   WHERE p.is_active = true
     AND (p.company_id = $1 OR (
       p.is_group_shared = true
       AND p.company_id IN (
         SELECT id FROM companies
          WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
            SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
              FROM companies WHERE id = $1)))))`;

const STEPS_BY_SEGMENT = {
  otica: [
    ['laboratorio_cadastrado', `EXISTS (SELECT 1 FROM optical_labs WHERE company_id = $1 AND is_active = true)`],
    ['primeira_receita', `EXISTS (SELECT 1 FROM optical_prescriptions WHERE company_id = $1)`],
    ['primeiro_pedido_de_lente', `EXISTS (SELECT 1 FROM service_orders WHERE company_id = $1 AND kind = 'otica' AND status <> 'cancelada')`],
  ],
  matcon: [
    ['produtos_cadastrados', PRODUCT_EXISTS],
    ['primeiro_orcamento', `EXISTS (SELECT 1 FROM matcon_quotes WHERE company_id = $1)`],
    ['entrega_configurada', `EXISTS (SELECT 1 FROM matcon_deliveries WHERE company_id = $1)`],
  ],
  assistencia: [
    ['primeira_os', `EXISTS (SELECT 1 FROM service_orders WHERE company_id = $1 AND kind = 'reparo')`],
    ['termo_de_garantia_preenchido', `(
      EXISTS (SELECT 1 FROM companies
               WHERE id = $1 AND NULLIF(btrim(pdv_settings->>'warranty_terms'), '') IS NOT NULL)
      OR EXISTS (SELECT 1 FROM warranties WHERE company_id = $1))`],
    ['pecas_ou_servicos_cadastrados', PRODUCT_EXISTS],
  ],
  studio: [
    ['catalogo_montado', `(
      EXISTS (SELECT 1 FROM products WHERE company_id = $1 AND is_active = true AND is_personalizable = true)
      OR EXISTS (SELECT 1 FROM studio_templates WHERE company_id = $1 AND is_active = true))`],
    ['primeiro_orcamento', `EXISTS (SELECT 1 FROM studio_quotes WHERE company_id = $1)`],
    ['primeiro_item_em_producao', `(
      EXISTS (SELECT 1 FROM sales WHERE company_id = $1 AND studio_production_status IS NOT NULL)
      OR EXISTS (SELECT 1 FROM digital_orders WHERE company_id = $1 AND studio_production_status IS NOT NULL))`],
  ],
  varejo: [
    ['produtos_cadastrados', PRODUCT_EXISTS],
    ['primeira_venda', `EXISTS (SELECT 1 FROM sales WHERE company_id = $1 AND COALESCE(status, 'completed') <> 'cancelled')`],
    ['cliente_cadastrado', `EXISTS (SELECT 1 FROM customers WHERE company_id = $1)`],
  ],
};

function stepsFor(segment) {
  return STEPS_BY_SEGMENT[segment] || STEPS_BY_SEGMENT.varejo; // outro / NULL
}

// GET /companies/:id/onboarding/first-steps
router.get('/first-steps', asyncHandler(async (req, res) => {
  const cid = req.params.id;
  const { rows } = await db.query(
    'SELECT segment, onboarding_dismissed_at FROM companies WHERE id = $1',
    [cid]
  );
  if (!rows.length) throw new AppError('Empresa nao encontrada', 404);
  const segment = rows[0].segment || null;
  const steps = stepsFor(segment);

  // Uma consulta so, um EXISTS por coluna (s0, s1, s2). O SQL e fixo do
  // codigo; o unico parametro e o id da empresa.
  const sql = 'SELECT ' + steps.map(([, expr], i) => `${expr} AS s${i}`).join(', ');
  const { rows: done } = await db.query(sql, [cid]);
  const d = done[0] || {};

  res.json({
    segment,
    dismissed: !!rows[0].onboarding_dismissed_at,
    steps: steps.map(([key], i) => ({ key, done: d['s' + i] === true })),
  });
}));

// POST /companies/:id/onboarding/first-steps/dismiss
router.post('/first-steps/dismiss', asyncHandler(async (req, res) => {
  const cid = req.params.id;
  const { rows } = await db.query(
    `UPDATE companies
        SET onboarding_dismissed_at = COALESCE(onboarding_dismissed_at, NOW())
      WHERE id = $1
      RETURNING onboarding_dismissed_at`,
    [cid]
  );
  if (!rows.length) throw new AppError('Empresa nao encontrada', 404);
  res.json({ dismissed: true, dismissed_at: rows[0].onboarding_dismissed_at });
}));

router.STEPS_BY_SEGMENT = STEPS_BY_SEGMENT;
module.exports = router;
