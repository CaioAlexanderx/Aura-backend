# CONTRACT_CATEGORIES — contrato congelado

**Fase:** F0 — Loja Digital v2 · **Congelado em:** 28/07/2026 · **Origem:** SPEC_LOJA_F0_TAXONOMIA v2, seção 3

> Este contrato é a fonte da verdade para a paralelização. Os agentes de frontend (B3, C1, C2) constroem contra ele com mock; os de backend (B1, B2) implementam contra ele. **Mudança depois do congelamento exige aviso ao orquestrador e re-sync dos dois lados no mesmo dia.**

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
4. **Nenhum endpoint da F0 expõe seleção de `type`.** Ver §1.

---

## 1. Convenção de rota

O repo monta tudo sob `/api/v1/companies/:id/...` com `Router({ mergeParams: true })` e leitura via **`req.params.id`** — não `:companyId`. Confirmado em `src/app.js` e em `src/routes/productCategories.js`.

O router de categorias **mantém o path `/product-categories`**, que o aura-app já chama hoje. Não criar `/categories` em paralelo.

### Tratamento de `?type=`

| Endpoint | Comportamento |
|---|---|
| `GET /` (rota legada preservada) | **Continua aceitando `?type=product\|service`**, com o mesmo comportamento de hoje. É retrocompatibilidade pura — o aura-app já chama assim e não pode quebrar. |
| Todos os endpoints **novos** da F0 | Operam sempre em `type = 'product'`, fixo. Não aceitam o parâmetro. Se vier, ignorar em silêncio. |
| `POST /` | Cria sempre com `type = 'product'`. Se o body trouxer `type: 'service'`, responder `422 CATEGORY_SERVICE_OUT_OF_SCOPE`. |

**Sem gate de plano.** Categoria é infraestrutura de estoque, não feature de loja. Não entra em `MODULE_PLAN_MAP` nem em `module_overrides`.

---

## 2. Objeto Category

```jsonc
{
  "id": "uuid",
  "company_id": "uuid",
  "type": "product",                   // sempre 'product' na F0 — ver §0
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
  "product_count": 34,                 // direto, não inclui descendentes
  "product_count_total": 87,           // calculado na query de árvore
  "children": []                       // presente apenas em GET .../tree
}
```

O campo `type` **continua no payload** por retrocompatibilidade, sempre com `"product"`. O frontend não deve construir seletor de tipo.

### Nota de implementação — `product_count`

A coluna `product_count` é **desnormalizada**, mantida pelo trigger `trg_category_count` (migration 259), e conta **links**.

A rota legada calculava `product_count` ao vivo, com `products.category = c.name` filtrado por `unit`. São semânticas diferentes. Enquanto a migração dos dados não roda, `product_count` fica em 0 para as 55 categorias existentes. **B1 deve decidir e documentar** se o `GET /` continua devolvendo a contagem calculada ao vivo (compat total) ou passa a ler a coluna. A recomendação é manter o cálculo ao vivo no `GET /` até a migração rodar, e usar a coluna só no `GET /tree`.

---

## 3. Endpoints — categorias

Base: `/api/v1/companies/:id/product-categories`

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Lista flat com `path`. Aceita `?depth=`, `?parent_id=`, `?q=`, e `?type=` **apenas por retrocompat**. **Mantém o shape atual** `{ categories, total, type }`. |
| GET | `/tree` | Árvore aninhada, com `product_count_total`. Product-only. |
| POST | `/` | Body: `{ name, parent_id?, color?, sort_order? }`. `type` forçado a `'product'`. |
| PATCH | `/:catId` | Renomeia / edita metadados. `path` e `slug` são recalculados **pelo trigger**, não pela rota. |
| DELETE | `/:catId` | Só se não tiver filhos nem produtos. Mantém `?move_to=` do comportamento legado. |
| POST | `/:catId/move` | Body: `{ parent_id, sort_order }`. Valida ciclo e profundidade. |
| POST | `/merge` | Body: `{ source_ids: [], target_id }`. |
| POST | `/reorder` | Body: `{ parent_id, ordered_ids: [] }`. |
| POST | `/clone-from` | Body: `{ source_company_id }`. Copia árvore vazia de outra unidade. |

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
- `merge` → move links com `DO NOTHING` e **reafirma a primária em statement separado**.

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
| `409 CATEGORY_HAS_CHILDREN` | Delete com filhos. Payload inclui `children_count`. | rota |
| `409 CATEGORY_HAS_PRODUCTS` | Delete com produtos e sem `move_to`. Payload inclui `product_count`. | rota |
| `409 CATEGORY_DUPLICATE` | Nome repetido sob o mesmo pai. Payload inclui `existing_id`. | `unique_violation` (23505) no índice `product_categories_unique_sibling` |
| `422 CATEGORY_MAX_DEPTH` | Tentativa de criar 4º nível. | `check_violation` em `product_categories_depth_max` |
| `422 CATEGORY_CYCLE` | Mover categoria para dentro do próprio descendente. | `RAISE EXCEPTION` no trigger `trg_category_cycle_check` |
| `422 CATEGORY_SERVICE_OUT_OF_SCOPE` | `POST /` com `type: 'service'`. | rota (§1) |
| `403 CATEGORY_CROSS_TENANT` | Categoria e produto de empresas diferentes. | `RAISE EXCEPTION` no trigger `trg_link_tenant_guard` |

Dois desses erros chegam à rota como `raise_exception` (SQLSTATE `P0001`) com a string no `err.message`. B1 mapeia por comparação de mensagem, não por código.

`CATEGORY_TYPE_MISMATCH` **saiu da superfície de API** — o trigger que o levanta continua no schema como guarda latente, mas nenhum caminho da F0 consegue dispará-lo, porque tudo é `'product'`.

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

A v2 corrigia o `LIKE` da v1 com `ESCAPE`. Aqui foi trocado por `left()` + comparação, que é a mesma solução usada no trigger `category_path_cascade` — sem curinga, sem escape, uma regra só.
