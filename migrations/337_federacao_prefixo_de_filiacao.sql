-- ============================================================
-- 337 — Prefixo do código de filiação vira dado da federação
--
-- POR QUE: `nextDojoAffiliationId` (src/services/karateService.js) devolvia
-- `FPKT-NNN` HARDCODED para QUALQUER federação. Ao criar a segunda federação
-- (JKA Teste, 16/09/2026) os 10 dojôs dela nasceram FPKT-001..FPKT-010 — o
-- código de filiação de uma federação carimbado na outra.
--
-- Diretriz do Caio (16/09/2026): nenhuma identidade de federação escrita no
-- código; tudo deriva do registro em `companies`. O prefixo passa a ser uma
-- COLUNA da federação — estado declarado, não deduzido.
--
-- BACKFILL SEM NOME PRÓPRIO NO SQL: cada federação recebe o prefixo que os
-- PRÓPRIOS dojôs dela já usam (o pedaço antes do `-NNN` final do
-- `fpkt_affiliation_id` mais recente). Por construção nenhuma numeração
-- existente muda: a federação incumbente continua FPKT-NNN. Federação sem
-- dojô numerado fica NULL e o código resolve na hora (ver karateService.js).
--
-- ⚠️ A JKA Teste também é backfillada com 'FPKT', porque é isso que os dojôs
-- dela têm hoje. Corrigir para o prefixo próprio é ato de operação, não de
-- migration: PUT /federation/:id/settings/identity { affiliation_prefix }.
-- Os 10 dojôs já criados mantêm o código antigo (renumerar é outra decisão —
-- `fpkt_affiliation_id` é campo de exibição/busca, não chave estrangeira).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE só onde ainda é NULL.
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS karate_affiliation_prefix text;

COMMENT ON COLUMN companies.karate_affiliation_prefix IS
  'Federação: prefixo do código de filiação dos dojôs (ex.: FPKT -> FPKT-001). NULL = resolvido na hora a partir dos dojôs existentes / slug. Ver src/services/karateService.js:nextDojoAffiliationId.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'companies'
       AND column_name  = 'fpkt_affiliation_id'
  ) THEN
    UPDATE companies f
       SET karate_affiliation_prefix = sub.prefix
      FROM (
        SELECT DISTINCT ON (d.federation_id)
               d.federation_id,
               -- 'FPKT-014' -> 'FPKT'. Sem o `-NNN` final não há prefixo.
               substring(d.fpkt_affiliation_id from '^(.+)-[0-9]+$') AS prefix
          FROM companies d
         WHERE d.vertical = 'karate_dojo'
           AND d.federation_id IS NOT NULL
           AND d.fpkt_affiliation_id ~ '^.+-[0-9]+$'
         ORDER BY d.federation_id, d.fpkt_affiliation_id DESC
      ) sub
     WHERE f.id = sub.federation_id
       AND f.vertical = 'karate_federation'
       AND f.karate_affiliation_prefix IS NULL
       AND sub.prefix IS NOT NULL
       AND sub.prefix <> '';
  END IF;
END $$;
