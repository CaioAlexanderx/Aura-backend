-- Migration 114: Aceite de Termos de Uso
-- Adiciona campos para registrar quando e qual versão dos Termos o usuário aceitou.
-- Idempotente — seguro para re-executar.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_version     VARCHAR(20);

-- Índice para auditoria rápida (ex: filtrar usuários que aceitaram a v1 e precisam re-aceitar a v2)
CREATE INDEX IF NOT EXISTS idx_users_terms_accepted_at
  ON users (terms_accepted_at)
  WHERE terms_accepted_at IS NOT NULL;
