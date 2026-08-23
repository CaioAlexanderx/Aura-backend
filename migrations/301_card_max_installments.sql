-- 301 — parcelamento visivel na pagina de produto.
--
-- A loja mostrava so o preco a vista. Quem vende peca de R$ 159 perde
-- venda por isso: "3x de R$ 53" e uma frase diferente de "R$ 159,90", e e
-- a frase que todo e-commerce grande mostra.
--
-- O numero e DECLARADO pela lojista, nao lido do gateway: a tabela
-- companies_payment_gateways guarda credencial e nada mais, e o Mercado
-- Pago so decide parcelas na hora do checkout. Melhor a lojista dizer a
-- politica dela do que a loja inventar um numero.
--
-- NULL = nao mostrar parcelamento (padrao, comportamento de hoje).

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS card_max_installments INTEGER;

DO $$
BEGIN
  ALTER TABLE digital_channel_config
    ADD CONSTRAINT digital_channel_config_card_max_inst_chk
    CHECK (card_max_installments IS NULL OR (card_max_installments BETWEEN 2 AND 12));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN digital_channel_config.card_max_installments IS
  'Ate quantas vezes a lojista parcela no cartao. NULL esconde o parcelamento.';
