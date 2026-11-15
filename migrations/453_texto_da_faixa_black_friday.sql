-- ============================================================
-- 453 — O lojista escreve o texto da faixa de Black Friday (p-122, 14/11/2026)
--
-- Pedido do Caio: além das três opções prontas (bf_titulo, migration 451),
-- a loja pode escrever o próprio título da faixa e a frase da faixa grande.
--
--   bf_titulo_texto  até 28 caracteres; vale na faixa fina e no título da
--                    faixa grande. Guardado como digitado (a vitrine põe em
--                    caixa alta pelo CSS). NULL = a opção pronta (bf_titulo).
--   bf_frase_texto   até 90 caracteres; a frase da faixa grande. NULL = o
--                    texto padrão.
--
-- Por que 28: a faixa fina leva ainda " · ATÉ 99% OFF · ATÉ 30/11" (26) e
-- a 390 px cabem cerca de 47 por linha; até 28 quebra em duas linhas no
-- celular e fica numa linha acima de 1100 px. O "até N% OFF" e a data
-- continuam calculados pelo servidor: o texto não aceita "%" nem "R$" (o
-- PUT valida; o CHECK aqui garante só o tamanho).
--
-- Por empresa, como a campanha. O backend tolera a migration ausente
-- (42703: a campanha segue com as opções prontas). Idempotente.
-- ============================================================

ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS bf_titulo_texto varchar(28);
ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS bf_frase_texto varchar(90);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'digital_channel_config_bf_textos_check'
  ) THEN
    ALTER TABLE digital_channel_config
      ADD CONSTRAINT digital_channel_config_bf_textos_check
      CHECK (
        (bf_titulo_texto IS NULL OR char_length(btrim(bf_titulo_texto)) BETWEEN 1 AND 28)
        AND (bf_frase_texto IS NULL OR char_length(btrim(bf_frase_texto)) BETWEEN 1 AND 90)
      );
  END IF;
END $$;
