-- ============================================================
-- AURA. — Migration 345: novos status da agenda odonto
--
-- QA do módulo odonto (16/09/2026): o app oferece "confirmado",
-- "paciente_consultorio" (paciente chegou / na sala de espera) e
-- "falta_justificada", mas o enum dental_appointment_status só tinha
-- agendado, avaliacao, aprovado, em_atendimento, concluido, cancelado e
-- faltou. Consequências em produção:
--   - PATCH de status com esses valores caía em 400 (máquina de estados);
--   - o portal do paciente (POST /dental-portal/:token/confirm/:aid) faz
--     SET status='confirmado' e dava 500 ("invalid input value for enum");
--   - consultas com status = 'confirmado' (IA odonto, aiContext) falhavam e
--     o erro era engolido, zerando os contadores do dia.
--
-- A tabela de transições vive em src/services/dentalSchedule.js.
--
-- ALTER TYPE ... ADD VALUE roda dentro de transação no PG >= 12 (o runner
-- abre BEGIN por migration); a única restrição é não USAR o valor novo na
-- mesma transação — esta migration não usa. IF NOT EXISTS deixa idempotente.
-- ============================================================

ALTER TYPE dental_appointment_status ADD VALUE IF NOT EXISTS 'confirmado'           AFTER 'agendado';
ALTER TYPE dental_appointment_status ADD VALUE IF NOT EXISTS 'paciente_consultorio' AFTER 'confirmado';
ALTER TYPE dental_appointment_status ADD VALUE IF NOT EXISTS 'falta_justificada'    AFTER 'faltou';
