-- ============================================================
-- AURA. — Migration 066: View appointments_unified (cross-vertical)
--
-- CONTEXTO: o app tem hoje DOIS endpoints de agenda separados,
-- cada um lendo da sua tabela:
--   GET /companies/:cid/appointments         -> barbershop_appointments
--   GET /companies/:cid/dental/appointments  -> dental_appointments
--
-- Cada vertical tem necessidades clinicas/comerciais distintas
-- (chief_complaint vs deposit, practitioner com CRO vs comissao
-- de barbeiro, etc), entao manter as tabelas separadas faz sentido.
--
-- O QUE FALTA: nao existe vista CONSOLIDADA pra:
--   - Dashboard executivo Aura (gestor com mais de uma vertical)
--   - Relatorios cross-vertical do tipo "atendimentos hoje"
--   - Auditoria/exportacao consolidada
--
-- ESTA MIGRATION:
--   Cria VIEW READ-ONLY appointments_unified com UNION ALL das
--   duas tabelas + discriminator `vertical` ('barber' | 'dental').
--   Campos divergentes resolvidos:
--     - customer_name/phone: barber tem denormalizado, dental joina
--       customers (D-UNIFY 050) ou dental_patients (legado).
--     - practitioner_id: barber.professional_id, dental.practitioner_id.
--     - status::text: enums diferentes (barber_appointment_status vs
--       dental_appointment_status), cast pra TEXT.
--     - chief_complaint: nullable (barber nao tem).
--
-- IMPORTANTE: NAO altera os endpoints existentes. GET /appointments
-- continua lendo de barbershop_appointments. GET /dental/appointments
-- continua lendo de dental_appointments. A view e infraestrutura pra
-- consumir DEPOIS sem precisar duplicar query.
--
-- IDEMPOTENTE: CREATE OR REPLACE VIEW.
-- ============================================================

CREATE OR REPLACE VIEW appointments_unified AS
SELECT
  'barber'::text                          AS vertical,
  a.id                                    AS id,
  a.company_id                            AS company_id,
  a.customer_id                           AS customer_id,
  COALESCE(c.name, a.customer_name)       AS customer_name,
  COALESCE(c.phone, a.customer_phone)     AS customer_phone,
  a.professional_id                       AS practitioner_id,
  bp.name                                 AS practitioner_name,
  a.scheduled_at                          AS scheduled_at,
  a.duration_min                          AS duration_min,
  a.status::text                          AS status,
  NULL::text                              AS chief_complaint,
  a.total_amount                          AS total,
  a.notes                                 AS notes,
  a.started_at                            AS started_at,
  a.concluded_at                          AS concluded_at,
  a.cancelled_at                          AS cancelled_at,
  a.cancel_reason                         AS cancel_reason,
  a.created_at                            AS created_at,
  a.updated_at                            AS updated_at
FROM barbershop_appointments a
LEFT JOIN barbershop_professionals bp ON bp.id = a.professional_id
LEFT JOIN customers                c  ON c.id  = a.customer_id

UNION ALL

SELECT
  'dental'::text                          AS vertical,
  d.id                                    AS id,
  d.company_id                            AS company_id,
  d.customer_id                           AS customer_id,
  COALESCE(c.name, dp.full_name)          AS customer_name,
  COALESCE(c.phone, dp.phone)             AS customer_phone,
  d.practitioner_id                       AS practitioner_id,
  pr.name                                 AS practitioner_name,
  d.scheduled_at                          AS scheduled_at,
  d.duration_min                          AS duration_min,
  d.status::text                          AS status,
  d.chief_complaint                       AS chief_complaint,
  d.total                                 AS total,
  d.clinical_notes                        AS notes,
  d.started_at                            AS started_at,
  d.concluded_at                          AS concluded_at,
  d.cancelled_at                          AS cancelled_at,
  d.cancel_reason                         AS cancel_reason,
  d.created_at                            AS created_at,
  d.updated_at                            AS updated_at
FROM dental_appointments d
LEFT JOIN customers            c  ON c.id  = d.customer_id
LEFT JOIN dental_patients      dp ON dp.id = d.patient_id
LEFT JOIN dental_practitioners pr ON pr.id = d.practitioner_id;

COMMENT ON VIEW appointments_unified IS
  'View read-only que une barbershop_appointments e dental_appointments com discriminator vertical TEXT (barber|dental). Use para dashboards cross-vertical, relatorios consolidados e auditoria. NAO substitui os endpoints especificos por vertical — apenas oferece a vista unificada quando necessario.';
