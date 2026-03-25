-- ============================================================
-- Migration 013 — eSocial ME + campos extras em employees
-- Feature: BE-29f
-- Criado em: 25/03/2026
-- CORRIGIDO: usa schema real da obligations_templates (migration 005)
-- ============================================================

-- ── Novos campos em employees ─────────────────────────────────
-- Necessários para gerar o XML S-2200 corretamente

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS esocial_admissao_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS esocial_admissao_date DATE,
  ADD COLUMN IF NOT EXISTS pis                   TEXT,
  ADD COLUMN IF NOT EXISTS cbo                   TEXT,
  ADD COLUMN IF NOT EXISTS scholarity            TEXT,
  ADD COLUMN IF NOT EXISTS gender                CHAR(1),
  ADD COLUMN IF NOT EXISTS birth_date            DATE,
  ADD COLUMN IF NOT EXISTS nationality           TEXT DEFAULT 'brasileiro',
  ADD COLUMN IF NOT EXISTS first_job             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_hours            INT DEFAULT 44,
  ADD COLUMN IF NOT EXISTS contract_type         TEXT DEFAULT '1',
  ADD COLUMN IF NOT EXISTS social_name           TEXT,
  ADD COLUMN IF NOT EXISTS race                  TEXT,
  ADD COLUMN IF NOT EXISTS marital               TEXT,
  ADD COLUMN IF NOT EXISTS nat_atividade         TEXT DEFAULT '01';

-- Índice para busca de funcionários com admissão eSocial pendente
CREATE INDEX IF NOT EXISTS idx_employees_esocial_pendente
  ON employees (company_id, esocial_admissao_sent)
  WHERE esocial_admissao_sent = false;

COMMENT ON COLUMN employees.esocial_admissao_sent IS
  'true quando S-2200 foi transmitido ao eSocial com sucesso';
COMMENT ON COLUMN employees.pis IS
  'Número PIS/PASEP — obrigatório para envio ao eSocial';
COMMENT ON COLUMN employees.cbo IS
  'Código Brasileiro de Ocupações — necessário para S-2200';

-- ── Templates de obrigações trabalhistas ME ───────────────────
-- Usando o schema real da tabela (migration 005):
-- code, name_display, description, regime, frequency,
-- due_rule, due_day, responsible, filter_label, aura_action,
-- user_action, time_estimate, sort_order

INSERT INTO obligations_templates (
  code, name_display, description,
  regime, has_employee, cnae_category,
  frequency, due_rule, due_day,
  responsible, filter_label,
  aura_action, user_action, time_estimate,
  checkpoint_total, sort_order
) VALUES

  -- Folha mensal + eSocial (S-1200 + S-1299) — dia 15
  (
    'ESOCIAL_FOLHA_MENSAL',
    'Folha de pagamento — enviar ao governo',
    'Enviar remunerações (S-1200) e fechar a folha (S-1299) até o dia 15. Sem o fechamento, a guia do FGTS não é gerada.',
    'simples_nacional', true, 'general',
    'monthly', 'day_15', 15,
    'voce', 'voce_faz',
    'Calcula salários, INSS e IRRF de cada funcionário e gera os arquivos XML prontos para envio',
    'Acesse o eSocial com seu certificado digital, envie os arquivos e confirme o fechamento',
    '15 min',
    5, 30
  ),

  -- DCTFWeb — INSS patronal + IRRF — dia 20
  (
    'DCTFWEB_MENSAL',
    'INSS dos funcionários — pagar via governo',
    'Pagar INSS patronal (25,8%) e IRRF dos funcionários pelo portal e-CAC até o dia 20.',
    'simples_nacional', true, 'general',
    'monthly', 'day_20', 20,
    'voce', 'voce_faz',
    'Calcula o valor total de INSS e IRRF e guia você passo a passo no portal do governo',
    'Acesse o e-CAC, localize a DCTFWeb gerada automaticamente e pague o boleto',
    '10 min',
    3, 31
  ),

  -- FGTS Digital — dia 20
  (
    'FGTS_DIGITAL_MENSAL',
    'FGTS dos funcionários — pagar via governo',
    'Pagar 8% de FGTS de cada funcionário pelo portal FGTS Digital até o dia 20. Depende do fechamento da folha no eSocial.',
    'simples_nacional', true, 'general',
    'monthly', 'day_20', 20,
    'voce', 'voce_faz',
    'Calcula o valor total do FGTS e guia você passo a passo no FGTS Digital',
    'Acesse o FGTS Digital, localize a guia gerada após o fechamento da folha e pague',
    '10 min',
    3, 32
  )

ON CONFLICT (code) DO NOTHING;
