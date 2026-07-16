-- ============================================================
-- AURA KARATÊ — Migration 221: escape hatch escopado para purge em
-- cascata de karate_practitioner_transfers (append-only/imutável).
--
-- Contexto (bug de produção):
--   DELETE /federation/:id/dojos/:dojoId?cascade=true (karateDojos.js) e
--   DELETE /federation/:id/practitioners/:practitionerId?cascade=true
--   (karatePractitioners.js) precisam apagar linhas de
--   karate_practitioner_transfers como parte da exclusão definitiva em
--   cascata — mas a trigger de imutabilidade (migration 180) SEMPRE
--   levanta exceção em UPDATE/DELETE, mesmo dentro dessas cascatas
--   deliberadas e já confirmadas pelo caller (409 HAS_HISTORY + cascade=true).
--   Isso incluía também o DELETE indireto (via FK CASCADE de
--   practitioner_id) disparado ao apagar customers do dojô/praticante.
--
-- Correção: a função do trigger passa a permitir UPDATE/DELETE somente
-- quando o GUC de sessão/transação app.allow_transfer_purge está 'on'.
-- As rotas usam SET LOCAL (escopado à transação, expira sozinho no
-- COMMIT/ROLLBACK) imediatamente antes da cascata deliberada. Fora
-- disso — inclusive nas rotas de edição/exclusão de UM registro de
-- transferência (karateTransfers.js) — a tabela segue append-only e
-- imutável, como pretendido.
--
-- Idempotente por natureza: CREATE OR REPLACE FUNCTION.
-- ============================================================

CREATE OR REPLACE FUNCTION public.karate_practitioner_transfers_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.allow_transfer_purge', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'karate_practitioner_transfers é append-only e imutável. '
    'Use INSERT para registrar novas transferências. '
    'Contate o administrador para correções excepcionais.';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FIM DA MIGRATION 221
-- ============================================================
