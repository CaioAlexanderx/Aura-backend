-- ============================================================
-- 455 — Tempos da venda no Caixa, medidos no app (p-151, 17/11/2026)
--
-- O log [pdv-sale-timing] (p-140) mede o servidor. O que a pessoa sente no
-- balcão tem mais duas partes que só o app vê: quanto tempo leva montar o
-- carrinho e quanto tempo a tela fica parada depois da venda. O app anota,
-- por venda:
--   atendimento_ms  primeiro item no carrinho -> clique em Finalizar
--   espera_ms       Finalizar -> resposta do servidor
--   ocioso_ms       resposta -> começo da próxima venda (Nova venda)
-- e manda o lote quando a próxima venda começa, sem esperar resposta.
--
-- Sem dado de cliente final: só números, sim/não e o id interno da venda.
-- Idempotente: o app gera um id por venda (client_id); reenvio não duplica.
-- ============================================================
CREATE TABLE IF NOT EXISTS pdv_sale_timings (
  id              BIGSERIAL PRIMARY KEY,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id       TEXT NOT NULL,
  sale_id         UUID,
  ocorreu_em      TIMESTAMPTZ NOT NULL,
  atendimento_ms  INT,
  espera_ms       INT,
  ocioso_ms       INT,
  itens           INT,
  entrada         TEXT,                  -- 'leitor' | 'grade' | 'busca' | 'misto'
  ok              BOOLEAN,               -- a venda foi registrada (false = recusada / sem resposta)
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pdv_sale_timings_client
  ON pdv_sale_timings (company_id, client_id);
CREATE INDEX IF NOT EXISTS idx_pdv_sale_timings_company_quando
  ON pdv_sale_timings (company_id, ocorreu_em DESC);
