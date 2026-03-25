-- ============================================================
-- Migration 013 — Obrigações eSocial ME no Calendário Fiscal
-- Feature: BE-29f
-- Criado em: 25/03/2026
-- ============================================================
-- Adiciona coluna esocial_admissao_sent em employees
-- (controle se a admissão já foi enviada ao eSocial)
-- e insere templates de obrigações trabalhistas ME
-- na tabela obligations_templates.
-- ============================================================

-- Coluna de controle de admissão eSocial por funcionário
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS esocial_admissao_sent  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS esocial_admissao_date  DATE,
  ADD COLUMN IF NOT EXISTS pis                    TEXT,
  ADD COLUMN IF NOT EXISTS cbo                    TEXT,
  ADD COLUMN IF NOT EXISTS scholarity             TEXT,
  ADD COLUMN IF NOT EXISTS gender                 CHAR(1),
  ADD COLUMN IF NOT EXISTS birth_date             DATE,
  ADD COLUMN IF NOT EXISTS nationality            TEXT DEFAULT 'brasileiro',
  ADD COLUMN IF NOT EXISTS first_job              BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_hours             INT DEFAULT 44,
  ADD COLUMN IF NOT EXISTS contract_type          TEXT DEFAULT '1',
  ADD COLUMN IF NOT EXISTS social_name            TEXT,
  ADD COLUMN IF NOT EXISTS race                   TEXT,
  ADD COLUMN IF NOT EXISTS marital                TEXT,
  ADD COLUMN IF NOT EXISTS nat_atividade          TEXT DEFAULT '01';

-- Templates de obrigações trabalhistas ME
-- (serão gerados em fiscal_obligations por worker mensal)
INSERT INTO obligations_templates (
  regime, obligation_type, title, description,
  frequency, due_day, due_month, alert_days_before,
  is_active
) VALUES
  -- Folha de pagamento + eSocial (S-1200 + S-1299) — dia 15
  (
    'me', 'trabalhista',
    'Folha de pagamento — enviar ao eSocial',
    'Enviar remunerações (S-1200) e fechar a folha (S-1299) até o dia 15. Sem o fechamento, a guia do FGTS Digital não é gerada.',
    'monthly', 15, NULL,
    ARRAY[10, 5, 3, 1],
    true
  ),
  -- DCTFWeb — INSS patronal + IRRF — dia 20
  (
    'me', 'trabalhista',
    'INSS dos funcionários — pagar via DCTFWeb',
    'Pagar INSS patronal (25,8%) e IRRF dos funcionários pelo portal e-CAC até o dia 20.',
    'monthly', 20, NULL,
    ARRAY[10, 5, 3, 1],
    true
  ),
  -- FGTS Digital — dia 20
  (
    'me', 'trabalhista',
    'FGTS dos funcionários — pagar via FGTS Digital',
    'Pagar 8% de FGTS de cada funcionário pelo portal FGTS Digital até o dia 20. Depende do S-1299 enviado.',
    'monthly', 20, NULL,
    ARRAY[10, 5, 3, 1],
    true
  )
ON CONFLICT DO NOTHING;

-- Índice para busca de funcionários com admissão pendente
CREATE INDEX IF NOT EXISTS idx_employees_esocial_pendente
  ON employees (company_id, esocial_admissao_sent)
  WHERE esocial_admissao_sent = false AND status = 'active';

COMMENT ON COLUMN employees.esocial_admissao_sent IS
  'true quando S-2200 foi transmitido ao eSocial com sucesso';
COMMENT ON COLUMN employees.pis IS
  'Número PIS/PASEP — obrigatório para envio ao eSocial';
COMMENT ON COLUMN employees.cbo IS
  'Código Brasileiro de Ocupações — necessário para S-2200';
