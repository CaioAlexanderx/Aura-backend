-- ============================================================
-- 458 — Banner A da loja com produto personalizável (p-180, 17/11/2026)
--
-- Decisão do Caio (D9, mockup p-132 versão A): na home da loja comum que
-- tem peça personalizável, a lojista pode escolher o modelo pronto da Aura
-- para o banner, com a foto da peça, título, texto e botões editáveis
-- ("Personalizar agora", "Ver como fica em 3D") e a faixa de confiança.
--
-- Um objeto JSON por loja, saneado em services/bannerPersonalizados.js:
--   { ativo, produto_id, imagem_url, kicker, titulo, texto, botao,
--     botao_3d, mostrar_3d }
-- NULL (o padrão) = a lojista não escolheu o modelo: a home de hoje.
-- Loja sem peça personalizável nunca lê a coluna para desenhar a página.
--
-- Idempotente. Sem dado de cliente final.
-- ============================================================
ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS banner_personalizados JSONB;

COMMENT ON COLUMN digital_channel_config.banner_personalizados IS
  'p-180: banner A da loja com personalizavel (services/bannerPersonalizados.js). NULL = home de hoje.';
