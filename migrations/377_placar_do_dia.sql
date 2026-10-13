-- ============================================================
-- 377_placar_do_dia.sql — Placar do dia no WhatsApp do dono (13/10/2026)
--
-- Preferencia por loja do "placar do dia": resumo de fim de dia (vendas,
-- ticket medio, item mais vendido, comparacao com o mes anterior e crediario
-- recebido) enviado ao dono pelo WhatsApp da propria loja.
--
--   placar_do_dia_enabled  liga/desliga (PUT /companies/:id/placar-do-dia).
--                          DEFAULT false: nada sai sem o dono pedir.
--   placar_do_dia_sempre   segundo campo: por padrao o placar roda so dentro
--                          da temporada (services/temporada.TEMPORADA,
--                          01/11/2026 a 31/01/2027); com `sempre` ligado a
--                          loja recebe o ano todo.
--
-- Idempotente. O backend sobe antes desta migration: o codigo trata 42703
-- como "placar desligado".
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS placar_do_dia_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS placar_do_dia_sempre  BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.placar_do_dia_enabled IS
  'Placar do dia no WhatsApp do dono. Default desligado (services/placarDoDia).';
COMMENT ON COLUMN companies.placar_do_dia_sempre IS
  'true = placar o ano todo; false = so dentro da TEMPORADA (services/temporada).';
