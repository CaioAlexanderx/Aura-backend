-- 363 — Comprovante anexado ao lançamento · 29/09/2026
--
-- Contas a pagar F3: a lojista anexa a foto ou o PDF do comprovante ao dar
-- baixa (ou depois, pelo Editar). O arquivo vai para o R2 (utils/r2Storage);
-- aqui fica só a chave e o nome, para abrir por URL assinada. Um comprovante
-- por lançamento: anexar de novo substitui.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_key TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_filename TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_content_type TEXT;
