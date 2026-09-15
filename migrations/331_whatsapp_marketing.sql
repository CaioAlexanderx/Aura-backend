-- ============================================================
-- 331 — WhatsApp de MARKETING: reativação de clientes e aniversário
--
-- As Fases 1–6 cuidaram de COBRANÇA (templates UTILITY). Reativação e
-- aniversário são MARKETING na Meta: custam mais caro, têm limite por
-- usuário (erro 131049), derrubam a qualidade do número quando mal
-- usados e — diferente da cobrança — exigem consentimento de quem
-- recebe. Por isso as colunas abaixo existem antes de qualquer envio.
--
-- companies.wa_marketing_consent_at: a DECLARAÇÃO do lojista de que os
-- clientes dele autorizaram receber mensagens da loja. Sem essa data,
-- nenhuma mensagem de marketing sai — nem manual pela fila, nem por job.
-- É um carimbo, não um booleano, porque em disputa de LGPD o que importa
-- é QUANDO a loja declarou isso.
--
-- wa_reactivation_auto / wa_birthday_auto: estado declarado, não
-- deduzido (memória do repo) — cada rotina automática tem o próprio
-- interruptor, nenhuma é ligada "por tabela".
--
-- wa_contacts.marketing_blocked_until: o 131049 da Meta é "esta PESSOA
-- já recebeu marketing demais", não "este número não existe". Até aqui
-- ele caía no invalid_at e cegava o contato também para COBRANÇA — uma
-- promoção não entregue passava a impedir o lembrete da parcela. Agora
-- bloqueia só marketing, e por 30 dias.
--
-- wa_marketing_log: o histórico que responde "quem recebeu o quê e
-- quando" sem depender da wa_outbox (que é fila e é podada). É dele que
-- sai o dedupe de aniversário (1 por cliente por ano) e o de reativação.
-- ============================================================

-- ── companies ───────────────────────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_marketing_consent_at TIMESTAMPTZ;
COMMENT ON COLUMN companies.wa_marketing_consent_at IS
  'Quando o dono declarou que os clientes autorizaram receber mensagens da loja pelo WhatsApp. NULL = nenhum envio de marketing.';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_reactivation_auto BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN companies.wa_reactivation_auto IS
  'Interruptor do job semanal de reativação (terça 10h BRT). Ligar exige plano/adicional, número conectado, template aprovado e consentimento.';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_birthday_auto BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN companies.wa_birthday_auto IS
  'Interruptor do job diário de aniversário (9h30 BRT). Mesmos pré-requisitos da reativação.';

-- Defaults do cupom de reativação. Existe separado do
-- birthday_coupon_defaults porque o desconto de quem sumiu há 60 dias
-- não é o mesmo presente de aniversário — e a validade é mais curta de
-- propósito (a urgência é o que traz de volta).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS reactivation_coupon_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN companies.reactivation_coupon_defaults IS
  'Defaults do cupom de reativação (discount_type, discount_value, validity_days, min_order_value, max_uses). Vazio = cai no birthday_coupon_defaults e depois no padrão do código.';

-- ── wa_contacts (307) ───────────────────────────────────────
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS marketing_blocked_until TIMESTAMPTZ;
COMMENT ON COLUMN wa_contacts.marketing_blocked_until IS
  'Erro 131049 (limite de marketing por usuário): bloqueia SÓ marketing até esta data. Cobrança continua saindo para este contato.';

CREATE INDEX IF NOT EXISTS idx_wa_contacts_marketing_blocked
  ON wa_contacts(company_id, marketing_blocked_until)
  WHERE marketing_blocked_until IS NOT NULL;

-- ── wa_marketing_log ────────────────────────────────────────
-- customer_id sem FK de propósito: este log tem que sobreviver ao
-- cliente ser apagado (é prova de que a loja mandou a mensagem).
CREATE TABLE IF NOT EXISTS wa_marketing_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id   UUID,
  kind          TEXT NOT NULL CHECK (kind IN ('reativacao','aniversario')),
  segment       TEXT,
  coupon_id     UUID,
  wa_outbox_id  UUID,
  -- Ano de referência do envio. A spec pedia um índice único sobre
  -- date_trunc('year', created_at), mas date_trunc sobre TIMESTAMPTZ não
  -- é IMMUTABLE (depende do TimeZone da sessão) e o Postgres recusa o
  -- índice. Guardar o ano como coluna resolve, é determinístico e é o
  -- mesmo padrão do birthday_messages_sent.birthday_year (065).
  ref_year      INT,
  status        TEXT NOT NULL DEFAULT 'queued',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE wa_marketing_log IS
  'Histórico de mensagens de MARKETING (reativação/aniversário) enfileiradas pela Cloud API. Fonte do dedupe e da frequência.';
COMMENT ON COLUMN wa_marketing_log.segment IS 'at_risk | dormant (reativação); NULL no aniversário.';
COMMENT ON COLUMN wa_marketing_log.ref_year IS 'Ano do envio (America/Sao_Paulo) — base do "1 aniversário por cliente por ano".';

CREATE INDEX IF NOT EXISTS idx_wa_marketing_log_company
  ON wa_marketing_log(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wa_marketing_log_customer
  ON wa_marketing_log(company_id, customer_id, kind, created_at DESC);

-- Um aniversário por cliente por ano. O job roda todo dia e a rota é
-- clicável à vontade: é este índice que garante que ninguém recebe duas
-- mensagens pagas do mesmo aniversário.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_marketing_log_bday_year
  ON wa_marketing_log(company_id, customer_id, kind, ref_year)
  WHERE kind = 'aniversario' AND customer_id IS NOT NULL AND ref_year IS NOT NULL;
