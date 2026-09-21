-- ============================================================
-- 340 — CRM Fase 1: CONSENTIMENTO DE MARKETING POR CLIENTE
--
-- Até aqui o marketing pelo WhatsApp dependia de uma DECLARAÇÃO do
-- lojista para a base inteira (companies.wa_marketing_consent_at, 331).
-- Antes de ampliar qualquer envio de marketing, o consentimento passa a
-- ser registrado por cliente, como EVENTO:
--
-- customer_consent_events: cada opt-in/opt-out é uma linha nova, nunca
-- um UPDATE. Em disputa de LGPD o que importa é QUEM consentiu, QUANDO,
-- por qual CANAL e com qual TEXTO — um booleano sobrescrito não prova
-- nada. O estado atual é o evento mais recente (opt-out sempre vence
-- nas guardas de envio).
--   - company_id: o CNPJ controlador. No multi-CNPJ o cliente é do dono,
--     mas o consentimento é por CNPJ; o opt-out é gravado em TODAS as
--     empresas do mesmo dono (uma linha por empresa).
--   - customer_id sem FK de propósito (mesmo motivo do wa_marketing_log):
--     a prova tem que sobreviver ao cliente ser apagado.
--   - phone: E.164 só dígitos (mesma normalização do wa_contacts), para
--     casar com a fila, que só conhece o telefone.
--
-- companies.wa_optin_required_from: data de corte. A partir dela o
-- marketing só sai para cliente com opt-in individual. NULL = regra
-- antiga (consentimento declarado da empresa) continua valendo.
--
-- Idempotente: pode rodar de novo sem efeito.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_consent_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id   UUID,
  phone         TEXT,
  action        TEXT NOT NULL,
  channel       TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT 'marketing',
  consent_text  TEXT,
  collected_by  UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_consent_events_action_chk
    CHECK (action IN ('opt_in','opt_out')),
  CONSTRAINT customer_consent_events_channel_chk
    CHECK (channel IN ('pdv','cadastro','whatsapp','canal_digital','qr',
                       'importacao','manual','legitimo_interesse')),
  CONSTRAINT customer_consent_events_alvo_chk
    CHECK (customer_id IS NOT NULL OR phone IS NOT NULL)
);

COMMENT ON TABLE customer_consent_events IS
  'Histórico (append-only) de opt-in/opt-out de marketing por cliente e por CNPJ. Estado atual = evento mais recente; opt-out sempre vence.';
COMMENT ON COLUMN customer_consent_events.phone IS
  'Telefone E.164 só dígitos (ex.: 5511988887777), mesma normalização do wa_contacts.';
COMMENT ON COLUMN customer_consent_events.channel IS
  'Onde o consentimento foi coletado: pdv | cadastro | whatsapp | canal_digital | qr | importacao | manual | legitimo_interesse.';
COMMENT ON COLUMN customer_consent_events.consent_text IS
  'Texto exato apresentado ao cliente (ou a mensagem que ele mandou, no WhatsApp).';
COMMENT ON COLUMN customer_consent_events.collected_by IS
  'Usuário que registrou (NULL quando veio do webhook).';

CREATE INDEX IF NOT EXISTS idx_customer_consent_events_customer
  ON customer_consent_events(company_id, customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_consent_events_phone
  ON customer_consent_events(company_id, phone);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_optin_required_from DATE;
COMMENT ON COLUMN companies.wa_optin_required_from IS
  'Data de corte: a partir dela o marketing pelo WhatsApp só sai para cliente com opt-in individual (customer_consent_events). NULL = vale o consentimento declarado (wa_marketing_consent_at).';
