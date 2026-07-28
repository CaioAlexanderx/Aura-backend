# Consumidores de `products.category` — auditoria

**Bloco 0 da F0 (Loja Digital v2 — Taxonomia).** Pré-requisito do Bloco A.
**Data:** 2026-07-28 · **Referência:** `main` do aura-backend e do aura-app.

Este documento existe para uma coisa só: nenhuma depreciação de `products.category` é autorizada enquanto qualquer item desta lista apontar para ela. O trigger de dual-write da F0 (`trg_sync_legacy_category`) mantém a coluna coerente; esta auditoria diz **quem depende dessa coerência** e, mais importante, **quem escreve na coluna e por isso vai disputar a escrita com o trigger**.

---

## 0. Método e grau de confiança

O clone do aura-app é de `main` e está atualizado. O clone do aura-backend usado para o grep **não estava**: branch `feat/karate-dojo-keystone`, commit `d7b1f2d` de 09/07/2026, 19 dias atrás de `main`. Por isso a defasagem foi **medida arquivo a arquivo por blob SHA contra `main`, não presumida**, e todo arquivo divergente ou ausente foi lido direto da API do GitHub.

| Escopo | Cobertura | Como |
|---|---|---|
| aura-app, árvore inteira | 100% | Clone de `main` (`af68540`, 27/07/2026), grep completo. |
| aura-backend `src/routes` + `src/services` — 303 de 362 arquivos | 100% | Blob SHA idêntico ao clone local → o grep local é autoritativo. |
| aura-backend `src/routes` + `src/services` — 59 arquivos (31 só no remoto, 28 com SHA divergente) | 100% | Lidos integralmente pela API, um a um. Todos de karatê/dojô, billing, NFC-e e SEFAZ. **Nenhum toca `products.category`; 50 deles sequer tocam a tabela `products`.** |
| aura-backend `src/templates` (6 + 10 em `storefront/parts`) | 100% | Todos os 16 blob SHAs idênticos ao clone local. |
| aura-backend `src/utils` (16 arquivos) | 100% | 12 SHAs idênticos; os 4 restantes (`buildDanfeNfceHtml.js` divergente, `qrInline.js`, `autoPrintScript.js`, `secretCrypto.js` novos) lidos pela API — nenhum menciona `category`. |
| aura-backend `src/middleware`, `src/config`, `src/jobs`, `src/marketplaces`, `src/services/credit` | Varridos no clone local, zero ocorrências | **Não conferidos por SHA contra `main`.** É o único risco residual desta auditoria, e é baixo: são 19 arquivos de autenticação, configuração, cron e adaptadores de marketplace. |

Fora de escopo por decisão: `src/migrations` (histórico, não é consumidor) e a suíte de testes.

---

## 1. Backend — ESCRITORES (crítico)

Todo ponto abaixo escreve `products.category` diretamente. Com o trigger `trg_sync_legacy_category` ativo, essas escritas passam a competir com a escrita derivada do vínculo primário. **Cada um precisa de decisão explícita antes do merge do Bloco A.**

| Arquivo | Linha | O que faz | Conflito com o trigger |
|---|---|---|---|
| `src/routes/products.js` | 287–288 | `INSERT INTO products (... category ...)`, com default `'Produtos'` quando o corpo não manda nada. | **Sim.** Produto criado pelo cadastro nasce com texto e sem vínculo. O Bloco D substitui isso pelo picker; até lá, o produto entra em *A organizar*. |
| `src/routes/products.js` | 350 | `fieldMap` do PATCH inclui `category:'category'` → `UPDATE products SET category = $n`. | **Sim.** Escrita direta que o trigger não sabe reverter. Deve passar a gravar o vínculo, não o texto. |
| `src/routes/productsBatch.js` | 59, 118, 126, 133 | `INSERT` em lote com `category` normalizado (`'Produtos'` como default). | **Sim.** Importação em massa cria texto sem vínculo. |
| `src/routes/productsBatch.js` | 98, 102, 104 | Chave de deduplicação é `LOWER(name) \| category`. | **Indireto, e perigoso.** Se o texto mudar por efeito do trigger, o critério de duplicata muda junto. Revisar antes de ligar o dual-write. |
| `src/routes/importData.js` | 314, 418–420 | `INSERT INTO products (... category ...)` na importação de CSV/planilha. Mapeamento de coluna em `:56` aceita `categoria`, `category`, `grupo`, `tipo`. | **Sim.** Mesmo caso do lote. |
| `src/routes/dentalSupplies.js` | 143, 154 | `INSERT INTO products (... category, dental_category ...)` gravando **`category = dental_category`** por compatibilidade. | **Sim, e é o caso menos óbvio da lista.** A vertical Odonto escreve `products.category` a partir de um campo próprio. Se o trigger sobrescrever, o insumo odontológico perde a categoria clínica. Precisa de decisão: ou Odonto passa a usar a árvore com `type='service'`, ou fica explicitamente fora do dual-write. |
| `src/routes/dentalSupplies.js` | 238 | `UPDATE ... category = COALESCE($5, category)`. | **Sim.** Mesmo caso. |
| `src/routes/productCategories.js` | 135–143 | Cascade de rename: `UPDATE products SET category = <novo nome> WHERE category = <nome antigo>`. | **Sim — e é substituído.** O Bloco B1 remove esta lógica ao absorver a rota; o gatilho (d.3) do trigger passa a fazer o mesmo trabalho a partir do vínculo. Manter os dois é escrita dupla garantida. |
| `src/routes/productCategories.js` | 194–200 | `DELETE ?move_to=`: `UPDATE products SET category = <destino>`. | **Sim — e é substituído.** Mesma observação. |

**Nenhum outro ponto do backend escreve `products.category`.** Verificado por varredura de `INSERT INTO products` / `UPDATE products` em toda a árvore (39 ocorrências), cruzada com a presença da palavra `category` no arquivo.

---

## 2. Backend — LEITORES

Quebram se a coluna ficar incoerente ou for removida. Não conflitam com o trigger.

### 2.1 Produto, estoque e PDV

| Arquivo | Linha | Uso |
|---|---|---|
| `src/routes/products.js` | 147, 157 | Filtro da listagem: `?category=` → `AND category = $n`. **É o filtro que o Bloco D torna hierárquico.** |
| `src/routes/products.js` | 179, 205 | `SELECT ... category ...` e default `'Produtos'` na resposta. |
| `src/routes/pdv.js` | 112, 124 | Catálogo do PDV: seleciona e devolve `p.category`. |
| `src/routes/scanner.js` | 22, 47, 68 | Três queries de leitura por código de barras devolvem `p.category`. |
| `src/routes/barcode.js` | 119 | Leitura de produto por código devolve `p.category`. |
| `src/routes/productLinks.js` | 401 | Consolidação multi-CNPJ devolve `p.category`. |
| `src/routes/studioSaleItemPatch.js` | 72, 76, 92, 120, 124, 140 | Busca de item no PDV do Studio: `name ILIKE $n OR category ILIKE $n`, em duas queries. **Busca textual sobre a categoria** — o comportamento muda quando o texto virar nome de nó. |

### 2.2 Relatórios, ranking e margem

| Arquivo | Linha | Uso |
|---|---|---|
| `src/services/productsRanking.js` | 75, 88, 107, 193, 207 | Ranking de produtos. Filtra por `COALESCE(p.category,'Sem categoria')`, agrupa por categoria e **serve `GET /products/categories`** (rota definida em `productsRanking.js:99`). |
| `src/routes/productMargin.js` | 17, 33, 98 | Margem por produto — plano Expansão (`private.js:108`). Seleciona, agrupa e devolve `p.category`. |
| `src/services/salesAnalytics.js` | 158, 169 | Analítico de vendas: seleciona e agrupa por `p.category`. |
| `src/services/reportDataQueries.js` | 95, 105 | Query base do relatório: seleciona e agrupa por `p.category`. |
| `src/services/reportGenerator.js` | 166, 299, 300 | Monta o relatório. **Chave de agregação é `` `${p.name}|${p.category}` ``** e usa `'Geral'` como default. |
| `src/templates/weeklyReport.js` | 155 | Renderiza `${p.category}` no HTML do relatório semanal enviado por e-mail. |
| `src/routes/meAggregates.js` | 915, 926 | Agregados do `/me`: seleciona e agrupa por `p.category`. |

### 2.3 Loja pública e canais

| Arquivo | Linha | Uso |
|---|---|---|
| `src/services/storefrontBuilder.js` | 369 | Injeta `category` no payload de cada produto da vitrine. |
| `src/templates/storefront/parts/init.js` | 30 | **Monta a lista de filtros da loja a partir de `p.category`** — é a navegação por categoria do storefront hoje. |
| `src/templates/storefront/parts/products.js` | 14, 52 | Filtra a grade por `p.category === currentCat` e renderiza o rótulo. |
| `src/templates/storefront/parts/product_detail.js` | ~201 | Detalhe do produto na loja. |
| `src/routes/digitalChannel.js` | 265 | Canal digital devolve `category` no produto. |
| `src/routes/studioStorefront.js` | 318 | Vitrine do Studio devolve `p.category`. |
| `src/routes/importData.js` | 411 | Leitura de conferência pós-importação. |

### 2.4 Não consomem (verificado, para não reabrir)

`nfce.js`, `labels.js`, `print.js`, `smartAlerts.js`, `adminAuraNotas.js`, `billing.js`, `src/utils/buildDanfeNfceHtml.js`, `src/services/auraNotas/` e `src/services/sefazSp/` (14 arquivos) — **nenhum lê `products.category`**. Relevante porque etiquetas, impressão e NFC-e eram suspeitos naturais. As etiquetas leem `id, name, price, barcode, barcode_format, sku, color, size` e nada mais; a NFC-e trabalha com `ncm`, `tax_profile`, `csosn` e `cfop`, nunca com a categoria comercial.

---

## 3. Frontend (aura-app)

### 3.1 Clientes de API

| Arquivo | Linha | Uso |
|---|---|---|
| `services/companiesApi.ts` | 86, 89, 92, 95 | CRUD completo de `/product-categories`. **É o contrato que o Bloco B1 não pode quebrar** — a resposta esperada é `{ categories, total, type }`. |
| `services/companiesApi.ts` | 148 | `productsCategories()` → `GET /products/categories?period=`. Servida por `productsRanking.js`. |
| `services/companiesApi.ts` | 37, 46 | Filtro `?category=` na listagem de produtos. |
| `services/studioApi.ts` | 764, 768, 770, 772 | **Segundo cliente para as mesmas rotas** `/product-categories`. Duplicação existente: qualquer mudança de contrato precisa tocar os dois arquivos. |
| `hooks/useProductCategories.ts` | 9, 15, 29 | Hook React Query. `queryKey: ["product-categories", companyId, type]`. |
| `services/productsBatchApi.ts` | 15, 27 | `category` no payload do lote. |
| `services/productLinks.ts` | 88 | `category` no tipo de produto consolidado. |
| `services/meAggregates.ts` | 48, 100, 278 | `category` nos agregados. |

### 3.2 Escritores

| Arquivo | Linha | Uso |
|---|---|---|
| `components/screens/estoque/AddProductForm.tsx` | 127, 241, 247 | Cadastro de produto. Envia `category: finalCategory \|\| "Produtos"`. **Alvo direto do `CategoryTreePicker` no Bloco D.** |
| `components/screens/estoque/AddServiceForm.tsx` | 47, 64, 71 | Cadastro de serviço. Default `"Servicos"`. Confirma que a árvore precisa de `type='service'`. |
| `components/studio/StudioNewProductWizard.tsx` | 30–31, 107, 241–242, 256 | Wizard do Studio. **Documenta no próprio código a premissa que a F0 muda:** *"envia `category` (texto = nome) em vez de `category_id` (FK) — o campo category no produto é TEXT"*. |
| `components/QuickBatchProductsModal.tsx` | 78, 214–219, 258, 389 | Lote rápido. Aceita coluna `categoria`/`category`/`cat` e resolve override por seção. |
| `components/screens/estoque/DanfeImportModal.tsx` | 172, 203, 471–472 | Importação de DANFE. **Default hardcoded `"Calçados"`** na linha 172. |
| `components/ImportDanfeModal.tsx` | 216 | Variante antiga do mesmo fluxo; default `"Produtos"`. |
| `utils/csv.ts` | 84 | Template de importação de produtos declara a coluna "Categoria". |

### 3.3 Leitores e filtros

| Arquivo | Linha | Uso |
|---|---|---|
| `app/(tabs)/estoque.tsx` | 114, 185, 250, 338, 363, 388 | Tela de Estoque. Monta a lista de filtros a partir de `products.map(p => p.category)`, filtra por inclusão e **usa `p.category === "Servicos"` para contar serviços**. É a tela que ganha a aba Catálogo. |
| `hooks/useProducts.ts` | 40, 79–80, 89 | Deriva a lista de categorias de `products`, com default `"Produtos"`. |
| `hooks/usePdvState.ts` | 197, 200, 227 | Chips de categoria do PDV e filtro `p.category === cat`. |
| `utils/productSearch.ts` | 48, 78 | **Busca do PDV inclui `category` nos tokens** — mudar o texto muda o que o operador acha. |
| `app/studio/(estudio)/estoque.tsx` | 44, 86, 226, 261–262, 291, 562 | Estoque do Studio. O comentário da linha 44 declara: *"filtragem por `product.category === categoria.name` (texto)"*. |
| `components/studio/pdv/useStudioCatalog.ts` | 46, 79–95 | Catálogo do PDV do Studio; default `"Sem categoria"`. |
| `components/screens/estoque/ProductRow.tsx` | 23, 87 | Exibe e normaliza a categoria na linha do produto. |
| `components/screens/estoque/ProductTableWeb.tsx` | 148, 153 | Coluna de categoria na tabela web. |
| `components/screens/estoque/CategoriesModal.tsx` | 6, 29 | Modal de gestão de categorias — a UI que a aba Catálogo substitui. |
| `components/screens/estoque/CategoryDropdownWeb.tsx` | 11, 16 | Dropdown multi-seleção de categorias (recebe `string[]`). |
| `components/screens/pdv/ProductCard.tsx` | 39, 43 | **Escolhe o ícone por texto:** `category === "Servicos" ? "S" : "Combos" ? "C" : "Extras" ? "E" : "P"`. Acoplamento a valores literais. |
| `components/screens/canal/TabVitrine.tsx` | 451–452 | Vitrine do canal digital exibe a categoria. |
| `components/screens/estoque/types.ts` | 6 | `category: string` no tipo de produto. |
| `components/studio/storefront/types.ts` | 16, 21 | `category` e `category_name` no tipo da vitrine. |

---

## 4. Homônimos — NÃO são `products.category`

Registrados para que ninguém os inclua numa futura remoção da coluna.

| Domínio | Onde |
|---|---|
| `transactions.category` (lançamento financeiro) | `financeiroInsights.js:120–278`, `transactionSale.js:424`, `trocaV2.js:594,603`, `digitalOrderConfirmation.js:166`, `importData.js:595`, `print.js` (crediário), `smartAlerts.js` (expense spike), `adminClients360.js:117`, `karateAnnuityService.js` (`categoryForKind`), e todo o `components/screens/financeiro/*`, `stores/transactions.ts`, `utils/dreReport.ts` no app. |
| `products.dental_category` | `dentalSupplies.js:43,196` e `components/verticals/odonto/*`. Atenção: o mesmo arquivo **também** escreve `products.category` — ver §1. |
| `fiscal_obligations.category` | `aiContext.js:97,101`, `constants/obligations.ts`, `ObligationRow.tsx`. |
| `aura_consultations.category` | `adminOps.js:82–88`. |
| Categorias de karatê (`karate_competition_categories`) | Todo `routes/karate*`, `services/karate*`, `app/karate/*`, `components/karate/*`. |
| `food_categories` | `routes/food.js:122,137`, `hooks/useFoodMenu.ts`. |
| Categorias de galeria do Studio | `studioApi.ts:620–626`, `StudioTemplatesPanel.tsx`, `TemplateUploadWizard.tsx`. |
| Categorias de lead/CRM | `components/admin/crm/*`, `services/crmApi.ts`. |
| Categoria de arquivo em storage | `ProfileHero.tsx:45` (`category: "branding"`), `AddClinicalImageModal.tsx:111` (`'clinical'`). |

---

## 5. Conclusões que afetam a F0

1. **Nove pontos de escrita, em cinco arquivos de backend, disputam a coluna com o trigger.** Dois deles (`productCategories.js`) são removidos pelo próprio Bloco B1. Os outros sete precisam de decisão consciente. O mais delicado é `dentalSupplies.js`: a vertical Odonto usa `products.category` como espelho de `dental_category`, e o dual-write vai sobrescrever isso.

2. **O storefront público já navega por `products.category`.** `templates/storefront/parts/init.js:30` constrói a lista de filtros varrendo o texto dos produtos. Enquanto o trigger mantiver a coluna coerente, a loja continua funcionando sem alteração — que é exatamente o que a §7.4 da spec promete. O consumo da árvore é F3.

3. **Existem dois clientes de API para as mesmas rotas de categoria** no app: `services/companiesApi.ts` e `services/studioApi.ts`. O Bloco B1 preserva o shape `{ categories, total, type }`; qualquer mudança futura de contrato tem que tocar os dois.

4. **Colisão de path a corrigir no contrato.** `GET /products/categories` já existe e é servida por `productsRanking.js:99` (agregação por período, consumida em `companiesApi.ts:148`). O contrato da F0 previa `POST /products/categories/bulk` no mesmo prefixo. Não há conflito técnico — os verbos diferem — mas o path fica ambíguo. **Recomendação: mover a atribuição em lote para `POST /product-categories/assign-bulk`**, junto do resto da taxonomia, e deixar `/products/categories` como o endpoint de relatório que já é.

5. **Três acoplamentos a valores literais** que a migração pode quebrar sem erro visível: `estoque.tsx:388` (`p.category === "Servicos"` para contar serviços), `ProductCard.tsx:43` (ícone do PDV por `"Servicos"` / `"Combos"` / `"Extras"`) e `productsBatch.js:98–104` (chave de duplicata `nome|categoria`). Nenhum levanta exceção quando o texto muda — só passa a contar ou desenhar errado.

6. **A busca textual inclui a categoria** em `utils/productSearch.ts:78` (PDV) e em `studioSaleItemPatch.js:72,120` (`category ILIKE`). Renomear nós da árvore altera o que o operador encontra no PDV.

7. **Onde os routers são montados.** `src/routes/index.js` não monta produtos nem categorias — delega tudo sob `/companies/:id` para `src/routes/private.js`. Lá estão: `/product-categories` → `productCategories.js` (linha 41) e nove routers sob `/products` (linhas 30–40). É o arquivo que o Bloco B1 e o Bloco D precisam tocar para registrar rotas novas.

---

## 6. Condição para depreciar `products.category`

A coluna só pode sair quando os 9 escritores da §1 estiverem gravando vínculo em vez de texto, os 32 leitores das §2 e §3.3 estiverem lendo da árvore, e os 3 acoplamentos literais da §5.5 tiverem sido reescritos. **Não é escopo da F0.** A F0 entrega o dual-write que torna essa migração possível sem downtime.
