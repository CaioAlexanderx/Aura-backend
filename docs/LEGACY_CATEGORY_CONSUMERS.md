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

## 3. `products.unit = 'srv'` — RESOLVIDO por decisão de escopo

**Status: fechado em 28/07/2026.** Mantido no documento porque explica por que a F0 não tem guard de coerência de tipo, e porque a dívida da §3.3 continua viva.

### 3.1 O achado

A rota legada distingue produto de serviço **pela coluna `products.unit`**, não por uma coluna `type` em `products`:

```js
// type === 'service'
`p.unit = 'srv'`
// type === 'product'
`(p.unit IS NULL OR p.unit <> 'srv')`
```

Aparece em três lugares do arquivo: no `countExpr` do `GET /`, no `unitFilter` do `PATCH` e no `unitFilter` do `DELETE`.

O `type` da migration 045 vive só em `product_categories`. Os dois sistemas nunca se tocavam — até a F0 criar `product_category_links`, que é o primeiro vínculo estruturado entre produto e categoria. Um produto `unit='srv'` vinculado a uma categoria `type='product'` sumiria das duas listagens legadas: a de serviço o exclui pelo `type`, a de produto pelo `unit`.

### 3.2 A decisão

**Serviço sai do escopo da F0.** A árvore é product-only. Ver `CONTRACT_CATEGORIES.md` §0.

Com a árvore sem opinião sobre serviço, os dois sistemas deixam de se encontrar e a incoerência não tem onde acontecer. **Nenhum guard no trigger, nenhuma validação de `unit` na API, nenhuma migration nova.**

Dado que sustenta, medido em 28/07:

| Fato | Valor |
|---|---|
| `product_categories` com `type='service'` | **0** na base inteira |
| `products` com `unit='srv'` fora da empresa `Aura.` | **0** |
| `products` com `unit='srv'` na empresa `Aura.` | 6 — SKUs dos próprios planos, faturamento interno |
| Sheid Mania (piloto Studio) | 54 produtos, **0** `unit='srv'`, **0** categorias `type='service'` |

Toda vertical que vende serviço tem modelo próprio e não passa por `product_categories`: Studio (`studio_template_categories`, `studio_orders`, `studio_quotes`, `studio_compositions`), Barber (`barbershop_appointment_services`, `barbershop_queue`), Odonto (TISS), Salão (`salon_partner_splits`). **O Shell Studio não é afetado.**

### 3.3 Dívida que permanece

A decisão remove o conflito, não a causa. `products.unit` continua sendo campo de **unidade de medida** sobrecarregado como discriminador de tipo. Os valores reais na base são texto livre e inconsistente:

`par` (5.359) · `un` (3.313) · `PR` (20) · `srv` (6) · `UN` (4) · `PARES` (4) · `PAR` (1) · `KIT` (1) · `kit` (1) · `pct` (1) · `L` (1)

E a comparação da rota legada é `= 'srv'`, **sensível a caixa** — um serviço cadastrado como `'SRV'` já hoje é tratado como produto pelas listagens. Bug anterior à F0, sem sintoma porque não há serviço de cliente na base.

A correção de raiz seria uma coluna própria em `products` (`is_service boolean` ou `type`), com backfill de `unit = 'srv'` e migração dos consumidores. **Fora do escopo da F0 e sem urgência.** Só volta à mesa se um cliente do Shell Negócio passar a comercializar serviço.

---

## 4. O que esta auditoria NÃO cobre

Esta seção existe para que ninguém trate o documento como completo.

A varredura de código foi feita por leitura direcionada via MCP do GitHub, arquivo a arquivo, e **não** por grep sobre a árvore inteira dos dois repos. Foi auditado apenas `src/routes/productCategories.js` — escolhido por ser o ponto de escrita que a própria spec já apontava.

**Falta auditar, em `aura-backend`:** PDV (`pdv*.js`), produtos (`products.js`), importação (`importData.js`), relatórios e DRE, curva ABC, storefront (`src/services/storefrontBuilder.js`, `src/templates/storefrontPage.js`), canal digital, marketplaces, etiquetas, NFC-e e emissão fiscal.

### 4.1 Odonto (`src/routes/dentalSupplies.js`) — AUDITADO, RESOLVIDO em 30/07/2026

Auditado por decisão do Caio. Escrevia em `products.category` como espelho legado de `products.dental_category` em dois pontos:

- `POST /dental/supplies` — `category` estava na lista de colunas do `INSERT INTO products`, com o mesmo valor de `dental_category`.
- `PATCH /dental/supplies/:id` — `category = COALESCE($5, category)` ao lado de `dental_category = COALESCE($5, dental_category)`.

Removido em `fix/dental-supplies-drop-legacy-category`. Motivação:

- O discriminador do módulo é a coluna booleana **`products.is_dental_supply`**, não o texto em `category`.
- A taxonomia do módulo vive em coluna própria, **`products.dental_category`**.
- **`products.category` nunca era lida de volta** pelo módulo Odonto — nenhum `SELECT`, nenhum `WHERE`. Só aparecia por efeito colateral dos `RETURNING *`.
- Base de produção, medida em 30/07: **0** empresas com `vertical='dental'`, **0** produtos com `is_dental_supply`, **0** `dental_category` preenchido. Sem dado para migrar, sem migration necessária.

Com a F0 (migration 259), `products.category` passou a ser mantida exclusivamente pelo trigger `trg_sync_legacy_category`; o Odonto tinha um segundo escritor nessa coluna. Está fechado — não entra mais na lista de pendências abaixo.

**Falta auditar, em `aura-app`:** `estoque.tsx`, formulários de produto, filtros de PDV, e todo consumidor de `category` em `services/api.ts`.

**Recomendação:** fechar esta lista com um `grep -rn "\.category\b"` local nos dois repos antes do merge do Bloco B1 — é minutos de trabalho com o repo em disco e cobre o que a leitura via MCP não alcança. Até lá, o dual-write protege as leituras: `products.category` continua populado e coerente, então **nenhum consumidor de leitura quebra**, mesmo os não mapeados.

O risco remanescente é restrito a **outros pontos de escrita** ainda não descobertos.
