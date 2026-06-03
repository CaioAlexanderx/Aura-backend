// ============================================================
// AURA Studio — GET /studio/onboarding-status
//
// Deriva o progresso de setup do Studio a partir de counts
// existentes. SEM migration, SEM flags persistidas — puro READ.
//
// Contrato de resposta (shape imutável — Agente F depende disso):
//   { temInsumo, temFicha, temProduto, temVenda }
//
// Tabelas consultadas:
//   temInsumo  → studio_inputs          (is_active = true)
//   temFicha   → studio_composition_items JOIN studio_compositions
//                (composição com ≥1 item, sem filtro de is_active pois
//                 a composição em si não tem flag — o vínculo por product
//                 já é suficiente)
//   temProduto → products (is_personalizable=true AND is_active=true)
//   temVenda   → digital_orders (vertical='studio' + status não cancelado)
//
// DEFENSIVO (padrão Aura-backend):
//   Cada checagem em try/catch individual. Erros 42P01 (tabela
//   inexistente) e 42703 (coluna inexistente) retornam false para
//   aquele campo sem derrubar a resposta inteira.
//
// Adicionado em: feat/studio-shell-clareza (branch agent/backend-onboarding)
// Consumido por: Agente F (frontend studioOnboarding*)
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

// Códigos de erro Postgres tratados defensivamente
const PG_UNDEFINED_TABLE  = '42P01';
const PG_UNDEFINED_COLUMN = '42703';

function isSchemaError(err) {
  return err && (err.code === PG_UNDEFINED_TABLE || err.code === PG_UNDEFINED_COLUMN);
}

// ─── GET /studio/onboarding-status ─────────────────────────
router.get('/onboarding-status', async function(req, res) {
  const cid = req.params.id;

  // Resultado default — cada booleano começa false.
  // Se a subquery tiver erro de schema (tabela/coluna inexistente),
  // mantém false e segue. Qualquer outro erro também mantém false
  // (não derruba a resposta).
  const out = {
    temInsumo:  false,
    temFicha:   false,
    temProduto: false,
    temVenda:   false,
  };

  // ── temInsumo: existe ≥1 insumo ativo do estúdio ──────────
  // Tabela: studio_inputs
  try {
    const r = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM studio_inputs
          WHERE company_id = $1 AND is_active = true
         LIMIT 1
       ) AS exists`,
      [cid]
    );
    out.temInsumo = r.rows[0]?.exists === true;
  } catch (err) {
    if (!isSchemaError(err)) {
      console.error('[studio/onboarding-status][temInsumo]', err.message);
    }
  }

  // ── temFicha: existe ≥1 composição com ≥1 item ────────────
  // Tabela: studio_composition_items JOIN studio_compositions
  // Nota: studio_compositions não tem flag is_active por produto —
  // a existência do item já é o sinal semântico correto aqui.
  try {
    const r = await db.query(
      `SELECT EXISTS (
         SELECT 1
           FROM studio_composition_items ci
           JOIN studio_compositions c ON c.id = ci.composition_id
          WHERE c.company_id = $1
         LIMIT 1
       ) AS exists`,
      [cid]
    );
    out.temFicha = r.rows[0]?.exists === true;
  } catch (err) {
    if (!isSchemaError(err)) {
      console.error('[studio/onboarding-status][temFicha]', err.message);
    }
  }

  // ── temProduto: existe ≥1 produto personalizável publicado ─
  // Tabela: products
  // is_personalizable=true  → produto configurado para o Studio
  // is_active=true          → produto publicado no catálogo
  // Visibility: apenas produtos da empresa (company_id = cid).
  // Produtos compartilhados da matriz são intencionalmente excluídos
  // aqui — queremos que a loja configure ao menos um produto próprio.
  try {
    const r = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM products
          WHERE company_id = $1
            AND is_personalizable = true
            AND is_active = true
         LIMIT 1
       ) AS exists`,
      [cid]
    );
    out.temProduto = r.rows[0]?.exists === true;
  } catch (err) {
    if (!isSchemaError(err)) {
      console.error('[studio/onboarding-status][temProduto]', err.message);
    }
  }

  // ── temVenda: existe ≥1 venda Studio concluída ────────────
  // Tabela: digital_orders  (vertical='studio')
  // Exclui cancelados. Pedidos sem status explícito são tratados
  // como válidos (mesma convenção de studioPainel.js e studio.js).
  try {
    const r = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM digital_orders
          WHERE company_id = $1
            AND vertical = 'studio'
            AND COALESCE(status, 'completed') NOT IN ('cancelled', 'cancelado')
         LIMIT 1
       ) AS exists`,
      [cid]
    );
    out.temVenda = r.rows[0]?.exists === true;
  } catch (err) {
    if (!isSchemaError(err)) {
      console.error('[studio/onboarding-status][temVenda]', err.message);
    }
  }

  res.json(out);
});

module.exports = router;
