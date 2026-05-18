-- ============================================================
-- Fase 4: hidden_product_ids permite ocultar produtos especificos
-- da vitrine publica sem ter que tirar do estoque.
--
-- featured_product_ids muda de semantica:
--   - ANTES (bug): se nao vazio, FILTRAVA a vitrine pra mostrar
--     so esses IDs. Marcar 5 produtos escondia o resto da loja.
--   - DEPOIS: passa a ser ORDEM DE DESTAQUE. Produtos listados
--     aparecem PRIMEIRO; o resto vem depois pela ordenacao padrao.
--
-- hidden_product_ids eh opt-in raro (produto fora de linha que
-- o lojista quer manter cadastrado mas nao mostrar pra cliente).
--
-- Sem perda de dados: lojas com featured_product_ids hoje
-- simplesmente vao ganhar mais produtos visiveis na vitrine
-- (os que estavam "ocultos" pelo bug do filtro). Comportamento
-- desejado, correcao de bug — Rec #3 do AUDIT_CANAL_DIGITAL_18MAI2026.md.
-- ============================================================

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS hidden_product_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN digital_channel_config.featured_product_ids IS
  'Fase 4 (18/05/2026): lista de produtos destacados na vitrine. Aparecem PRIMEIRO na ordenacao, mas nao filtra o resto. Antes era usado como filtro (bug).';

COMMENT ON COLUMN digital_channel_config.hidden_product_ids IS
  'Fase 4 (18/05/2026): produtos explicitamente ocultos da vitrine publica. Opt-in raro pra produtos que o lojista quer manter cadastrados mas nao exibir online.';
