-- ============================================================
-- 389 — Nome na comanda do Caixa (card tc-01)
--
-- Contexto (17/10/2026, pedido do Caio): a comanda da 368 é só o NÚMERO do
-- cartão. Na adega, o operador quer abrir "a 12 do João" ou "a 3 da mesa do
-- fundo" para achar a comanda certa sem depender só do cartão.
--
-- pdv_comandas.name: opcional, texto curto (até 40 caracteres, já aparado
-- pelo backend). Gravado na abertura (POST /comandas/:number/items com
-- `name`); lançar de novo com nome atualiza o nome; lançar sem nome mantém o
-- que já estava. NULL = comanda só com número (todas as que já existem).
--
-- Idempotente. O backend pode subir antes desta migration: as rotas sondam a
-- coluna (cache de 60 s para o "não existe") e seguem sem nome enquanto ela
-- não chega.
-- ============================================================

ALTER TABLE pdv_comandas ADD COLUMN IF NOT EXISTS name VARCHAR(40) NULL;

COMMENT ON COLUMN pdv_comandas.name IS
  'Nome opcional da comanda (389), ex.: "João", "Mesa do fundo". Até 40 caracteres. NULL = só o número.';
