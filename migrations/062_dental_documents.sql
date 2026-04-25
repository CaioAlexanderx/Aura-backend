-- ============================================================
-- AURA. — GAP-01: Receituário + Atestado + Pedido de Exame
-- Aplicada em producao via MCP Supabase em 25/04/2026.
-- Arquivo espelho criado conforme regra de migration da sessao.
-- ============================================================

CREATE TABLE IF NOT EXISTS dental_document_templates (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        REFERENCES companies(id) ON DELETE CASCADE,
  doc_type    varchar(40) NOT NULL,
  name        varchar(120) NOT NULL,
  content     text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_doc_templates_company
  ON dental_document_templates(company_id, doc_type) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS dental_documents (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id         uuid        REFERENCES customers(id) ON DELETE SET NULL,
  practitioner_id     uuid        REFERENCES dental_practitioners(id) ON DELETE SET NULL,
  appointment_id      uuid        REFERENCES dental_appointments(id) ON DELETE SET NULL,
  template_id         uuid        REFERENCES dental_document_templates(id) ON DELETE SET NULL,
  doc_type            varchar(40) NOT NULL,
  doc_number          varchar(20),
  content_data        jsonb       NOT NULL DEFAULT '{}',
  rendered_text       text        NOT NULL DEFAULT '',
  signed_at           timestamptz,
  signed_by_id        uuid        REFERENCES dental_practitioners(id) ON DELETE SET NULL,
  signature_hash      text,
  sent_whatsapp_at    timestamptz,
  sent_whatsapp_phone varchar(20),
  created_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_documents_company
  ON dental_documents(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dental_documents_customer
  ON dental_documents(company_id, customer_id, doc_type);

CREATE OR REPLACE FUNCTION dental_document_next_number(p_company_id uuid, p_prefix text)
RETURNS varchar AS $$
DECLARE v_seq int; v_today varchar;
BEGIN
  v_today := to_char(CURRENT_DATE, 'YYYYMMDD');
  SELECT COALESCE(COUNT(*),0)+1 INTO v_seq
    FROM dental_documents
   WHERE company_id = p_company_id
     AND doc_number LIKE p_prefix || v_today || '-%';
  RETURN p_prefix || v_today || '-' || lpad(v_seq::text,3,'0');
END;
$$ LANGUAGE plpgsql;

INSERT INTO dental_document_templates (doc_type, name, content) VALUES
('receituario_simples', 'Receituário Simples',
'RECEITUÁRIO ODONTOLÓGICO

Paciente: {{paciente}}
Data: {{data}}

{{medicamentos}}

Uso: {{posologia}}
Duração: {{duracao}}

{{observacoes}}'),

('receituario_controlado', 'Receituário de Controle Especial',
'RECEITUÁRIO DE CONTROLE ESPECIAL — VIA A e VIA B

Paciente: {{paciente}}
Data de nascimento: {{data_nascimento}}
Endereço: {{endereco}}
Data: {{data}}

{{medicamentos}}

Quantidade: {{quantidade}}
Uso: {{posologia}}
Duração: {{duracao}}
CID: {{cid}}

Prescritor responsável'),

('atestado_comparecimento', 'Atestado de Comparecimento',
'ATESTADO DE COMPARECIMENTO

Atestamos para os devidos fins que o(a) Sr(a). {{paciente}},
portador(a) do CPF {{cpf}}, compareceu a esta clínica odontológica
no dia {{data_consulta}}, no horário de {{hora_inicio}} às {{hora_fim}},
para atendimento odontológico.

{{observacoes}}'),

('atestado_incapacidade', 'Atestado de Incapacidade',
'ATESTADO MÉDICO-ODONTOLÓGICO

Atestamos que o(a) Sr(a). {{paciente}}, portador(a) do CPF {{cpf}},
esteve sob meus cuidados odontológicos, necessitando de afastamento
de suas atividades pelo período de {{dias}} dia(s),
a partir de {{data_inicio}}.

CID: {{cid}}
{{observacoes}}'),

('pedido_exame', 'Pedido de Exames',
'SOLICITAÇÃO DE EXAMES

Paciente: {{paciente}}
Data: {{data}}

Exames solicitados:
{{exames}}

Hipótese diagnóstica: {{hipotese_diagnostica}}
Urgência: {{urgencia}}

{{observacoes}}'),

('encaminhamento', 'Encaminhamento',
'ENCAMINHAMENTO

Encaminho o(a) paciente {{paciente}} ao colega especialista em
{{especialidade}}, para avaliação e tratamento.

Motivo: {{motivo}}
Hipótese diagnóstica: {{hipotese_diagnostica}}

{{observacoes}}')

ON CONFLICT DO NOTHING;
