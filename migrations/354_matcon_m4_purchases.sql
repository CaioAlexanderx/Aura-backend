-- ============================================================
-- 354 — Matcon M4: compras (sugestao de compra e pedido ao fornecedor)
--
-- Contexto (23/09/2026): terceira esteira do Matcon (aura-app
-- app/(tabs)/matcon/compras.tsx, chave de modulo `matcon.compras`).
-- Contrato em aura-app/docs/CONTRACT_MATCON.md secao "M4 › Compras".
-- Lote/tonalidade (product_lots) NAO entra aqui: migration propria.
--
-- DECISOES:
--
-- (a) ULTIMA COMPRA NO PRODUTO. products ganha last_supplier_name,
--     last_supplier_cnpj, last_supplier_phone, last_purchase_unit_cost e
--     last_purchase_at. Nada disso existia: a 350 so criou a unidade de
--     compra (purchase_unit/purchase_factor), e o import de DANFE
--     (src/routes/danfeImport.js) so faz o parse, nunca grava produto.
--     products.supplier_name/supplier_cnpj (342) continuam como estao: sao
--     o fornecedor CADASTRADO; as colunas novas sao "quem me vendeu isso
--     na ultima nota", que e o que a sugestao agrupa.
--     - last_supplier_cnpj guarda so digitos (mesma normalizacao de
--       suppliers.cnpj), para casar com o pedido sem depender de mascara.
--     - last_purchase_unit_cost e o valor unitario DA NOTA, na unidade de
--       compra (a caixa de 2,32 m², nao o m²). A sugestao divide pelo
--       purchase_factor para estimar o custo na unidade de venda.
--     - Tudo nullable, sem default e sem backfill: loja sem Matcon nunca
--       escreve aqui e nada muda para ela (contrato de zero impacto).
--
-- (b) PEDIDO COM ITENS EM JSONB, NAO EM TABELA. O pedido de compra e um
--     DOCUMENTO (o texto que vai no WhatsApp do fornecedor), nao um
--     movimento: nao baixa nem soma estoque (quem soma e a entrada da
--     nota). Os itens sao um retrato do produto no momento do pedido
--     (nome, unidade, custo estimado) e o PATCH troca a lista inteira de
--     uma vez. O unico escritor concorrente e a entrada da nota, que le e
--     grava o pedido inteiro com SELECT ... FOR UPDATE na linha do pedido.
--     Tabela de itens so pagaria o custo de join/sincronia sem ganhar
--     nada; produto apagado depois continua legivel no pedido antigo pelo
--     nome do retrato (sem FK que quebre).
--     Forma do item: {product_id, name, unit, quantity, unit_cost_est,
--     received_qty} — quantity/received_qty na unidade de VENDA.
--
-- (c) NUMERO "C-0042" SEQUENCIAL POR EMPRESA. Mesma mecanica da OS
--     (migration 313, decisao e): contador por empresa com UPSERT ...
--     RETURNING, que trava a linha ate o COMMIT (dois pedidos ao mesmo
--     tempo nunca pegam o mesmo numero; ROLLBACK devolve o numero).
--     Guarda-se o inteiro (seq); o "C-" + 4 digitos e formatado na rota.
--     A alocacao fica na rota (sem trigger): so existe um caminho de
--     insercao, o POST.
--
-- (d) status: draft | sent | received | cancelled. Transicoes validadas na
--     rota (src/routes/matconPurchases.js), nao no banco.
--
-- Idempotente (padrao do repo): reaplicar nao duplica coluna, tabela nem
-- indice.
-- ============================================================

-- ── (1) Ultima compra no produto (decisao a) ────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS last_supplier_name      TEXT,
  ADD COLUMN IF NOT EXISTS last_supplier_cnpj      VARCHAR(14),
  ADD COLUMN IF NOT EXISTS last_supplier_phone     VARCHAR(30),
  ADD COLUMN IF NOT EXISTS last_purchase_unit_cost NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS last_purchase_at        TIMESTAMPTZ;

COMMENT ON COLUMN products.last_supplier_name      IS 'Matcon M4: emitente da ultima nota de compra que deu entrada neste produto.';
COMMENT ON COLUMN products.last_supplier_cnpj      IS 'Matcon M4: CNPJ (so digitos) do emitente da ultima nota de compra.';
COMMENT ON COLUMN products.last_supplier_phone     IS 'Matcon M4: telefone do fornecedor da ultima compra (a nota nao traz no parse; vem da conferencia ou do cadastro).';
COMMENT ON COLUMN products.last_purchase_unit_cost IS 'Matcon M4: valor unitario da ultima nota, na unidade de COMPRA (dividir por purchase_factor para a unidade de venda).';
COMMENT ON COLUMN products.last_purchase_at        IS 'Matcon M4: quando a ultima nota de compra deu entrada.';

-- ── (2) Pedidos de compra (decisoes b e d) ──────────────────
CREATE TABLE IF NOT EXISTS matcon_purchase_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  status            VARCHAR(12) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  supplier_name     TEXT,
  supplier_cnpj     VARCHAR(14),
  supplier_phone    VARCHAR(30),
  items             JSONB NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(items) = 'array'),
  total_est         NUMERIC(12,2) NOT NULL DEFAULT 0,
  sent_at           TIMESTAMPTZ,
  received_at       TIMESTAMPTZ,
  received_invoice  TEXT,
  cancelled_at      TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE matcon_purchase_orders IS
  'Matcon M4: pedido de compra ao fornecedor. Documento, nao movimento: o estoque entra pela nota do fornecedor, que casa itens por product_id e fecha o pedido.';
COMMENT ON COLUMN matcon_purchase_orders.items IS
  'Lista de {product_id, name, unit, quantity, unit_cost_est, received_qty}; quantidades na unidade de venda.';
COMMENT ON COLUMN matcon_purchase_orders.received_invoice IS
  'Numero(s) da(s) nota(s) do fornecedor que deram entrada, separados por virgula quando o recebimento veio em mais de uma.';

-- Numero unico por empresa (decisao c).
CREATE UNIQUE INDEX IF NOT EXISTS uq_matcon_purchase_orders_company_seq
  ON matcon_purchase_orders (company_id, seq);

-- Lista da tela (filtro por status, mais novo primeiro).
CREATE INDEX IF NOT EXISTS idx_matcon_purchase_orders_company_status
  ON matcon_purchase_orders (company_id, status, created_at DESC);

-- Entrada da nota: acha os pedidos enviados daquele fornecedor.
CREATE INDEX IF NOT EXISTS idx_matcon_purchase_orders_sent_cnpj
  ON matcon_purchase_orders (company_id, supplier_cnpj)
  WHERE status = 'sent';

-- ── (3) Contador por empresa (decisao c) ────────────────────
CREATE TABLE IF NOT EXISTS matcon_purchase_order_counters (
  company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE matcon_purchase_order_counters IS
  'Ultimo numero de pedido de compra (C-0042) entregue por empresa. Alocacao atomica via UPSERT ... RETURNING na rota.';
