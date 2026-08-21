-- ============================================================
-- AURA KARATÊ — Migration 298: P1 do Hub — TERMO DE RESPONSABILIDADE
-- digital e MÓDULO DE ARBITRAGEM (Dossiê Shiai §2 e §7)
--
-- 1) TERMO (karate_competition_waivers)
--    "Sem o termo de responsabilidade entregue, o atleta NÃO participa"
--    (regulamentos JKA e FPKT). O documento real reúne consentimento +
--    isenção de responsabilidade + uso de imagem, assinado pelo atleta
--    ou pelo responsável (se menor), com RG e as MODALIDADES autorizadas.
--    Aqui ele vira aceite digital por (competição, praticante), com
--    snapshot do texto aceito — o termo pode mudar entre eventos, e o
--    que vale é o que a pessoa leu. accepted_by_role diz quem assinou.
--    Sem FK em practitioner_id de propósito? NÃO: aqui HÁ FK (o atleta é
--    da federação); o que fica sem FK é o snapshot (jsonb puro).
--
-- 2) ARBITRAGEM (karate_officials + karate_competition_officials)
--    O árbitro tem CADASTRO na federação com credencial (A/B/C/D), e a
--    cada evento é CONVOCADO → confirma → é ESCALADO num koto → tem
--    presença registrada (a ausência não justificada gera multa ao
--    clube, R$100 no regulamento JKA). Mesários seguem o mesmo trilho
--    com role='mesario'. É o que a "DISTRIBUIÇÃO DE ÁRBITROS & MESÁRIOS"
--    (e sua retificação) faz em papel.
--
--    O oficial é ancorado em customers (praticante da federação) quando
--    existe cadastro, mas name é obrigatório e independente: a lista real
--    inclui gente de outras federações (ex.: "André Reis - JKA-RJ").
--
-- Tudo aditivo e idempotente. Aplicar via Supabase MCP antes do merge.
-- ============================================================

-- ── 1) Termo de responsabilidade ────────────────────────────
CREATE TABLE IF NOT EXISTS karate_competition_waivers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  competition_id  UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  practitioner_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dojo_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  -- Quem assinou: o próprio atleta ou o responsável (menor de idade).
  accepted_by_role TEXT NOT NULL DEFAULT 'athlete'
                     CHECK (accepted_by_role IN ('athlete','guardian')),
  accepted_by_name TEXT NOT NULL,
  accepted_by_doc  TEXT,                      -- RG/CPF de quem assinou
  -- Modalidades que o responsável autorizou (kata, kumite, en-bu...).
  modalities       TEXT[],
  -- O texto/versão do termo aceito (imutável): { version, title, body }.
  terms_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_consent    BOOLEAN NOT NULL DEFAULT true,
  accepted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_ip      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, practitioner_id)
);
CREATE INDEX IF NOT EXISTS idx_kcw_competition
  ON karate_competition_waivers(competition_id, dojo_id);

ALTER TABLE karate_competition_waivers ENABLE ROW LEVEL SECURITY;

-- Texto padrão do termo por competição (a federação edita antes de abrir
-- as inscrições; o aceite guarda o snapshot).
ALTER TABLE karate_competitions
  ADD COLUMN IF NOT EXISTS waiver_terms JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE karate_competitions
  ADD COLUMN IF NOT EXISTS waiver_required BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN karate_competitions.waiver_terms IS
  'Termo de responsabilidade do evento: { version, title, body }. O aceite copia isto para karate_competition_waivers.terms_snapshot.';
COMMENT ON COLUMN karate_competitions.waiver_required IS
  'true = a federação exige termo aceito por atleta (bloqueio é decisão de UI/relatório; o backend expõe o status).';

-- ── 2) Oficiais (árbitros / mesários / staff) ───────────────
CREATE TABLE IF NOT EXISTS karate_officials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  practitioner_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  dojo_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  dojo_name       TEXT,                        -- texto livre (ex.: "JKA-RJ")
  role            TEXT NOT NULL DEFAULT 'arbitro'
                    CHECK (role IN ('arbitro','mesario','staff')),
  -- Credencial de arbitragem (A > B > C > D). NULL para mesário/staff.
  credential      TEXT CHECK (credential IS NULL OR credential IN ('A','B','C','D')),
  credential_note TEXT,
  email           TEXT,
  phone           TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ko_federation
  ON karate_officials(federation_id, role, active);
CREATE INDEX IF NOT EXISTS idx_ko_dojo
  ON karate_officials(dojo_id);

DROP TRIGGER IF EXISTS trg_ko_updated_at ON karate_officials;
CREATE TRIGGER trg_ko_updated_at BEFORE UPDATE ON karate_officials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_officials ENABLE ROW LEVEL SECURITY;

-- Convocação/escala por evento.
CREATE TABLE IF NOT EXISTS karate_competition_officials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  official_id    UUID NOT NULL REFERENCES karate_officials(id) ON DELETE CASCADE,
  area_id        UUID REFERENCES karate_competition_areas(id) ON DELETE SET NULL,
  -- Ciclo do regulamento: convocado → confirma → presente/ausente.
  status         TEXT NOT NULL DEFAULT 'summoned'
                   CHECK (status IN ('summoned','confirmed','declined','present','absent')),
  is_chief       BOOLEAN NOT NULL DEFAULT false,   -- chefe de arbitragem / shuchin do koto
  sort_order     INT NOT NULL DEFAULT 0,
  -- Ausência não justificada gera multa ao clube (R$100 árbitro / R$50
  -- colaborador no regulamento JKA). Valor fica aberto por federação.
  penalty_amount NUMERIC(12,2),
  penalty_note   TEXT,
  notes          TEXT,
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, official_id)
);
CREATE INDEX IF NOT EXISTS idx_kco_competition
  ON karate_competition_officials(competition_id, status);
CREATE INDEX IF NOT EXISTS idx_kco_area
  ON karate_competition_officials(area_id, sort_order);

DROP TRIGGER IF EXISTS trg_kco_updated_at ON karate_competition_officials;
CREATE TRIGGER trg_kco_updated_at BEFORE UPDATE ON karate_competition_officials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_competition_officials ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- FIM DA MIGRATION 298
-- ============================================================
