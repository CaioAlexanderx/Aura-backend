-- ============================================================
-- 394 — label_design: tira o 'classico' que ninguem escolheu (card f1-16)
--
-- Contexto (18/10/2026): o #813 criou pdv_settings.label_design com default
-- 'classico' no GET. O app salva o objeto inteiro que leu (Configuracoes do
-- Caixa, migracao do vale-troca), entao o default foi gravado em 8 lojas que
-- nunca escolheram desenho nenhum — ate hoje NAO existe tela para escolher.
-- Medido em producao (SELECT) em 18/10: 8 com 'classico', 0 com 'editorial'.
--
-- A partir desta versao o default e null = "desenho padrao do modelo"
-- (105x21 e 40x25 editoriais, os outros classicos). Um 'classico' que
-- sobrasse viraria escolha explicita assim que o app passar a ler a chave:
-- a etiqueta 40x25 da conta interna Aura, por exemplo, deixaria de ser
-- editorial. Remover a chave devolve essas lojas ao padrao — que e o que
-- elas imprimem hoje.
--
-- Roda no deploy do backend (preDeployCommand), ANTES do PR do app que
-- mostra a opcao: ate la nenhum 'classico' no banco e escolha de alguem.
-- Idempotente: na 2a vez nao acha nada.
-- ============================================================

UPDATE companies
   SET pdv_settings = pdv_settings - 'label_design'
 WHERE pdv_settings->>'label_design' = 'classico';
