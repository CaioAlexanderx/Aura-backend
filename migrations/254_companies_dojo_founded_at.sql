-- ============================================================
-- 254 — Aura Dojô: data de fundação do dojô (editável pelo próprio dojô)
--
-- O cadastro federativo só guardava o ANO (companies.dojo_founded_year,
-- smallint) porque o form da FEDERAÇÃO pedia ano. Com o PATCH /dojo/me o
-- próprio dojô passa a editar o cadastro e informa a DATA de fundação.
--
-- Aditiva e idempotente. SEM backfill de propósito: transformar
-- dojo_founded_year em 01/01/<ano> inventaria um dia que ninguém informou
-- ("dado faltante ≠ pendência"). Dojô legado segue com founded_at null até
-- alguém preencher; dojo_founded_year continua sendo espelhado a cada
-- PATCH para a tela da federação não regredir.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS dojo_founded_at date;

COMMENT ON COLUMN companies.dojo_founded_at IS
  'Aura Dojô: data de fundação informada pelo próprio dojô (PATCH /federation/:id/dojo/me). dojo_founded_year é mantido em sincronia com o ano desta data.';
