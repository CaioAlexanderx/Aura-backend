-- ============================================================
-- 279 — Backfill dos 4 caixa_fechamentos corrompidos pela row negativa
--        de troca em sale_payments (bug corrigido no back#491).
--
-- caixa_fechamentos é snapshot imutável POR CONTRATO; esta correção
-- retroativa foi explicitamente aprovada pelo Caio em 13/08/2026
-- ("Faça a atualização também no histórico — o Davi ainda vê R$40").
--
-- Método: valor correto = valor gravado + |row negativa| no bucket do
-- método (a única coisa errada nos snapshots era a inclusão da row
-- -returnedValue da trocaV2). fiado/outros intactos (fontes distintas).
-- dinheiro_esperado acompanha o bucket dinheiro; `diferenca` é coluna
-- GENERATED (contado - esperado), recalcula sozinha.
-- Cada UPDATE tem guarda no valor errado antigo → idempotente e no-op
-- em banco limpo (CI). Aplicada em PROD em 13/08/2026 via Supabase MCP.
--
-- Conferência (fonte: sale_payments/troca_payouts das sessões):
--  8edd147e (Villa 11/08):  pix -89,99→100,00; geral 40,00→229,99
--  b98d8f21 (Matriz 11/08): dinheiro -159,99→0; esperado -159,99→0; geral -159,99→0
--  3c8c4690 (Villa 04/08):  debito -159,99→90,00; geral 680,73→930,72
--  11534afd (Matriz 03/07): dinheiro -157,00→12,99; esperado -157,00→12,99; geral -7,02→162,97
--    (diferenca vira -12,99: falta real daquele dia — cliente pagou 12,99
--     em dinheiro na troca e o contado foi 0)
--  Sessão 30353d34 (Aura 03/06) também tinha row negativa mas nunca gerou
--  snapshot em caixa_fechamentos — nada a corrigir.
-- ============================================================

UPDATE caixa_fechamentos
   SET total_pix = 100.00, total_geral = 229.99
 WHERE id = '8edd147e-18d6-4015-bc52-15738aadb8e2'
   AND total_pix = -89.99 AND total_geral = 40.00;

UPDATE caixa_fechamentos
   SET total_dinheiro = 0.00, dinheiro_esperado = 0.00, total_geral = 0.00
 WHERE id = 'b98d8f21-9c74-4211-8a05-30400dd671a7'
   AND total_dinheiro = -159.99 AND total_geral = -159.99;

UPDATE caixa_fechamentos
   SET total_cartao_debito = 90.00, total_geral = 930.72
 WHERE id = '3c8c4690-cf3d-46c5-8dd2-41480bf52b16'
   AND total_cartao_debito = -159.99 AND total_geral = 680.73;

UPDATE caixa_fechamentos
   SET total_dinheiro = 12.99, dinheiro_esperado = 12.99, total_geral = 162.97
 WHERE id = '11534afd-06e2-4fa4-ba72-bd9af8908d0a'
   AND total_dinheiro = -157.00 AND total_geral = -7.02;
