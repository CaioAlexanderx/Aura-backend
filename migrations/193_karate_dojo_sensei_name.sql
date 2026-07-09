-- migration 193: karate_dojo_sensei_name
-- Adiciona nome do sensei responsável e vínculo opcional a um praticante (customers)
-- ao cadastro do dojô (companies vertical='karate_dojo').
--
-- sensei_name            → texto livre (ex.: "Sensei João da Silva")
-- sensei_practitioner_id → FK soft para customers.id (sem FK rígida para não
--                          travar exclusão de praticante; o app valida na UI).
--                          ON DELETE SET NULL garante integridade sem bloquear.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS).
-- NÃO APLICAR manualmente — aplique via script de migração padrão do projeto.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS sensei_name text;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS sensei_practitioner_id uuid
    REFERENCES customers(id) ON DELETE SET NULL;
