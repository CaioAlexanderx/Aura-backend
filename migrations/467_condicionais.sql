-- ============================================================
-- 467 — Venda condicional (C1, 25/11/2026)
--
-- A cliente leva pecas para experimentar em casa. Cada peca fica "com
-- cliente" (fora da loja), separado do "reservado" do pedido do balcao (459,
-- a peca do pedido continua na prateleira). Regras do Caio (mockup aprovado
-- em 25/11):
--   - guardar a condicional NAO e venda: nada entra no Financeiro, no Caixa,
--     no fechamento, na comissao ou no Painel ate existir venda;
--   - uma unidade por linha (quantidade sempre 1);
--   - preco da cobranca = o da retirada (condicional_itens.unit_price);
--   - peca nao devolvida nunca vira venda sozinha;
--   - o texto de termos da loja e COPIADO para a condicional ao guardar
--     (terms_snapshot); sem texto, sem quadro.
--
-- Tabelas:
--   condicionais          uma por cliente/retirada, de UMA loja (company_id).
--                         numero = sequencia por loja (exibida como C-0031).
--   condicional_itens     uma linha por peca. situacao:
--                           com_cliente | ficou | voltou | voltou_defeito
--                         sale_id = venda que cobrou a peca (C11).
--   condicional_eventos   historico (criada, peca acrescentada, voltou,
--                         nova data, venda, cancelada, encerrada).
--   condicional_sequencias  ultimo numero usado por loja. O proximo numero
--                         sai de um UPSERT nesta linha (trava de linha), e o
--                         indice unico (company_id, numero) e a garantia final.
--   sales.condicional_id  venda que cobrou pecas de uma condicional (C11).
--
-- "Com clientes" e CALCULADO, nunca gravado (como a reserva do pedido):
--   soma das pecas com_cliente e das ficou sem sale_id das condicionais
--   abertas, por produto e variante, no grupo da loja
--   (src/services/comClientes.js). O indice parcial idx_condicional_itens_fora
--   cobre exatamente esse filtro.
--
-- Configuracoes por loja (termos e prazo padrao): moram em
-- companies.pdv_settings (jsonb), as mesmas configuracoes do Caixa de hoje,
-- nas chaves condicional_termos (texto ou null) e condicional_prazo_padrao
-- (1-30 dias, ausente = 3). jsonb nao precisa de migration: as chaves entram
-- na whitelist de src/routes/pdvSettings.js. Nada a alterar aqui.
--
-- Produto e variante SEM chave estrangeira de proposito: a grade de variantes
-- e regravada ao editar o produto (linhas apagadas e recriadas), e a FK
-- travaria a edicao ou apagaria a referencia. Nome, cor, tamanho e rotulo
-- ficam copiados na linha (como digital_order_items).
--
-- Travas (revisao de 25/11): sales e customers sao tabelas quentes (o Caixa
-- grava venda a todo momento). Nada aqui pode ficar esperando trava nelas:
--   - lock_timeout de 5 s no topo: se nao conseguir a trava, a migration
--     falha em vez de enfileirar o Caixa atras dela (e pode ser repetida);
--   - sales.condicional_id entra num ALTER sozinho (coluna nula, sem default:
--     so metadado, instantaneo);
--   - toda FK que aponta para sales ou customers nasce NOT VALID (nao varre a
--     tabela) e e validada num comando separado (VALIDATE nao bloqueia
--     escrita; as colunas novas sao todas NULL, entao e imediato);
--   - o indice em sales(condicional_id) e CREATE INDEX CONCURRENTLY, FORA de
--     bloco DO e de transacao (ver o fim do arquivo).
--
-- Aditiva e idempotente. Nenhuma linha existente muda.
-- Caminho de volta (depois de reverter o PR do backend):
--   ALTER TABLE sales DROP COLUMN IF EXISTS condicional_id;
--   DROP TABLE IF EXISTS condicional_eventos, condicional_itens,
--     condicional_sequencias, condicionais;
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS condicionais (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  numero           INTEGER NOT NULL,
  customer_id      UUID,
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  seller_id        UUID,
  employee_id      UUID,
  seller_name      TEXT,
  due_date         DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'aberta',
  notes            TEXT,
  terms_snapshot   TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  idempotency_key  TEXT
);

DO $$
BEGIN
  ALTER TABLE condicionais
    ADD CONSTRAINT condicionais_status_check
    CHECK (status IN ('aberta', 'encerrada', 'cancelada'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE condicionais
    ADD CONSTRAINT condicionais_numero_positivo CHECK (numero > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Numero unico por loja (garantia final contra corrida na numeracao).
CREATE UNIQUE INDEX IF NOT EXISTS uq_condicionais_company_numero
  ON condicionais (company_id, numero);

-- Idempotency-Key unica por loja (mesmo desenho do pedido do balcao, 416).
CREATE UNIQUE INDEX IF NOT EXISTS uq_condicionais_company_idem
  ON condicionais (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Lista da aba (abertas, atrasadas primeiro, por prazo).
CREATE INDEX IF NOT EXISTS idx_condicionais_company_status_due
  ON condicionais (company_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_condicionais_customer
  ON condicionais (customer_id)
  WHERE customer_id IS NOT NULL;

COMMENT ON TABLE condicionais IS
  'Venda condicional (467): pecas que a cliente levou para experimentar. Nao e venda: nada entra no Financeiro ate a cobranca no Caixa (sales.condicional_id).';
COMMENT ON COLUMN condicionais.numero IS
  'Sequencia por loja (condicional_sequencias). Exibida como C-0031.';
COMMENT ON COLUMN condicionais.status IS
  'aberta | encerrada (nenhuma peca com a cliente, com ou sem venda) | cancelada (aberta por engano). A situacao da tela (vence hoje, atrasada, parcial) e derivada.';
COMMENT ON COLUMN condicionais.terms_snapshot IS
  'Copia de pdv_settings.condicional_termos no momento de guardar. NULL = loja sem texto (o comprovante nao tem quadro de termos).';

-- Ultimo numero por loja.
CREATE TABLE IF NOT EXISTS condicional_sequencias (
  company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  ultimo      INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS condicional_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  condicional_id  UUID NOT NULL REFERENCES condicionais(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL,
  variant_id      UUID,
  product_name    TEXT NOT NULL,
  variant_label   TEXT,
  color_name      TEXT,
  size_label      TEXT,
  unit_price      NUMERIC(12,2) NOT NULL,
  situacao        TEXT NOT NULL DEFAULT 'com_cliente',
  defect_note     TEXT,
  decided_at      TIMESTAMPTZ,
  decided_by      UUID,
  sale_id         UUID,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  ALTER TABLE condicional_itens
    ADD CONSTRAINT condicional_itens_situacao_check
    CHECK (situacao IN ('com_cliente', 'ficou', 'voltou', 'voltou_defeito'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE condicional_itens
    ADD CONSTRAINT condicional_itens_preco_check CHECK (unit_price >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_condicional_itens_condicional
  ON condicional_itens (condicional_id);

-- "Com clientes" por produto e variante (services/comClientes.js): so as
-- pecas fora da loja. O filtro da condicional aberta vem do JOIN.
CREATE INDEX IF NOT EXISTS idx_condicional_itens_fora
  ON condicional_itens (product_id, variant_id)
  WHERE situacao = 'com_cliente' OR (situacao = 'ficou' AND sale_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_condicional_itens_sale
  ON condicional_itens (sale_id)
  WHERE sale_id IS NOT NULL;

COMMENT ON COLUMN condicional_itens.unit_price IS
  'Preco do dia na retirada (preco efetivo, promocao vigente conta). E o preco da cobranca.';
COMMENT ON COLUMN condicional_itens.situacao IS
  'com_cliente | ficou (a cliente fica e paga; sale_id quando cobrada) | voltou | voltou_defeito.';

CREATE TABLE IF NOT EXISTS condicional_eventos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  condicional_id  UUID NOT NULL REFERENCES condicionais(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL,
  tipo            TEXT NOT NULL,
  item_id         UUID,
  dados           JSONB,
  user_id         UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  ALTER TABLE condicional_eventos
    ADD CONSTRAINT condicional_eventos_tipo_check
    CHECK (tipo IN ('criada', 'peca_acrescentada', 'ficou', 'voltou', 'voltou_defeito',
                    'ainda_com_ela', 'nova_data', 'venda', 'cancelada', 'encerrada'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_condicional_eventos_condicional
  ON condicional_eventos (condicional_id, created_at);

-- FKs para tabelas quentes: NOT VALID agora, VALIDATE em comando separado.
DO $$
BEGIN
  ALTER TABLE condicionais
    ADD CONSTRAINT condicionais_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE condicionais VALIDATE CONSTRAINT condicionais_customer_id_fkey;

DO $$
BEGIN
  ALTER TABLE condicional_itens
    ADD CONSTRAINT condicional_itens_sale_id_fkey
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE condicional_itens VALIDATE CONSTRAINT condicional_itens_sale_id_fkey;

-- sales.condicional_id: coluna sozinha (nula, sem default: so metadado).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS condicional_id UUID;

DO $$
BEGIN
  ALTER TABLE sales
    ADD CONSTRAINT sales_condicional_id_fkey
    FOREIGN KEY (condicional_id) REFERENCES condicionais(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE sales VALIDATE CONSTRAINT sales_condicional_id_fkey;

COMMENT ON COLUMN sales.condicional_id IS
  'Condicional (467) cujas pecas esta venda cobrou. NULL = venda comum.';

-- ------------------------------------------------------------
-- FORA DE TRANSACAO. CREATE INDEX CONCURRENTLY nao roda dentro de BEGIN/
-- COMMIT nem de bloco DO. O CI aplica com `psql -f` (cada comando em
-- autocommit), entao passa. Aplicando a mao (SQL Editor, apply_migration ou
-- psql -1, que embrulham o arquivo numa transacao): rode tudo ACIMA desta
-- linha primeiro e depois ESTE comando sozinho. Se um CONCURRENTLY
-- interrompido deixar o indice INVALID, o IF NOT EXISTS o pularia: apague
-- com DROP INDEX CONCURRENTLY IF EXISTS idx_sales_condicional_id e rode de novo.
-- ------------------------------------------------------------
-- O CONCURRENTLY nao bloqueia escrita em sales; ele so espera as transacoes
-- abertas terminarem. Sem lock_timeout aqui, para nao falhar a toa por isso.
RESET lock_timeout;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_condicional_id
  ON sales (condicional_id)
  WHERE condicional_id IS NOT NULL;
