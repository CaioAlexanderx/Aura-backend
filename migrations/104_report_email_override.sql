-- ============================================================
-- AURA. — Migration 104: report_email_override
--
-- Permite sobrescrever o e-mail de destino do relatório semanal
-- por empresa. Quando NULL, o scheduler usa companies.email.
--
-- Caso de uso: Encanto Presentes (cliente Alynne) — relatório
-- semanal vai para o e-mail pessoal dela, não para o e-mail
-- de cadastro da empresa.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS report_email_override TEXT;

COMMENT ON COLUMN companies.report_email_override IS
  'E-mail dedicado para envio do relatório semanal (sobrescreve companies.email). NULL = usar companies.email.';

-- Encanto Presentes (Alynne Rodrigues Barbosa) — envio para e-mail pessoal
UPDATE companies
SET report_email_override = 'alynnerodrgs@gmail.com'
WHERE (LOWER(COALESCE(trade_name, '')) LIKE '%encanto%presentes%'
    OR LOWER(COALESCE(legal_name, '')) LIKE '%encanto%presentes%')
  AND is_active = true;
