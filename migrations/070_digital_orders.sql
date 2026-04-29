-- ============================================================
-- AURA. — Migration 070: digital_orders + baixa de estoque
--
-- CONTEXTO: Canal Digital Fase 1. O comerciante agora tem uma
-- vitrine publica com carrinho e checkout. Cada pedido finalizado
-- precisa ser persistido, ter seu pagamento rastreado (Asaas Pix)
-- e baixar o estoque dos produtos comprados ao ser confirmado.
--
-- TABELAS:
--   digital_orders       — cabecalho do pedido
--   digital_order_items  — itens (produto, qty, preco no momento)
--
-- TRIGGER:
--   trg_digital_order_stock_deduct
--   Dispara quando status muda para 'confirmed'.
--   Decrementa stock_qty em products para cada item.
--   Usa idempotency_key para nao deduzir duas vezes.
--
-- STATUS FLOW:
--   pending_payment -> confirmed -> preparing -> ready -> delivered
--                  \-> cancelled (qualquer etapa antes de delivered)
--
-- IDEMPOTENTE em todos os comandos.
-- ============================================================


-- ============================================================
-- 1. ENUM: status de pedido e de pagamento
-- ============================================================

DO $$ BEGIN
  CREATE TYPE digital_order_status AS ENUM (
    'pending_payment',
    'confirmed',
    'preparing',
    'ready',
    'delivered',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE digital_order_payment_status AS ENUM (
    'pending',
    'paid',
    'failed',
    'refunded'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE digital_order_delivery_type AS ENUM (
    'pickup',
    'delivery'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================
-- 2. SEQUENCE: numero legivel de pedido por empresa
--    Formato: <PREFIXO>-<NNNN> (ex: BLR-0001, AUR-0042)
--    O prefixo e gerado a partir do slug da empresa.
-- ============================================================

CREATE TABLE IF NOT EXISTS digital_order_sequences (
  company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_seq    INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE digital_order_sequences IS
  'Contador por empresa para gerar numeros de pedido legíveis.';


-- ============================================================
-- 3. TABELA PRINCIPAL: digital_orders
-- ============================================================

CREATE TABLE IF NOT EXISTS digital_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Numero legivel (gerado pela funcao next_digital_order_number)
  order_number        VARCHAR(20) NOT NULL,

  -- Dados do cliente final (nao cadastrado, anonimo)
  customer_name       VARCHAR(255) NOT NULL,
  customer_phone      VARCHAR(30)  NOT NULL,
  customer_email      VARCHAR(255),

  -- Entrega
  delivery_type       digital_order_delivery_type NOT NULL DEFAULT 'pickup',
  delivery_address    TEXT,        -- NULL quando pickup
  delivery_fee        NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Valores
  subtotal            NUMERIC(10,2) NOT NULL,
  total               NUMERIC(10,2) NOT NULL, -- subtotal + delivery_fee

  -- Status
  status              digital_order_status NOT NULL DEFAULT 'pending_payment',
  payment_status      digital_order_payment_status NOT NULL DEFAULT 'pending',

  -- Pagamento Asaas
  asaas_payment_id    VARCHAR(100),   -- ID da cobranca no Asaas
  asaas_pix_qrcode    TEXT,           -- QR Code base64
  asaas_pix_payload   TEXT,           -- Copia-e-cola
  asaas_pix_expires_at TIMESTAMPTZ,

  -- Controle de idempotencia para o trigger de estoque
  stock_deducted      BOOLEAN NOT NULL DEFAULT FALSE,

  -- Observacoes do cliente
  notes               TEXT,

  -- Timestamps
  confirmed_at        TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unicidade do numero de pedido dentro da empresa
CREATE UNIQUE INDEX IF NOT EXISTS uq_digital_orders_number
  ON digital_orders(company_id, order_number);

-- Indice principal para listagem admin (empresa + status + data)
CREATE INDEX IF NOT EXISTS idx_digital_orders_company_status
  ON digital_orders(company_id, status, created_at DESC);

-- Indice para lookup por Asaas payment_id (webhook)
CREATE INDEX IF NOT EXISTS idx_digital_orders_asaas_payment
  ON digital_orders(asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;

COMMENT ON TABLE digital_orders IS
  'Pedidos recebidos pelo Canal Digital (vitrine publica). Fase 1.';
COMMENT ON COLUMN digital_orders.stock_deducted IS
  'Flag de idempotencia: TRUE apos o trigger deduzir estoque. Evita dupla deducao.';
COMMENT ON COLUMN digital_orders.order_number IS
  'Numero legivel gerado pela funcao next_digital_order_number(). Formato: SLUG-NNNN.';


-- ============================================================
-- 4. TABELA DE ITENS: digital_order_items
-- ============================================================

CREATE TABLE IF NOT EXISTS digital_order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES digital_orders(id) ON DELETE CASCADE,
  product_id  UUID REFERENCES products(id) ON DELETE SET NULL,

  -- Snapshot do produto no momento do pedido
  product_name  VARCHAR(255) NOT NULL,
  product_image VARCHAR(500),
  unit_price    NUMERIC(10,2) NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  subtotal      NUMERIC(10,2) NOT NULL -- unit_price * quantity
);

CREATE INDEX IF NOT EXISTS idx_digital_order_items_order
  ON digital_order_items(order_id);

COMMENT ON TABLE digital_order_items IS
  'Itens de cada pedido do Canal Digital. Snapshot de preco/nome no momento da compra.';


-- ============================================================
-- 5. FUNCAO: gerar numero legivel de pedido
--    Formato: <3 letras do slug em maiusculo>-<seq 4 digitos>
--    Ex: slug 'bella-rosa' → 'BEL-0001'
--        slug 'acai-do-ze' → 'ACA-0001'
-- ============================================================

CREATE OR REPLACE FUNCTION next_digital_order_number(p_company_id UUID)
RETURNS VARCHAR AS $$
DECLARE
  v_seq     INTEGER;
  v_prefix  VARCHAR(3);
  v_slug    VARCHAR;
BEGIN
  -- Busca slug da empresa no digital_channel_config
  SELECT UPPER(LEFT(REGEXP_REPLACE(COALESCE(slug, 'aur'), '[^a-z]', '', 'g'), 3))
    INTO v_prefix
    FROM digital_channel_config
   WHERE company_id = p_company_id;

  IF v_prefix IS NULL OR v_prefix = '' THEN
    v_prefix := 'AUR';
  END IF;

  -- Incrementa sequencia atomicamente (INSERT … ON CONFLICT)
  INSERT INTO digital_order_sequences(company_id, last_seq)
    VALUES (p_company_id, 1)
  ON CONFLICT (company_id) DO UPDATE
    SET last_seq = digital_order_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;

  RETURN v_prefix || '-' || LPAD(v_seq::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION next_digital_order_number(UUID) IS
  'Gera numero legivel de pedido no formato PREFIX-NNNN. Thread-safe via INSERT ON CONFLICT.';


-- ============================================================
-- 6. TRIGGER: baixa de estoque ao confirmar pedido
--    Dispara em UPDATE quando status muda para confirmed.
--    Usa stock_deducted como idempotencia — nunca deduz duas vezes.
--    Nao bloqueia se stock_qty ja for 0 (sobrevenda e tratada
--    na aplicacao antes de confirmar; aqui e best-effort).
-- ============================================================

CREATE OR REPLACE FUNCTION deduct_stock_on_order_confirmed()
RETURNS TRIGGER AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- Reage apenas quando status chega em 'confirmed'
  IF NEW.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;

  -- Idempotencia: se estoque ja foi deduzido, nao deduz de novo
  IF NEW.stock_deducted = TRUE THEN
    RETURN NEW;
  END IF;

  -- Decrementa stock_qty para cada item com product_id valido
  FOR v_item IN
    SELECT product_id, quantity
      FROM digital_order_items
     WHERE order_id = NEW.id
       AND product_id IS NOT NULL
  LOOP
    UPDATE products
       SET stock_qty = GREATEST(0, stock_qty - v_item.quantity),
           updated_at = NOW()
     WHERE id = v_item.product_id;
  END LOOP;

  -- Marca idempotencia e timestamp
  NEW.stock_deducted := TRUE;
  NEW.confirmed_at   := COALESCE(NEW.confirmed_at, NOW());

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_digital_order_stock_deduct ON digital_orders;

CREATE TRIGGER trg_digital_order_stock_deduct
  BEFORE UPDATE OF status
  ON digital_orders
  FOR EACH ROW
  EXECUTE FUNCTION deduct_stock_on_order_confirmed();

COMMENT ON FUNCTION deduct_stock_on_order_confirmed() IS
  'Decrementa products.stock_qty ao confirmar pedido digital. Idempotente via stock_deducted flag. GREATEST(0,...) evita stock negativo.';


-- ============================================================
-- 7. TRIGGER: updated_at automatico em digital_orders
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at_digital_orders()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_digital_orders_updated_at ON digital_orders;

CREATE TRIGGER trg_digital_orders_updated_at
  BEFORE UPDATE ON digital_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_digital_orders();


-- ============================================================
-- 8. TRIGGER: timestamps de cancelled_at e delivered_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_digital_order_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'delivered' AND OLD.status <> 'delivered' THEN
    NEW.delivered_at := NOW();
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    NEW.cancelled_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_digital_order_timestamps ON digital_orders;

CREATE TRIGGER trg_digital_order_timestamps
  BEFORE UPDATE OF status
  ON digital_orders
  FOR EACH ROW EXECUTE FUNCTION set_digital_order_timestamps();
