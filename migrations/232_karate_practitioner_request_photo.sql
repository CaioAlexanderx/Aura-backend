-- ============================================================
-- AURA KARATÊ — Migration 232: foto na solicitação de praticante (item 9
-- da revisão de Atualização Cadastral, 15/07/2026)
-- ------------------------------------------------------------
-- karate_practitioner_requests ainda não tinha campo de foto — o Caio
-- pediu que "solicitar novo praticante" (H2/H2b) suporte foto, reusando o
-- MESMO mecanismo de upload já usado para praticante existente
-- (POST /federation/:id/practitioners/:practitionerId/photo em
-- karatePractitioners.js: JSON + base64 -> Cloudflare R2 -> grava URL).
--
-- Como a solicitação ainda NÃO é um praticante (não existe linha em
-- customers até a federação aprovar), a foto fica temporariamente aqui —
-- os novos endpoints de upload (karateDojoPractitionerRequests.js e
-- karateRosterPortalPublic.js) sobem para o MESMO bucket R2 (uploadToR2,
-- nenhum mecanismo novo) sob a chave
-- karate/practitioner-requests/{requestId}.{ext} e gravam a URL aqui.
-- Na aprovação (karatePractitionerRequestsAdmin.js), esta URL é copiada
-- 1:1 para customers.karate_photo_url — mesma coluna que toda foto de
-- praticante já usa, sem duplicar o conceito.
--
-- Idempotente (IF NOT EXISTS).
-- ============================================================

ALTER TABLE karate_practitioner_requests ADD COLUMN IF NOT EXISTS photo_url text;

COMMENT ON COLUMN karate_practitioner_requests.photo_url IS 'Foto do praticante solicitado (R2, mesmo mecanismo de customers.karate_photo_url) — copiada para customers.karate_photo_url quando a solicitação é aprovada. Item 9, revisão Atualização Cadastral 15/07/2026.';
