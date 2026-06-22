-- migration 187: Pix Automático (cobrança recorrente com débito automático)
-- Adiciona o rastreamento da autorização de Pix Automático da Asaas em companies.
-- Idempotente (IF NOT EXISTS). Não altera nada do fluxo de cartão/PIX comum.
--
-- billing_method:
--   'pix_auto'   → assinatura via Pix Automático (débito automático, autorização única)
--   'pix_common' → assinatura PIX comum (cliente paga o QR todo mês) — fallback
--   'card'       → cartão tokenizado recorrente
-- pix_auto_status: ciclo de vida da autorização Pix Automático
--   'pending' | 'active' | 'refused' | 'cancelled' | 'expired'

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS billing_method                  TEXT,
  ADD COLUMN IF NOT EXISTS asaas_pix_auto_authorization_id TEXT,
  ADD COLUMN IF NOT EXISTS pix_auto_status                 TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_pix_auto_auth
  ON companies (asaas_pix_auto_authorization_id)
  WHERE asaas_pix_auto_authorization_id IS NOT NULL;
