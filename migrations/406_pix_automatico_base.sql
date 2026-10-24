-- ============================================================
-- AURA. — Migration 406: base do Pix Automático da Asaas (tq-104/105)
--
-- Piloto aprovado pelo Caio em 24/10/2026: 3 lojas anuais migram da
-- assinatura Pix comum para o Pix Automático (Jornada 3, modo SUBSCRIPTION).
--
-- 1. companies.pix_auto_status / asaas_pix_auto_authorization_id
--    Já existem em produção (vieram da migration 187 do PR #224, aplicada
--    no banco e nunca mergeada). Repetidas aqui com IF NOT EXISTS para o
--    repositório e o CI terem o mesmo schema. Valores de pix_auto_status
--    (mesmo vocabulário do comentário da 187):
--      creating   a rota de staff está criando (trava contra duas autorizações)
--      pending    autorização criada, esperando a cliente pagar o QR
--      active     banco da pagadora confirmou (ACTIVATED)
--      refused    não concluída (QR vencido, pagadora não terminou, banco
--                 não confirmou — inclusive depois do PAYMENT_RECEIVED)
--      cancelled  cancelada (pela pagadora no banco, pela Aura ou outro motivo)
--      expired    chegou ao finishDate
--
-- 2. pix_automatico_autorizacoes — uma linha por autorização criada pela
--    rota de staff: quem pediu, valor, datas, assinatura que a Asaas criou e
--    a assinatura Pix comum que ela substitui (troca só depois de active).
--
-- 3. pix_automatico_eventos — todo evento PIX_AUTOMATIC_* recebido no
--    webhook. event_key é o id do evento da Asaas (evt_...), com UNIQUE: a
--    entrega é "pelo menos uma vez", o segundo INSERT não entra e o evento
--    não é processado de novo.
--
-- 4. pix_automatico_elegibilidade — uma linha (id = 1): o último
--    PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED da conta da Aura
--    (ELIGIBLE / INELIGIBLE + motivos). A Gestão Aura lê por
--    GET /admin/painel/pix-automatico/elegibilidade.
--
-- Sem RLS de leitura: só o backend (service role) lê e escreve.
-- Idempotente. Desfazer: ver o fim do arquivo.
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS asaas_pix_auto_authorization_id TEXT,
  ADD COLUMN IF NOT EXISTS pix_auto_status                 TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_pix_auto_auth
  ON companies (asaas_pix_auto_authorization_id)
  WHERE asaas_pix_auto_authorization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pix_automatico_autorizacoes (
  id                    TEXT        PRIMARY KEY,          -- id da autorização na Asaas
  company_id            UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status                TEXT        NOT NULL DEFAULT 'pending',
  contract_id           TEXT        NOT NULL,
  value                 NUMERIC(12,2) NOT NULL,
  first_payment_value   NUMERIC(12,2),
  start_date            DATE        NOT NULL,
  finish_date           DATE,
  asaas_customer_id     TEXT,
  subscription_id       TEXT,                             -- assinatura que a Asaas cria (modo SUBSCRIPTION)
  old_subscription_id   TEXT,                             -- assinatura Pix comum que esta substitui
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at          TIMESTAMPTZ,
  refused_at            TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancellation_reason   TEXT,
  expired_at            TIMESTAMPTZ,
  swapped_at            TIMESTAMPTZ,                      -- assinatura antiga cancelada
  swapped_by            UUID,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pix_auto_autorizacoes_company
  ON pix_automatico_autorizacoes (company_id, created_at DESC);

-- No máximo UMA autorização viva (pending/active) por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pix_auto_autorizacao_viva
  ON pix_automatico_autorizacoes (company_id)
  WHERE status IN ('pending', 'active');

CREATE TABLE IF NOT EXISTS pix_automatico_eventos (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key         TEXT        NOT NULL UNIQUE,
  event             TEXT        NOT NULL,
  company_id        UUID        REFERENCES companies(id) ON DELETE SET NULL,
  authorization_id  TEXT,
  status            TEXT,                                 -- status do objeto no evento
  result            TEXT,                                 -- o que o handler fez
  verified          BOOLEAN     NOT NULL DEFAULT false,   -- token do webhook ou releitura na Asaas
  payload           JSONB       NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pix_auto_eventos_company
  ON pix_automatico_eventos (company_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_pix_auto_eventos_autorizacao
  ON pix_automatico_eventos (authorization_id)
  WHERE authorization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pix_automatico_elegibilidade (
  id                  SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status              TEXT        NOT NULL,               -- ELIGIBLE | INELIGIBLE
  ineligible_reasons  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  account_id          TEXT,
  event_key           TEXT,
  event_date          TEXT,                               -- dateCreated do evento (horário da Asaas)
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pix_automatico_autorizacoes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pix_automatico_eventos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pix_automatico_elegibilidade ENABLE ROW LEVEL SECURITY;

-- Desfazer (manual, só se nenhuma autorização real tiver sido criada):
--   DROP TABLE IF EXISTS pix_automatico_elegibilidade;
--   DROP TABLE IF EXISTS pix_automatico_eventos;
--   DROP TABLE IF EXISTS pix_automatico_autorizacoes;
-- As colunas de companies ficam (já existiam antes desta migration).
