-- ============================================================
-- Migration 070: Corrige default de tax_regime
--
-- BUG: migration 001 definiu DEFAULT 'mei' na coluna tax_regime
-- da tabela companies. Toda empresa criada sem escolher regime
-- ficava classificada como MEI erroneamente.
--
-- FIX:
--   1. Altera o DEFAULT para 'simples_nacional'
--   2. Backfill: todas as empresas com tax_regime = 'mei' são
--      atualizadas para 'simples_nacional', pois nenhuma empresa
--      cadastrada no sistema é MEI real (natureza jurídica 2135).
--      Empresas genuinamente MEI terão seu regime corrigido
--      manualmente via configurações se necessário.
-- ============================================================

-- 1. Corrige o default do banco
ALTER TABLE companies
  ALTER COLUMN tax_regime SET DEFAULT 'simples_nacional';

-- 2. Backfill: corrige todas as empresas que ficaram como MEI por default
UPDATE companies
SET    tax_regime = 'simples_nacional',
       updated_at = NOW()
WHERE  tax_regime = 'mei';
