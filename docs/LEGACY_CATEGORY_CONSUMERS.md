# LEGACY_CATEGORY_CONSUMERS — auditoria de `products.category`

**Fase:** F0 — Bloco 0 (pré-requisito) · **Data:** 28/07/2026 · **Fechamento:** 18/08/2026
**Estado e sequência dos itens da fase:** `docs/F0_EXECUCAO.md`
**Status: ESCRITAS FECHADAS** — a §2.2 traz a varredura completa. Leituras seguem
protegidas pelo dual-write; a §4 explica o que isso cobre e o que não cobre.

> Propósito: `products.category` passa a ser escrito pelo trigger `trg_sync_legacy_category` (migration 259). Todo ponto que **também** escreve nessa coluna vai conflitar. Todo ponto que **lê** precisa continuar funcionando durante o dual-write, e só pode ser depreciado quando esta lista estiver vazia.
>
> A auditoria de 28/07 foi leitura pura. O fechamento de 18/08 alterou **um**
> arquivo: `src/routes/dentalSupplies.js`, que escrevia na coluna (ver §2.2.1).

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

### 2.2 Varredura completa de escritas — grep local, 18/08/2026

Rodado o grep recomendado pela §4 (repo em disco, os dois repos). **A lista de
escritas em `products.category` está fechada:**

| Arquivo | Escrita | Situação |
|---|---|---|
| `src/routes/products.js` | `POST /` (INSERT, default `'Produtos'`) e `PATCH /:id` (via `fieldMap`) | Esperado. É o cadastro — a Onda D troca o campo de texto pelo picker. |
| `src/routes/productsBatch.js` | INSERT em lote com colunas dinâmicas (inclui `category`) | **Entra no escopo declarado da Onda D** (decisão de 18/08). |
| `src/routes/importData.js` | 2 INSERTs + 1 UPDATE (importação de planilha) | **Entra no escopo declarado da Onda D** — importação escrevendo texto livre recriaria o problema que a F0 resolve. |
| `src/routes/dentalSupplies.js` | ~~INSERT + UPDATE espelhando `dental_category` em `category`~~ | **REMOVIDO em 18/08** (esta mudança). Ver 2.2.1. |
| `src/services/categoryMigration.js` | UPDATE de cleanup (`category = NULL` sem link) | Esperado — é o próprio serviço da F0. |
| `src/routes/productCategories.js` | cascata do PATCH + `move_to` do DELETE | Já auditado na §2.1. |

No `aura-app`: 119 ocorrências de `.category`, todas leitura ou montagem de
payload do cadastro — protegidas pelo dual-write; B3/D cuidam da troca.

### 2.2.1 O caso `dentalSupplies` — resolvido

A rota espelhava `dental_category` (enum de insumo odontológico) em
`products.category` "por compatibilidade". Sem trigger lendo a coluna
(o dual-write da 259 flui **links → coluna**, nunca o contrário), o espelho
não semeava a árvore — mas causava dois problemas reais:

1. **Poluição do staging do B2**: o wizard lê os distintos de
   `products.category`; `anestesico`/`broca`/`rx` apareceriam como categorias
   candidatas da loja.
2. **Anulação pelo cleanup**: `categoryMigration.js` zera `category` de
   produto sem link — apagaria o espelho dental de quem rodasse a migração.

Fix: o espelho foi removido (INSERT e PATCH); `dental_category` é o único
campo de categoria do módulo dental. Medido antes do fix: **0 insumos
dentais na base inteira** (módulo parado) — nenhum backfill necessário.
Decisão do Caio (18/08): a prioridade é a F0; o dental permanece montado,
mas fora do caminho da taxonomia.

**Recomendação belt-and-suspenders para o B2**: o staging deve filtrar
`is_dental_supply IS NOT TRUE` mesmo assim — protege contra base antiga ou
escrita futura que escape deste documento.

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

## 3.4 Leituras de `products.category` — auditoria fechada (E2, 18/08/2026)

O Bloco 0 fechou as **escritas** (§2.2). Esta seção fecha as **leituras**, que era o item E2 da Onda E.

### Backend — 26 arquivos leem `p.category`

| Grupo | Arquivos | O que acontece com eles |
|---|---|---|
| **Da própria F0** | `productCategories`, `categoryMigration`, `importCategoryLink`, `catalogHealth`, `productDescriptionAi`, `productDescriptions`, `productLinks` | São o motor da fase. Nada a fazer. |
| **Vitrine pública** | `storefrontBuilder`, `studioStorefront`, `templates/storefront/parts/{init,products,product_detail}` | **Já migrados aditivamente na D3**: o payload ganhou `categories[]` + `category_id/slug/path` e manteve o texto. Os templates seguem lendo texto — trocar é trabalho da fase de vitrine, junto das URLs canônicas. |
| **Cadastro e importação** | `products`, `productsBatch`, `importData`, `barcode`, `scanner` | Escrita fechada na D4; a leitura é eco do que gravaram. |
| **Relatórios e análise** | `salesAnalytics`, `productsRanking`, `productMargin`, `reportDataQueries`, `reportGenerator`, `weeklyReport`, `financeiroInsights`, `meAggregates`, `digitalChannel` | **É aqui que mora o trabalho restante.** Agrupam receita/venda por texto de categoria. Enquanto o dual-write existir, os números continuam certos. |
| **PDV** | `pdv` | Idem — filtro por texto, protegido pelo dual-write. |

### App — 56 arquivos citam `.category`

A maioria é de **outro domínio**: categoria de transação financeira, `dental_category`, categoria de lead no CRM, categoria de competição do Karatê. Os consumidores de categoria de **produto** se concentram em `screens/estoque/*`, `app/(tabs)/estoque.tsx`, `app/(tabs)/index.tsx`, `app/studio/(estudio)/estoque.tsx`, `components/screens/canal/TabVitrine.tsx` e `QuickBatchProductsModal`.

Desses, os de estoque e PDV foram tratados na **D1/D2**: o cadastro escreve vínculo e o filtro virou hierárquico. Os demais leem texto para exibir, e continuam corretos pelo dual-write.

### Conclusão: nenhuma leitura bloqueia a fase

**Nenhum consumidor de leitura quebra**, porque `products.category` continua populado e coerente pelo trigger da migration 259. A migração de leitura é incremental e por consumidor, não um corte.

**A coluna só pode ser depreciada quando os relatórios pararem de agrupar por ela** — é o grupo de "Relatórios e análise" acima, não a vitrine e não o estoque. Isso é trabalho de outra fase; a F0 não o exige.

---

## 4. Cobertura da auditoria — ATUALIZADA em 18/08/2026

**Escritas: lista FECHADA.** O grep local recomendado pela versão anterior
desta seção foi rodado em 18/08 nos dois repos (ver §2.2). Todos os pontos
de escrita em `products.category` estão mapeados e tratados. O gate do
Bloco 0 para o merge do B1 está cumprido.

**Leituras: FECHADAS em 18/08 (E2) — ver §3.4.** O parágrafo abaixo é o registro de como estavam antes.

**Leituras: mapeadas por amostragem, protegidas por design.** O dual-write
mantém `products.category` populado e coerente, então nenhum consumidor de
leitura quebra — mesmo os que não foram lidos um a um (PDV, DRE, curva ABC,
storefront, marketplaces, etiquetas, fiscal). A troca de leitura por árvore
é trabalho da Onda D e da F3, arquivo a arquivo, com o legado de rede.

**O que segue fora do escopo desta auditoria:** consumidores fora dos dois
repos (integrações externas que leiam o payload público) e SQL ad-hoc de
operação. Nada disso escreve na coluna.
