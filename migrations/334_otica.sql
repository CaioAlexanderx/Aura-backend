-- ============================================================
-- 334 — Modulo Otica (semi-vertical sobre a Ordem de Servico)
--
-- Contexto (15/09/2026): otica de bairro vende oculos de grau, que e um
-- pedido com espera: a armacao sai da loja pro laboratorio surfacar a
-- lente, volta, e montada, conferida e so entao o cliente busca. Esse
-- ciclo e exatamente o de uma OS (migration 313) — entrada, execucao,
-- pronta, entregue — com UMA etapa a mais no meio (o laboratorio) e um
-- dado que a OS de reparo nao tem: a receita.
--
-- DECISOES:
--
-- (a) OS GENERICA COM `kind`, NAO TABELA NOVA. O balcao da otica abre,
--     imprime, aprova e entrega igual a assistencia tecnica; duplicar a
--     maquina de status em outra tabela seria manter dois fluxos iguais
--     que divergem no primeiro bugfix. `kind` ('reparo' | 'otica')
--     escolhe o gate e os campos obrigatorios; a maquina de status e a
--     mesma.
--
-- (b) ETAPA DE LABORATORIO E COLUNA PROPRIA (lab_status), nao um status
--     novo. O status principal responde "onde esta o pedido do ponto de
--     vista do cliente" (em execucao); lab_status responde "onde esta a
--     lente do ponto de vista da loja" (foi, voltou, refez). Misturar os
--     dois na mesma coluna obrigaria a OS de reparo a conhecer estados
--     que nunca usa.
--
-- (c) A RECEITA PERTENCE AO CLIENTE, NAO A OS. O mesmo cliente compra
--     dois oculos com a mesma receita e volta no ano seguinte com outra.
--     optical_prescriptions guarda a receita por (company, customer); a
--     OS leva um SNAPSHOT em `optical` jsonb, porque o que foi montado
--     precisa ficar congelado mesmo que a receita seja corrigida depois.
--
-- (d) SINAL E UMA VENDA (deposit_sale_id). O fluxo de sinal ja existe
--     no PDV (sale-com-sinal, saldo no crediario). A OS so aponta pra
--     venda que registrou o sinal — e o saldo em aberto sai da mesma
--     credit_installments que o tracker do Studio ja le.
--
-- (e) TRACKER PUBLICO DA OS. Mesma mecanica do sales.tracker_token (286):
--     gerado por DEFAULT no banco, 128 bits, sem expiracao. Aplicado a
--     TODA OS (nao so otica) pelo mesmo motivo da 286: amarrar ao kind
--     criaria link quebrado no dia em que uma OS mudasse de tipo.
--
-- (f) REGULATORIO EMBUTIDO. prescriber_type restringe a medico ou
--     optometrista; nao ha agenda de exame nem comissao a prescritor.
--     Dado de saude: a receita NUNCA vai em mensagem de WhatsApp.
--
-- Idempotente (padrao do repo).
-- ============================================================

-- ── (1) Configuracao da otica por empresa ────────────────────
-- jsonb separado do pdv_settings de proposito: pdv_settings tem
-- whitelist tipada propria (pdvSettings.js) e a otica tem chaves demais
-- pra misturar la (RT, licenca sanitaria, laboratorio padrao, automacoes).
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS otica_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN companies.otica_settings IS
  'Configuracao do modulo Otica (defaults em src/routes/otica.js): validade padrao da receita, garantia de adaptacao, laboratorio padrao, RT, licenca sanitaria e automacoes de WhatsApp.';

-- Toggle explicito, como a 313 fez com os_enabled. O backend ja faz
-- {...DEFAULT_SETTINGS, ...saved}; a linha existe pra deixar o estado
-- visivel na tabela.
UPDATE companies
   SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb) || '{"otica_enabled": false}'::jsonb
 WHERE pdv_settings IS NULL
    OR NOT (pdv_settings ? 'otica_enabled');

-- ── (2) Laboratorios ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optical_labs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  portal_url    TEXT,
  -- Prazo tipico em dias corridos: vira o promised_at default da OS.
  lead_days     INTEGER NOT NULL DEFAULT 7 CHECK (lead_days >= 0),
  notes         TEXT,
  -- Desativa em vez de apagar quando ha OS apontando (historico).
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE optical_labs IS
  'Laboratorios opticos da empresa (quem surfaca/monta a lente). lead_days e o prazo tipico e vira o promised_at default da OS de otica.';

CREATE INDEX IF NOT EXISTS idx_optical_labs_company
  ON optical_labs (company_id, is_active, name);

DROP TRIGGER IF EXISTS trg_optical_labs_updated_at ON optical_labs;
CREATE TRIGGER trg_optical_labs_updated_at
  BEFORE UPDATE ON optical_labs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── (3) Receitas (decisao c) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS optical_prescriptions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Olho direito
  od_sph              NUMERIC(5,2),
  od_cyl              NUMERIC(5,2),
  od_axis             INTEGER CHECK (od_axis BETWEEN 0 AND 180),
  od_add              NUMERIC(4,2),
  od_prism            NUMERIC(4,2),
  od_base             TEXT,
  -- Olho esquerdo
  oe_sph              NUMERIC(5,2),
  oe_cyl              NUMERIC(5,2),
  oe_axis             INTEGER CHECK (oe_axis BETWEEN 0 AND 180),
  oe_add              NUMERIC(4,2),
  oe_prism            NUMERIC(4,2),
  oe_base             TEXT,

  -- DNP por olho e altura de montagem (mm). Sao medidas da LOJA, nao do
  -- prescritor — por isso measured_by aponta pra employees.
  od_pd               NUMERIC(4,1),
  oe_pd               NUMERIC(4,1),
  od_height           NUMERIC(4,1),
  oe_height           NUMERIC(4,1),

  -- Decisao (f): so quem pode prescrever.
  prescriber_type     TEXT NOT NULL DEFAULT 'medico'
                      CHECK (prescriber_type IN ('medico','optometrista')),
  prescriber_name     TEXT,
  prescriber_registry TEXT,     -- "CRM 12345/SP" ou registro do optometrista

  issued_at           DATE NOT NULL,
  valid_until         DATE NOT NULL,

  photo_url           TEXT,     -- foto da receita em papel (R2)
  measured_by         UUID REFERENCES employees(id) ON DELETE SET NULL,
  notes               TEXT,

  -- Lembrete de revisao ja enviado (job oticaReminderJob). DATE, nao
  -- timestamp: e um por receita e o que importa e "em que dia saiu".
  revisao_notified_at DATE,

  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabela criada numa rodada anterior desta migration sem a coluna.
ALTER TABLE optical_prescriptions ADD COLUMN IF NOT EXISTS revisao_notified_at DATE;

COMMENT ON TABLE optical_prescriptions IS
  'Receita oftalmologica do cliente (dado de saude: nunca sai em WhatsApp nem no tracker publico). Pertence ao cliente; a OS de otica guarda um snapshot em service_orders.optical.';

CREATE INDEX IF NOT EXISTS idx_optical_prescriptions_customer
  ON optical_prescriptions (company_id, customer_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_optical_prescriptions_validade
  ON optical_prescriptions (company_id, valid_until);

DROP TRIGGER IF EXISTS trg_optical_prescriptions_updated_at ON optical_prescriptions;
CREATE TRIGGER trg_optical_prescriptions_updated_at
  BEFORE UPDATE ON optical_prescriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── (4) service_orders: kind + campos de otica (decisoes a, b, d) ──
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS kind            TEXT NOT NULL DEFAULT 'reparo';
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS optical         JSONB;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS lab_id          UUID REFERENCES optical_labs(id) ON DELETE SET NULL;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS lab_order_ref   TEXT;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS lab_status      TEXT;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS lab_sent_at     TIMESTAMPTZ;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS lab_received_at TIMESTAMPTZ;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS lab_redo_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS deposit_sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS ready_notified_at      TIMESTAMPTZ;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS adaptation_notified_at TIMESTAMPTZ;

-- CHECKs via DO: ADD CONSTRAINT nao tem IF NOT EXISTS.
DO $$
BEGIN
  ALTER TABLE service_orders
    ADD CONSTRAINT chk_service_orders_kind CHECK (kind IN ('reparo','otica'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE service_orders
    ADD CONSTRAINT chk_service_orders_lab_status
    CHECK (lab_status IS NULL OR lab_status IN ('aguardando_envio','no_laboratorio','recebida','em_montagem','refacao'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN service_orders.kind IS
  'reparo (assistencia tecnica, fluxo original da 313) ou otica (oculos de grau). Escolhe gate e campos obrigatorios; a maquina de status e a mesma.';

COMMENT ON COLUMN service_orders.optical IS
  'Snapshot da OS de otica: { prescription_id, prescription {od, oe, prescritor, datas}, frame, lens, adaptation_warranty_days, use }. Congelado na abertura: corrigir a receita do cliente depois nao reescreve o que foi montado.';

COMMENT ON COLUMN service_orders.lab_status IS
  'Etapa da lente no laboratorio (so kind=otica): aguardando_envio -> no_laboratorio -> recebida -> em_montagem, com refacao voltando pra no_laboratorio. Separado de status de proposito (decisao b).';

COMMENT ON COLUMN service_orders.deposit_sale_id IS
  'Venda que registrou o SINAL (POST /pdv/sale-com-sinal), criada antes da OS. sale_id continua sendo a venda de entrega, normalmente nula na otica.';

-- ── (5) Tracker publico (decisao e) ──────────────────────────
ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS tracker_token TEXT DEFAULT encode(gen_random_bytes(16), 'hex');

UPDATE service_orders
   SET tracker_token = encode(gen_random_bytes(16), 'hex')
 WHERE tracker_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_orders_tracker_token
  ON service_orders (tracker_token)
  WHERE tracker_token IS NOT NULL;

COMMENT ON COLUMN service_orders.tracker_token IS
  'Credencial do acompanhamento publico (/acompanhar/:token). Mesma mecanica de sales.tracker_token (286): DEFAULT no banco, sem expiracao.';

-- ── (6) Indice do quadro de laboratorio ──────────────────────
-- A tela da otica abre agrupando por lab_status dentro da empresa; o
-- indice parcial nao custa nada pra quem so emite OS de reparo.
CREATE INDEX IF NOT EXISTS idx_service_orders_otica_lab
  ON service_orders (company_id, kind, lab_status)
  WHERE kind = 'otica';

-- ── Sanity check ────────────────────────────────────────────
DO $$
DECLARE
  v_sem_token BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_sem_token FROM service_orders WHERE tracker_token IS NULL;
  IF v_sem_token > 0 THEN
    RAISE WARNING '[migration 334] % OS sem tracker_token apos o backfill', v_sem_token;
  END IF;
END
$$;
