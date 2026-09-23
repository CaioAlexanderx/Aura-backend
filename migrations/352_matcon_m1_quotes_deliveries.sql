-- ============================================================
-- 352 — Matcon M1: orcamento -> pedido -> entrega
--
-- Contexto (23/09/2026): loja de material de construcao vende em tres
-- tempos. O cliente pede um orcamento (e leva pra casa, compara, volta),
-- fecha no Caixa e recebe o material em uma ou mais viagens do caminhao.
-- Contrato: docs/CONTRACT_MATCON.md secao M1 (repo do app) e o client
-- services/matconApi.ts, que esta migration espelha campo a campo.
--
-- DECISOES:
--
-- (a) ITENS DO ORCAMENTO EM JSONB (matcon_quotes.items), NAO TABELA. O
--     orcamento e um DOCUMENTO: nasce inteiro, e lido inteiro (a esteira
--     e a pagina publica mostram tudo), o PATCH troca a lista inteira e
--     ninguem consulta "quais orcamentos tem cimento". Nao ha FK a
--     proteger: o item guarda nome e preco DO DIA (o produto pode mudar
--     de preco ou sumir e o orcamento enviado nao pode mudar junto). O
--     front le `items[]` dentro do quote — jsonb devolve isso sem join.
--
-- (b) ITENS DA ENTREGA EM TABELA (matcon_delivery_items). Aqui o caso e
--     o oposto: a regra "a soma entregue de um item nunca passa do que
--     foi vendido" e um SUM por sale_item_id ATRAVES de varias entregas,
--     e o item precisa apontar pra sale_items (FK) — nome, unidade e
--     preco sao os DA VENDA, lidos por join, nunca copiados.
--
-- (c) NUMERO POR EMPRESA COM CONTADOR TRAVADO. Mesmo desenho da OS
--     (migration 313) e da venda (310): UPSERT ... RETURNING no contador
--     da empresa, dentro de uma trigger BEFORE INSERT. MAX()+1 daria o
--     mesmo numero a dois orcamentos salvos no mesmo segundo. Contador
--     proprio: orcamento, OS e venda sao documentos diferentes.
--
-- (d) public_token GERADO NO BANCO, 128 bits. Mesmo mecanismo do
--     sales.tracker_token (286): o link existe no instante em que o
--     orcamento (ou a entrega) nasce, e o token E a credencial.
--
-- (e) SEM RESERVA DE ESTOQUE. O repo nao tem mecanismo de reserva e esta
--     migration nao inventa um: "virar pedido" so aprova o orcamento; a
--     baixa acontece na venda (pdv.js), como sempre.
--
-- (f) ENTREGA DE VENDA CANCELADA NAO SOME DO BANCO: ganha cancelled_at e
--     sai das listas. Fica o rastro do que ja tinha ido pro caminhao.
--
-- (g) nfe_emission_id: a NF-e que nasce da entrega (M2). O POST
--     /nfce/emit com delivery_id grava aqui; a esteira le numero, status
--     e DANFE por join em nfce_emissions.
--
-- Idempotente (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
-- ============================================================

-- ── (1) Orcamentos ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matcon_quotes (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number             INTEGER,
  status             VARCHAR(10) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'approved', 'lost', 'expired')),
  customer_id        UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name      TEXT,
  customer_phone     TEXT,
  seller_id          UUID REFERENCES employees(id) ON DELETE SET NULL,
  seller_name        TEXT,
  valid_until        DATE NOT NULL,
  public_token       TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  items              JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal           NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total              NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes              TEXT,
  reference          TEXT,
  approved_at        TIMESTAMPTZ,
  converted_sale_id  UUID REFERENCES sales(id) ON DELETE SET NULL,
  sent_at            TIMESTAMPTZ,
  responded_at       TIMESTAMPTZ,
  response_note      TEXT,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE matcon_quotes IS
  'Matcon M1 (352): orcamento de material. items jsonb = snapshot do dia {product_id, name, unit, quantity numeric(12,3), unit_price, discount}. Nao reserva estoque: a baixa e na venda.';
COMMENT ON COLUMN matcon_quotes.reference IS
  'Texto livre ("obra Rua das Acacias, 233"). Nao e cadastro de obra.';
COMMENT ON COLUMN matcon_quotes.converted_sale_id IS
  'Venda que nasceu deste orcamento (POST /pdv/sale com quote_id). Volta a NULL se a venda for cancelada.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_matcon_quotes_public_token
  ON matcon_quotes (public_token);

CREATE UNIQUE INDEX IF NOT EXISTS uq_matcon_quotes_company_number
  ON matcon_quotes (company_id, number)
  WHERE number IS NOT NULL;

-- A esteira abre filtrando por status dentro da empresa; o job diario
-- procura open vencido.
CREATE INDEX IF NOT EXISTS idx_matcon_quotes_company_status
  ON matcon_quotes (company_id, status, valid_until);

CREATE INDEX IF NOT EXISTS idx_matcon_quotes_open_valid_until
  ON matcon_quotes (valid_until)
  WHERE status = 'open';

-- ── (2) Contador por empresa (decisao c) ────────────────────
CREATE TABLE IF NOT EXISTS company_matcon_quote_counters (
  company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE company_matcon_quote_counters IS
  'Ultimo numero de orcamento Matcon por empresa. Alocacao atomica via UPSERT ... RETURNING (trava a linha ate o COMMIT).';

CREATE OR REPLACE FUNCTION next_matcon_quote_number(p_company_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_number INTEGER;
BEGIN
  INSERT INTO company_matcon_quote_counters AS c (company_id, last_number)
       VALUES (p_company_id, 1)
  ON CONFLICT (company_id) DO UPDATE
       SET last_number = c.last_number + 1,
           updated_at  = NOW()
    RETURNING c.last_number INTO v_number;

  RETURN v_number;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assign_matcon_quote_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.number IS NULL THEN
    NEW.number := next_matcon_quote_number(NEW.company_id);
  ELSE
    -- Numero explicito (import) e respeitado, e o contador acompanha —
    -- senao a numeracao automatica colide com ele la na frente (mesma
    -- bomba-relogio documentada na 310/313). GREATEST: so anda pra frente.
    INSERT INTO company_matcon_quote_counters AS c (company_id, last_number)
         VALUES (NEW.company_id, NEW.number)
    ON CONFLICT (company_id) DO UPDATE
         SET last_number = GREATEST(c.last_number, EXCLUDED.last_number),
             updated_at  = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_matcon_quotes_assign_number ON matcon_quotes;
CREATE TRIGGER trg_matcon_quotes_assign_number
  BEFORE INSERT ON matcon_quotes
  FOR EACH ROW EXECUTE FUNCTION assign_matcon_quote_number();

-- set_updated_at() vem da migration 001.
DROP TRIGGER IF EXISTS trg_matcon_quotes_updated_at ON matcon_quotes;
CREATE TRIGGER trg_matcon_quotes_updated_at
  BEFORE UPDATE ON matcon_quotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── (3) Venda que nasceu de um orcamento ────────────────────
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES matcon_quotes(id) ON DELETE SET NULL;

COMMENT ON COLUMN sales.quote_id IS
  'Matcon M1 (352): orcamento que montou o carrinho desta venda. NULL = venda comum.';

CREATE INDEX IF NOT EXISTS idx_sales_quote_id
  ON sales (quote_id)
  WHERE quote_id IS NOT NULL;

-- ── (4) Entregas ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matcon_deliveries (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id          UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sequence         INTEGER NOT NULL DEFAULT 1 CHECK (sequence >= 1),
  stage            VARCHAR(12) NOT NULL DEFAULT 'separating'
                   CHECK (stage IN ('separating', 'ready', 'out', 'delivered')),
  scheduled_for    DATE NOT NULL,
  delivered_by     TEXT,
  customer_name    TEXT,
  customer_phone   TEXT,
  address          TEXT,
  public_token     TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  out_at           TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  nfe_emission_id  UUID REFERENCES nfce_emissions(id) ON DELETE SET NULL,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_matcon_deliveries_sale_sequence UNIQUE (sale_id, sequence)
);

COMMENT ON TABLE matcon_deliveries IS
  'Matcon M1 (352): viagens de entrega de uma venda. sequence 1, 2... = 1a, 2a entrega do mesmo pedido (entrega parcial). delivered_by e texto livre (sem cadastro de motorista).';
COMMENT ON COLUMN matcon_deliveries.cancelled_at IS
  'Venda cancelada: a entrega sai das listas mas o registro fica.';
COMMENT ON COLUMN matcon_deliveries.nfe_emission_id IS
  'NF-e emitida a partir desta entrega (POST /nfce/emit com delivery_id).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_matcon_deliveries_public_token
  ON matcon_deliveries (public_token);

CREATE INDEX IF NOT EXISTS idx_matcon_deliveries_company_day
  ON matcon_deliveries (company_id, scheduled_for)
  WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_matcon_deliveries_sale
  ON matcon_deliveries (sale_id);

DROP TRIGGER IF EXISTS trg_matcon_deliveries_updated_at ON matcon_deliveries;
CREATE TRIGGER trg_matcon_deliveries_updated_at
  BEFORE UPDATE ON matcon_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── (5) Itens da entrega (decisao b) ────────────────────────
CREATE TABLE IF NOT EXISTS matcon_delivery_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  delivery_id   UUID NOT NULL REFERENCES matcon_deliveries(id) ON DELETE CASCADE,
  sale_item_id  UUID NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  quantity      NUMERIC(12,3) NOT NULL CHECK (quantity >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_matcon_delivery_items UNIQUE (delivery_id, sale_item_id)
);

COMMENT ON TABLE matcon_delivery_items IS
  'Quanto de cada item da venda vai (ou foi) nesta entrega. Nome, unidade e preco vem de sale_items por join. Regra da rota: soma por sale_item_id nunca passa de sale_items.quantity.';

CREATE INDEX IF NOT EXISTS idx_matcon_delivery_items_sale_item
  ON matcon_delivery_items (sale_item_id);
