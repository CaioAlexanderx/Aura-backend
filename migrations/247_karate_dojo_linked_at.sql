-- ============================================================
-- AURA DOJÔ — Migration 247: karate_dojo_linked_at (visibilidade p/ federação)
-- ------------------------------------------------------------
-- NUMERAÇÃO: 246 (turmas/presença F4) é a última tomada — esta é a 247.
-- Convenção CLAUDE.md: numeração sequencial, incrementar.
--
-- BUG (QA 20/07/2026): um dojô self-serve (company vertical='karate_dojo'
-- com federation_id setado — necessário para o roteamento /federation/:id/
-- dojo/*) apareceu na INTERFACE da federação (lista de dojôs da FPKT).
--
-- MODELO CORRETO: federation_id é vínculo TÉCNICO (roteamento + guard
-- requireDojoAccess), NÃO visibilidade. A VISIBILIDADE de um dojô para a
-- federação nasce só com a CONEXÃO/filiação aceita (fase F6 formaliza o
-- fluxo). Enquanto não conectado, o shell do dojô é 100% funcional, mas ele
-- é INVISÍVEL para a federação (listas, contagens, agregados, campanha de
-- anuidade, régua, saúde da rede).
--
-- Coluna karate_dojo_linked_at timestamptz NULL:
--   NULL     = ainda NÃO conectado (self-serve; invisível para a federação)
--   NOT NULL = conectado/filiado (visível) — timestamp do vínculo
--
-- ESCRITA (ver back PR): POST /federation/:id/dojos (federação cadastra) e
-- PATCH /admin/clients/:cid/karate mode='dojo' setam now() na criação
-- (registro DA federação, sempre visível). O fluxo F6 setará no ACEITE da
-- conexão de um dojô self-serve.
--
-- BACKFILL: todos os dojôs EXISTENTES foram criados pela federação/admin
-- (o fluxo self-serve F6 ainda nem existe), então são visíveis → recebem
-- created_at (ou now() se nulo). O dojô de QA será DESVINCULADO manualmente
-- depois, FORA desta migration:
--   UPDATE companies SET karate_dojo_linked_at = NULL WHERE id = '<dojo_qa>';
--
-- ORDEM: aplicar ANTES do deploy do backend — as listagens/agregados da
-- federação passam a filtrar por karate_dojo_linked_at IS NOT NULL (direto
-- nas leituras; onde barato o backend degrada em 42703 — ver PR).
-- Idempotente (ADD COLUMN IF NOT EXISTS + backfill só onde NULL). NÃO
-- aplicada neste PR.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS karate_dojo_linked_at timestamptz;

-- Backfill: dojôs existentes = criados pela federação/admin → visíveis.
-- Idempotente (só toca linhas ainda NULL). vertical = identidade canônica
-- (migration 147); INSERT/PATCH gravam vertical E vertical_active juntos.
UPDATE companies
   SET karate_dojo_linked_at = COALESCE(created_at, now())
 WHERE vertical = 'karate_dojo'
   AND karate_dojo_linked_at IS NULL;

COMMENT ON COLUMN companies.karate_dojo_linked_at IS
  'Aura Dojo (migration 247): timestamp da CONEXAO/filiacao do dojo a federacao. NULL = dojo self-serve ainda NAO conectado (invisivel para a federacao: listas/contagens/agregados/campanha/regua/saude da rede filtram por IS NOT NULL); NOT NULL = conectado/visivel. federation_id e vinculo TECNICO (roteamento/guard), NAO visibilidade. Setado em now() na criacao pela federacao (POST /dojos) e pelo admin (PATCH .../karate mode=dojo); o fluxo F6 seta no aceite da conexao de um dojo self-serve.';
