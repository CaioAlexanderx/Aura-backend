-- ============================================================
-- 323 — Duracao do servico e galeria de fotos por cor
-- 08/09/2026
--
-- ── products.duration_minutes ──────────────────────────────────────────
-- O app escrevia "Duracao: 45 min" no FIM DA DESCRICAO do produto. A
-- descricao e texto livre que vai pra vitrine, pro marketplace e pro
-- WhatsApp — a duracao ficava presa la dentro, impossivel de somar numa
-- agenda, de ordenar ou de mostrar num campo proprio. Agora e coluna:
-- inteiro de minutos, NULL pra quem nao e servico. O cliente converte
-- "1h30" em 90 antes de mandar; o backend so aceita inteiro.
--
-- ── product_images ────────────────────────────────────────────────────
-- Ate hoje uma peca tinha UMA foto (products.image_url) e cada cor tinha
-- UMA foto na variante (product_variants.image_url, migration 129). A
-- cliente que quer ver o tenis preto por tres angulos nao tem como — e a
-- lojista ja fotografou, ela so nao tem onde colocar.
--
-- FORMA: tabela, e nao mais um array jsonb como a galeria da 290. A
-- diferenca e a CHAVE: a 290 guarda a galeria do produto (uma lista so,
-- sempre lida junto do produto); esta aqui e por (produto, COR), um
-- conjunto que a UI edita cor a cor, reordena e apaga item a item. Linha
-- com id proprio e o que torna DELETE /images/:id e reorder possiveis
-- sem reescrever o array inteiro a cada clique.
--
-- color_hex NULL = galeria PRINCIPAL do produto (as fotos que valem pra
-- peca inteira). Normalizado minusculo '#rrggbb' pela rota — a
-- comparacao de cor no catalogo ja sofreu com '#FF0000' vs '#ff0000'.
--
-- COMPATIBILIDADE: a foto na posicao 0 da galeria principal continua
-- espelhando products.image_url, e a posicao 0 de uma cor continua sendo
-- aplicada nas variantes daquela cor (o que POST /color-image faz hoje).
-- Assim vitrine, PDV, carrinho, marketplace e notificacao seguem lendo o
-- que sempre leram, sem nenhum deles ser tocado. Mesmo dual-write da 290.
--
-- thumb_url acompanha url porque toda foto de produto nasce em DOIS
-- tamanhos (migration 317 + utils/fotosDeProduto.js). Sem a miniatura na
-- linha, promover a foto seguinte a capa deixaria products.image_thumb_url
-- apontando pro arquivo que acabou de ser apagado.
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;

COMMENT ON COLUMN products.duration_minutes IS
  'Duracao do servico em MINUTOS (inteiro, >= 0). NULL = nao e servico ou nao informado. Substitui o "Duracao: 45 min" que o app anexava em description.';

CREATE TABLE IF NOT EXISTS product_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color_hex   text,
  url         text NOT NULL,
  thumb_url   text,
  position    smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A leitura e sempre "as fotos deste produto, desta cor, na ordem".
CREATE INDEX IF NOT EXISTS product_images_produto_cor_pos_idx
  ON product_images (product_id, color_hex, position);

-- RLS ligada sem policy, mesmo padrao de product_category_links (258) e
-- digital_orders. O isolamento multi-tenant e por WHERE company_id no
-- backend; a RLS existe pra que um acesso direto ao banco pelo PostgREST
-- do Supabase nao veja nada.
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE product_images IS
  'Galeria de fotos do produto, ate 4 por cor. color_hex NULL = galeria principal. position 0 e a capa daquela cor e espelha products.image_url (principal) ou product_variants.image_url (cor).';
COMMENT ON COLUMN product_images.color_hex IS
  'Cor da galeria, minusculo #rrggbb. NULL = galeria principal do produto.';
COMMENT ON COLUMN product_images.position IS
  'Ordem de exibicao dentro do par (product_id, color_hex), comecando em 0. Sem buracos: DELETE reempacota.';
