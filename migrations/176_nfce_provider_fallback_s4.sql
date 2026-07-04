-- ============================================================
-- AURA. — Migration 176: seletor de provider + fallback engine→gateway (S4)
-- Roadmap NFC-e própria v1, Sessão 4.
--
-- RACIONAL — SÉRIE SEPARADA por provider:
--   A emissão própria (SEFAZ-SP) usa uma SÉRIE dedicada (serie_sefaz_sp,
--   default 2) e um contador PRÓPRIO (next_number_sefaz_sp), distintos da
--   série/contador do gateway (serie_nfce / next_number).
--
--   Por quê: no fallback automático (S4.2), uma MESMA venda pode reservar
--   um número da série própria (queimado ao dar throw a engine) e, na mesma
--   request, emitir de fato pelo gateway com número da série do gateway. Se
--   os dois providers compartilhassem a mesma série/contador, teríamos:
--     • risco de duplicidade de <serie,numero> na SEFAZ (rejeição 539/204);
--     • gaps intercalados na única série, difíceis de inutilizar (S2.1).
--   Com séries separadas cada provider tem sua faixa contígua e limpa: o gap
--   da série própria é inutilizável isoladamente; o gateway nunca colide.
--
--   provider_used / fallback_reason em nfce_emissions dão rastro de por qual
--   caminho cada nota saiu (auditoria + alerta de fallback ativo em S4.3).
-- Idempotente.
-- ============================================================

-- ===== nfce_config: série + contador dedicados da emissão própria =====

ALTER TABLE nfce_config
  ADD COLUMN IF NOT EXISTS serie_sefaz_sp       INT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS next_number_sefaz_sp INT DEFAULT 1;

COMMENT ON COLUMN nfce_config.serie_sefaz_sp       IS 'Série DEDICADA da emissão própria SEFAZ-SP (default 2). Separada de serie_nfce (gateway) pra numerações nunca colidirem no fallback — S4.1';
COMMENT ON COLUMN nfce_config.next_number_sefaz_sp IS 'Contador PRÓPRIO da emissão SEFAZ-SP (reserva atômica UPDATE...RETURNING, análogo a next_number do gateway) — S4.1';

-- ===== nfce_emissions: rastro do provider efetivamente usado =====

ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS provider_used   TEXT,
  ADD COLUMN IF NOT EXISTS fallback_reason TEXT;

COMMENT ON COLUMN nfce_emissions.provider_used   IS 'Provider que efetivamente transmitiu a nota: sefaz_sp | nuvemfiscal — S4.2';
COMMENT ON COLUMN nfce_emissions.fallback_reason IS 'Motivo do fallback automático engine→gateway (engine_error: <msg> | breaker_open). NULL quando não houve fallback — S4.2/S4.3';
