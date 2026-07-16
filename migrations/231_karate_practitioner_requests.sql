-- ============================================================
-- AURA KARATÊ — Migration 231: solicitação de criação de praticante (H1)
-- ------------------------------------------------------------
-- Regras de negócio fechadas com o Caio (14/07/2026):
--  - O número de matrícula FPKT é gerado pela FEDERAÇÃO, fora do nosso
--    sistema. Nós só REGISTRAMOS o número que a federação informar na
--    aprovação — o backend NUNCA gera/inventa número (ver remoção do
--    modo "auto" em src/routes/karatePractitioners.js, mesmo PR).
--  - O número é OBRIGATÓRIO: conferido em produção (14/07/2026), dos
--    9.608 praticantes cadastrados, 0 estão sem número e 0 têm número
--    duplicado — o invariante já é real; esta migration só o torna
--    explícito no schema via índice único.
--  - O praticante NASCE já com número. Quem "espera" o número é a
--    SOLICITAÇÃO (tabela nova abaixo), que fica pendente até a federação
--    aprovar e registrar o número (ou rejeitar, ou resolver como
--    transferência de um praticante já existente).
--  - Faixa é ALEGADA pelo sensei — não há validação de faixa aqui.
--  - Nada nesta fase gera cobrança automaticamente nem altera is_active
--    de terceiros.
--
-- Idempotente / defensivo (42703 / 42P01) seguindo CLAUDE.md.
-- ============================================================

-- 1) Índice único (federation_id, karate_registration_number) — só TRAVA a
--    porta; hoje já não há duplicata (conferido acima). Parcial: ignora
--    NULL/'' (nunca deve haver linha assim, mas não custa ser defensivo).
--    Nota: já existe idx_customers_karate_reg_number (migration 148), único
--    GLOBAL (sem escopo de federação). Este índice novo é o semanticamente
--    correto (escopado por federação) e convive com o antigo sem conflito;
--    o antigo não foi removido nesta migration (fora de escopo — decisão de
--    produto separada se um dia > 1 federação reaproveitar faixas de número).
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_federation_fpkt
  ON customers (federation_id, karate_registration_number)
  WHERE federation_id IS NOT NULL
    AND karate_registration_number IS NOT NULL
    AND karate_registration_number <> '';

-- 2) unaccent — usado pela deduplicação (nome normalizado sem acento) em
--    src/services/karatePractitionerDedup.js. unaccent() é STABLE (não
--    IMMUTABLE), por isso a normalização de nome roda em JS, não em índice
--    funcional/coluna gerada — esta extensão fica disponível para uso
--    pontual em queries, se necessário. Já instalada em prod (Supabase);
--    o CI sobe um Postgres 16 limpo e precisa dela explicitamente.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 3) Tabela de solicitações de criação/transferência de praticante,
--    originadas no portal do sensei (token-gated, dojo_id sempre do
--    token). Fica pendente até a federação aprovar (criação exige número
--    FPKT obrigatório) ou rejeitar (com motivo).
CREATE TABLE IF NOT EXISTS karate_practitioner_requests (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id             uuid NOT NULL,
  dojo_id                   uuid NOT NULL,

  -- Colunas "core" (indexáveis/exibidas em listagem e usadas na
  -- deduplicação) + payload completo (ficha inteira, inclui endereço e
  -- responsável) em jsonb — nunca perde dado, mesmo o que não tem coluna
  -- própria.
  full_name                 text NOT NULL,
  birth_date                date,
  cpf                       text,
  rg                        text,
  phone                     text,
  email                     text,
  claimed_belt              text,           -- faixa ALEGADA pelo sensei, não validada
  payload                   jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- número que o sensei digitou, se digitou. NUNCA gerado por nós.
  fpkt_number_claimed       text,

  -- chave de deduplicação/idempotência: dojô + nome normalizado + nascimento
  -- (ver karatePractitionerDedup.buildDedupKey). Duas solicitações pendentes
  -- iguais no mesmo dojô não podem coexistir (índice único parcial abaixo).
  dedup_key                 text NOT NULL,

  status                    text NOT NULL DEFAULT 'pendente',
  resolution                text,
  resolved_practitioner_id  uuid,
  reject_reason             text,

  -- autor da solicitação (sensei) — canal do token, nunca segredo algum.
  requested_by_channel      text,
  requested_by_label        text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  resolved_at               timestamptz,
  resolved_by               uuid
);

DO $$ BEGIN
  ALTER TABLE karate_practitioner_requests
    ADD CONSTRAINT karate_practitioner_requests_status_check
    CHECK (status IN ('pendente','aprovada','rejeitada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_practitioner_requests
    ADD CONSTRAINT karate_practitioner_requests_resolution_check
    CHECK (resolution IS NULL OR resolution IN ('created','transferred','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- FKs defensivas (ON DELETE CASCADE/SET NULL) — mesma filosofia de
-- migration 227 (karate_finance_audit_log): não bloqueiam o INSERT se a
-- FK ainda não puder ser validada por ordem de criação, e nunca perdem a
-- trilha por causa de um cascade em outra tabela.
DO $$ BEGIN
  ALTER TABLE karate_practitioner_requests
    ADD CONSTRAINT karate_practitioner_requests_federation_id_fkey
    FOREIGN KEY (federation_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_practitioner_requests
    ADD CONSTRAINT karate_practitioner_requests_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_practitioner_requests
    ADD CONSTRAINT karate_practitioner_requests_resolved_practitioner_id_fkey
    FOREIGN KEY (resolved_practitioner_id) REFERENCES customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_practitioner_requests
    ADD CONSTRAINT karate_practitioner_requests_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotência real: uma solicitação PENDENTE por (dojô, dedup_key). Depois
-- de resolvida (aprovada/rejeitada) o sensei PODE reenviar (ex.: corrigir e
-- reenviar após rejeição) — por isso o índice é parcial, só sobre
-- status='pendente'.
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_practitioner_requests_pending_dedup
  ON karate_practitioner_requests (dojo_id, dedup_key)
  WHERE status = 'pendente';

-- Índices por (federation_id, status) e (dojo_id, status) — pedidos
-- explicitamente na entrega (listagem da federação por status/dojô;
-- listagem do sensei por status do próprio dojô).
CREATE INDEX IF NOT EXISTS idx_karate_practitioner_requests_fed_status
  ON karate_practitioner_requests (federation_id, status);

CREATE INDEX IF NOT EXISTS idx_karate_practitioner_requests_dojo_status
  ON karate_practitioner_requests (dojo_id, status);

COMMENT ON TABLE karate_practitioner_requests IS
  'Solicitação de criação/transferência de praticante, enviada pelo sensei (portal token-gated, dojo_id sempre do token). Fica pendente até a federação aprovar (criação exige fpkt_number obrigatório, informado pela federação na aprovação — o backend nunca gera número) ou rejeitar (com motivo). Deduplicação é sugestão (karatePractitionerDedup), nunca bloqueio automático.';
