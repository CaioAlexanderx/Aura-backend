-- ============================================================
-- 308 — "mostrar na loja apenas peças com foto"
--
-- Nasce da Finesse: 1.302 peças cadastradas, 143 com foto. A loja está
-- publicada e nove em cada dez produtos aparecem como um retângulo cinza
-- com o nome escrito. Isso é pior que não ter loja.
--
-- POR QUE UM INTERRUPTOR E NÃO UMA LISTA. A alternativa era jogar as
-- 1.159 sem foto em hidden_product_ids. Funcionaria hoje e apodreceria
-- amanhã: no dia em que a lojista fotografar uma peça, ela continuaria
-- escondida até alguém editar a lista. Como regra, a peça acende sozinha
-- assim que ganha foto — e apaga sozinha se a foto for removida.
--
-- DEFAULT false. Nenhuma das lojas existentes muda de comportamento; a
-- lojista que quiser liga no painel.
-- ============================================================

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS require_product_image BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN digital_channel_config.require_product_image IS
  'Quando true, a loja publica so mostra produtos com foto (capa ou galeria). A peca reaparece sozinha quando ganha foto.';
