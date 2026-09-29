-- 364_studio_quote_items_modelo.sql
-- Studio · modelo de mockup por item do orçamento (29/09/2026)
--
-- O modal novo do orçamento (docs/studio/orcamento-modal-diagnostico.md,
-- no aura-app) deixa a lojista trocar o modelo de mockup de uma peça só
-- naquele orçamento, sem mexer no produto. O vídeo 3D lê o modelo do item
-- antes do modelo do produto.
--
-- NULL = herda do produto (products.visual_template_key). É o padrão de
-- todo item que já existe e de todo item novo em que a lojista não trocou
-- nada. Referência solta, sem FK: mesmo racional de products
-- .visual_template_key (migration 208), o modelo pode ser arquivado.
--
-- Aditiva e idempotente, sem nada de sessão: o runner roda cada migration
-- numa transação do pooler, com SET LOCAL lock_timeout (backend#769).

ALTER TABLE studio_quote_items ADD COLUMN IF NOT EXISTS visual_template_key text;
