-- ============================================================
-- AURA KARATÊ — Migration 230: telefone CELULAR do dojô (phone_mobile)
-- ------------------------------------------------------------
-- Contexto: companies.phone era o único telefone do dojô (hoje usado como
-- fixo, na prática). O usuário quer os DOIS contatos separados: fixo
-- (companies.phone, mantido por compat) e celular (esta coluna nova).
--
-- Deliberadamente NULLABLE e sem backfill: dojô com só um dos dois
-- preenchido é o caso normal (não é erro, não é dado ausente = alerta).
--
-- Backend sobe antes da migration ser aplicada (armadilha
-- schema-antes-da-migration do CLAUDE.md) — src/routes/karateDojos.js trata
-- 42703 defensivamente (cache module-level HAS_PHONE_MOBILE_COL).
-- ============================================================

DO $$
BEGIN
  ALTER TABLE companies ADD COLUMN phone_mobile text;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

COMMENT ON COLUMN companies.phone_mobile IS
  'Telefone CELULAR do dojô/empresa, distinto de companies.phone (telefone FIXO). NULL = não informado (normal, não é erro). Exposto no GET/PUT de dojô (aura-backend) e exibido com máscara na ficha (aura-app).';
