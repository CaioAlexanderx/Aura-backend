-- ============================================================
-- 360 — Nomes com a acentuação correta (dados)
-- 28/09/2026 — QA final da vitrine Studio (LJ-16 e o dado da
-- "Folha de sublimação" com caractere quebrado)
--
-- Decisão do Caio: "Precisamos corrigir e ter acentuação correta".
--
--  - Os mockups da aba Aparência apareciam sem acento ("Caneca alca
--    coracao 355ml", "Xicara com pires e colher"): o nome é o de
--    studio_visual_templates, gravado assim no cadastro dos templates.
--  - "Folha de sublimação" com caractere quebrado na grade da vitrine e na
--    API, na Sheid Mania e na aura-qa.
--
-- Cada UPDATE casa pelo id E pelo nome antigo: rodar de novo não faz
-- nada, e um nome que alguém já tenha trocado à mão não é sobrescrito.
-- Poucas linhas por chave primária: nenhuma trava longa.
-- ============================================================

-- Templates visuais (mockups da aba Aparência) -------------------------
UPDATE studio_visual_templates SET name = 'Caneca alça coração 355ml', updated_at = NOW()
 WHERE id = '25f526eb-57da-4caa-bf9a-9629638eed49' AND name = 'Caneca alca coracao 355ml';

UPDATE studio_visual_templates SET name = 'Caneca alça coração preta 355ml', updated_at = NOW()
 WHERE id = 'b1582583-6f16-41c5-9661-fc6a01fd7301' AND name = 'Caneca alca coracao preta 355ml';

UPDATE studio_visual_templates SET name = 'Caneca alça colorida 355ml', updated_at = NOW()
 WHERE id = '48cb4b2a-5bbc-4703-af4c-32269653edc7' AND name = 'Caneca alca colorida 355ml';

UPDATE studio_visual_templates SET name = 'Caneca cerâmica vintage fosca', updated_at = NOW()
 WHERE id = '3dff306c-b2c0-4a7e-bfbb-cf1304333b96' AND name = 'Caneca ceramica vintage fosca';

UPDATE studio_visual_templates SET name = 'Xícara com pires e colher', updated_at = NOW()
 WHERE id = '59e86de3-98de-4cc1-b73d-34c98caadebf' AND name = 'Xicara com pires e colher';

-- Produto "Folha de sublimação" (Sheid Mania e aura-qa) ----------------
-- O nome gravado tem bytes quebrados depois de "sublima"; o LIKE pega
-- qualquer variante, e o <> impede de reescrever o que já está certo.
UPDATE products SET name = 'Folha de sublimação', updated_at = NOW()
 WHERE id IN ('20afafae-898d-41b0-b9b5-1b567be00e02', '8c7f1280-dee8-47a1-9cfe-81b1d9e1dfe4')
   AND name LIKE 'Folha de sublima%'
   AND name <> 'Folha de sublimação';
