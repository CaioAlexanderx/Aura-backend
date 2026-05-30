-- 139_studio_pricing_rules.sql
-- Studio Camada 1: Motor de Precificação — regras por produto (Fase B, 30/05/2026)
-- DA-B: qty_tiers SEMPRE por produto. Regra global (product_id IS NULL)
-- só define defaults de setup/labor/margem, nunca faixas de tiragem.

CREATE TABLE IF NOT EXISTS studio_pricing_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id          uuid REFERENCES products(id) ON DELETE CASCADE,  -- NULL = regra global da loja
  -- setup_fee: taxa de arte/matriz/clichê cobrada uma vez por pedido (rateada por qtd no motor)
  setup_fee           numeric(12,2) NOT NULL DEFAULT 0,
  -- labor_cost: mão de obra por unidade
  labor_cost          numeric(12,2) NOT NULL DEFAULT 0,
  -- default_margin_pct: margem alvo sobre o custo total (ex: 30.00 = 30%)
  default_margin_pct  numeric(5,2),
  -- urgency_pct: acréscimo percentual para urgência (ex: 20.00 = +20% no preço final)
  urgency_pct         numeric(5,2) NOT NULL DEFAULT 0,
  -- qty_tiers: [{min_qty, max_qty, unit_multiplier?, unit_price?}]
  -- Faixas de tiragem — SEMPRE por produto (DA-B).
  -- unit_multiplier: multiplica o custo base; unit_price: preço fixo na faixa.
  qty_tiers           jsonb,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Uma regra por produto por empresa (NULL product_id = regra global)
  UNIQUE (company_id, product_id)
);

CREATE INDEX IF NOT EXISTS studio_pricing_rules_company_id_idx ON studio_pricing_rules(company_id);
CREATE INDEX IF NOT EXISTS studio_pricing_rules_product_idx    ON studio_pricing_rules(company_id, product_id);
