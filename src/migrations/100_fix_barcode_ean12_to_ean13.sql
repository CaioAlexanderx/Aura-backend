-- Migration 100: normaliza barcodes EAN-12 (UPC-A) para EAN-13
-- Contexto: durante a importação dos produtos do Davi Calçados, 25 barcodes
-- foram gravados com 12 dígitos (formato UPC-A). Scanners brasileiros lêem
-- EAN-13 (13 dígitos). A discrepância de 1 dígito faz o lookup falhar.
-- Fix: adiciona zero-líder em barcodes puramente numéricos de 12 dígitos
-- que ainda não começam com '0' (evita duplo-prefix em re-runs).
-- Idempotente: WHERE length(barcode) = 12 nunca casa com códigos já
-- migrados (que terão 13 dígitos após o UPDATE).

UPDATE products
SET
  barcode    = '0' || barcode,
  updated_at = NOW()
WHERE
  barcode ~ '^\d{12}$'
  AND barcode NOT LIKE '0%';

-- Confirma quantos foram corrigidos (útil nos logs do deploy)
SELECT
  COUNT(*) AS barcodes_migrados
FROM products
WHERE barcode ~ '^0\d{12}$'
  AND updated_at >= NOW() - INTERVAL '5 seconds';
