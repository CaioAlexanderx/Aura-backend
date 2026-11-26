-- ============================================================
-- 474 — Etiquetas das conversas do hub (WhatsApp · Conversas)
--
-- A lojista cria etiquetas ("Orçamento", "Esperando Pix", "Crediário") e
-- aplica nas conversas; a lista filtra por elas. Duas tabelas pequenas e
-- novas (sem lock em tabela existente, sem CONCURRENTLY: o runner usa uma
-- transação):
--
--   hub_labels               a etiqueta da loja (nome único por loja, sem
--                            diferenciar maiúscula; cor em #rrggbb)
--   hub_conversation_labels  quais etiquetas estão em cada conversa
--
-- Apagar a etiqueta tira ela de todas as conversas (ON DELETE CASCADE);
-- apagar a conversa ou a loja leva junto.
--
-- Aditiva e idempotente. O backend guarda 42P01 até esta migration subir.
-- Caminho de volta (depois de reverter o PR do backend):
--   DROP TABLE IF EXISTS hub_conversation_labels;
--   DROP TABLE IF EXISTS hub_labels;
-- ============================================================

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS hub_labels (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        VARCHAR(30) NOT NULL,
  color       VARCHAR(7)  NOT NULL DEFAULT '#7c3aed' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_labels_company_name
  ON hub_labels (company_id, lower(name));

CREATE TABLE IF NOT EXISTS hub_conversation_labels (
  conversation_id UUID        NOT NULL REFERENCES hub_conversations(id) ON DELETE CASCADE,
  label_id        UUID        NOT NULL REFERENCES hub_labels(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_hub_conv_labels_label
  ON hub_conversation_labels (label_id);

COMMENT ON TABLE hub_labels IS
  'Etiquetas das conversas do hub (WhatsApp · Conversas). Nome unico por loja, sem diferenciar maiuscula.';
COMMENT ON TABLE hub_conversation_labels IS
  'Etiquetas aplicadas em cada conversa do hub.';
