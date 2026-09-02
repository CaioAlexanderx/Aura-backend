-- ============================================================
-- 318 — Nome de categoria e unico ENTRE IRMAOS, nao na loja inteira
--
-- Criado: 02/09/2026 (Davi Calcados)
--
-- A migration 045 poe UNIQUE (company_id, type, name) — de quando
-- categoria era uma lista plana. A 257 trouxe a arvore e criou os dois
-- indices que valem hoje: `product_categories_unique_sibling`
-- (company_id, type, parent_id, name_norm) e
-- `product_categories_unique_path`. A nota da 257 diz que o unique
-- legado ficava "de proposito, nao dropar nesta fase".
--
-- A fase chegou. Uma loja de calcado precisa de "Tenis" dentro de
-- Masculino, Feminino E Infantil — tres nos irmaos de pais diferentes,
-- o que o unique de irmao permite e o legado proibe. A Finesse so nao
-- esbarrou nisso porque a arvore dela nomeia a folha inteira
-- ("Vestido Midi Festa").
--
-- O que continua garantido depois deste drop:
--   - dois filhos do MESMO pai nao podem ter o mesmo nome (unique_sibling,
--     que ainda normaliza acento/caixa via name_norm — mais forte que o
--     legado, que comparava o texto cru);
--   - dois nos da mesma empresa nao podem ter o mesmo caminho (unique_path).
--
-- O que muda de verdade: `products.category` (a string legada que o
-- gatilho escreve com o nome da folha) passa a poder repetir entre
-- ramos. A loja nao le mais essa string pra navegar — ela navega por
-- caminho (catalogoPaginado) —, e a tela de estoque so a exibe.
-- ============================================================

ALTER TABLE product_categories
  DROP CONSTRAINT IF EXISTS product_categories_company_type_name_key;

-- 045 criou como CONSTRAINT; em base restaurada de dump pode ter virado
-- so o indice. Os dois nomes sao o mesmo objeto, entao o DROP INDEX
-- abaixo e um no-op quando o DROP CONSTRAINT acima ja resolveu.
DROP INDEX IF EXISTS product_categories_company_type_name_key;
