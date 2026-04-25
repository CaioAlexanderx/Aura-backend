-- ============================================================
-- AURA. — W2-05: IA Odonto (Expansao only)
--
-- Conversas persistentes de IA dedicadas a clinicas odontologicas.
-- Diferente do aiChat genérico (stateless), aqui as conversas
-- ficam salvas e podem ser retomadas. Quando vinculadas a um
-- paciente, a IA recebe contexto profundo (anamnese, odontograma,
-- plano de tratamento, alergias, historico).
--
-- Acesso: somente plano 'expansao' + vertical_active='odonto'.
-- ============================================================

CREATE TABLE IF NOT EXISTS dental_ai_conversations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id           uuid        REFERENCES users(id) ON DELETE SET NULL,
  patient_id        uuid        REFERENCES customers(id) ON DELETE SET NULL,
  title             varchar(200),
  context_snapshot  jsonb,
  message_count     int         NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW(),
  archived_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_dental_ai_conv_company
  ON dental_ai_conversations(company_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dental_ai_conv_patient
  ON dental_ai_conversations(patient_id, created_at DESC)
  WHERE patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dental_ai_conv_user
  ON dental_ai_conversations(user_id, updated_at DESC)
  WHERE user_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS dental_ai_messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES dental_ai_conversations(id) ON DELETE CASCADE,
  role            varchar(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         text        NOT NULL,
  tokens_in       int,
  tokens_out      int,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_ai_msg_conv
  ON dental_ai_messages(conversation_id, created_at);

-- Trigger pra atualizar updated_at + message_count na conversa
CREATE OR REPLACE FUNCTION update_dental_ai_conv_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE dental_ai_conversations
     SET updated_at    = NOW(),
         message_count = message_count + 1
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dental_ai_msg_update_conv ON dental_ai_messages;
CREATE TRIGGER trg_dental_ai_msg_update_conv
  AFTER INSERT ON dental_ai_messages
  FOR EACH ROW
  EXECUTE FUNCTION update_dental_ai_conv_on_message();

COMMENT ON TABLE dental_ai_conversations IS
  'W2-05: Conversas persistentes da IA Odonto. Apenas plano Expansao com vertical odonto ativo. Vinculo opcional a paciente injeta contexto clinico no system prompt.';
COMMENT ON COLUMN dental_ai_conversations.context_snapshot IS
  'Snapshot do contexto do paciente no momento da criacao (anamnese resumida, alergias, alertas). Mantido para auditoria mesmo se paciente mudar.';
COMMENT ON TABLE dental_ai_messages IS
  'Mensagens da conversa. role=user|assistant|system. tokens_in/out usados pra rastreio de consumo da API Claude.';
