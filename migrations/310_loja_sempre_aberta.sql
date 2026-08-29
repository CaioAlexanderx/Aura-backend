-- 310_loja_sempre_aberta.sql
--
-- "Aberta 24 horas" e um ESTADO da loja, nao um intervalo de horario.
--
-- Sem esta coluna, a unica forma de dizer 24h era preencher os sete dias
-- com 00:00 as 23:59 — sete linhas no painel pra dizer uma coisa so, e
-- ainda com um buraco: a comparacao de aberto e `agora < fechamento`,
-- entao das 23:59:00 as 23:59:59 a loja aparecia Fechada. Todo dia.
--
-- Tentar fechar as 24:00 pra tapar o buraco e pior: e um horario que nao
-- existe, o parse rejeita, e a loja cai no ramo do "proximo dia aberto" —
-- Fechada o dia inteiro. Aconteceu em producao em 29/08/2026.
--
-- Com always_open o estado e declarado, nao deduzido de um intervalo.

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS always_open BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN digital_channel_config.always_open IS
  'Loja atende 24h. Quando true, business_hours e ignorado no calculo de aberto/fechado.';
