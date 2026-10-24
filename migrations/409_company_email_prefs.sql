-- ============================================================
-- AURA. — Migration 409: preferências de e-mail e endereços de aviso
-- (tq-87, 24/10/2026)
--
-- company_email_prefs: uma linha por empresa e tipo que a empresa pode
-- ligar/desligar. Linha AUSENTE vale o padrão (services/emailPreferencias,
-- PADROES): relatório, ajuda, acompanhamento, novidades e pedido novo da
-- loja nascem ligados (Caio, 21/10). Cobrança e segurança não têm linha:
-- sempre saem.
--   config (jsonb), por tipo:
--     relatorio   { dia 0-6, hora 0-23, versao, blocos[], destinatarios[] }
--     pedido_loja { pedido_destino: 'equipe' | 'enderecos', destinatarios[] }
--   destinatarios ausente = todos os endereços confirmados.
--   origem: 'migracao_409' | 'tela' | 'descadastro' | 'reclamacao' | ...
--
-- company_email_addresses: endereços EXTRAS de aviso por empresa. O
-- principal é o e-mail do dono (users.email de companies.owner_id), lido na
-- hora e sem linha aqui, para acompanhar a troca de e-mail do dono. Extra
-- só recebe depois de confirmado pelo link (token assinado em
-- services/emailLinks, sem coluna de token: apagar a linha invalida o link).
--
-- Migração do estado de hoje, sem perder nada:
--   1. weekly_report_enabled = true -> relatorio ligado (linha explícita).
--      O destinatário de hoje (COALESCE(report_email_override, email))
--      continua sendo o único destinatário: quando difere do e-mail do dono,
--      vira endereço extra já confirmado e fica marcado em destinatarios.
--   2. quem desligou pelo descadastro do tq-74 (audit_log
--      'email.descadastro', tipo relatorio) e segue com
--      weekly_report_enabled = false -> relatorio desligado (linha explícita).
--   3. as demais empresas ficam sem linha = padrão novo (ligado).
--
-- Idempotente: IF NOT EXISTS e ON CONFLICT DO NOTHING em tudo; rodar duas
-- vezes não muda nada. Não altera companies.
-- ============================================================

CREATE TABLE IF NOT EXISTS company_email_prefs (
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tipo        TEXT        NOT NULL
                          CHECK (tipo IN ('relatorio', 'ajuda', 'acompanhamento', 'novidades', 'pedido_loja')),
  ligado      BOOLEAN     NOT NULL,
  config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  origem      TEXT,
  updated_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, tipo)
);

CREATE TABLE IF NOT EXISTS company_email_addresses (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email                   TEXT        NOT NULL,
  confirmado_em           TIMESTAMPTZ,
  confirmacao_enviada_em  TIMESTAMPTZ,
  origem                  TEXT,
  created_by              UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_company_email_addresses_empresa_email
  ON company_email_addresses (company_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_company_email_addresses_email
  ON company_email_addresses (lower(email));

ALTER TABLE company_email_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_email_addresses ENABLE ROW LEVEL SECURITY;

-- 1a. Destinatário de hoje diferente do e-mail do dono: vira extra confirmado.
INSERT INTO company_email_addresses (company_id, email, confirmado_em, origem)
SELECT c.id, lower(trim(COALESCE(NULLIF(trim(c.report_email_override), ''), c.email))), NOW(), 'migracao_409'
  FROM companies c
  LEFT JOIN users u ON u.id = c.owner_id
 WHERE c.weekly_report_enabled = true
   AND COALESCE(NULLIF(trim(c.report_email_override), ''), NULLIF(trim(c.email), '')) IS NOT NULL
   AND lower(trim(COALESCE(NULLIF(trim(c.report_email_override), ''), c.email)))
       IS DISTINCT FROM lower(trim(COALESCE(u.email, '')))
ON CONFLICT DO NOTHING;

-- 1b. Relatório ligado, com o destinatário de hoje como único destinatário.
INSERT INTO company_email_prefs (company_id, tipo, ligado, config, origem)
SELECT c.id, 'relatorio', true,
       jsonb_build_object(
         'destinatarios',
         jsonb_build_array(lower(trim(COALESCE(NULLIF(trim(c.report_email_override), ''), NULLIF(trim(c.email), ''), u.email))))
       ),
       'migracao_409'
  FROM companies c
  LEFT JOIN users u ON u.id = c.owner_id
 WHERE c.weekly_report_enabled = true
   AND COALESCE(NULLIF(trim(c.report_email_override), ''), NULLIF(trim(c.email), ''), u.email) IS NOT NULL
ON CONFLICT (company_id, tipo) DO NOTHING;

-- 1c. Ligada sem nenhum e-mail conhecido (não recebia nada): ligada, sem lista.
INSERT INTO company_email_prefs (company_id, tipo, ligado, origem)
SELECT c.id, 'relatorio', true, 'migracao_409'
  FROM companies c
 WHERE c.weekly_report_enabled = true
ON CONFLICT (company_id, tipo) DO NOTHING;

-- 2. Descadastro do tq-74 que ainda vale: relatório desligado.
INSERT INTO company_email_prefs (company_id, tipo, ligado, origem)
SELECT DISTINCT a.company_id, 'relatorio', false, 'descadastro'
  FROM audit_log a
  JOIN companies c ON c.id = a.company_id
 WHERE a.action = 'email.descadastro'
   AND COALESCE(a.metadata->>'tipo', 'relatorio') = 'relatorio'
   AND c.weekly_report_enabled = false
ON CONFLICT (company_id, tipo) DO NOTHING;
