-- ============================================================
-- AURA. — migration 327: access_codes aceita o que o painel oferece
--
-- 11/09/2026: a 019 criou access_codes com dois CHECKs inline
--   type IN ('payment','trial','referral','promo')
--   plan IN ('essencial','negocio','expansao')
-- mas a rota do painel (src/routes/adminAccessCodes.js) aceita
--   VALID_TYPES = trial, promo, manual
--   VALID_PLANS = essencial, negocio, expansao, personalizado
-- e o Gestao Aura (AccessCodesCard.tsx) mostra o chip "Manual". Criar um
-- codigo manual (ou de plano personalizado) violava o CHECK (23514) e virava
-- 500. Os dois CHECKs passam a aceitar a uniao: nada que ja existe deixa de
-- valer (payment e referral continuam; referral e o REF-* das indicacoes).
--
-- CHECK inline sem nome ganha o nome padrao do Postgres
-- (<tabela>_<coluna>_check), que e o que se derruba aqui. DROP e ADD vivem no
-- MESMO bloco: aplicada via psql sem transacao (CI), um DROP solto seguido de
-- um ADD que falha deixaria a tabela sem trava nenhuma.
--
-- Se em algum banco o CHECK antigo tiver outro nome, o DROP IF EXISTS nao
-- acha nada e o antigo continua barrando 'manual' em silencio. O ultimo bloco
-- existe para isso: sobrou CHECK na coluna type/plan alem dos dois daqui, a
-- migration falha com o nome dele em vez de "passar".
--
-- plan_type (enum de companies.plan, 001) tambem nao conhece 'personalizado',
-- embora adminPlan.js, PLAN_RANK e os limites de assento ja o tratem como
-- plano. Sem o valor no enum, alargar o CHECK so mudaria o 500 de lugar: o
-- codigo seria criado e o /auth/register, que copia access_codes.plan para
-- companies.plan, quebraria no cadastro do cliente (22P02). ADD VALUE entra
-- no fim do enum, na mesma ordem do PLAN_RANK, e nao e usado nesta migration
-- (valor novo de enum nao pode ser usado na mesma transacao que o criou).
--
-- Idempotente: pode rodar 2x sem quebrar.
-- ============================================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_type') THEN
    ALTER TYPE plan_type ADD VALUE IF NOT EXISTS 'personalizado';
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE access_codes DROP CONSTRAINT IF EXISTS access_codes_type_check;
  ALTER TABLE access_codes
    ADD CONSTRAINT access_codes_type_check
    CHECK (type IN ('payment','trial','referral','promo','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE access_codes DROP CONSTRAINT IF EXISTS access_codes_plan_check;
  ALTER TABLE access_codes
    ADD CONSTRAINT access_codes_plan_check
    CHECK (plan IN ('essencial','negocio','expansao','personalizado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
DECLARE
  sobra TEXT;
BEGIN
  SELECT string_agg(c.conname || ' = ' || pg_get_constraintdef(c.oid), '; ')
    INTO sobra
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'access_codes'::regclass
     AND c.contype = 'c'
     AND a.attname IN ('type', 'plan')
     AND c.conname NOT IN ('access_codes_type_check', 'access_codes_plan_check');

  IF sobra IS NOT NULL THEN
    RAISE EXCEPTION 'migration 327: access_codes ainda tem CHECK antigo em type/plan: %', sobra;
  END IF;
END $$;
