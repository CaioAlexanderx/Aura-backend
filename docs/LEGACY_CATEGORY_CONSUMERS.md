# LEGACY_CATEGORY_CONSUMERS — auditoria de `products.category`

**Fase:** F0 — Bloco 0 (pré-requisito) · **Data:** 28/07/2026
**Status: PARCIAL — ver seção 4.**

> Propósito: `products.category` passa a ser escrito pelo trigger `trg_sync_legacy_category` (migration 259). Todo ponto que **também** escreve nessa coluna vai conflitar. Todo ponto que **lê** precisa continuar funcionando durante o dual-write, e só pode ser depreciado quando esta lista estiver vazia.
>
> Leitura pura. Nenhum arquivo de código foi alterado nesta auditoria.

---

## 1. Camada de banco — COMPLETA

Varredura em `pg_views`, `pg_matviews`, `pg_proc`, `pg_trigger` e `pg_indexes`.

| Objeto | Resultado |
|---|---|
| Views que referenciam `products` + `category` | **nenhuma** |
| Materialized views | **nenhuma** |
| Functions (`prokind='f'`) | **nenhuma** |
| Triggers em `products` | apenas `trg_products_updated_at` (timestamp genérico, sem relação com `category`) |
| Triggers em `product_categories` | nenhum antes da 259 |
| Índices sobre `products.category` | `idx_products_category` |

**Conclusão:** o banco não tem nenhum consumidor de `products.category` além de um índice. Nenhum risco de conflito vindo da camada de dados. Todos os consumidores estão em código de aplicação.

---

## 2. Pontos de ESCRITA identificados

### 2.1 `src/routes/productCategories.js` — CONFLITA com o trigger (d)

| Local | Operação | O que faz |
|---|---|---|
| `PATCH /:catId`, bloco "Cascade" | `UPDATE products p SET category = $1, updated_at = NOW() WHERE p.company_id = $2 AND p.category = $3 AND <unitFilter>` | Ao renomear a categoria, propaga o nome novo para os produtos. |
| `DELETE /:catId` com `?move_to=` | `UPDATE products p SET category = $1, updated_at = NOW() WHERE p.company_id = $2 AND p.category = $3 AND <unitFilter>` | Move os produtos da categoria apagada para a categoria destino. |

**Ação para o Bloco B1:** o trigger `trg_sync_legacy_category_rename` (259) já faz a cascata de rename a partir dos links. **Remover a cascata manual do `PATCH`.** Manter as duas causa escrita dupla — no melhor caso redundante, no pior divergente, porque as duas usam critérios diferentes: o trigger casa por **link primário**, a rota casa por **igualdade de texto em `products.category`**.

O `move_to` do `DELETE` é caso à parte: enquanto não houver links, ele ainda é a única forma de mover produto entre categorias-texto. B1 decide se reimplementa via links ou mantém até a migração de dados rodar. **Precisa de decisão explícita, não de omissão.**

---

## 3. Achado não previsto na spec v2 — `products.unit = 'srv'`

A rota legada distingue produto de serviço **pela coluna `products.unit`**, não por uma coluna `type` em `products`:

```js
// type === 'service'
`p.unit = 'srv'`
// type === 'product'
`(p.unit IS NULL OR p.unit <> 'srv')`
```

Isso aparece em três lugares do arquivo: no `countExpr` do `GET /`, no `unitFilter` do `PATCH` e no `unitFilter` do `DELETE`.

**Consequência que a spec v2 não cobre.** O `type` da migration 045 vive em `product_categories`; a contraparte em `products` é `unit = 'srv'`. Nada no schema impede vincular um produto com `unit = 'srv'` a uma categoria `type = 'product'` — o trigger `trg_link_tenant_guard` valida apenas `company_id`.

Se isso acontecer, o produto fica invisível nas duas listagens legadas: a de serviço o exclui pelo filtro de `unit`, e a de produto também, porque `unit = 'srv'`.

**Aberto para decisão de Caio.** Três opções:

1. **Estender o guard** — acrescentar ao `trg_link_tenant_guard` a validação de coerência entre `products.unit` e `product_categories.type`, levantando `CATEGORY_TYPE_MISMATCH`. Custa uma migration nova (262) e fecha a porta no nível mais baixo.
2. **Validar na API** — B1 recusa o vínculo incoerente em `PUT /products/:id/categories` e no `bulk`. Mais barato, mas não protege escrita direta no banco.
3. **Não tratar** — aceitar que a UI só oferece a árvore do `type` certo e que o caso é improvável na prática.

Recomendação: **opção 1**. O mesmo argumento que justifica o guard de tenant vale aqui — a tabela cruza duas entidades e a coerência não é expressável por FK. Mas é escopo novo, e por isso não foi implementado sem decisão.

---

## 4. O que esta auditoria NÃO cobre

Esta seção existe para que ninguém trate o documento como completo.

A varredura de código foi feita por leitura direcionada via MCP do GitHub, arquivo a arquivo, e **não** por grep sobre a árvore inteira dos dois repos. Foi auditado apenas `src/routes/productCategories.js` — escolhido por ser o ponto de escrita que a própria spec já apontava.

**Falta auditar, em `aura-backend`:** PDV (`pdv*.js`), produtos (`products.js`), importação (`importData.js`), relatórios e DRE, curva ABC, storefront (`src/services/storefrontBuilder.js`, `src/templates/storefrontPage.js`), canal digital, marketplaces, etiquetas, NFC-e e emissão fiscal.

**Falta auditar, em `aura-app`:** `estoque.tsx`, formulários de produto, filtros de PDV, e todo consumidor de `category` em `services/api.ts`.

**Recomendação:** fechar esta lista com um `grep -rn "\.category\b"` local nos dois repos antes do merge do Bloco B1 — é minutos de trabalho com o repo em disco e cobre o que a leitura via MCP não alcança. Até lá, o dual-write protege as leituras: `products.category` continua populado e coerente, então **nenhum consumidor de leitura quebra**, mesmo os não mapeados.

O risco remanescente é restrito a **outros pontos de escrita** ainda não descobertos.
