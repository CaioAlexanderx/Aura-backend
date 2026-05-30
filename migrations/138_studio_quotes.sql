-- 138_studio_quotes.sql
-- Studio Camada 1: Orçamento como entidade + itens (Fase A, 30/05/2026)
-- Ref: plano_execucao_studio_orcamento_camada1.md
-- FK order_id → digital_orders (pedidos Studio ficam em digital_orders WHERE vertical='studio')

-- ─── Tabela principal de orçamentos ─────────────────────────────
CREATE TABLE IF NOT EXISTS studio_quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   text,
  customer_phone  text,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','accepted','rejected','expired','converted')),
  token           text UNIQUE,
  subtotal        numeric(12,2) NOT NULL DEFAULT 0,
  discount        numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL DEFAULT 0,
  estimated_cost  numeric(12,2),            -- soma do BOM dos itens (margem)
  validity_days   int NOT NULL DEFAULT 7,
  expires_at      timestamptz,
  sent_at         timestamptz,
  responded_at    timestamptz,
  response_note   text,
  order_id        uuid REFERENCES digital_orders(id) ON DELETE SET NULL,  -- preenchido na conversão
  deposit_pct     numeric(5,2),             -- DA-C: % de sinal escolhido pelo lojista (ex: 50.00)
  deposit_amount  numeric(12,2),            -- valor absoluto do sinal
  notes           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS studio_quotes_company_id_idx  ON studio_quotes(company_id);
CREATE INDEX IF NOT EXISTS studio_quotes_status_idx      ON studio_quotes(company_id, status);
CREATE INDEX IF NOT EXISTS studio_quotes_token_idx       ON studio_quotes(token) WHERE token IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_quotes_order_id_idx    ON studio_quotes(order_id) WHERE order_id IS NOT NULL;

-- ─── Itens do orçamento ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_quote_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id        uuid NOT NULL REFERENCES studio_quotes(id) ON DELETE CASCADE,
  product_id      uuid REFERENCES products(id) ON DELETE SET NULL,  -- null = item livre (DA-A)
  description     text NOT NULL,   -- nome do produto OU texto livre
  quantity        numeric(12,2) NOT NULL DEFAULT 1,
  unit_price      numeric(12,2) NOT NULL DEFAULT 0,  -- preço final (pós-motor/override)
  unit_cost       numeric(12,2),   -- custo do BOM no momento (snapshot)
  pricing_meta    jsonb,           -- breakdown {base_cost, labor, setup, tier_multiplier, margin_pct, urgency}
  customization   jsonb,           -- briefing por item (espelha order item)
  sort_order      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS studio_quote_items_quote_id_idx ON studio_quote_items(quote_id);
