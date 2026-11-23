-- ============================================================
-- 462 — Modelos de mensagem do crediário (21/11/2026)
--
-- O botão Cobrar do app montava um texto fixo; a lojista editava na
-- prévia e a edição morria ao fechar. Agora cada LOJA (company_id) guarda
-- até 10 modelos, com um padrão por situação da parcela:
--   a_vencer · vence_hoje · em_atraso
-- Modelo sem situação é "livre": aparece na fileira, nunca é escolhido
-- sozinho. Os 4 prontos da Aura NÃO moram aqui (ficam no código,
-- src/services/credit/messageTemplates.js), para a Aura poder melhorar o
-- texto sem migration.
--
-- credit_message_template_imports: marca, por loja, que os textos que ela
-- tinha escrito na régua (credit_collection_rules.rules[].template) já
-- viraram modelos. Sem a marca, apagar todos os modelos traria a régua de
-- volta a cada leitura.
--
-- Só aditiva e idempotente. Nenhuma linha existente muda. Sem dado de
-- cliente final (o texto do modelo tem variáveis, não nomes).
-- Caminho de volta (depois de reverter o PR do backend):
--   DROP TABLE IF EXISTS credit_message_template_imports;
--   DROP TABLE IF EXISTS credit_message_templates;
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_message_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        VARCHAR(40) NOT NULL,
  body        TEXT NOT NULL,
  situation   VARCHAR(12),
  is_default  BOOLEAN NOT NULL DEFAULT false,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cmt_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT cmt_body_len CHECK (char_length(body) BETWEEN 1 AND 1000),
  CONSTRAINT cmt_situation CHECK (situation IS NULL OR situation IN ('a_vencer', 'vence_hoje', 'em_atraso')),
  -- Padrão sempre tem situação: "padrão de quê?" não existe.
  CONSTRAINT cmt_default_has_situation CHECK (NOT is_default OR situation IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_cmt_company ON credit_message_templates (company_id, sort, created_at);

-- Um padrão por situação, por loja.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cmt_default_por_situacao
  ON credit_message_templates (company_id, situation)
  WHERE is_default;

CREATE TABLE IF NOT EXISTS credit_message_template_imports (
  company_id     UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_count INTEGER NOT NULL DEFAULT 0
);
