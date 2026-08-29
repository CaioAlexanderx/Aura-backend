-- ============================================================
-- 309 — desconto no Pix, mostrado no cartão do produto
--
-- Comparação com a Oscar (29/08): cada cartão deles traz duas linhas —
-- "R$ 219,99" e "ou R$ 208,99 no Pix". A segunda faz a conta que a
-- cliente faria, e faz ANTES de ela decidir. A loja da Aura mostrava
-- parcelamento, que responde outra pergunta: a de quem não tem o valor à
-- vista.
--
-- É PERCENTUAL e não valor fixo porque o desconto acompanha o preço da
-- peça — um real de desconto num vestido de 300 não convence ninguém, e
-- num chinelo de 20 quebra a margem.
--
-- DEFAULT 0 = desligado. Nenhuma loja existente passa a anunciar desconto
-- que a lojista não decidiu dar.
--
-- O teto de 30 é guarda-corpo contra dedo errado: quem digita 50 achando
-- que são "50 reais" anunciaria metade do preço para o cliente e a Aura
-- não teria como desfazer depois da venda.
-- ============================================================

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS pix_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  ALTER TABLE digital_channel_config
    ADD CONSTRAINT digital_channel_config_pix_discount_pct_check
    CHECK (pix_discount_pct >= 0 AND pix_discount_pct <= 30);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN digital_channel_config.pix_discount_pct IS
  'Percentual de desconto no Pix mostrado no cartao do produto. 0 = nao mostra nada.';
