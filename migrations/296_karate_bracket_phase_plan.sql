-- ============================================================
-- AURA KARATÊ — Migration 296: P1 do Hub — FORMATOS POR FASE,
-- REGISTRO DE DECISÃO e KATA EM CHAVE (Dossiê Shiai, §4)
--
-- O QUE OS REGULAMENTOS EXIGEM (JKA + FPKT, 2026):
--   • O formato da prova MUDA conforme a chave avança: Copa JKA Mirim
--     roda eliminatórias em Sanbon-Kumite, 8 semifinalistas em
--     Kihon-Ippon e 4 finalistas em Jyu-Ippon; Infantil termina em
--     Shobu-Ippon; a final do Adulto Masc Principal é Shobu-Sanbon de
--     5 minutos — um formato exclusivo de UMA luta do evento.
--   • A decisão da luta não é só "quem venceu": Hantei (bandeiras dos 5
--     árbitros), Kettei-Sen (prorrogação de 1'), Sai-Shiai (nova luta),
--     decisão do árbitro central, W.O. — a súmula registra o COMO.
--   • Kata eliminatório é CHAVE 1×1 por bandeiras (não bateria de
--     notas) até a final/4 finalistas — com kata exigido por kyu.
--
-- O QUE ESTA MIGRATION ADICIONA (aditiva e idempotente):
--   1) karate_brackets.phase_plan (jsonb): o plano de fases da categoria.
--      Shape (validado em src/services/karatePhasePlanService.js):
--        { "phases": [
--            { "from_participants": null, "format": "sanbon_kumite", "decision": "hantei" },
--            { "from_participants": 8,    "format": "kihon_ippon",  "decision": "hantei" },
--            { "from_participants": 4,    "format": "jyu_ippon",    "decision": "hantei" },
--            { "final": true, "format": "shobu_ippon", "duration_sec": 90, "time_mode": "efetivo" }
--          ],
--          "tiebreak": ["hantei","kettei_sen","central"],
--          "required_kata": "Heians até a faixa do menos graduado",
--          "prize_places": 4, "third_place_dispute": false,
--          "notes": "..." }
--      from_participants = fase vale quando o nº de participantes da
--      rodada é <= este teto (null = pega tudo / eliminatórias).
--   2) karate_brackets.kata_mode ('score_rounds'|'hantei_tree'):
--      'hantei_tree' liga o kata em CHAVE 1×1 reusando TODO o motor de
--      matches (aka/shiro/winner) — a final por notas continua nas
--      karate_kata_scores (phase='final'), coexistindo.
--   3) karate_bracket_matches.match_format (snapshot do formato efetivo
--      no lançamento) e .decision (jsonb: { method, votes_aka,
--      votes_shiro, note }) — o "como se decidiu" da súmula.
--
-- Nada muda para chaves existentes: phase_plan '{}' = comportamento
-- atual; kata_mode NULL = bateria de notas (modo vigente).
-- Aplicar via Supabase MCP antes do merge.
-- ============================================================

ALTER TABLE karate_brackets
  ADD COLUMN IF NOT EXISTS phase_plan JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE karate_brackets
  ADD COLUMN IF NOT EXISTS kata_mode TEXT;
DO $$ BEGIN
  ALTER TABLE karate_brackets
    ADD CONSTRAINT karate_brackets_kata_mode_check
    CHECK (kata_mode IS NULL OR kata_mode IN ('score_rounds','hantei_tree'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE karate_bracket_matches
  ADD COLUMN IF NOT EXISTS match_format TEXT;
ALTER TABLE karate_bracket_matches
  ADD COLUMN IF NOT EXISTS decision JSONB;

COMMENT ON COLUMN karate_brackets.phase_plan IS
  'Plano de fases da categoria (formato/decisão por nº de participantes da rodada + regras de desempate + kata exigido). Ver karatePhasePlanService. {} = sem plano (comportamento legado).';
COMMENT ON COLUMN karate_bracket_matches.decision IS
  'Como a luta foi decidida: { method: ippon|wazari|hantei|kettei_sen|sai_shiai|central|wo|kiken, votes_aka?, votes_shiro?, note? }. NULL = não registrado.';

-- ============================================================
-- FIM DA MIGRATION 296
-- ============================================================
