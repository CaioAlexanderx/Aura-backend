-- 362_studio_orcamento_ajustes.sql
-- Studio · "Cliente pediu ajuste" no orçamento em vídeo (28/09/2026)
--
-- Depois do envio pelo WhatsApp, o cliente pede para mudar alguma coisa
-- (cor, arte, quantidade). A lojista registra o pedido no painel e o
-- orçamento volta a ser editável (status 'draft'). Ao reenviar, a versão
-- sobe (2, 3...). É registro INTERNO da lojista: nada vai para o cliente.
--
-- Nada em studio_quotes guardava isso: notes é texto livre do orçamento e
-- response_note é a resposta final (recusa/fechamento). Por isso a tabela
-- própria, com company_id para o filtro multi-CNPJ.
--
-- Tudo aditivo e idempotente, sem nada de sessão: o runner roda cada
-- migration numa transação do pooler (backend#769).

-- Versão do orçamento que o cliente recebeu. Começa em 1 e sobe a cada
-- reenvio depois de um ajuste pedido.
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS versao integer NOT NULL DEFAULT 1;

-- Quando o último ajuste foi pedido e ainda não foi reenviado. É o que
-- acende o selo "Ajuste pedido" no editor e na lista; o reenvio limpa.
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS ajuste_pedido_em timestamptz;

CREATE TABLE IF NOT EXISTS studio_quote_ajustes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    uuid NOT NULL REFERENCES studio_quotes(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  texto       text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 500),
  versao      integer NOT NULL,          -- a versão que o cliente viu
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS studio_quote_ajustes_quote_idx
  ON studio_quote_ajustes (quote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_quote_ajustes_company_idx
  ON studio_quote_ajustes (company_id);
