-- ============================================================
-- 328 — WhatsApp: adicional contratado + conexão COMPLETA do número
--
-- Duas lacunas viraram esta migration:
--
-- 1) O envio automático custa dinheiro POR MENSAGEM. Até aqui o único
--    portão era o plano — e 104 dos 106 dojôs estão no 'essencial', que
--    é justamente o público do adicional de R$39/mês. company_addons dá
--    ao gate um lugar próprio: quem paga o adicional liga o automático,
--    quem não paga continua com a pista manual (wa.me, grátis).
--
-- 2) Conectar o número pelo Embedded Signup não era o bastante: sem
--    POST /{waba}/subscribed_apps o webhook NUNCA recebe evento deste
--    número (status de entrega, aprovação de template, qualidade), e sem
--    POST /{phone_number_id}/register a Meta recusa o envio com 133010.
--    As colunas abaixo registram que cada passo aconteceu, guardam o PIN
--    de registro (cifrado, prefixo v1: — mesmo cofre do token) e dão
--    lugar para a qualidade do número e para a PAUSA da fila.
--
-- wa_contacts.invalid_at: telefone que a Meta disse não ser WhatsApp ou
-- estar inalcançável. Sem isso, a fila gasta uma chamada paga por dia
-- para sempre no mesmo número errado.
-- ============================================================

CREATE TABLE IF NOT EXISTS company_addons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  addon_key   TEXT NOT NULL,              -- 'whatsapp_auto'
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  price_cents INT  NOT NULL DEFAULT 3900,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  source      TEXT,                       -- 'admin' | 'asaas' | 'trial'
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, addon_key)
);

CREATE INDEX IF NOT EXISTS idx_company_addons_company ON company_addons(company_id);

COMMENT ON TABLE company_addons IS
  'Adicionais contratados por empresa (ex.: whatsapp_auto, R$39/mes). O gate do envio automatico le daqui, nao do plano.';

-- Conexão: PIN de registro do número (cifrado, prefixo v1:) e metadados.
-- companies.wa_access_token / wa_phone_number_id vêm da src/migrations/039,
-- que NÃO roda no CI — por isso o runtime guarda 42703 em toda leitura que
-- mistura aquelas colunas com estas.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_register_pin TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_subscribed_at TIMESTAMPTZ;   -- subscribed_apps OK
ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_registered_at TIMESTAMPTZ;   -- /register OK
ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_quality_rating TEXT;         -- GREEN|YELLOW|RED
ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_paused_reason TEXT;          -- QUALIDADE_BAIXA | CONTA_RESTRITA | MANUAL
ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_paused_at TIMESTAMPTZ;

COMMENT ON COLUMN companies.wa_register_pin IS
  'PIN de 6 digitos do /register da Cloud API, CIFRADO (v1:...). Nunca gravado em texto puro.';
COMMENT ON COLUMN companies.wa_paused_reason IS
  'Motivo da pausa da fila: QUALIDADE_BAIXA | CONTA_RESTRITA | MANUAL. NULL = fila liberada.';

-- Contato que a Meta disse ser inválido/inalcançável: nunca mais gastar tentativa.
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ;
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS invalid_reason TEXT;
