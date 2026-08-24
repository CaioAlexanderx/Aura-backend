-- ============================================================
-- 305 — CHECK-IN LEVE (credenciamento do dia, Onda B)
--
-- O credenciamento real é simples: o dojô responde pela presença dos
-- seus atletas; a mesa central precisa saber quem está no ginásio; a
-- chamada do koto precisa saber quem não veio. Flags na INSCRIÇÃO
-- (marcar o atleta propaga a todas as inscrições dele na competição):
--   checked_in_at  → presente (credenciado)
--   no_show_at     → ausência confirmada
--   (ambos NULL    → sem informação; nunca são preenchidos juntos)
--   check_in_source→ quem marcou ('dojo' | 'federacao')
--
-- karate_competition_entries nasce na 169 (mesmo diretório) — sem guard.
-- ============================================================

ALTER TABLE karate_competition_entries
  ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS no_show_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS check_in_source TEXT
    CHECK (check_in_source IS NULL OR check_in_source IN ('dojo', 'federacao'));

-- ============================================================
-- FIM DA MIGRATION 305
-- ============================================================
