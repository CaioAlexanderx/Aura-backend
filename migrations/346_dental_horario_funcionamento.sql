-- ============================================================
-- AURA. — Migration 346: horário de funcionamento do consultório odonto
--
-- Mockup aprovado pelo dono em 17/09/2026.
--
-- (1) dental_clinic_hours — 1 linha por empresa (company_id). No
--     multi-CNPJ cada unidade é uma company, então cada uma tem o seu.
--     Tabela própria (e não companies.dental_settings) porque o
--     PUT /dental/settings regrava aquele jsonb inteiro.
--       business_hours: 7 dias, seg=1 … dom=7
--         [{"weekday":1,"open":true,"shifts":[{"start":"08:00","end":"12:00"},
--                                            {"start":"14:00","end":"18:00"}]}, …]
--       default_interval_min: 15/20/30/45/60 ou NULL (nenhum)
--     Sem linha = clínica ainda não configurou (a API devolve
--     configured:false + sugestão; a agenda continua 07–19h).
--     A validação fina (HH:MM, passos de 15 min, sobreposição) fica em
--     src/services/dentalHours.js; o CHECK aqui só garante o formato.
--
-- (2) dental_booking_config (agenda online):
--       use_clinic_hours     herda o horário da clínica (padrão true)
--       online_window        {"from":"HH:MM","to":"HH:MM","days":[1..7]}
--                            — só restringe (interseção com a clínica)
--       slot_duration_custom o dentista escolheu a duração dos horários
--                            online; senão vale o intervalo padrão da clínica
--     Backfill (só quando as colunas são criadas agora):
--       - slot_duration_min diferente do default (60) → custom = true
--       - quem já tinha mexido em start_hour/end_hour/available_days fica
--         com use_clinic_hours = false e online_window = janela antiga, para
--         a agenda online não se ALARGAR quando a clínica salvar o horário.
--
-- Idempotente.
-- ============================================================

-- ── (1) Horário da clínica ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS dental_clinic_hours (
  company_id            UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  business_hours        JSONB NOT NULL,
  default_interval_min  SMALLINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dental_clinic_hours_business_hours_chk
    CHECK (jsonb_typeof(business_hours) = 'array' AND jsonb_array_length(business_hours) = 7),
  CONSTRAINT dental_clinic_hours_interval_chk
    CHECK (default_interval_min IS NULL OR default_interval_min IN (15, 20, 30, 45, 60))
);

COMMENT ON TABLE dental_clinic_hours IS
  'Horario de funcionamento do consultorio odonto por empresa (seg=1..dom=7, 1 a 3 turnos por dia) e intervalo padrao entre consultas. Regras em src/services/dentalHours.js.';

-- ── (2) Agenda online ──────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'dental_booking_config' AND column_name = 'slot_duration_custom'
  ) THEN
    ALTER TABLE dental_booking_config
      ADD COLUMN slot_duration_custom BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE dental_booking_config
       SET slot_duration_custom = TRUE
     WHERE slot_duration_min IS DISTINCT FROM 60;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'dental_booking_config' AND column_name = 'use_clinic_hours'
  ) THEN
    ALTER TABLE dental_booking_config
      ADD COLUMN use_clinic_hours BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS online_window JSONB;

    -- available_days antigo usa 0=domingo; online_window usa 1=segunda..7=domingo.
    UPDATE dental_booking_config
       SET use_clinic_hours = FALSE,
           online_window = jsonb_build_object(
             'from', lpad(LEAST(GREATEST(COALESCE(start_hour, 8), 0), 23)::text, 2, '0') || ':00',
             'to',   lpad(LEAST(GREATEST(COALESCE(end_hour, 18), 1), 24)::text, 2, '0') || ':00',
             'days', COALESCE((
               SELECT jsonb_agg(DISTINCT CASE WHEN d::int = 0 THEN 7 ELSE d::int END)
                 FROM jsonb_array_elements_text(COALESCE(available_days, '[1,2,3,4,5]'::jsonb)) AS d
                WHERE d ~ '^[0-6]$'
             ), '[1,2,3,4,5]'::jsonb)
           )
     WHERE COALESCE(start_hour, 8) <> 8
        OR COALESCE(end_hour, 18) <> 18
        OR COALESCE(available_days, '[1,2,3,4,5]'::jsonb) <> '[1,2,3,4,5]'::jsonb;
  END IF;
END $$;

ALTER TABLE dental_booking_config ADD COLUMN IF NOT EXISTS online_window JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dental_booking_config_online_window_chk'
  ) THEN
    ALTER TABLE dental_booking_config
      ADD CONSTRAINT dental_booking_config_online_window_chk
      CHECK (online_window IS NULL OR jsonb_typeof(online_window) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN dental_booking_config.use_clinic_hours IS
  'true: agenda online herda dental_clinic_hours. false: vale a intersecao com online_window.';
COMMENT ON COLUMN dental_booking_config.online_window IS
  '{"from":"HH:MM","to":"HH:MM","days":[1..7]} (1=segunda). So restringe o horario da clinica.';
COMMENT ON COLUMN dental_booking_config.slot_duration_custom IS
  'true: slot_duration_min foi escolhido pelo dentista. false: segue o intervalo padrao da clinica.';
