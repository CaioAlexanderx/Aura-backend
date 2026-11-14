-- ============================================================
-- 451 — Campanha de Black Friday da loja online (p-118, 14/11/2026)
--
-- A lojista liga a campanha na página Black Friday do painel; com ela
-- ligada e uma promoção no ar (o De/Por do Estoque, migration 427), a loja
-- online mostra a faixa preta, a faixa grande na home e "Ofertas" no menu
-- (p-119b). Uma campanha por empresa: cada CNPJ do grupo liga a sua.
--
--   bf_ativa   a lojista ligou a campanha (padrão: desligada)
--   bf_titulo  o título da faixa, uma de três opções fixas:
--                black_friday          "Black Friday"
--                black_friday_da_loja  "Black Friday da <nome da loja>"
--                ofertas_de_novembro   "Ofertas de novembro"
--
-- O "até N% OFF" não é gravado: o servidor calcula a cada página pelo
-- maior desconto real entre as promoções no ar (services/campanhaDaLoja.js).
--
-- O backend tolera a migration ausente (42703 → sem campanha, a loja sai
-- como hoje; as rotas devolvem 503 MIGRATION_PENDING). Idempotente.
-- ============================================================

ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS bf_ativa boolean NOT NULL DEFAULT false;
ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS bf_titulo text NOT NULL DEFAULT 'black_friday';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'digital_channel_config_bf_titulo_check'
  ) THEN
    ALTER TABLE digital_channel_config
      ADD CONSTRAINT digital_channel_config_bf_titulo_check
      CHECK (bf_titulo IN ('black_friday', 'black_friday_da_loja', 'ofertas_de_novembro'));
  END IF;
END $$;
