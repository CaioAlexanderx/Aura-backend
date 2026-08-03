-- ============================================================
-- AURA DOJÔ — Migration 268: check-in por QR único do dojô (F9)
-- ------------------------------------------------------------
-- NUMERAÇÃO: 267 (credit_leads) já tomada — esta é a 268.
--
-- F9: além do QR PESSOAL do aluno (payload { s: student_id, d: dojo_id },
-- migration 246), o dojô agora também pode gerar um QR ÚNICO por dojô
-- (payload { d: dojo_id }, SEM aluno embutido — MESMA assinatura HMAC,
-- token STATELESS, nada persistido para o token em si — não há tabela
-- nova aqui, só o ajuste abaixo).
--
-- Esta migration distingue, na PRESENÇA já existente
-- (karate_dojo_attendance.method), o check-in feito pelo QR único do
-- feito pelo QR pessoal — útil pro dojô auditar qual cartaz está sendo
-- usado (ex.: decidir se ainda vale a pena manter cartões individuais).
-- Método novo: 'qr_dojo' (mantém 'manual' e 'qr' como estavam).
--
-- Idempotente/defensiva (DROP CONSTRAINT IF EXISTS + DO $$ na ADD, mesmo
-- padrão das migrations 243-267). NÃO aplicada neste PR (aplicar via MCP
-- antes do deploy — enquanto isso, o check-in pelo QR único devolve 503
-- SCHEMA_PENDING, ver handleWriteError em karateDojoClasses.js).
-- ============================================================

ALTER TABLE karate_dojo_attendance
  DROP CONSTRAINT IF EXISTS karate_dojo_attendance_method_check;

DO $$ BEGIN
  ALTER TABLE karate_dojo_attendance
    ADD CONSTRAINT karate_dojo_attendance_method_check
    CHECK (method IN ('manual', 'qr', 'qr_dojo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN karate_dojo_attendance.method IS
  'manual (chamada) · qr (QR pessoal do aluno, F4) · qr_dojo (QR único do dojô — F9, cartaz único que resolve a turma pela janela de tolerância em torno do horário).';
