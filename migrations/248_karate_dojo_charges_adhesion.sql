-- ============================================================
-- AURA KARATÊ — Migration 248: F2 da reforma da anuidade
-- companies.karate_charges_adhesion — seletor persistente que decide se
-- aquele dojô paga a taxa de ADESÃO (filiação, R$195 — ADESAO_FEE_BRL em
-- karateAnnuityService.js) no próximo lançamento de anuidade.
-- ------------------------------------------------------------
-- Contexto de negócio (decisão fechada com o Caio, F2):
--   A adesão NÃO é automática por "é dojô novo" — é um SELETOR que a
--   federação marca no CADASTRO do dojô (POST /federation/:id/dojos) e na
--   REATIVAÇÃO (PATCH /federation/:id/dojos/:dojoId, is_active:true).
--   Dojô que retorna pode ser isento (reativado sem marcar o seletor).
--
-- Desenho escolhido (documentado aqui porque é a decisão de arquitetura
-- do F2 — ver PR): COLUNA persistente em companies, não um flag solto no
-- request de /charge. Motivo: o Caio descreveu o gatilho como algo que a
-- federação MARCA no cadastro/reativação (um estado que existe ANTES do
-- lançamento, não uma decisão tomada no momento de cobrar) — um flag
-- efêmero no body do POST .../charge exigiria o operador lembrar de
-- marcá-lo TODA VEZ que lança a anuidade daquele dojô específico (e
-- reproduziria, para adesão, o mesmo bug de produto que a Migration 226
-- corrigiu para plano: dado importante vivendo só na cabeça do operador).
-- Uma coluna persistente + a rota de /charge lendo essa coluna no momento
-- do lançamento (mesmo padrão de karate_annuity_plan/Migration 226) deixa
-- a decisão auditável e visível no cadastro do dojô, sem repetição manual.
--
-- Mesma armadilha_schema_pre_migration do CLAUDE.md: o backend sobe antes
-- desta migration ser aplicada — karateDojos.js/karateAnnuities.js
-- guardam com cache module-level otimista (HAS_CHARGES_ADHESION_COL),
-- caindo em 42703 quando a coluna ainda não existe (dojô sem seletor
-- disponível ainda / /charge nunca semeia adesão nesse meio-tempo — igual
-- ao fallback já usado para karate_annuity_plan/phone_mobile).
--
-- Guarda de unicidade contra duplicação (reativar um dojô que já pagou
-- adesão): NÃO é feita nesta migration via constraint de banco (a parcela
-- de adesão vive em karate_annuity_installments, ligada a companies só
-- indiretamente via karate_dojo_annuity_history.dojo_id — um índice único
-- parcial exigiria join, que Postgres não permite em UNIQUE INDEX direto).
-- A guarda é feita em APLICAÇÃO, dentro da mesma transação do /charge, com
-- advisory lock por dojô (mesmo padrão do lock de cobrança duplicada por
-- período já usado nesta rota) — ver buildAdhesionSpec() em
-- karateAnnuityService.js e o comentário na rota /charge de
-- karateAnnuities.js.
--
-- DEFAULT false (não NULL): ao contrário de karate_annuity_plan (onde NULL
-- = "indefinido" é um estado de negócio real e deve ficar visível), aqui
-- "a federação ainda não decidiu" e "este dojô não paga adesão" são o
-- MESMO estado prático (nenhuma parcela de adesão é gerada) — não há
-- comportamento de billing que dependa de distinguir NULL de false, então
-- manter a coluna NOT NULL evita um terceiro estado sem uso real.
--
-- Esta migration NÃO é aplicada em produção neste PR (padrão de 241/243/
-- 244/245/246/247 — aplicar via Supabase MCP depois do merge). Idempotente
-- de ponta a ponta.
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS karate_charges_adhesion boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.karate_charges_adhesion IS
  'Seletor (F2 da reforma da anuidade): true = este dojô paga a taxa de adesão/filiação (ADESAO_FEE_BRL, karateAnnuityService.js) no próximo lançamento de anuidade. Marcado pela federação no cadastro do dojô (POST /federation/:id/dojos) ou na reativação (PATCH .../dojos/:dojoId, is_active:true). Não é automático por "dojô novo" — dojô que retorna pode ser isento. Só aplicável a vertical_active=karate_dojo.';
