-- ============================================================
-- AURA. — Migration 122: Food Fase 7 — NFC-e manual + Caixa + Impressora
--
-- Idempotente: COALESCE / IF NOT EXISTS / ON CONFLICT em todas as
-- operações. Pode ser rodada várias vezes sem efeito colateral.
--
-- Conteúdo:
--   122a — toggles food em companies.pdv_settings
--   122b — food_orders.sale_id (link 1:1 quando mesa fecha)
--   122c — sales.source_type ('food'|'pdv'|'digital'|'crediario')
--   122d — nfce_emissions.metadata (JSONB) + índice food_order_id
-- ============================================================

-- 122a — Toggles food em pdv_settings ───────────────────────────
-- food_nfce_manual_enabled  : boolean (default false) — habilita botão "Emitir NFC-e" no painel da mesa
-- food_comanda_print_enabled: boolean (default true)  — imprime comanda 80mm ao confirmar (cozinha)
-- food_service_fee_pct      : numeric (default 0)     — taxa de serviço (gorjeta garçom) 0..30; mostrada
--                                                       separada no cupom, NÃO entra no NFC-e
--
-- Nota: NÃO duplica service_fee_pct genérico do PDV. Novo campo
-- food_service_fee_pct evita conflito com a taxa genérica do varejo.
UPDATE companies
SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
  || jsonb_build_object(
       'food_nfce_manual_enabled',   COALESCE((pdv_settings->>'food_nfce_manual_enabled')::boolean, false),
       'food_comanda_print_enabled', COALESCE((pdv_settings->>'food_comanda_print_enabled')::boolean, true),
       'food_service_fee_pct',       COALESCE((pdv_settings->>'food_service_fee_pct')::numeric, 0)
     )
WHERE TRUE;

-- 122b — Linkagem food_order → sale ─────────────────────────────
-- 1:1: quando mesa fecha (close-and-emit), cria sale e marca food_order.sale_id.
-- ON DELETE SET NULL: se a sale for deletada por algum motivo, food_order
-- não cai junto (food permanece com histórico). Idempotência da rota é
-- garantida via "WHERE sale_id IS NULL" no UPDATE.
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_food_orders_sale_id
  ON food_orders(sale_id)
  WHERE sale_id IS NOT NULL;

-- 122c — sales.source_type ──────────────────────────────────────
-- Marca origem da venda: 'food'|'pdv'|'digital'|'crediario'.
-- Nullable (retrofit-friendly): vendas antigas ficam NULL, novas marcam.
-- Relatórios podem filtrar/separar por canal sem JOIN extra.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS source_type TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_source_type
  ON sales(source_type)
  WHERE source_type IS NOT NULL;

-- 122d — nfce_emissions.metadata ────────────────────────────────
-- JSONB livre pra rastrear origem da emissão (food_order_id, digital_order_id, etc).
-- Índice parcial só nas emissões que têm food_order_id (~0% das emissões
-- existentes hoje, então índice fica leve).
ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_nfce_emissions_food_order_id
  ON nfce_emissions((metadata->>'food_order_id'))
  WHERE metadata ? 'food_order_id';
