-- ============================================================
-- AURA — K1 (Quadro Vivo): prazo prometido da encomenda
-- 18/08/2026
--
-- O card do Kanban mostrava a IDADE do pedido ("3d atras"), que nao e a
-- mesma coisa que o prazo combinado com o cliente. Um pedido de 3 dias
-- pode estar tranquilo (entrega semana que vem) ou estourando (era pra
-- ontem) -- a idade nao distingue os dois, entao o vermelho do card
-- estava medindo a coisa errada.
--
-- promised_date e a data que a lojista PROMETEU a entrega. Opcional de
-- proposito: venda sem prazo combinado continua valendo, e o card cai no
-- comportamento antigo (idade). Nada trava por falta desse campo.
--
-- DATE puro, sem hora: "sabado dia 22" e a promessa real de uma encomenda
-- personalizada; hora seria precisao falsa. Mesma escolha do due_date das
-- parcelas.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS promised_date DATE DEFAULT NULL;

COMMENT ON COLUMN sales.promised_date IS
  'K1 (18/08/2026): data prometida de entrega da encomenda, combinada com o cliente. Opcional — sem ela o card do Kanban usa a idade do pedido. Alimenta o chip de prazo, a regua de entregas da semana (K4) e o tracker publico (K3).';

-- Consulta do Kanban filtra por prazo em vendas ativas.
CREATE INDEX IF NOT EXISTS idx_sales_promised_date
  ON sales (company_id, promised_date)
  WHERE promised_date IS NOT NULL;
