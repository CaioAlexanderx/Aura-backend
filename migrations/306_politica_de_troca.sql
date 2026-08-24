-- 306 — politica de troca no rodape da loja.
--
-- O rodape tinha nome, endereco e a assinatura da Aura. Faltava o que
-- passa confianca: como pagar e o que acontece se a peca nao servir.
--
-- TEXTO PADRAO EDITAVEL, decidido em 24/08/2026. Nenhuma das 7 lojas
-- escreveria essa politica sozinha (nenhuma preencheu nem o aviso da
-- faixa superior), e um padrao protege a Aura de lojista prometendo o que
-- nao cumpre. NULL = usa o padrao do template.
--
-- O padrao espelha o prazo de 7 dias do Codigo de Defesa do Consumidor
-- para compra fora do estabelecimento (art. 49). Nao promete mais que a
-- lei; lojista que quiser ser mais generosa reescreve.

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS politica_troca TEXT;

COMMENT ON COLUMN digital_channel_config.politica_troca IS
  'Politica de troca no rodape. NULL usa o texto padrao do template.';
