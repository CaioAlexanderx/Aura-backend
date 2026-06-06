-- ============================================================
-- AURA KARATÊ — Migration 148: Extensão customers (praticante)
-- Adiciona campos de filiação federativa ao cadastro de clientes
-- Padrão: ADD COLUMN IF NOT EXISTS (idempotente)
-- ============================================================

-- Flag: este customer é um praticante de karatê
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_student BOOLEAN NOT NULL DEFAULT false;

-- Responsável legal (para praticantes menores de idade — LGPD Art.14)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS parent_guardian_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- Número de registro único na federação (ex: 'FPKT-A-01429')
-- Gerado sequencialmente pela federação; imutável após emissão
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS karate_registration_number TEXT;

-- FK para a federação à qual o praticante está filiado
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS federation_id UUID REFERENCES companies(id) ON DELETE SET NULL;

-- FK para o dojô atual do praticante
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS dojo_id UUID REFERENCES companies(id) ON DELETE SET NULL;

-- Funções técnicas do praticante na federação
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_arbiter    BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_instructor BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_examiner   BOOLEAN NOT NULL DEFAULT false;

-- Foto 3x4 para a carteirinha digital
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS karate_photo_url TEXT;

-- Data de nascimento (pode não estar preenchida no cadastro Aura padrão)
-- birth_date já existe na tabela customers desde migration 001
-- Nada a adicionar para este campo

-- RG (documento adicional exigido para carteirinha)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS rg TEXT;

-- Índices
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_karate_reg_number
  ON customers(karate_registration_number)
  WHERE karate_registration_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_federation
  ON customers(federation_id)
  WHERE federation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_dojo
  ON customers(dojo_id)
  WHERE dojo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_is_student
  ON customers(company_id, is_student)
  WHERE is_student = true;

-- ============================================================
-- FIM DA MIGRATION 148
-- ============================================================
