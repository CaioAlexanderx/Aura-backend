-- ============================================================
-- 473 — WhatsApp: automaticas, divisao das novidades e modelos editaveis
-- (tela nova do WhatsApp, 26/11/2026; agente B)
--
-- Tres tabelas pequenas e novas. Nada aqui liga envio: tudo fica atras da
-- trava WHATSAPP_OFICIAL_LIBERADO e das flags de cada automatica (que
-- nascem desligadas).
--
--   wa_automaticas        interruptor e configuracao de cada automatica por
--                         loja: aniversario | venda_mais | crediario_cobrar |
--                         crediario_vender. `config` e JSONB (tom, presente,
--                         passos, dia do mes...).
--   wa_novidades_divisao  como as novidades do mes sao divididas entre
--                         Aniversario, Venda+ e Crediario (padrao 4/4/2). A
--                         soma <= saldo e validada no servidor, nao aqui.
--   wa_modelo_versoes     cada texto que a lojista manda para aprovacao e o
--                         estado dele na Meta. Texto novo = template NOVO na
--                         Meta (nome versionado), entao ate aprovar vale o
--                         anterior. O que vale e a maior versao APPROVED ou
--                         PADRAO (PADRAO = a lojista voltou ao texto da Aura).
--
-- Aditiva e idempotente; sem CONCURRENTLY. Caminho de volta:
--   DROP TABLE IF EXISTS wa_modelo_versoes, wa_novidades_divisao, wa_automaticas;
-- ============================================================

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS wa_automaticas (
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  automatica  TEXT        NOT NULL CHECK (automatica IN ('aniversario','venda_mais','crediario_cobrar','crediario_vender')),
  ligada      BOOLEAN     NOT NULL DEFAULT false,
  config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ligada_em   TIMESTAMPTZ,
  ultima_rodada_em TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, automatica)
);

CREATE TABLE IF NOT EXISTS wa_novidades_divisao (
  company_id  UUID        PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  aniversario INT         NOT NULL DEFAULT 4 CHECK (aniversario >= 0),
  venda_mais  INT         NOT NULL DEFAULT 4 CHECK (venda_mais >= 0),
  crediario   INT         NOT NULL DEFAULT 2 CHECK (crediario >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_modelo_versoes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  modelo        TEXT        NOT NULL,
  versao        INT         NOT NULL,
  texto         TEXT,
  template_name TEXT        NOT NULL,
  estado        TEXT        NOT NULL CHECK (estado IN ('PENDING','APPROVED','REJECTED','PADRAO')),
  motivo        TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decidido_em   TIMESTAMPTZ,
  UNIQUE (company_id, modelo, versao)
);

-- O nome do template na Meta e unico por loja; PADRAO reaproveita o nome base.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_modelo_versoes_template
  ON wa_modelo_versoes(company_id, template_name) WHERE estado <> 'PADRAO';

-- O webhook de aprovacao acha a versao pelo nome do template.
CREATE INDEX IF NOT EXISTS idx_wa_modelo_versoes_lookup
  ON wa_modelo_versoes(company_id, modelo, versao DESC);
