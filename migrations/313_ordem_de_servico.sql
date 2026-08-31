-- ============================================================
-- 313 — Ordem de Servico (service_orders)
--
-- Contexto (31/08/2026): pedido de emitir OS junto com o cupom e a NFC-e,
-- habilitada por toggle porque nem toda loja emite. Na analise ficou claro
-- que uma OS de verdade NAO cabe no que `sales` ja guarda: venda tem total,
-- desconto, pagamento e itens; OS precisa de equipamento recebido, defeito
-- relatado, diagnostico, prazo, garantia, tecnico e assinatura.
--
-- DECISOES:
--
-- (a) A OS NASCE ANTES DA VENDA. Foi a decisao de produto (31/08). A OS e o
--     documento que autoriza o servico e fica com o cliente enquanto o
--     aparelho esta na loja — ela existe desde a ENTRADA do equipamento,
--     quando ainda nao ha venda nenhuma, e so encosta numa venda no fim.
--     Por isso `sale_id` e NULLABLE: uma OS aberta e uma OS em execucao nao
--     tem venda, e isso e o estado normal delas, nao um dado faltando.
--
-- (b) STATUS E CAMPO PROPRIO, NAO DEDUZIDO DE sale_id. Seria tentador ler
--     "tem sale_id => entregue". Nao serve: existe OS cancelada com venda
--     (cliente desistiu depois de pagar a analise), OS entregue sem venda
--     (garantia, retrabalho, cortesia) e OS pronta esperando o cliente
--     aparecer. Sao cinco situacoes distintas e uma coluna que so tem dois
--     valores nao consegue representar cinco.
--
-- (c) sale_id NAO E UNICO. O cliente que deixou dois aparelhos retira os
--     dois e paga numa venda so. Duas OS apontando pra mesma venda e o
--     caso normal do balcao, nao anomalia.
--
-- (d) ITENS DA OS SAO ORCAMENTO, NAO MOVIMENTO DE ESTOQUE. service_order_items
--     descreve o que sera feito e por quanto. Quem baixa estoque e a VENDA,
--     no fluxo que ja existe (pdv.js). Se a OS tambem baixasse, a peca sairia
--     duas vezes do estoque. `product_id` aqui e so rastreabilidade de qual
--     peca foi orcada.
--
-- (e) NUMERO SEQUENCIAL POR EMPRESA, mesma mecanica de sales.sale_number
--     (migration 310): contador em tabela + UPSERT ... RETURNING que trava a
--     linha ate o COMMIT, e trigger BEFORE INSERT pra cobrir todo caminho de
--     escrita. Numero de OS e lido em voz alta no balcao e vai no papel que o
--     cliente leva — UUID nao serve. Contador PROPRIO: OS e venda sao
--     documentos diferentes e cada um comeca no 1.
--
-- (f) DUAS ASSINATURAS. Entrada (cliente confere o estado em que entregou o
--     aparelho) e retirada (cliente confere que recebeu de volta). Sao os
--     dois momentos em que a loja precisa de prova, e sao meses diferentes.
--     Padrao do repo: URL de PNG no R2 + timestamp (igual dental_consents).
--
-- Idempotente (padrao do repo).
-- ============================================================

-- ── (1) Tabela principal ────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_orders (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  os_number             INTEGER,

  -- Cliente e obrigatorio: sem ele nao ha pra quem devolver o aparelho.
  customer_id           UUID NOT NULL REFERENCES customers(id),

  status                TEXT NOT NULL DEFAULT 'aberta'
                        CHECK (status IN ('aberta','em_execucao','pronta','entregue','cancelada')),

  -- ── Equipamento recebido ──
  equipment_type        TEXT,          -- "notebook", "tenis", "maquina de costura"
  equipment_brand       TEXT,
  equipment_model       TEXT,
  equipment_serial      TEXT,
  equipment_condition   TEXT,          -- estado em que ENTROU (riscos, faltando peca)
  equipment_accessories TEXT,          -- o que veio junto (fonte, capa, cabo)
  equipment_photos      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- URLs no R2

  -- ── O servico ──
  reported_issue        TEXT NOT NULL, -- defeito RELATADO pelo cliente (palavras dele)
  diagnosis             TEXT,          -- diagnostico do tecnico (preenchido depois)
  solution              TEXT,          -- o que foi feito de fato

  technician_id         UUID REFERENCES employees(id) ON DELETE SET NULL,
  promised_at           TIMESTAMPTZ,   -- prazo prometido ao cliente
  warranty_days         INTEGER NOT NULL DEFAULT 0 CHECK (warranty_days >= 0),

  -- ── Orcamento ──
  -- Valor total dos itens. Congelado no momento da aprovacao; a venda pode
  -- sair diferente (desconto no fechamento) e isso NAO reescreve a OS.
  estimated_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  approved_at           TIMESTAMPTZ,   -- quando o cliente aprovou o orcamento
  approved_note         TEXT,

  -- ── Fechamento ──
  -- Ver decisao (a) e (c): nullable de proposito, e NAO unico.
  sale_id               UUID REFERENCES sales(id) ON DELETE SET NULL,
  delivered_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancel_reason         TEXT,

  -- ── Assinaturas (decisao f) ──
  intake_signature_url  TEXT,
  intake_signed_at      TIMESTAMPTZ,
  pickup_signature_url  TEXT,
  pickup_signed_at      TIMESTAMPTZ,

  notes                 TEXT,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE service_orders IS
  'Ordem de Servico. Nasce na ENTRADA do equipamento (antes da venda) e so encosta numa venda ao ser entregue. sale_id nullable e nao-unico: OS aberta nao tem venda, e varias OS podem fechar na mesma venda.';

COMMENT ON COLUMN service_orders.status IS
  'aberta -> em_execucao -> pronta -> entregue, com cancelada saindo de qualquer uma. Campo proprio, NAO deduzido de sale_id: existe OS entregue sem venda (garantia) e OS cancelada com venda (cliente pagou a analise e desistiu).';

COMMENT ON COLUMN service_orders.reported_issue IS
  'Defeito nas palavras do CLIENTE. Separado de diagnosis de proposito: o que ele reclamou e o que o tecnico achou sao coisas diferentes, e a divergencia entre as duas e o que resolve discussao no balcao.';

COMMENT ON COLUMN service_orders.equipment_condition IS
  'Estado em que o aparelho ENTROU. Junto com intake_signature_url, e a defesa da loja quando o cliente diz que o risco na tampa nao estava la.';

-- ── (2) Itens da OS (orcamento — ver decisao d) ─────────────
CREATE TABLE IF NOT EXISTS service_order_items (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_order_id  UUID NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,

  kind              TEXT NOT NULL DEFAULT 'servico' CHECK (kind IN ('servico','peca')),
  description       TEXT NOT NULL,
  -- Rastreabilidade da peca orcada. NAO baixa estoque: quem baixa e a venda.
  product_id        UUID REFERENCES products(id) ON DELETE SET NULL,

  quantity          NUMERIC(10,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  total_price       NUMERIC(12,2) NOT NULL DEFAULT 0,

  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE service_order_items IS
  'Linhas do orcamento da OS (servicos e pecas). Documento, nao movimento: o estoque sai na venda, no fluxo do pdv.js. product_id e so pra saber qual peca foi orcada.';

-- ── (3) Contador por empresa (decisao e) ────────────────────
CREATE TABLE IF NOT EXISTS company_service_order_counters (
  company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE company_service_order_counters IS
  'Ultimo os_number entregue por empresa. Alocacao atomica via UPSERT ... RETURNING (trava a linha ate o COMMIT). Contador separado do de vendas: OS e venda sao documentos diferentes.';

-- ── (4) Unicidade do numero por empresa ─────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_orders_company_number
  ON service_orders (company_id, os_number)
  WHERE os_number IS NOT NULL;

-- ── (5) Alocacao atomica ────────────────────────────────────
CREATE OR REPLACE FUNCTION next_service_order_number(p_company_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_number INTEGER;
BEGIN
  INSERT INTO company_service_order_counters AS c (company_id, last_number)
       VALUES (p_company_id, 1)
  ON CONFLICT (company_id) DO UPDATE
       SET last_number = c.last_number + 1,
           updated_at  = NOW()
    RETURNING c.last_number INTO v_number;

  RETURN v_number;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION next_service_order_number(UUID) IS
  'Proximo numero de OS da empresa. Atomico: o UPSERT trava a linha do contador ate o COMMIT, entao duas OS abertas ao mesmo tempo na mesma empresa nunca recebem o mesmo numero, e um ROLLBACK devolve o numero.';

-- ── (6) Trigger de atribuicao ───────────────────────────────
CREATE OR REPLACE FUNCTION assign_service_order_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.os_number IS NULL THEN
    NEW.os_number := next_service_order_number(NEW.company_id);
  ELSE
    -- INSERT com numero explicito (import/migracao) e respeitado, mas o
    -- contador tem que acompanhar — senao a numeracao automatica chega la na
    -- frente no numero importado e colide com o indice unico, derrubando uma
    -- OS do balcao muito depois do import e sem pista nenhuma da causa.
    -- GREATEST: o contador so anda pra frente.
    INSERT INTO company_service_order_counters AS c (company_id, last_number)
         VALUES (NEW.company_id, NEW.os_number)
    ON CONFLICT (company_id) DO UPDATE
         SET last_number = GREATEST(c.last_number, EXCLUDED.last_number),
             updated_at  = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_orders_assign_number ON service_orders;
CREATE TRIGGER trg_service_orders_assign_number
  BEFORE INSERT ON service_orders
  FOR EACH ROW EXECUTE FUNCTION assign_service_order_number();

-- ── (7) updated_at ──────────────────────────────────────────
-- set_updated_at() vem da migration 001.
DROP TRIGGER IF EXISTS trg_service_orders_updated_at ON service_orders;
CREATE TRIGGER trg_service_orders_updated_at
  BEFORE UPDATE ON service_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── (8) Indices ─────────────────────────────────────────────
-- A tela de OS abre filtrando por status dentro da empresa e ordenando pela
-- mais recente; e o balcao procura pelo numero que o cliente leu no papel.
CREATE INDEX IF NOT EXISTS idx_service_orders_company_status
  ON service_orders (company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_orders_customer
  ON service_orders (company_id, customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_orders_sale
  ON service_orders (sale_id) WHERE sale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_service_orders_technician
  ON service_orders (company_id, technician_id) WHERE technician_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_service_order_items_os
  ON service_order_items (service_order_id, sort_order);

-- ── (9) Toggle os_enabled ───────────────────────────────────
-- Espelha o default do pdvSettings.js (opt-in: nem toda loja emite OS).
-- A leitura no backend ja faz {...DEFAULT_SETTINGS, ...saved}, entao empresa
-- antiga funciona sem esta linha — ela existe pra deixar o estado explicito
-- na tabela em vez de so implicito no codigo.
UPDATE companies
   SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb) || '{"os_enabled": false}'::jsonb
 WHERE pdv_settings IS NULL
    OR NOT (pdv_settings ? 'os_enabled');

-- ── Sanity check ────────────────────────────────────────────
DO $$
DECLARE
  v_sem_numero BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_sem_numero FROM service_orders WHERE os_number IS NULL;
  IF v_sem_numero > 0 THEN
    RAISE WARNING '[migration 313] % OS sem numero — a trigger nao rodou nelas', v_sem_numero;
  END IF;
END
$$;
