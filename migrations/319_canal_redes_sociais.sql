-- ============================================================
-- 319 — TikTok e Facebook no canal digital
--
-- Criado: 02/09/2026
--
-- `instagram` ja existia desde o comeco do canal digital (e ninguem
-- desenhava). Estas duas nascem ao lado dele, no mesmo formato: o @ como
-- a lojista digita. Quem normaliza e src/services/redesSociais.js — a
-- coluna guarda o que veio do painel ja limpo pela rota.
--
-- TEXT e nao VARCHAR(n): o limite de tamanho de cada rede muda com o
-- tempo e vive no alfabeto do servico, nao no schema.
-- ============================================================

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS tiktok   TEXT,
  ADD COLUMN IF NOT EXISTS facebook TEXT;

COMMENT ON COLUMN digital_channel_config.tiktok   IS 'Perfil do TikTok, so o @ (redesSociais.js normaliza).';
COMMENT ON COLUMN digital_channel_config.facebook IS 'Perfil ou pagina do Facebook, so o @ (redesSociais.js normaliza).';
