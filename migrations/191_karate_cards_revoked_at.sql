-- migration 191: karate_membership_cards.revoked_at
-- Coluna de timestamp da revogação de carteirinha (decisão Caio 25/06/2026:
-- liberdade total da federação — revogar carteirinha emitida).
-- O status 'revoked' já era suportado pelo schema e por verifyByToken; faltava
-- registrar QUANDO foi revogada. revokeCard() grava revoked_at = NOW().
-- Idempotente (IF NOT EXISTS) — seguro reaplicar.
--
-- Coordenação de numeração: 190 reservada ao domínio Dojô (delete/void); este
-- branch (domínio Praticante) usa 191.

ALTER TABLE karate_membership_cards
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
