-- ============================================================
-- 463 — Profissão do cliente (ótica, cadastro completo — p-204, 23/11/2026)
--
-- Só aditiva. RG (148) e sexo (050) já existem em customers; falta a
-- profissão, que a ficha da ótica imprime. Sem índice: não entra em busca.
-- O backend sobe antes desta migration: sem a coluna, POST/PATCH devolvem
-- ignored_fields: ['occupation'] e o GET não anuncia o campo em
-- customer_fields (src/services/customerDadosCompletos.js).
-- ============================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS occupation TEXT;
