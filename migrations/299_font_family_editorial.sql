-- 299 — o painel oferece quatro tipografias; o banco aceitava tres.
--
-- `editorial` (Playfair Display + Manrope) entrou no seletor da lojista,
-- mas o CHECK de digital_channel_config.font_family so conhecia
-- classic/modern/humanist. Quem escolhesse Editorial levava erro no
-- salvar — a opcao aparecia na tela e era impossivel de aplicar.
--
-- Idempotente: derruba e recria o CHECK com a lista completa.

ALTER TABLE digital_channel_config
  DROP CONSTRAINT IF EXISTS digital_channel_config_font_family_chk;

ALTER TABLE digital_channel_config
  ADD CONSTRAINT digital_channel_config_font_family_chk
  CHECK (font_family = ANY (ARRAY['classic','modern','humanist','editorial']));
