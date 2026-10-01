-- ============================================================
-- 365 — Garantia de produto (extensao do modo Ordem de Servico)
--
-- Uma garantia e um DOCUMENTO emitido para uma venda, com cliente
-- obrigatorio, e carrega 1..N produtos, cada um com seus dias. O QR do
-- documento aponta para `code` e so valida dentro do app (logado na conta
-- do lojista) — por isso nao ha rota publica.
--
-- Os dias viram DATA (starts_on / expires_on) na emissao: o cliente guarda
-- o papel por meses e a discussao no balcao nao pode depender de recontar.
-- O nome do produto e copiado (product_name): renomear ou apagar o produto
-- depois nao reescreve o que foi prometido ao cliente.
--
-- Idempotente. Gate por pdv_settings.os_enabled so na escrita (POST); a
-- listagem, o documento e a validacao ficam abertos pelo mesmo motivo da OS.
-- ============================================================

CREATE TABLE IF NOT EXISTS warranties (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warranty_number INTEGER NOT NULL,
  -- Codigo curto lido do QR. Nao e segredo (a validacao exige login); e so
  -- um identificador digitavel caso a camera falhe.
  code            TEXT NOT NULL,
  sale_id         UUID REFERENCES sales(id) ON DELETE SET NULL,
  customer_id     UUID NOT NULL REFERENCES customers(id),
  -- Snapshot do cliente no momento da emissao (nome/cpf/telefone do papel).
  customer_name   TEXT NOT NULL,
  customer_cpf    TEXT,
  customer_phone  TEXT,
  -- Termos impressos, congelados na emissao: editar o modelo depois nao
  -- muda o que o cliente ja assinou.
  terms_text      TEXT,
  notes           TEXT,
  voided_at       TIMESTAMPTZ,
  void_reason     TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_warranties_company_number
  ON warranties (company_id, warranty_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_warranties_company_code
  ON warranties (company_id, code);
CREATE INDEX IF NOT EXISTS idx_warranties_company_created
  ON warranties (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warranties_customer
  ON warranties (customer_id);
CREATE INDEX IF NOT EXISTS idx_warranties_sale
  ON warranties (sale_id);

CREATE TABLE IF NOT EXISTS warranty_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  warranty_id   UUID NOT NULL REFERENCES warranties(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_item_id  UUID REFERENCES sale_items(id) ON DELETE SET NULL,
  product_id    UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,
  -- IMEI / numero de serie digitado na emissao (opcional).
  serial        TEXT,
  quantity      NUMERIC(10,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price    NUMERIC(10,2),
  days          INTEGER NOT NULL CHECK (days > 0 AND days <= 3650),
  starts_on     DATE NOT NULL,
  expires_on    DATE NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_warranty_items_warranty
  ON warranty_items (warranty_id);
CREATE INDEX IF NOT EXISTS idx_warranty_items_company_expires
  ON warranty_items (company_id, expires_on);
CREATE INDEX IF NOT EXISTS idx_warranty_items_product
  ON warranty_items (product_id);
