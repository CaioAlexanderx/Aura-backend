-- ============================================================
-- 401 — digital_channel_config: titulo e texto do bloco do WhatsApp
--
-- Pedido do Caio em 21/10/2026 (loja Felic, adega): o bloco da home
-- "Duvida sobre tamanho ou modelo? / Fale direto com a gente no WhatsApp."
-- foi escrito para loja de roupa e nao faz sentido para uma adega.
--
-- O que esta migration faz:
--   - duas colunas novas, TEXT, nulaveis: whats_bloco_titulo e
--     whats_bloco_texto. NULL = o texto de hoje (a loja nao muda nada).
--     O PUT /digital-channel grava ja limpo: sem HTML, espacos colapsados,
--     ate 80 (titulo) e 200 (texto) caracteres.
-- Nao toca em linha nenhuma: todas nascem NULL.
--
-- Idempotente: IF NOT EXISTS nas duas colunas.
-- Caminho de volta:
--   ALTER TABLE digital_channel_config DROP COLUMN IF EXISTS whats_bloco_titulo;
--   ALTER TABLE digital_channel_config DROP COLUMN IF EXISTS whats_bloco_texto;
-- ============================================================

ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS whats_bloco_titulo TEXT;
ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS whats_bloco_texto TEXT;

COMMENT ON COLUMN digital_channel_config.whats_bloco_titulo IS
  'Titulo do bloco do WhatsApp na home da loja (migration 401, 21/10/2026). NULL = "Dúvida sobre tamanho ou modelo?".';
COMMENT ON COLUMN digital_channel_config.whats_bloco_texto IS
  'Texto do bloco do WhatsApp na home da loja (migration 401, 21/10/2026). NULL = "Fale direto com a gente no WhatsApp.".';
