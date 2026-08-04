-- ============================================================
-- AURA DOJÔ — Migration 271: F9.1, o CERTIFICADO PRÓPRIO DO DOJÔ
--
-- Pedido do dono do produto (04/08/2026):
--   "Vamos deixar o certificado dentro de eventos, idêntico ao que temos
--    na federação. Dentro de eventos vamos fazer a emissão e impressão em
--    massa e também criar o design. Essa página então será apenas para
--    visualizar o status dos certificados que foram pedidos para a
--    federação. Processo: Dojô faz exame de kyu, emite certificado do
--    Dojô para os aprovados e solicita para a federação o certificado de
--    Kyu da federação, que é o oficial."
--
-- NÃO aplicada por este PR. Aplicar via Supabase MCP (apply_migration).
-- 100% idempotente e ADITIVA: só CREATE TABLE IF NOT EXISTS + índices +
-- comentários. Nenhuma tabela existente é alterada.
--
-- ============================================================
-- DOIS CERTIFICADOS DISTINTOS PARA A MESMA GRADUAÇÃO
-- ============================================================
-- O DA FEDERAÇÃO (OFICIAL) já existe — karate_certificate_templates +
-- karate_issued_certificates (Fase 3), karateEventCertificates.js,
-- karateCertificateService.createOrder (Track J). NENHUMA dessas tabelas
-- é tocada aqui.
--
-- O DO DOJÔ (NÃO OFICIAL) é este PR. Tabelas PRÓPRIAS, escopadas por
-- dojo_id — NUNCA federation_id. A decisão de NÃO reusar as tabelas da
-- federação com um dojo_id opcional é deliberada: misturar emissão
-- oficial e não oficial levaria a um WHERE federation_id IS NULL frágil
-- como escopo, e os dois documentos têm peso jurídico diferente (um é
-- homologado pela FPKT; o outro é assinado só pelo próprio dojô). O
-- modelo abaixo ESPELHA os mesmos conceitos da federação (template +
-- emitido, verify_token, snapshots) — não inventa um formato novo.
--
-- ============================================================
-- ELEGÍVEL = APROVADO NO EXAME DE KYU DO DOJÔ
-- ============================================================
-- karate_dojo_belt_exams + karate_dojo_belt_exam_results (migrations
-- 264/265, karateDojoBeltExamService.js — INTOCADOS por este PR). A
-- emissão em massa lê os resultados com result='approved' de um exame
-- concluído; antiduplicação por (exam_id, student_id) com revoked=false,
-- mesmo padrão do karate_issued_certificates da federação.
--
-- ⚠️ ALUNO NÃO FEDERADO TAMBÉM RECEBE O CERTIFICADO DO DOJÔ — por isso
-- student_id referencia karate_dojo_students, NUNCA customers. Mesmo
-- motivo pelo qual o resultado do exame (264) foi ancorado no aluno do
-- dojô: o dojô gradua e certifica o PRÓPRIO aluno, federado ou não. O
-- certificado oficial da federação continua exigindo practitioner_id —
-- essa regra não muda e não é deste arquivo.
--
-- ============================================================
-- COMPATIBILIDADE COM buildCertificateHtml (aura-app)
-- ============================================================
-- components/karate/certificado/buildCertificateHtml.ts é AGNÓSTICO:
-- recebe só {data: CertData, template: CertTemplate} e não sabe (nem
-- precisa saber) se quem emitiu foi a federação ou o dojô. template
-- (karate_dojo_certificate_templates) e template_snapshot/data_snapshot
-- (karate_dojo_issued_certificates) usam EXATAMENTE o mesmo shape dos
-- da federação — layout/title/body_mode/body_text/seals/font/text_scale/
-- auto_fit no template; participant_name/course_name/hours/
-- instructors_text/dates_text/location/issued_date_text/
-- federation_name/signatories no snapshot de dados. O campo
-- `federation_name` do CertData é só o texto pequeno acima do título —
-- aqui carrega o nome do DOJÔ (o engine não interpreta o valor, só
-- renderiza). A ÚNICA divergência de origem: `signatories` vem do
-- TEMPLATE do dojô (coluna nova `signatories`, abaixo), não de uma
-- tabela de "instrutores do evento" — o exame do dojô não tem esse
-- conceito, e o produto pediu "o mesmo editor... incluindo assinatura",
-- então a assinatura passa a fazer parte do MODELO, configurada uma vez
-- pelo sensei e reaplicada a toda emissão feita com aquele template.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_certificate_templates (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- O dojô dono do modelo (companies.id, vertical karate_dojo).
  dojo_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  name           TEXT NOT NULL DEFAULT 'Modelo',
  layout         TEXT NOT NULL DEFAULT 'A',
  title          TEXT NOT NULL DEFAULT 'CERTIFICADO',
  body_mode      TEXT NOT NULL DEFAULT 'default',
  body_text      TEXT,

  -- Mesmo shape de karate_certificate_templates.seals (federação):
  -- [{label, image_url}].
  seals          JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- NOVO em relação ao template da federação (ver nota acima): assinatura
  -- faz parte do MODELO do dojô, não do evento. Shape [{name, role,
  -- signature_url}] — o mesmo de CertSignatory em buildCertificateHtml.ts.
  signatories    JSONB NOT NULL DEFAULT '[]'::jsonb,

  font           TEXT NOT NULL DEFAULT 'classica',
  text_scale     NUMERIC(3,2),
  auto_fit       BOOLEAN NOT NULL DEFAULT false,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  active         BOOLEAN NOT NULL DEFAULT true,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_certificate_templates
    ADD CONSTRAINT karate_dojo_cert_templates_layout_check
    CHECK (layout IN ('A','B','C','D','E'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_cert_templates_layout_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_certificate_templates
    ADD CONSTRAINT karate_dojo_cert_templates_body_mode_check
    CHECK (body_mode IN ('default','custom'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_cert_templates_body_mode_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_certificate_templates
    ADD CONSTRAINT karate_dojo_cert_templates_font_check
    CHECK (font IN ('classica','imponente','elegante','sofisticada','tradicional'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_cert_templates_font_check já existe';
END $$;

CREATE INDEX IF NOT EXISTS idx_dojo_cert_templates_dojo
  ON karate_dojo_certificate_templates (dojo_id, is_default DESC, created_at DESC);

DO $$ BEGIN
  CREATE TRIGGER trg_dojo_cert_templates_updated_at
    BEFORE UPDATE ON karate_dojo_certificate_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'trg_dojo_cert_templates_updated_at já existe';
END $$;

COMMENT ON TABLE karate_dojo_certificate_templates IS
  'F9.1: modelo do certificado NÃO OFICIAL emitido pelo PRÓPRIO DOJÔ (não confundir com karate_certificate_templates, da federação). Mesmo shape consumido por buildCertificateHtml.ts (aura-app), agnóstico ao emissor.';

COMMENT ON COLUMN karate_dojo_certificate_templates.signatories IS
  'F9.1: [{name, role, signature_url}] — assinatura(s) do modelo. Diferente da federação (onde a assinatura vem dos instrutores DO EVENTO): o exame do dojô não tem essa tabela, e o produto pediu que a assinatura fizesse parte do MESMO editor do modelo. Reaplicada a toda emissão feita com este template; fallback no código é o examiner_name do exame quando o template não tem nenhuma.';

-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS karate_dojo_issued_certificates (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  dojo_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- O exame de kyu do DOJÔ (não karate_belt_exams, que é a banca da
  -- federação). Elegibilidade = resultado 'approved' deste exame.
  exam_id           UUID NOT NULL REFERENCES karate_dojo_belt_exams(id) ON DELETE CASCADE,

  -- O ALUNO DO DOJÔ é a âncora — não o praticante da federação. Aluno
  -- NÃO FEDERADO também recebe o certificado do dojô (mesma decisão da
  -- 264 para karate_dojo_belt_exam_results.student_id).
  student_id        UUID NOT NULL REFERENCES karate_dojo_students(id) ON DELETE CASCADE,

  -- Rastreio até o resultado que tornou o aluno elegível. SET NULL (não
  -- CASCADE): o certificado já emitido não deve desaparecer se por algum
  -- motivo a linha de resultado for removida.
  result_id         UUID REFERENCES karate_dojo_belt_exam_results(id) ON DELETE SET NULL,

  verify_token      TEXT NOT NULL,

  -- Snapshot do MODELO no momento da emissão (mesmo shape de
  -- karate_certificate_templates via tplBody). Reemitir depois de o
  -- sensei editar o modelo não altera certificados já emitidos.
  template_snapshot JSONB NOT NULL,

  -- Snapshot dos DADOS no momento da emissão — o que buildCertificateHtml
  -- consome como CertData. Mesmo motivo do snapshot de template: o
  -- certificado emitido é imutável mesmo que o aluno mude de nome depois.
  data_snapshot     JSONB NOT NULL,

  revoked           BOOLEAN NOT NULL DEFAULT false,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  issued_by_name    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_dojo_issued_certs_verify_token
  ON karate_dojo_issued_certificates (verify_token);

-- Antiduplicação por (exame, aluno): a rota confere isto antes de
-- inserir (SELECT ... WHERE exam_id=$1 AND student_id=$2 AND revoked=
-- false), mesmo padrão do karate_issued_certificates da federação (que
-- também não tem UNIQUE de banco — permite reemitir depois de revogar).
-- Este índice parcial só acelera essa checagem.
CREATE INDEX IF NOT EXISTS idx_dojo_issued_certs_exam_student_active
  ON karate_dojo_issued_certificates (exam_id, student_id)
  WHERE revoked = false;

CREATE INDEX IF NOT EXISTS idx_dojo_issued_certs_dojo
  ON karate_dojo_issued_certificates (dojo_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_dojo_issued_certs_student
  ON karate_dojo_issued_certificates (student_id, issued_at DESC);

COMMENT ON TABLE karate_dojo_issued_certificates IS
  'F9.1: certificado NÃO OFICIAL emitido pelo PRÓPRIO DOJÔ para aprovados em karate_dojo_belt_exams (não confundir com karate_issued_certificates, da federação — documento oficial, tabela intocada). Verificação pública em GET /public/karate/verify/dojo-cert/:token (karateDojoCertPublic.js), que marca certificate_type=''dojo'' e official=false para nunca ser confundido com o certificado oficial.';

COMMENT ON COLUMN karate_dojo_issued_certificates.student_id IS
  'F9.1: aponta para karate_dojo_students (o ALUNO DO DOJÔ), não para customers/practitioner. Aluno não federado também é certificado pelo dojô — o mesmo motivo de karate_dojo_belt_exam_results.student_id (migration 264).';

-- ============================================================
-- FIM DA MIGRATION 271
-- ============================================================
