-- ============================================================
-- 368 — Comandas no Caixa
--
-- Contexto (09/10/2026): a adega do Luis Henrique vende copao, dose e combo
-- para quem fica no balcao a noite inteira e paga no fim. O Caixa so sabia
-- vender na hora: sem ter onde pendurar o consumo, a loja anotava em papel e
-- quase nada passava pelo sistema (10 vendas em 30 dias). O modulo Food
-- (mesas, garcom, cozinha) existe mas esta despriorizado e e pesado demais
-- para isso. Aqui entra a comanda LEVE, dentro do Caixa: o operador digita os
-- produtos, manda para a comanda N, e no fim fecha a comanda N — o consumo
-- vira o carrinho e a venda nasce no Caixa como qualquer outra.
--
-- DECISOES:
--
-- (a) NUMERO E O DA LOJA, NAO SEQUENCIAL. A comanda e o cartao/ficha que a
--     loja entrega ao cliente ("comanda 12"). O mesmo numero volta a ser
--     usado amanha — por isso a unicidade e so entre as ABERTAS
--     (indice parcial). 1..9999.
--
-- (b) ITENS SAO SNAPSHOT (nome, unidade, preco do momento do lancamento),
--     como o orcamento do Matcon (352). product_id/variant_id ficam para a
--     venda baixar o estoque certo; se o produto sumir, a comanda continua
--     fechando (ON DELETE SET NULL).
--
-- (c) SEM BAIXA DE ESTOQUE NO LANCAMENTO. A baixa e na venda, como sempre.
--     Fechar a comanda NAO cria venda no servidor: o Caixa monta o carrinho
--     e manda POST /pdv/sale com comanda_id; o gancho
--     (services/comandaSaleHooks.js) fecha a comanda dentro da transacao da
--     venda. Mesmo desenho do "virar pedido" do orcamento — um caminho so
--     para pagamento, NFC-e, caixa e crediario.
--
-- (d) TAXA DE SERVICO entra na venda como um item sem produto ("Taxa de
--     servico (10%)"), decidido no fechamento. A comanda guarda o percentual
--     aplicado so para consulta.
--
-- (e) VENDA CANCELADA REABRE A COMANDA (sale_id volta a NULL), salvo se o
--     mesmo numero ja estiver aberto de novo — ai ela fica cancelada.
--
-- Gate: companies.pdv_settings.comanda_enabled (jsonb, sem migration), so na
-- escrita. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS pdv_comandas (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number           INTEGER NOT NULL CHECK (number BETWEEN 1 AND 9999),
  status           VARCHAR(10) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'closed', 'cancelled')),
  opened_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  sale_id          UUID REFERENCES sales(id) ON DELETE SET NULL,
  service_fee_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pdv_comandas IS
  'Comanda leve do Caixa (368). number = o cartao da loja, unico so entre as abertas. Fecha quando a venda com comanda_id e gravada.';

-- Decisao (a): um numero aberto por loja.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pdv_comandas_open_number
  ON pdv_comandas (company_id, number)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_pdv_comandas_company_status
  ON pdv_comandas (company_id, status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_pdv_comandas_sale
  ON pdv_comandas (sale_id)
  WHERE sale_id IS NOT NULL;

-- set_updated_at() vem da migration 001.
DROP TRIGGER IF EXISTS trg_pdv_comandas_updated_at ON pdv_comandas;
CREATE TRIGGER trg_pdv_comandas_updated_at
  BEFORE UPDATE ON pdv_comandas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS pdv_comanda_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Ordem de lancamento. created_at nao serve de ordem: os itens de um mesmo
  -- lancamento nascem na mesma transacao, com o mesmo NOW().
  seq          BIGINT GENERATED ALWAYS AS IDENTITY,
  comanda_id   UUID NOT NULL REFERENCES pdv_comandas(id) ON DELETE CASCADE,
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
  variant_id   UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  unit         TEXT,
  quantity     NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  added_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pdv_comanda_items IS
  'Consumo lancado na comanda (368). Snapshot do nome e do preco do momento; a baixa de estoque e na venda.';

CREATE INDEX IF NOT EXISTS idx_pdv_comanda_items_comanda
  ON pdv_comanda_items (comanda_id, seq);

-- Venda que fechou uma comanda.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS comanda_id UUID REFERENCES pdv_comandas(id) ON DELETE SET NULL;

COMMENT ON COLUMN sales.comanda_id IS
  'Comanda do Caixa (368) que esta venda fechou. NULL = venda comum.';

CREATE INDEX IF NOT EXISTS idx_sales_comanda_id
  ON sales (comanda_id)
  WHERE comanda_id IS NOT NULL;
