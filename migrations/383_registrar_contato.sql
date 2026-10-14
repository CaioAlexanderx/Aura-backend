-- ============================================================
-- 383 — Registrar contato (company_admin_notes com estrutura)
--
-- Contexto (14/10/2026, cartão t1-09, spec da Cassie de 13/10, autorizado pelo
-- Caio): o botão "Registrar contato" da ficha do cliente e do verbo dos
-- alertas do Painel passa a gravar em company_admin_notes (0 linhas hoje). A
-- Cassie lê dali na rodada das 7h30 para saber quem foi contatado, o que
-- respondeu, por que não quis e qual o próximo passo.
--
-- Colunas novas em company_admin_notes (todas opcionais; as notas livres de
-- antes continuam valendo, só com tudo NULL). `body` segue sendo "uma frase do
-- que aconteceu":
--
--   canal              whatsapp | ligacao | email | presencial
--   resultado          respondeu | sem_resposta | pediu_tempo |
--                      combinou_ligacao | quer_assinar | nao_quer
--   proximo_passo      texto curto ("ligar de novo", "mandar tabela")
--   proximo_passo_em   data do próximo passo (atalhos do app: +1, +3, +7 dias)
--   motivo             estoque_na_entrada | preco_plano | fiscal |
--                      atrito_produto | funcionalidade | frente_errada |
--                      ritmo_do_cliente | concorrente | elogio.
--                      OBRIGATÓRIO quando resultado = nao_quer ("o que pesou"
--                      é o motivo, não um campo à parte).
--   prorrogou_dias     só registra; a prorrogação do teste segue pelo
--                      caminho existente (PATCH /admin/clients/:cid/extend-trial)
--   marcador           importacao_assistida_pedida | importacao_assistida_entregue
--                      (tempo de importação assistida = diferença entre os
--                      dois registros; lido pelo bloco Check-in do painel)
--
-- Lead sem conta (ainda não virou empresa): o contato vai para
-- lead_interactions (channel, body, autor) e o restante, na coluna nova
-- `payload` (jsonb): resultado, proximo_passo, proximo_passo_em, motivo,
-- marcador, prorrogou_dias, canal e o check-in. O CHECK de channel da tabela
-- não tem "presencial" (tem "visita"): a API traduz.
--
-- O CREATE TABLE IF NOT EXISTS abaixo é o da migration 109 (que mora em
-- src/migrations e nunca entrou na pasta que o runner lê): em produção é
-- no-op, num banco novo evita o ALTER cair em tabela ausente.
--
-- Idempotente: IF NOT EXISTS e blocos DO com EXCEPTION para as constraints.
-- O backend sobe antes desta migration: o código trata 42703 como
-- "MIGRATION_PENDING" (503) na gravação e como lista vazia na leitura.
-- ============================================================

CREATE TABLE IF NOT EXISTS company_admin_notes (
  id             SERIAL PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES users(id),
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_notes_company_created
  ON company_admin_notes (company_id, created_at DESC);

ALTER TABLE company_admin_notes
  ADD COLUMN IF NOT EXISTS canal            TEXT,
  ADD COLUMN IF NOT EXISTS resultado        TEXT,
  ADD COLUMN IF NOT EXISTS proximo_passo    TEXT,
  ADD COLUMN IF NOT EXISTS proximo_passo_em DATE,
  ADD COLUMN IF NOT EXISTS motivo           TEXT,
  ADD COLUMN IF NOT EXISTS prorrogou_dias   INTEGER,
  ADD COLUMN IF NOT EXISTS marcador         TEXT;

DO $$ BEGIN
  ALTER TABLE company_admin_notes ADD CONSTRAINT company_admin_notes_canal_check
    CHECK (canal IS NULL OR canal IN ('whatsapp', 'ligacao', 'email', 'presencial'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE company_admin_notes ADD CONSTRAINT company_admin_notes_resultado_check
    CHECK (resultado IS NULL OR resultado IN
      ('respondeu', 'sem_resposta', 'pediu_tempo', 'combinou_ligacao', 'quer_assinar', 'nao_quer'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE company_admin_notes ADD CONSTRAINT company_admin_notes_motivo_check
    CHECK (motivo IS NULL OR motivo IN
      ('estoque_na_entrada', 'preco_plano', 'fiscal', 'atrito_produto', 'funcionalidade',
       'frente_errada', 'ritmo_do_cliente', 'concorrente', 'elogio'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE company_admin_notes ADD CONSTRAINT company_admin_notes_marcador_check
    CHECK (marcador IS NULL OR marcador IN
      ('importacao_assistida_pedida', 'importacao_assistida_entregue'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Quem disse "não quer" tem que dizer o motivo (a mesma regra da API).
DO $$ BEGIN
  ALTER TABLE company_admin_notes ADD CONSTRAINT company_admin_notes_nao_quer_motivo_check
    CHECK (resultado IS DISTINCT FROM 'nao_quer' OR motivo IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE company_admin_notes ADD CONSTRAINT company_admin_notes_prorrogou_dias_check
    CHECK (prorrogou_dias IS NULL OR (prorrogou_dias > 0 AND prorrogou_dias <= 365));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Leitura "contatos registrados desde uma data" (rodada da Cassie).
CREATE INDEX IF NOT EXISTS idx_admin_notes_created
  ON company_admin_notes (created_at DESC);

-- Lead sem conta: o que não cabe nas colunas de lead_interactions.
ALTER TABLE lead_interactions ADD COLUMN IF NOT EXISTS payload JSONB NULL;

COMMENT ON COLUMN company_admin_notes.resultado IS
  'Resultado do contato: respondeu, sem_resposta, pediu_tempo, combinou_ligacao, quer_assinar, nao_quer.';
COMMENT ON COLUMN company_admin_notes.motivo IS
  'O que pesou (9 classes). Obrigatorio quando resultado = nao_quer.';
COMMENT ON COLUMN company_admin_notes.marcador IS
  'importacao_assistida_pedida | importacao_assistida_entregue: tempo de importacao assistida = diferenca entre os dois registros.';
COMMENT ON COLUMN lead_interactions.payload IS
  'Contato registrado pela Gestao Aura (jsonb): resultado, proximo_passo, proximo_passo_em, motivo, marcador, prorrogou_dias, canal, checkin.';
