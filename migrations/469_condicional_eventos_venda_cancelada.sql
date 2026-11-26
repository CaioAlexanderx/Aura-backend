-- 469 — Eventos da condicional: venda_cancelada e reaberta (C11, 26/11/2026)
-- Cancelar a venda que cobrou as pecas solta o sale_id delas (evento
-- 'venda_cancelada' por peca) e reabre a condicional que so tinha encerrado
-- por essa venda (evento 'reaberta'). Aditiva: so amplia a lista permitida.
-- Tabela nova (467), pequena; o runner aplica numa transacao.
SET lock_timeout = '5s';

ALTER TABLE condicional_eventos DROP CONSTRAINT IF EXISTS condicional_eventos_tipo_check;
ALTER TABLE condicional_eventos
  ADD CONSTRAINT condicional_eventos_tipo_check
  CHECK (tipo IN ('criada', 'peca_acrescentada', 'ficou', 'voltou', 'voltou_defeito',
                  'ainda_com_ela', 'nova_data', 'venda', 'cancelada', 'encerrada',
                  'venda_cancelada', 'reaberta'));

RESET lock_timeout;
