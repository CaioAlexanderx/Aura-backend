-- ============================================================
-- 317 — Miniatura das fotos de produto + controle de jobs
--
-- Criado: 02/09/2026 (QA da Finesse)
--
-- image_thumb_url: a versao de ate 640px da foto, gerada no upload
-- (src/utils/fotosDeProduto.js). A loja usa na grade, na home e na
-- sacola; image_url continua sendo a foto grande (ate 1600px) da pagina
-- do produto. NULL = foto de antes das miniaturas; o job
-- jobs/001_miniaturas_das_fotos.js preenche o acervo aos poucos.
--
-- jobs_run: o controle dos jobs de uma vez so (src/utils/jobRunner.js),
-- no mesmo espirito de schema_migrations — uma linha por job concluido.
-- E tabela de migration (e nao criada pelo runner) porque o runner de
-- jobs roda DEPOIS das migrations, em segundo plano no boot.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS image_thumb_url TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS image_thumb_url TEXT;

CREATE TABLE IF NOT EXISTS jobs_run (
  key        TEXT PRIMARY KEY,
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resumo     JSONB
);

COMMENT ON COLUMN products.image_thumb_url IS 'Foto ate 640px pra grade/home/sacola (fotosDeProduto.js). NULL = ainda sem miniatura.';
COMMENT ON COLUMN product_variants.image_thumb_url IS 'Foto ate 640px da variante (cor). NULL = ainda sem miniatura.';
COMMENT ON TABLE jobs_run IS 'Controle dos jobs de uma vez so (src/utils/jobRunner.js): uma linha por job concluido.';
