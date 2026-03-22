-- ============================================================
-- Migration 005 — Templates de Obrigações Fiscais (BE-24)
-- Parametrizável: atualizar tabela quando legislação mudar
-- ============================================================

-- Enum de responsável
CREATE TYPE obligation_responsible AS ENUM ('aura', 'voce', 'contador');

-- Enum de filtro (UI)
CREATE TYPE obligation_filter AS ENUM ('aura_resolve', 'voce_faz', 'contador');

-- Enum de frequência
CREATE TYPE obligation_frequency AS ENUM ('monthly', 'annual', 'per_event', 'continuous');

-- Tabela de templates parametrizável
CREATE TABLE IF NOT EXISTS obligations_templates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Critérios de elegibilidade
  regime          TEXT NOT NULL CHECK (regime IN ('mei', 'simples_nacional', 'both')),
  has_employee    BOOLEAN,                -- NULL = indiferente, true/false = específico
  cnae_category   TEXT NOT NULL DEFAULT 'general',  -- 'general' | 'icms' | 'esocial_only'

  -- Identificação
  code            TEXT NOT NULL UNIQUE,
  name_display    TEXT NOT NULL,          -- linguagem simples para o cliente
  description     TEXT,                  -- detalhe interno

  -- Prazo
  frequency       obligation_frequency NOT NULL,
  due_rule        TEXT,                  -- ex: 'day_20', 'may_31', 'mar_31', 'day_7', 'per_event'
  due_month       SMALLINT,              -- para obrigações anuais: mês de vencimento (1-12)
  due_day         SMALLINT,              -- dia do vencimento (para mensais)

  -- Responsabilidade
  responsible     obligation_responsible NOT NULL,
  filter_label    obligation_filter NOT NULL,
  aura_action     TEXT NOT NULL,         -- o que a Aura faz — aparece na UI
  user_action     TEXT,                  -- o que o usuário faz (se responsible = voce)
  time_estimate   TEXT,                  -- ex: '5 min', '10 min' (se responsible = voce)

  -- Checkpoints gamificados
  checkpoint_total SMALLINT DEFAULT 0,

  -- Controle
  active          BOOLEAN NOT NULL DEFAULT true,
  sort_order      SMALLINT DEFAULT 99,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Adicionar colunas ao fiscal_obligations para rastrear template
ALTER TABLE fiscal_obligations
  ADD COLUMN IF NOT EXISTS template_id    UUID REFERENCES obligations_templates(id),
  ADD COLUMN IF NOT EXISTS responsible    obligation_responsible,
  ADD COLUMN IF NOT EXISTS filter_label   obligation_filter,
  ADD COLUMN IF NOT EXISTS aura_action    TEXT,
  ADD COLUMN IF NOT EXISTS user_action    TEXT,
  ADD COLUMN IF NOT EXISTS time_estimate  TEXT;

CREATE INDEX idx_obligations_templates_regime ON obligations_templates(regime, has_employee, active);

COMMENT ON TABLE obligations_templates IS
  'Templates parametrizáveis de obrigações fiscais por regime + CNAE + tem funcionário. Atualizar aqui quando legislação mudar — sem alterar código.';
