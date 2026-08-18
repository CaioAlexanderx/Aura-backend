# CONTRACT_CATEGORIES — contrato congelado

**Fase:** F0 — Loja Digital v2 · **Congelado em:** 28/07/2026 · **Re-sync:** 30/07/2026 (ver §9) · **Origem:** SPEC_LOJA_F0_TAXONOMIA v2, seção 3

> Este contrato é a fonte da verdade para a paralelização. Os agentes de frontend (B3, C1, C2) constroem contra ele com mock; os de backend (B1, B2) implementam contra ele. **Mudança depois do congelamento exige aviso ao orquestrador e re-sync dos dois lados no mesmo dia.**
>
> **Onde este documento e a SPEC_LOJA_F0_TAXONOMIA_v2.md divergirem, este documento vence.** A spec é anterior ao congelamento. As divergências conhecidas estão listadas na §9.2.

---

## 0. Decisão de escopo — 28/07/2026: **a F0 é product-only**

A árvore de categorias da F0 trata **exclusivamente** `type = 'product'`. Serviço está fora do escopo desta fase.

**Motivo, com o dado que sustenta:**

| Fato medido em 28/07 | Valor |
|---|---|
| Linhas em `product_categories` com `type = 'service'` | **0** (na base inteira) |
| Produtos com `unit = 'srv'` fora da empresa `Aura.` | **0** |
| Produtos com `unit = 'srv'` na empresa `Aura.` | 6 — são os SKUs dos próprios planos (Essencial/Negócio/Expansão, mensal e anual), usados para faturamento interno |
| Clientes do Shell Negócio que comercializam serviço | **nenhum** |

Toda vertical que de fato vende serviço **já tem modelo próprio** e não passa por `product_categories`:

- **Studio** → `studio_template_categories`, `studio_orders`, `studio_quotes`, `studio_compositions`, `studio_pricing_rules`. Verificado: Sheid Mania tem 54 produtos, **0** com `unit='srv'`, e **0** categorias `type='service'`.
- **Barber** → `barbershop_appointment_services`, `barbershop_queue`.
- **Odonto** → procedimentos e TISS (`dental_tiss_guides`).
- **Salão** → `salon_partner_splits`.

**O que isso resolve.** A incoerência entre `products.unit = 'srv'` e `product_categories.type` só existia porque os dois sistemas se encontravam em `product_category_links`. Com a árvore sem opinião sobre serviço, o encontro deixa de existir. **Não é preciso guard de coerência no trigger nem validação de `unit` na API.**

**O que isso NÃO resolve.** `products.unit` continua sendo um campo de unidade de medida sobrecarregado como discriminador de tipo, com comparação sensível a caixa (`= 'srv'`) e valores livres na base (`par`, `un`, `UN`, `PARES`, `PR`, `KIT`...). Isso é dívida pré-existente da rota legada, **não bloqueia a F0**, e só volta à mesa se um cliente do Shell Negócio passar a vender serviço.

**Consequências práticas para os agentes:**

1. A coluna `product_categories.type` **permanece no schema**. A rota legada lê, o aura-app chama `?type=`, e a migration 045 a criou. Dropar quebraria contrato existente sem ganho nenhum.
2. Os índices da migration 257 mantêm `type` na chave. Com todas as linhas em `'product'`, a coluna é constante e o índice se comporta como se ela não existisse. Deixa a porta aberta sem custo.
3. O trigger `trg_category_path_maintain` mantém a validação `NEW.type = parent.type`. É guarda latente de schema, não superfície de API.
4. **Nenhum endpoint NOVO da F0 expõe seleção de `type`.** O CRUD legado (`GET /`, `POST /`, `PATCH /:catId`, `DELETE /:catId`) continua bilíngue por retrocompatibilidade — ver §1 e a decisão **C1** da §9.1.

---

## 1. Convenção de rota

O repo monta tudo sob `/api/v1/companies/:id/...` com `Router({ mergeParams: true })` e leitura via **`req.params.id`** — não `:companyId`. Confirmado em `src/app.js` e em `src/routes/productCategories.js`.

O router de categorias **mantém o path `/product-categories`**, que o aura-app já chama hoje. Não criar `/categories` em paralelo.

### Tratamento de `?type=` [ATUALIZADO EM 30/07 — decisão C1]

| Endpoint | Comportamento |
|---|---|
| `GET /` (rota legada preservada) | **Continua aceitando `?type=product\|service`**, com o mesmo comportamento de hoje. Retrocompatibilidade pura — o aura-app já chama assim e não pode quebrar. |
| `POST /` (rota legada preservada) | **Continua aceitando `type: 'product' \| 'service'` no body**, default `'product'`. Categoria de serviço é criada **sempre flat**: `parent_id` forçado a `NULL`, `depth = 0`. Não participa da árvore. |
| `PATCH /:catId`, `DELETE /:catId` | Operam sobre o `type` da própria linha, como hoje. |
| Todos os endpoints **novos** da F0 (`/tree`, `/move`, `/merge`, `/reorder`, `/clone-from`, tudo em §4 e §5) | Operam sempre em `type = 'product'`, fixo. Não aceitam o parâmetro. Se vier, ignorar em silêncio. |

**Por que `POST /` não rejeita serviço.** Medido em 30/07 no `aura-app`: `hooks/useProductCategories.ts` monta o corpo como `createProductCategory(companyId, { ...body, type })` — o `type` do hook vai **sempre** no body. E `components/screens/estoque/AddServiceForm.tsx` e `components/screens/estoque/CategoriesModal.tsx` instanciam o hook com `"service"`. Um `422` ali transformaria em erro um caminho que hoje devolve `201`. Não há 0 linhas `type='service'` na base porque o caminho não existe — é porque ninguém usou. **O erro `422 CATEGORY_SERVICE_OUT_OF_SCOPE` foi retirado deste contrato.**

**Sem gate de plano.** Categoria é infraestrutura de estoque, não feature de loja. Não entra em `MODULE_PLAN_MAP` nem em `module_overrides`.

---

## 2. Objeto Category

```jsonc
{
  "id": "uuid",
  "company_id": "uuid",
  "type": "product",                   // 'product' na árvore; 'service' só nas linhas flat legadas — ver §1
  "parent_id": "uuid | null",
  "name": "Botas",
  "slug": "botas",
  "path": "/feminino/calcados/botas",
  "depth": 2,                          // 0, 1 ou 2
  "sort_order": 10,
  "color": "#7c3aed | null",
  "image_url": "string | null",
  "banner_url": "string | null",
  "is_visible_storefront": true,
  "seo_title": "string | null",
  "seo_description": "string | null",
  "product_count": 34,                 // semântica depende do endpoint — ver abaixo
  "product_count_total": 87,           // calculado na query de árvore
  "children": []                       // presente apenas em GET .../tree
}
```

O frontend **não deve construir seletor de tipo** em nenhuma tela nova. O `type` no payload é retrocompatibilidade.

### `product_count` — decisão A1, fechada em 30/07

Há duas semânticas possíveis e elas **não** coincidem:

- **ao vivo** — `COUNT(*) FROM products WHERE company_id = c.company_id AND category = c.name AND <unitFilter>`. É o que a rota legada faz hoje.
- **coluna** — `product_categories.product_count`, desnormalizada, mantida pelo trigger `trg_category_count` (migration 259). Conta **links**.

**Decisão: `GET /` mantém o cálculo ao vivo. `GET /tree` usa a coluna.**

Motivo: compatibilidade total com o consumidor atual, e o `GET /` é superfície legada com prazo de validade (some na F3). A coluna fica em 0 até a migração de dados rodar, o que tornaria o `GET /` mentiroso para as 3 empresas que têm as 55 categorias legadas.

**Limitação assumida, com olhos abertos.** O índice `product_categories_unique_sibling` só garante nome único *sob o mesmo pai*. `Feminino › Botas` e `Infantil › Botas` são dois nós legais com o mesmo `name` — e `WHERE category = c.name` conta os mesmos produtos nos dois. **O cálculo ao vivo passa a superestimar assim que existirem irmãos homônimos em ramos diferentes.** É aceito como transitório. O `GET /tree`, que é o que as telas novas consomem, está sempre correto.

---

## 3. Endpoints — categorias

Base: `/api/v1/companies/:id/product-categories`

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Lista flat com `path`. Aceita `?depth=`, `?parent_id=`, `?q=`, e `?type=` **por retrocompat**. **Mantém o shape atual** `{ categories, total, type }`. `product_count` ao vivo — ver §2. |
| GET | `/tree` | Árvore aninhada, com `product_count_total`. Product-only. `product_count` da coluna. |
| POST | `/` | Body: `{ name, parent_id?, color?, sort_order?, type? }`. `type='service'` cria flat — ver §1. |
| PATCH | `/:catId` | Renomeia / edita metadados. `path` e `slug` são recalculados **pelo trigger**, não pela rota. |
| DELETE | `/:catId` | Guardas obrigatórias + `?move_to=` — ver §3.1. |
| POST | `/:catId/move` | Body: `{ parent_id, sort_order }`. Valida ciclo e profundidade. |
| POST | `/merge` | Body: `{ source_ids: [], target_id }`. |
| POST | `/reorder` | Body: `{ parent_id, ordered_ids: [] }`. |
| POST | `/clone-from` | Body: `{ source_company_id }`. Copia árvore vazia de outra unidade. **Exige que origem e destino estejam no mesmo grupo de faturamento** (padrão `group_root` de `products.js`) — ver §3.2. |

### 3.2 `POST /clone-from` — guarda de grupo [ACRESCENTADO EM 30/07]

`clone-from` copia a árvore de **outra empresa**. Sem guarda, qualquer empresa clonaria a taxonomia de qualquer outra — a estrutura de categorias de um concorrente é informação de negócio, e a rota é autenticada apenas contra a empresa de **destino**.

A rota exige que origem e destino estejam no **mesmo grupo de faturamento**, usando o mesmo padrão `group_root` que `src/routes/products.js` já aplica. Origem fora do grupo → `403`.

Isso resolve o caso Davi (Matriz → Villa Branca, mesmo grupo) e fecha o buraco. Não estava no congelamento de 28/07 — foi levantado na implementação do B1 e aceito na revisão de 30/07.

### 3.1 `DELETE /:catId` — decisão B1, fechada em 30/07

**O comportamento atual está errado e precisa ser reescrito, não preservado.** Três problemas medidos em 30/07:

**(1) A rota não tem guarda nenhuma.** Ela apaga direto. Como `product_categories.parent_id` é `ON DELETE RESTRICT`, apagar um nó com filho hoje levanta `23503` e a rota devolve **500 genérico** — não o `409 CATEGORY_HAS_CHILDREN` deste contrato.

**(2) O `move_to` é silenciosamente desfeito pelo trigger.** A rota faz, nesta ordem: `UPDATE products SET category = $moveTo WHERE category = $oldName`, depois `DELETE FROM product_categories`. O `DELETE` cascateia em `product_category_links` (`ON DELETE CASCADE`), o que dispara `trg_sync_legacy_category` no `DELETE` → `products.category = NULL`. **O trigger roda depois e ganha.** Todo produto que tinha link primário na categoria apagada perde a categoria em vez de ser movido.

**(3) `move_to` é nome, não id.** `?move_to=Botas`, validado por `(company_id, name, type)`. Numa árvore, "Botas" pode existir em dois ramos: o `SELECT` de validação devolve 2 linhas, a rota não repara, e o `UPDATE` por texto vira lixo.

**Comportamento obrigatório do B1:**

- Guarda de filhos: se existir `product_categories` com `parent_id = :catId`, responder `409 CATEGORY_HAS_CHILDREN` com `children_count`. **Antes** de qualquer `DELETE`.
- Guarda de produtos: se existir link para `:catId` e não vier `move_to`, responder `409 CATEGORY_HAS_PRODUCTS` com `product_count`.
- `move_to` **aceita uuid e nome**:
  - Se o valor casa com o formato uuid → resolve direto por `id`, dentro da mesma empresa e mesmo `type`.
  - Senão → resolve por nome dentro do mesmo `type`. **Se resolver para mais de uma linha, responder `409 CATEGORY_DUPLICATE` com a lista de candidatos (`id`, `path`)** para a UI desambiguar. Nunca escolher por conta própria.
- Resolvido o destino, **mover os links**, não o texto: `UPDATE product_category_links SET category_id = :dest WHERE category_id = :src`, tratando o conflito de PK `(product_id, category_id)` e reafirmando a primária num statement separado — mesma disciplina do `merge`, ver §4.
- **A rota não escreve `products.category` em nenhum caminho.** O texto é responsabilidade exclusiva do trigger.

Motivo de aceitar nome: `hooks/useProductCategories.ts` (`remove(catId, moveTo)`) e `services/studioApi.ts` mandam **nome** hoje. Aceitar os dois formatos evita PR sincronizado no `aura-app` no dia do merge do B1.

---

## 4. Endpoints — produto ↔ categoria

| Método | Rota | Descrição |
|---|---|---|
| PUT | `/products/:productId/categories` | Body: `{ primary_category_id, also_in: [uuid] }`. **Substitui** os vínculos. |
| POST | `/products/categories/bulk` | Body: `{ product_ids: [], primary_category_id, mode }`. Máx 100. `mode`: `'replace_primary'` \| `'add_secondary'`. |
| GET | `/products/unclassified` | Órfãos paginados. `?q=`, `?has_stock=true`, `?limit=`, `?offset=`. Motor da tela "A organizar". |

**Nenhuma validação de `unit` nestes endpoints.** Ver §0: com a árvore product-only, não há incoerência possível entre `unit` e `type`.

### Semântica obrigatória do `bulk`

O índice parcial `product_category_links_one_primary` faz `INSERT ... ON CONFLICT DO NOTHING` de uma primária **falhar silenciosamente** num produto que já tem primária — o endpoint devolve 200 e não muda nada.

- `mode: 'replace_primary'` → `UPDATE ... SET is_primary = false WHERE product_id = ANY($1) AND is_primary`, **depois** `INSERT ... ON CONFLICT (product_id, category_id) DO UPDATE SET is_primary = true`.
- `mode: 'add_secondary'` → `INSERT ... ON CONFLICT DO NOTHING` com `is_primary = false`. Aqui `DO NOTHING` é correto.
- `merge` e `DELETE ?move_to=` → movem links com `DO NOTHING` e **reafirmam a primária em statement separado**.

---

## 5. Endpoints — migração e marca

**Nenhum destes endpoints chama serviço externo ou infere classificação.** A v2 removeu o motor de IA por decisão de produto.

| Método | Rota | Descrição |
|---|---|---|
| POST | `/categories/migration/analyze` | Varre `products.category`, popula staging: uma linha por valor-texto distinto + uma linha órfã. Idempotente. |
| GET | `/categories/migration/proposal` | Staging agrupado, com contagem e até 5 nomes de exemplo por linha. |
| PATCH | `/categories/migration/items/:itemId` | O **lojista** classifica: `{ kind, target_path?, status }`. |
| POST | `/categories/migration/apply` | Aplica o aprovado. Transacional por lote de 100, retomável. |
| GET | `/categories/migration/status` | `{ state, total, approved, applied, orphans }`. |
| GET | `/products/brand-candidates` | Agrupa `split_part(btrim(name), ' ', 1)` dos produtos sem `brand`, com contagem. Puro SQL. |
| POST | `/products/brand/apply` | Body: `{ assignments: [{ token, brand }] }`. Máx 100 tokens. |
| GET | `/catalog/health` | Cobertura de categoria, foto, descrição, custo, marca, e contagem de órfãos. |

O `analyze` varre apenas produtos que não são serviço (`unit IS NULL OR unit <> 'srv'`), preservando o filtro que a rota legada já aplica. Na prática isso só exclui os 6 SKUs de plano da própria Aura.

---

## 6. Erros padronizados

| Código | Situação | Origem |
|---|---|---|
| `409 CATEGORY_HAS_CHILDREN` | Delete com filhos. Payload inclui `children_count`. | rota (guarda explícita — ver §3.1) |
| `409 CATEGORY_HAS_PRODUCTS` | Delete com produtos e sem `move_to`. Payload inclui `product_count`. | rota |
| `409 CATEGORY_DUPLICATE` | Nome repetido sob o mesmo pai (`existing_id`), ou `move_to=<nome>` ambíguo (lista de candidatos). | `unique_violation` (23505) no índice `product_categories_unique_sibling`, ou rota (§3.1) |
| `422 CATEGORY_MAX_DEPTH` | Tentativa de criar 4º nível. | `check_violation` (23514) em `product_categories_depth_max` |
| `422 CATEGORY_CYCLE` | Mover categoria para dentro do próprio descendente. | `RAISE EXCEPTION` no trigger `trg_category_cycle_check` |
| `403 CATEGORY_CROSS_TENANT` | Categoria e produto de empresas diferentes. | `RAISE EXCEPTION` no trigger `trg_link_tenant_guard` |

`422 CATEGORY_SERVICE_OUT_OF_SCOPE` **foi removido** em 30/07 — ver §1 e §9.1.

### Exceções que chegam como string, não como código

Três erros vêm de `RAISE EXCEPTION` em trigger: SQLSTATE **`P0001`** (`raise_exception`), com a string em `err.message`. **Mapear por comparação de mensagem, não por código.**

| Mensagem | Trigger | Vira |
|---|---|---|
| `CATEGORY_CYCLE` | `trg_category_cycle_check` | `422` |
| `CATEGORY_CROSS_TENANT` | `trg_link_tenant_guard` | `403` |
| `CATEGORY_TYPE_MISMATCH` | `trg_category_path_maintain` | `422` — **inalcançável pela API da F0** (toda a árvore é `'product'`), mas mapear mesmo assim, para não vazar 500 se alguém escrever direto na tabela. |

Os demais vêm de constraint: `23505` no `product_categories_unique_sibling`, `23514` no `product_categories_depth_max`, `23503` na FK `parent_id` (`ON DELETE RESTRICT`).

---

## 7. Query de árvore — referência canônica

O filtro de `type` fica fixo em `'product'` na F0. Mantido como parâmetro para não precisar reescrever a query se serviço voltar ao escopo.

```sql
WITH RECURSIVE tree AS (
  SELECT c.*
  FROM product_categories c
  WHERE c.company_id = $1 AND c.type = 'product' AND c.parent_id IS NULL
  UNION ALL
  SELECT c.*
  FROM product_categories c JOIN tree t ON c.parent_id = t.id
),
totals AS (
  SELECT p.id,
         p.product_count + COALESCE((
           SELECT sum(d.product_count) FROM product_categories d
           WHERE d.company_id = p.company_id
             AND d.type = p.type
             AND d.path IS NOT NULL
             AND left(d.path, length(p.path) + 1) = p.path || '/'
         ), 0) AS product_count_total
  FROM product_categories p
  WHERE p.company_id = $1 AND p.type = 'product' AND p.path IS NOT NULL
)
SELECT t.*, COALESCE(tt.product_count_total, t.product_count) AS product_count_total
FROM tree t LEFT JOIN totals tt ON tt.id = t.id
ORDER BY t.path;
```

A SPEC v2 §4.6 traz uma variante com `LIKE ... ESCAPE '\'`. **Ela está superada.** Aqui foi trocada por `left()` + comparação, que é a mesma solução usada no trigger `category_path_cascade` — sem curinga, sem escape, uma regra só. Usar esta.

---

## 8. Objetos reais no banco — nomes conferidos em 30/07

A SPEC v2 §4.3 descreve "cinco triggers" com nomes que **não são** os aplicados. São **sete** objetos de trigger. Estes são os nomes reais:

| Trigger | Tabela | Quando | Função |
|---|---|---|---|
| `trg_category_path_maintain` | `product_categories` | BEFORE INSERT OR UPDATE OF name, parent_id | `category_path_maintain()` |
| `trg_category_path_cascade` | `product_categories` | AFTER UPDATE OF name, parent_id | `category_path_cascade()` |
| `trg_category_cycle_check` | `product_categories` | BEFORE UPDATE OF parent_id | `category_cycle_check()` |
| `trg_sync_legacy_category_rename` | `product_categories` | AFTER UPDATE OF name | `sync_legacy_category_on_rename()` |
| `trg_sync_legacy_category` | `product_category_links` | AFTER INSERT OR UPDATE OR DELETE | `sync_legacy_category_from_link()` |
| `trg_link_tenant_guard` | `product_category_links` | BEFORE INSERT OR UPDATE | `link_tenant_guard()` |
| `trg_category_count` | `product_category_links` | AFTER INSERT OR DELETE | `category_count_maintain()` |

Função auxiliar: `category_slugify(text)`, **STABLE**. Usada pelo backfill da 257 e pelo `category_path_maintain`. **Nunca calcular `slug`, `path` ou `depth` na aplicação.**

Índices e constraints relevantes:

- `product_categories_unique_sibling` — `(company_id, type, COALESCE(parent_id, '000…0'::uuid), name_norm)`
- `product_categories_unique_path` — `(company_id, type, path) WHERE path IS NOT NULL`
- `product_categories_depth_max` — `CHECK (depth >= 0 AND depth <= 2)`
- `product_categories_company_type_name_key` — unique legado `(company_id, type, name)`, **mantido de propósito**
- `product_category_links_one_primary` — `(product_id) WHERE is_primary` — índice **parcial**, origem da armadilha do `DO NOTHING` (§4)
- `product_category_links_pkey` — `(product_id, category_id)`

Estado da base em 30/07: `product_category_links` = **0 linhas**, `category_migration_staging` = **0 linhas**, `products.brand` preenchido em **0** produtos, `product_categories` = **55 linhas em 3 empresas** — e **0 na Davi Matriz**. A árvore da Davi nasce vazia.

---

## 9. Histórico de mudanças do contrato

### 9.1 Re-sync de 30/07/2026 — três decisões de Caio

| # | Decisão | Efeito |
|---|---|---|
| **A1** | `GET /` mantém `product_count` ao vivo; `GET /tree` usa a coluna. | §2. Limitação de irmãos homônimos aceita como transitória. |
| **B1** | `DELETE ?move_to=` aceita uuid **e** nome, resolve para id, move **links** e não texto. Guardas de filho e de produto viram obrigatórias. | §3.1, §6. Evita PR sincronizado no `aura-app`. |
| **C1** | `POST /` volta a aceitar `type: 'service'`, criando flat. `422 CATEGORY_SERVICE_OUT_OF_SCOPE` removido. | §1, §6. Evita regressão em `AddServiceForm.tsx` e `CategoriesModal.tsx`. |

Também nesta revisão: §8 com os nomes reais dos 7 triggers, §6 com a terceira exceção `P0001` (`CATEGORY_TYPE_MISMATCH`) e com o `23503` da FK `parent_id`, §7 marcando a query da spec como superada.

### 9.1.1 Adendo de 30/07 (noite) — revisão dos PRs da Onda B

Levantado ao revisar #440 (B1), #441 (B2) e #637 (B3), todos escritos em paralelo:

| # | O que apareceu | Onde ficou |
|---|---|---|
| 1 | **O contrato não fixava os envelopes de resposta.** O frontend inventou cinco, inclusive um `{ ok: boolean }` inexistente, e abreviou `product_count`/`sample_product_names` para `count`/`sample_names`. Reconciliado nos dois lados. | §10, nova |
| 2 | **`clone-from` não tinha guarda de tenant.** Sem ela, qualquer empresa clonaria a árvore de qualquer outra. Levantado pelo agente do B1 por conta própria, aceito. | §3.2, nova |
| 3 | O `GET /` e o `POST /` devolviam projeção incompleta de `Category` (sem `parent_id`, `slug`, `depth` e os metadados) — o cliente não conseguiria derivar hierarquia da lista flat. Corrigido no backend, envelope preservado. | §10 |
| 4 | O caminho do código de erro (`err.data.code`) foi verificado nos dois lados e **bate**. | §10.1 |

**Lição para as próximas fases: congelar objeto e lista de rotas não é congelar contrato.** Enquanto o envelope de resposta não estiver escrito, dois agentes paralelos vão inventar dois envelopes diferentes, e a conta só aparece na integração.

### 9.1.2 Adendo de 18/08/2026 — fechamento do Bloco 0 e escopo da Onda D

Quatro decisões do Caio, tomadas na revisão do repasse da F0:

| # | Decisão | Consequência |
|---|---|---|
| 1 | **Árvore da Davi confirmada: `Feminino`, `Masculino`, `Infantil`** no nível 0. Sem `Esportivo`. | `tests/fixtures/categoryTree.js` já refletia exatamente isso — a árvore sai de "proposta" para **confirmada**. O wizard da C2 permite renomear e criar raiz, então a decisão não trava o cliente. |
| 2 | **O módulo dental sai do caminho da taxonomia.** Ele espelhava `dental_category` em `products.category`; o espelho foi removido (`src/routes/dentalSupplies.js`). | O B2 não vê `anestesico`/`broca`/`rx` como categorias candidatas no staging. Recomendação adicional: filtrar `is_dental_supply IS NOT TRUE` no staging mesmo assim. Ver `LEGACY_CATEGORY_CONSUMERS.md` §2.2.1. |
| 3 | **`productsBatch.js` e `importData.js` entram no escopo declarado da Onda D.** | São pontos de escrita em `products.category` que o Bloco 0 não tinha mapeado. Importação que grava texto livre recria o problema que a F0 resolve. |
| 4 | **O Bloco 0 está fechado quanto a escritas.** | O gate para o merge do B1 está cumprido. Ver `LEGACY_CATEGORY_CONSUMERS.md` §2.2 e §4. |

### 9.2 Divergências conhecidas contra a SPEC_LOJA_F0_TAXONOMIA_v2.md

Onde divergir, **este documento vence**. Lista para quem ler a spec depois:

| Spec v2 diz | Contrato diz | Onde |
|---|---|---|
| §3.3 — "todo endpoint aceita `?type=`, default `product`" | Só o CRUD legado. Endpoints novos são product-only fixo. | §1 |
| §3.6 — erro `CATEGORY_TYPE_MISMATCH` na superfície de API | Fora da superfície. Inalcançável, mas mapeado defensivamente. | §6 |
| §4.3 — "cinco triggers", nomes `trg_category_path`, `trg_category_no_cycle` | Sete objetos, com os nomes da §8. | §8 |
| §4.6 — query de árvore com `LIKE ... ESCAPE '\'` | `left(d.path, length(p.path)+1) = p.path \|\| '/'`. | §7 |
| Bloco B3, aceite — "`type` é parâmetro do hook e do picker" | O picker e os hooks novos são product-only. Sem seletor de tipo. | §1, §2 |

---

## 10. Envelopes de resposta — fixados em 30/07, depois da Onda B

O congelamento de 28/07 definiu o **objeto** `Category` e a lista de rotas, mas **não o envelope de cada resposta**. O resultado foi previsível: o frontend construiu contra mock e inventou cinco envelopes que o backend não devolvia (inclusive um `{ ok: boolean }` que não existe em lugar nenhum). Foi reconciliado na revisão dos PRs #440/#441/#637; os shapes abaixo são os **implementados e verificados**, e valem para C1, C2 e D sem nova negociação.

| Endpoint | Envelope |
|---|---|
| `GET /product-categories/` | `{ categories: Category[], total, type }` — objeto `Category` **completo** (§2), inclusive `parent_id`, `slug`, `depth` |
| `GET /product-categories/tree` | `{ categories: Category[], type }` — aninhado por `children`, com `product_count_total` |
| `POST /product-categories/` | objeto `Category` completo |
| `PATCH /product-categories/:catId` | objeto `Category` completo + `affected_products` |
| `DELETE /product-categories/:catId` | `{ deleted: true, id, moved_products, type }` |
| `GET /products/unclassified` | `{ products: [{ id, name, sku, barcode, category, stock_qty, price, created_at }], total, limit, offset }` |
| `PUT /products/:productId/categories` | `{ product_id, primary_category_id, also_in }` |
| `POST /products/categories/bulk` | `{ updated, mode, primary_category_id }` |
| `GET /categories/migration/proposal` | `{ items: StagingRow[], orphan: StagingRow \| null }` |
| `GET /categories/migration/status` | `{ state, total, approved, applied, orphans }` |
| `GET /products/brand-candidates` | `{ candidates: [{ token, product_count }] }` |
| `POST /products/brand/apply` | `{ results: [{ token, brand, updated }] }` |

`StagingRow` = `{ id, raw_value, product_count, sample_product_names, kind, target_path, status, resolved_category_id, resolved_at, created_at, updated_at }` — os nomes são os **das colunas de `category_migration_staging`**. Não abreviar para `count` / `sample_names` no cliente.

### 10.1 Corpo de erro

O código de erro vai na **raiz** do JSON: `{ error: "<mensagem>", code: "CATEGORY_HAS_CHILDREN", ...extra }`, onde `extra` é `children_count`, `product_count`, `existing_id` ou a lista de candidatos, conforme a §6.

No `aura-app`, `services/api.ts` faz `throw new ApiError(data.error, res.status, data)` — **o corpo cru inteiro fica em `ApiError.data`**. Logo o cliente lê o código em **`err.data.code`**. Verificado nos dois lados em 30/07.

Ressalva: os `400` de validação simples do B2 (`kind` inválido, `assignments[]` ausente) devolvem só `{ error }`, sem `code`. O cliente cai no fallback `err.message`, o que é aceitável. Não padronizar isso agora.
