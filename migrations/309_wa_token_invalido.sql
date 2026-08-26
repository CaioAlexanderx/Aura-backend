-- ============================================================
-- AURA — WhatsApp: marcar quando a Meta RECUSA o token
--
-- Achado no QA de 26/08: o card do dojô mostrava "Conectado" (selo
-- verde) com o token já expirado havia dois dias. O dono do dojô só
-- descobria ao tentar usar — e recebia o erro cru da Meta em inglês.
--
-- Não dá para checar o token a cada carregamento de tela (uma chamada
-- à Graph API por request). Em vez disso, toda chamada que a Meta
-- recusa por credencial carimba aqui, e o status passa a dizer a
-- verdade até alguém reconectar (o connect limpa a marca).
--
--   wa_token_invalid_at  → quando a Meta recusou pela última vez
--   wa_token_invalid_reason → o que ela respondeu (para o suporte)
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS wa_token_invalid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wa_token_invalid_reason TEXT;

COMMENT ON COLUMN companies.wa_token_invalid_at IS
  'Ultima vez que a Meta recusou o token do WhatsApp (expirado/revogado). NULL = sem recusa conhecida.';
