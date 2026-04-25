-- ============================================================
-- AURA. — GAP-04: Templates específicos de Pedido de Exames
-- Aplicada em producao via MCP Supabase em 25/04/2026.
-- Arquivo espelho criado conforme regra de migration da sessao.
--
-- Complementa o template generico ja existente com modelos
-- pre-formatados para os exames mais comuns em odontologia.
-- ============================================================

INSERT INTO dental_document_templates (company_id, doc_type, name, content, is_active)
VALUES

(NULL, 'pedido_exame', 'RX Periapical',
'SOLICITACAO DE RADIOGRAFIA PERIAPICAL

Paciente: {{paciente}}
Data: {{data}}

Solicito a realizacao de Radiografia Periapical do(s) elemento(s) dentario(s) {{elementos_dentarios}}.

Indicacao clinica: {{indicacao_clinica}}

Observacoes: {{observacoes}}

Atenciosamente,
{{dentista}}
CRO {{cro}}', true),

(NULL, 'pedido_exame', 'RX Panoramico',
'SOLICITACAO DE RADIOGRAFIA PANORAMICA

Paciente: {{paciente}}
Data: {{data}}

Solicito a realizacao de Radiografia Panoramica.

Indicacao clinica: {{indicacao_clinica}}

Observacoes: {{observacoes}}

Atenciosamente,
{{dentista}}
CRO {{cro}}', true),

(NULL, 'pedido_exame', 'Tomografia CBCT',
'SOLICITACAO DE TOMOGRAFIA COMPUTADORIZADA DE FEIXE CONICO (CBCT)

Paciente: {{paciente}}
Data: {{data}}

Solicito a realizacao de Tomografia Computadorizada de Feixe Conico (CBCT)
Regiao de interesse: {{regiao}}
Campo de visao (FOV): {{fov}}

Indicacao clinica: {{indicacao_clinica}}

Observacoes: {{observacoes}}

Atenciosamente,
{{dentista}}
CRO {{cro}}', true),

(NULL, 'pedido_exame', 'RX Interproximal (Bite-Wing)',
'SOLICITACAO DE RADIOGRAFIA INTERPROXIMAL (BITE-WING)

Paciente: {{paciente}}
Data: {{data}}

Solicito a realizacao de Radiografias Interproximais (Bite-Wing)
Regiao: {{regiao}}

Indicacao clinica: Avaliacao de caries interproximais e nivel osseo crestal.

Observacoes: {{observacoes}}

Atenciosamente,
{{dentista}}
CRO {{cro}}', true),

(NULL, 'pedido_exame', 'Hemograma + Coagulograma',
'SOLICITACAO DE EXAMES LABORATORIAIS

Paciente: {{paciente}}
Data: {{data}}

Solicito os seguintes exames laboratoriais:

- Hemograma Completo
- Tempo de Protrombina (TP/RNI)
- Tempo de Tromboplastina Parcial Ativada (TTPA)
- Contagem de Plaquetas

Indicacao: Avaliacao pre-operatoria para procedimento odontologico cirurgico.

Observacoes: {{observacoes}}

Atenciosamente,
{{dentista}}
CRO {{cro}}', true),

(NULL, 'pedido_exame', 'Glicemia em Jejum',
'SOLICITACAO DE EXAME LABORATORIAL

Paciente: {{paciente}}
Data: {{data}}

Solicito:

- Glicemia em Jejum

Indicacao: Avaliacao metabolica pre-operatoria / controle glicemico.

Observacoes: {{observacoes}}

Atenciosamente,
{{dentista}}
CRO {{cro}}', true),

(NULL, 'pedido_exame', 'Pre-Operatorio Completo',
'SOLICITACAO DE EXAMES PRE-OPERATORIOS

Paciente: {{paciente}}
Data: {{data}}

Para realizacao de {{procedimento_cirurgico}}, solicito:

HEMATOLOGICOS
- Hemograma Completo com Diferencial
- Tempo de Protrombina (TP/RNI)
- Tempo de Tromboplastina Parcial Ativada (TTPA)
- Contagem de Plaquetas

BIOQUIMICOS
- Glicemia em Jejum
- Creatinina

Urgencia: {{urgencia}}

Observacoes: {{observacoes}}

Atenciosamente,
{{dentista}}
CRO {{cro}}', true)

ON CONFLICT DO NOTHING;
