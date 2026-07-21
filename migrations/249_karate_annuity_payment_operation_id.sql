-- ============================================================
-- AURA KARATÊ — Migration 249: F3 da reforma da anuidade
-- Dedup de retry HTTP na baixa livre por anuidade (operation_id).
-- ------------------------------------------------------------
-- Contexto (dívida deixada explícita no comentário de topo de
-- src/services/karateAnnuityLedger.js, Fase F1): applyAnnuityPayment roda
-- toda a leitura+distribuição+escrita em UMA transação com
-- SELECT...FOR UPDATE, o que já serializa duas chamadas concorrentes sobre
-- a MESMA anuidade — mas isso não protege contra um RETRY HTTP que reenvia
-- a MESMA requisição de baixa duas vezes (ex.: timeout no cliente + reenvio
-- automático, duplo-clique no botão de confirmar): do ponto de vista do
-- motor são dois `amount` legítimos, ele não tem como saber que é retry.
-- A F1 documentou que resolver isso era escopo da F3 (rota HTTP) — esta
-- migration é a peça de schema para isso.
--
-- Desenho escolhido — TABELA DE IDEMPOTÊNCIA dedicada (não uma coluna
-- UNIQUE direto em karate_annuity_payments): uma baixa livre por FIFO pode
-- gerar VÁRIAS linhas no ledger (uma por parcela tocada — ex.: R$300
-- quitando 2 parcelas parciais diferentes = 2 linhas de
-- karate_annuity_payments para o mesmo operation_id). Um UNIQUE
-- (annuity_id, operation_id) direto no ledger impediria a 2ª linha da
-- MESMA operação legítima. Uma tabela separada, com operation_id como
-- PRIMARY KEY (mesmo padrão já usado neste repo em troca_idempotency,
-- migration 135), guarda UMA reserva por operação (INSERT ... ON CONFLICT
-- DO NOTHING) e o snapshot completo do resultado (`result` jsonb) — um
-- retry com o MESMO operation_id perde a corrida no INSERT, não escreve
-- nada de novo, e a rota devolve o `result` já gravado (idempotent_hit:
-- true), com o MESMO shape que o commit original devolveu.
--
-- karate_annuity_payments.operation_id (NOVA, nullable, SEM unicidade):
-- tag de rastreabilidade — liga cada linha do ledger à operação/commit que
-- a originou (útil pra auditoria/extrato: "quais linhas vieram do mesmo
-- clique de baixa"). Não é o mecanismo de dedup em si (esse é a tabela
-- acima) — por isso não tem UNIQUE.
--
-- Sem operation_id no request, comportamento idêntico ao F1 (aplica
-- normal, sem passar pela tabela de idempotência) — dedup é opt-in do
-- cliente (F4/preview nunca populam isso; só o commit real).
--
-- Backend sobe antes desta migration ser aplicada (armadilha #1 do
-- CLAUDE.md): applyAnnuityPayment cacheia module-level
-- (HAS_OPERATION_ID_SUPPORT) e cai para 42P01 → aplica sem dedup em vez de
-- 500 (a baixa em si nunca fica bloqueada pela ausência desta tabela).
--
-- Esta migration NÃO é aplicada em produção neste PR (mesmo padrão de
-- 241/243/244/245/246/247/248 — aplicar via Supabase MCP depois do merge).
-- Idempotente de ponta a ponta.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_annuity_payment_operations (
  operation_id   text PRIMARY KEY,
  federation_id  uuid NOT NULL,
  annuity_id     uuid NOT NULL,
  amount         numeric NOT NULL,
  result         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kapo_annuity_id
  ON karate_annuity_payment_operations (annuity_id);

CREATE INDEX IF NOT EXISTS idx_kapo_federation_id
  ON karate_annuity_payment_operations (federation_id);

-- ── karate_annuity_payments ganha operation_id (rastreabilidade, sem
-- unicidade — ver justificativa acima) ──────────────────────────────────
ALTER TABLE karate_annuity_payments
  ADD COLUMN IF NOT EXISTS operation_id text;

CREATE INDEX IF NOT EXISTS idx_kap_operation_id
  ON karate_annuity_payments (operation_id)
  WHERE operation_id IS NOT NULL;

-- ============================================================
-- FIM DA MIGRATION 249
-- ============================================================
