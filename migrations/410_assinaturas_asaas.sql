-- ============================================================
-- AURA. — Migration 410: espelho das assinaturas da Asaas (tq-73, tq-79 —
-- 24/10/2026)
--
-- O webhook da Asaas passa a tratar SUBSCRIPTION_CREATED, _UPDATED,
-- _INACTIVATED e _DELETED (src/routes/webhookAsaas.js ->
-- services/assinaturasAsaas.js). Cada evento atualiza uma linha por
-- assinatura (sub_...). NADA aqui muda companies.billing_status nem bloqueia
-- a loja: a Aura apaga e troca assinaturas por conta própria (troca de plano
-- em /billing/subscribe, migração para o Pix Automático), e um
-- SUBSCRIPTION_DELETED não pode derrubar quem pagou.
--
--   status                   o da Asaas (ACTIVE, INACTIVE, EXPIRED) ou
--                            DELETED quando a assinatura foi removida
--   encerrada_em             quando chegou o primeiro DELETED/INACTIVATED
--   era_atual_no_encerramento a assinatura era companies.asaas_subscription_id
--                            no momento do encerramento
--   encerramento_pedido_por  quem pediu o encerramento, gravado ANTES do
--                            DELETE na Asaas pelos fluxos do próprio
--                            backend: 'troca_de_plano', 'pix_automatico'
--                            (ações da Aura: nunca geram e-mail de
--                            cancelada) ou 'cliente_no_app' (POST
--                            /billing/cancel)
--   aviso_decidido_em/       o e-mail de assinatura cancelada (tq-79) já
--   aviso_resultado          foi decidido: enviado, pela_aura,
--                            nao_era_a_atual, outra_ativa, fora...
--
-- Também garante companies.last_active_at (no-op em produção, ver o fim).
--
-- Idempotente. Sem política de RLS: só o backend (service role), como a
-- 407 e a 408.
-- ============================================================

CREATE TABLE IF NOT EXISTS assinaturas_asaas (
  asaas_subscription_id      TEXT        PRIMARY KEY,
  company_id                 UUID        REFERENCES companies(id) ON DELETE SET NULL,
  asaas_customer_id          TEXT,
  status                     TEXT,
  removida                   BOOLEAN     NOT NULL DEFAULT false,
  valor                      NUMERIC(12,2),
  ciclo                      TEXT,
  billing_type               TEXT,
  proximo_vencimento         DATE,
  ultimo_evento              TEXT,
  ultimo_evento_em           TIMESTAMPTZ,
  encerrada_em               TIMESTAMPTZ,
  evento_de_encerramento     TEXT,
  era_atual_no_encerramento  BOOLEAN,
  encerramento_pedido_por    TEXT,
  encerramento_pedido_em     TIMESTAMPTZ,
  aviso_decidido_em          TIMESTAMPTZ,
  aviso_resultado            TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assinaturas_asaas_company
  ON assinaturas_asaas (company_id);

-- Fila do aviso de cancelada: encerradas ainda sem decisão.
CREATE INDEX IF NOT EXISTS idx_assinaturas_asaas_aviso_pendente
  ON assinaturas_asaas (encerrada_em)
  WHERE encerrada_em IS NOT NULL AND aviso_decidido_em IS NULL;

-- Reenvio do mesmo evento de assinatura (a Asaas entrega "pelo menos uma
-- vez"): o webhook procura a chave do evento em webhook_logs.
CREATE INDEX IF NOT EXISTS idx_webhook_logs_asaas_assinatura_dedupe
  ON webhook_logs ((payload->>'dedupe_key'))
  WHERE provider = 'asaas' AND event LIKE 'SUBSCRIPTION\_%';

ALTER TABLE assinaturas_asaas ENABLE ROW LEVEL SECURITY;

-- tq-82: o "faz uns dias que você não aparece" lê companies.last_active_at
-- (gravado por requireCompanyAccess desde 12/10/2026). A coluna existe em
-- produção desde o schema base, mas nenhuma migration do repositório a
-- criava: o banco do CI não a tinha. Em produção isto é no-op, e a checagem
-- vem antes do ALTER para não pedir trava em companies à toa.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'companies' AND column_name = 'last_active_at'
  ) THEN
    ALTER TABLE companies ADD COLUMN last_active_at TIMESTAMPTZ;
  END IF;
END $$;
