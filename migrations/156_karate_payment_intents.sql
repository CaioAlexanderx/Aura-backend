-- ============================================================
-- Migration 156: karate_payment_intents
-- Track B — Track de pagamentos de anuidade karatê
--
-- Decisão de persistência:
--   Usamos tabela dedicada em vez de reutilizar transactions+idempotency_key
--   porque o intent PIX tem ciclo de vida próprio (pending→paid|expired)
--   independente do status da transaction. Permite múltiplos intents para
--   uma mesma cobrança (ex: QR expirado, admin gera novo), mantendo
--   idempotência na transaction pelo idempotency_key existente.
--
-- RLS: habilitado. Acesso via service_role (backend) apenas.
--   Adicione políticas específicas se o frontend precisar de acesso direto.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_payment_intents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Escopo
  federation_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  annuity_history_id  UUID REFERENCES karate_dojo_annuity_history(id) ON DELETE SET NULL,
  transaction_id      UUID REFERENCES transactions(id) ON DELETE SET NULL,

  -- Provider
  provider            TEXT NOT NULL DEFAULT 'static_brcode',
                      -- valores: 'static_brcode' | 'asaas'
  payment_intent_id   TEXT NOT NULL,  -- ID externo (ex: 'static-dojo-xxx-2026', Asaas payment id)
  payload             TEXT,           -- BR Code EMV (para static_brcode) ou null
  qr_image            TEXT,           -- base64 da imagem QR (para Asaas) ou null

  -- Status
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  expires_at          TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,

  -- Auditoria
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_karate_payment_intents_federation
  ON karate_payment_intents(federation_id);

CREATE INDEX IF NOT EXISTS idx_karate_payment_intents_annuity
  ON karate_payment_intents(annuity_history_id)
  WHERE annuity_history_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_karate_payment_intents_transaction
  ON karate_payment_intents(transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_karate_payment_intents_status
  ON karate_payment_intents(status);

-- RLS
ALTER TABLE karate_payment_intents ENABLE ROW LEVEL SECURITY;

-- Política permissiva para service_role (backend usa service_role)
-- O frontend NÃO acessa diretamente; exposto apenas via API backend.
CREATE POLICY "service_role full access"
  ON karate_payment_intents
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Trigger: atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION update_karate_payment_intents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_karate_payment_intents_updated_at
  BEFORE UPDATE ON karate_payment_intents
  FOR EACH ROW EXECUTE FUNCTION update_karate_payment_intents_updated_at();

-- Comentários
COMMENT ON TABLE karate_payment_intents IS
  'Intents de pagamento PIX para anuidades karatê. MVP=static_brcode (sem webhook). '
  'Confirmação manual pelo admin via POST /financial/payments/:id/confirm. '
  'Provider asaas plugável via env KARATE_PAYMENT_PROVIDER=asaas (não ativo no MVP).';

COMMENT ON COLUMN karate_payment_intents.provider IS
  'static_brcode: BR Code gerado localmente (padrão MVP). '
  'asaas: cobrança via Asaas API (requer ASAAS_API_URL + ASAAS_API_KEY).';

COMMENT ON COLUMN karate_payment_intents.annuity_history_id IS
  'NULL para anuidades CPF (não usam karate_dojo_annuity_history). '
  'Preenchido apenas para anuidades de dojô.';
