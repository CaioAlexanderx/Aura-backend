-- ============================================================
-- 440 — Tomador da NFS-e gravado na própria venda (10/11/2026)
--
-- Por quê: o Caixa pede o CPF/CNPJ de quem contratou quando a venda tem
-- serviço. Até aqui esse documento só chegava ao backend DEPOIS, pelo
-- POST /nfse/automatica/origem/venda/:id/completar, e só se a nota ficasse
-- 'pendente_dados'. Se a aba fechasse antes, o documento se perdia.
--
-- Agora o POST /pdv/sale (e /sale-com-sinal) aceita nfse_tomador
-- { doc, nome? } e grava o documento validado AQUI, dentro da MESMA
-- transação da venda. Assim ele sobrevive mesmo que o processo caia entre o
-- COMMIT e o agendamento da emissão (setImmediate): o próximo gatilho da
-- mesma venda (recebimento do crediário, OS entregue, "Emitir NFS-e" no app)
-- lê daqui.
--
-- Precedência do tomador (services/nfseAutomatica.js):
--   completado pelo app  >  sales.nfse_tomador  >  cadastro do cliente.
-- Nada aqui cria ou altera cadastro de cliente (customers não muda).
--
-- Formato: { "doc": "<11 ou 14 dígitos, dígito conferido>", "nome": "..." | null }
--
-- Só ADITIVA e idempotente: uma coluna nulável, sem default, sem backfill,
-- sem índice, sem reescrita de tabela. Venda sem nfse_tomador fica NULL e
-- tudo segue como antes. O backend tolera a coluna ausente (42703): grava
-- dentro de SAVEPOINT e lê a venda sem ela.
--
-- Caminho de volta (depois de reverter o PR):
--   ALTER TABLE sales DROP COLUMN IF EXISTS nfse_tomador;
-- ============================================================

ALTER TABLE sales ADD COLUMN IF NOT EXISTS nfse_tomador jsonb;

COMMENT ON COLUMN sales.nfse_tomador IS
  'Quem contratou o serviço, informado no Caixa para a NFS-e: { doc, nome }. Vale mais que o cadastro do cliente. NULL = usar o cadastro. Migration 440.';
