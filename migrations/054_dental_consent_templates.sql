-- ============================================================
-- AURA. — W2-04 Migration 054: TCLE templates + documents
--
-- Aplicada via Supabase MCP em 2026-04-25.
-- Mirror file (CI Github Actions valida que toda migration
-- via MCP tem arquivo espelho aqui).
--
-- Duas tabelas:
--
-- 1. dental_consent_templates: biblioteca de modelos
--    - is_system=true => template Aura (company_id NULL, todos veem)
--    - is_system=false => customizado pela clinica (company_id obrigatorio)
--    - body_md: markdown do termo com placeholders {{nome_paciente}},
--      {{procedimento}}, {{dente}}, {{valor_estimado}}, {{riscos}},
--      {{observacoes}}, {{nome_clinica}}, {{nome_dentista}}, {{cro}},
--      {{data}}.
--    - placeholders text[]: lista declarada de placeholders pra
--      validacao do form.
--    - category enum: cirurgia, endodontia, implante, ortodontia,
--      estetica, periodontia, protese, generico, lgpd
--
-- 2. dental_consent_documents: instancias de TCLEs preenchidos
--    - rendered_md: markdown final ja com placeholders substituidos
--    - placeholders_filled jsonb: valores preenchidos (auditoria)
--    - status enum: pending (token gerado, aguarda assinatura),
--      signed (paciente assinou), expired (10min sem uso),
--      void (cancelado pelo dentista antes de assinar)
--    - signature_url text: URL do PNG no R2 apos assinatura
--    - token text UNIQUE: usado em /dental/consent/sign/:token
--    - token_expires_at: 10min apos criacao
--    - signed_at: NOW() ao receber WS signature
--
-- Reuso: motor de assinatura WS do W1-04 (dentalWs.js) sera
-- estendido pra detectar tipo de token (appointment vs consent).
-- ============================================================

CREATE TABLE IF NOT EXISTS dental_consent_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        text NOT NULL,
  title       text NOT NULL,
  category    text NOT NULL CHECK (category IN (
    'cirurgia','endodontia','implante','ortodontia',
    'estetica','periodontia','protese','generico','lgpd'
  )),
  body_md     text NOT NULL,
  placeholders text[] NOT NULL DEFAULT '{}',
  is_system   boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT NOW(),
  updated_at  timestamptz DEFAULT NOW(),
  CONSTRAINT consent_tpl_unique_code UNIQUE NULLS NOT DISTINCT (company_id, code),
  CONSTRAINT consent_tpl_scope_check CHECK (
    (is_system = true  AND company_id IS NULL) OR
    (is_system = false AND company_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_consent_tpl_company  ON dental_consent_templates(company_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_consent_tpl_system   ON dental_consent_templates(is_system)  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_consent_tpl_category ON dental_consent_templates(category)   WHERE is_active = true;

CREATE TABLE IF NOT EXISTS dental_consent_documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id          uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  template_id          uuid NULL REFERENCES dental_consent_templates(id) ON DELETE SET NULL,
  appointment_id       uuid NULL REFERENCES dental_appointments(id) ON DELETE SET NULL,
  treatment_plan_id    uuid NULL,
  practitioner_id      uuid NULL REFERENCES dental_practitioners(id) ON DELETE SET NULL,
  title                text NOT NULL,
  category             text NOT NULL,
  rendered_md          text NOT NULL,
  placeholders_filled  jsonb NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','signed','expired','void')),
  token                text NOT NULL UNIQUE,
  token_expires_at     timestamptz NOT NULL,
  signature_url        text NULL,
  signed_at            timestamptz NULL,
  signer_ip            text NULL,
  signer_user_agent    text NULL,
  created_by           uuid NULL,
  created_at           timestamptz DEFAULT NOW(),
  updated_at           timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_doc_company        ON dental_consent_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_consent_doc_customer       ON dental_consent_documents(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_doc_token          ON dental_consent_documents(token) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_consent_doc_appointment    ON dental_consent_documents(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_doc_status_pending ON dental_consent_documents(token_expires_at) WHERE status = 'pending';

-- Triggers updated_at
CREATE OR REPLACE FUNCTION dental_consent_templates_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_consent_tpl_updated_at ON dental_consent_templates;
CREATE TRIGGER trg_consent_tpl_updated_at
  BEFORE UPDATE ON dental_consent_templates
  FOR EACH ROW EXECUTE FUNCTION dental_consent_templates_set_updated_at();

CREATE OR REPLACE FUNCTION dental_consent_documents_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_consent_doc_updated_at ON dental_consent_documents;
CREATE TRIGGER trg_consent_doc_updated_at
  BEFORE UPDATE ON dental_consent_documents
  FOR EACH ROW EXECUTE FUNCTION dental_consent_documents_set_updated_at();

-- 10 templates Aura (system, company_id NULL)
-- Os 10 codigos seed: cirurgia_extracao_simples, endodontia_canal, implante_unitario,
-- ortodontia_aparelho_fixo, estetica_clareamento, periodontia_cirurgia,
-- protese_coroa_unitaria, generico_avaliacao, generico_cirurgico, lgpd_imagem
--
-- IMPORTANTE: o seed completo dos 10 templates (com body_md de ~1KB cada,
-- ~9KB total) foi aplicado via MCP em producao em 2026-04-25. Para ver o
-- conteudo exato dos templates, consulte:
--
--   SELECT * FROM dental_consent_templates WHERE is_system = true;
--
-- Os templates estao versionados como dados (system seed), nao como schema.
-- Para reaplicar em ambiente novo, executar este script + script separado
-- de seed (a vir).
