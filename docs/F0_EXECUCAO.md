# F0_EXECUCAO — quadro de execução da Loja Digital

**Fase:** F0 — Taxonomia de catálogo · **Piloto:** Davi Calçados · **Atualizado:** 18/08/2026

> Este documento diz **o que falta fazer e em que ordem**.
> `CONTRACT_CATEGORIES.md` diz **o que a API é** — onde os dois divergirem, o contrato vence sobre forma de API e este quadro vence sobre sequência.

---

## 0. Como retomar esta fase

Se você está pegando a F0 do zero (agente novo, ou eu depois de semanas em outra frente), leia **nesta ordem** e pare quando tiver o suficiente:

1. **Esta seção e a §2** — o que é cada item, de que depende e de que lado vive.
   Para saber o que já **entrou**, use o git (§2.1) — este arquivo não guarda estado.
2. **`CONTRACT_CATEGORIES.md`** — forma da API. A §10 (envelopes) e a §9.1 (decisões `DEC-nn`) são as que mais economizam retrabalho.
3. **`LEGACY_CATEGORY_CONSUMERS.md`** — quem escreve e quem lê `products.category`. Escritas estão fechadas (§2.2); leituras seguem protegidas pelo dual-write.
4. **`tests/fixtures/categoryTree.js`** — a árvore confirmada da Davi, usada por B1 e B2.
5. O briefing do item que você vai tocar, na **§3** deste arquivo.

**Não** leia a `SPEC_LOJA_F0_TAXONOMIA_v2.md` como fonte da verdade: ela é anterior ao congelamento e diverge em cinco pontos já mapeados (contrato §9.2).

---

## 1. Regra de código — namespace

Duas famílias de código, **que nunca se cruzam**:

| Família | Formato | Exemplo | O que é |
|---|---|---|---|
| **Item de execução** | onda + número | `B1`, `C2`, `D3` | Uma unidade de trabalho entregável num PR |
| **Decisão** | `DEC-` + número | `DEC-03` | Uma escolha fechada, com efeito no contrato |

Até 18/08 as decisões usavam `A1`/`B1`/`C1` e colidiam de frente com os itens: `B1` era ao mesmo tempo "agente da API de árvore" e "decisão do `move_to`", `C1` era "tela Organizar catálogo" e "decisão do `?type=`". Renumeradas em 18/08 — de-para no contrato §9.1.

**Ao criar item ou decisão novos, continue a numeração; não recicle código de item concluído.**

---

## 2. Registro de itens

Lado: **BE** = `aura-backend`, **APP** = `aura-app`.

| Item | O quê | Lado | Depende de |
|---|---|---|---|
| Bloco 0 | Auditoria de consumidores de `products.category` | BE | — |
| Bloco A | Schema: árvore, links, triggers, staging, `brand` (migrations 257–261) | BE | Bloco 0 |
| B1 | API de árvore + absorção do CRUD legado | BE | Bloco A |
| B2 | API de migração de categorias + extração de marca | BE | Bloco A |
| B3 | `CategoryTreePicker` + hooks de categoria | APP | contrato |
| C1 | Tela *Organizar catálogo* | APP | B1, B3 |
| C2 | Wizard de migração de categorias | APP | B2, B3 |
| D1 | Cadastro de produto usa o picker no lugar do campo de texto | APP | C1 |
| D2 | Filtro hierárquico em estoque e PDV | APP | C1 |
| D3 | Árvore no payload público do storefront | BE | B1 |
| D4 | `productsBatch` e `importData` escrevem links, não texto | BE | B1, DEC-06, DEC-08 |
| E1 | Cobertura do catálogo por categoria (placar do lojista) | BE | B1 |
| E2 | Auditoria de leituras de `products.category` | BE | D1–D4 |
| P1 | Wiring da geração de descrição por IA | APP | E1 · **estacionado, ver §4** |

### 2.1 Onde está o estado — e por que não está aqui

**Este arquivo não tem coluna de status, de propósito.**

A primeira versão tinha, e o custo apareceu no primeiro par de PRs paralelos: D3 e D4 tocaram arquivos disjuntos de código e **mesmo assim conflitaram**, porque os dois marcaram o próprio item como concluído na mesma tabela. Com duas frentes em paralelo — que é justamente o desenho da fase — isso se repetiria a cada par de PRs.

Estado vive no git. Este arquivo guarda o que o git **não** tem: dependência, lado, briefing, ordem e as decisões de desenho.

```bash
gh pr list --state merged --search "f0 in:title" --limit 20
```

Para um item específico, o assunto do commit carrega o código (`D3 --`, `D4 --`), então `git log --oneline --grep="D4 --"` responde direto.

**Um item só é "livre" quando tudo em `Depende de` já entrou.** É a tabela acima mais o git — não uma terceira lista para alguém manter.

### O que mudou em 18/08

**A Onda D foi quebrada em quatro itens** porque metade dela é backend. Enquanto D era um bloco único "de frontend", ela ficava atrás de C inteira; separada, **D3 e D4 não dependem do app** e correm em paralelo com C. Foi o congelamento restrito ao wiring da IA que deixou isso visível.

**A Onda E ganhou metade adiantada.** O `GET /products/descriptions/coverage` do PR #511 já devolve total, com/sem descrição, com/sem foto e percentuais para a empresa. O que falta em E1 é quebrar por categoria e ligar ao limiar de publicação.

---

## 3. Briefings

Cada briefing é autocontido: dá para abrir um PR só com ele e o contrato.

### C1 — Tela *Organizar catálogo* (APP)

**Objetivo.** O lojista vê a árvore de 3 níveis e a reorganiza sem abrir chamado.

**Escopo.** Árvore navegável (`GET /product-categories/tree`); criar, renomear, mover (`/move`), mesclar (`/merge`), reordenar (`/reorder`), excluir com destino (`DELETE ?move_to=`); contagem de produtos visível por nó.

**Contrato.** Envelopes na §10; `product_count` na §2 (`GET /` ao vivo, `/tree` pela coluna); erros na §6, lidos em `err.data.code`.

**Aceite.** Excluir categoria com produtos e sem `move_to` mostra o `409 CATEGORY_HAS_PRODUCTS` com a contagem, não um erro genérico. Mover para além do nível 2 é barrado na UI **e** o `P0001` do trigger é tratado. Nó pai mostra a contagem da subárvore, senão o pai parece vazio.

**Armadilhas.** Não construa contra mock inventado — foi o que custou caro na Onda B (§9.1.1). Sem seletor de tipo: os endpoints novos são product-only (`DEC-03`).

### C2 — Wizard de migração (APP)

**Objetivo.** Converter o texto livre de `products.category` na árvore, com o lojista decidindo o de-para.

**Escopo.** Ler o staging do B2, sugerir de-para, permitir corrigir, aplicar em lote, mostrar o resultado. Sem IA — decisão de escopo do Bloco A.

**Contrato.** Endpoints de migração e marca na §5; semântica do `bulk` na §5.

**Aceite.** Rodar duas vezes não duplica vínculo. Produto sem correspondência fica visível, não some. O lojista consegue criar categoria nova no meio do fluxo (é o que torna `DEC-04` reversível — a árvore da Davi é padrão, não jaula).

**Armadilha.** Filtrar `is_dental_supply IS NOT TRUE` no staging mesmo com o espelho dental removido (`DEC-05`) — protege contra base antiga.

### D3 — Árvore no payload público (BE)

**Objetivo.** A vitrine pública passa a enxergar a árvore, preparando a navegação por categoria da fase seguinte.

**Escopo.** `src/services/storefrontBuilder.js` e a rota `/storefront/:slug` passam a expor a árvore e o vínculo do produto.

**Regra inegociável.** **Adicionar, nunca remover.** O campo `category` (texto) continua no payload pelo mesmo princípio do dual-write: consumidor externo que lê o payload hoje não pode quebrar. Depreciação só quando a lista de leitores estiver vazia.

**Aceite.** Payload atual continua byte-compatível para quem ignora os campos novos. Slug de categoria sai no payload — é a semente das URLs canônicas da fase de vitrine.

**Entregue assim.** O payload ganhou `categories[]` (lista flat com `parent_id`, mesmo formato do `GET /product-categories`) e, por produto, `category_id` / `category_slug` / `category_path`. O campo `category` (texto) **permanece**. Só entram categorias com `is_visible_storefront` — a árvore interna do lojista não é necessariamente a navegação que ele quer pública. Produto sem vínculo devolve `null`, nunca deriva categoria do texto legado.

> ⚠️ **Medido em 18/08, e é o que dá o tamanho do que falta:** `product_category_links` está **vazia na base inteira** — zero vínculos. As 55 categorias do backfill do Bloco A estão em 3 empresas, **todas em `depth = 0`** (lista flat, não árvore), e a Davi Calçados não tem nenhuma. Ou seja: **D3 está correto e não mostra nada ainda.** A taxonomia só ganha corpo quando C2 (wizard) rodar para o piloto. Isso não é bug do D3 — é a fila real da fase.

### D4 — `productsBatch` e `importData` (BE)

**Objetivo.** Fechar os dois pontos de escrita em `products.category` que o Bloco 0 mapeou tarde (`DEC-06`).

**Escopo.** Importação de planilha e criação em lote passam a gravar vínculo em `product_category_links`; o texto legado continua populado **pelo trigger**, não pela rota.

**Aceite.** Importar planilha com categoria nova cria categoria na árvore (ou deixa explicitamente pendente para o wizard) em vez de gravar texto solto. Nenhuma rota escreve `products.category` diretamente — o dual-write da migration 259 é a única fonte.

**Armadilha.** `productsBatch` monta colunas dinamicamente; verificar todo caminho que inclui `category`.

**Resolvido assim (DEC-08).** Categoria que existe na árvore vira vínculo primário e `products.category` passa a ser escrito pelo trigger. Categoria que **não** existe — ou cujo nome é **ambíguo**, existindo em dois ramos — fica **pendente em `category_migration_staging`**, com o texto mantido no produto.

Manter o texto não é concessão: o wizard casa produto com valor por `products.category = raw_value`. Zerar o texto do que não resolveu perderia esses produtos de vista para sempre. "Pendente" significa **na fila do wizard**, não texto apagado. As duas rotas devolvem `categorias: { vinculados, pendentes, ambiguos }` na resposta — pendência que não aparece vira silêncio.

### E1 — Placar de cobertura por categoria (BE)

**Objetivo.** Transformar o índice de saúde em ferramenta de gestão do lojista, não em relatório técnico.

**Escopo.** Estender `GET /products/descriptions/coverage` (PR #511) com quebra por categoria de nível 0 e 1, e expor o limiar de publicação.

**Por que importa.** É o que torna a fase de conteúdo acionável: "Feminino: 12/80 com foto" é meta; "10,3% de cobertura" é lamento. Medido em 18/08: a Davi tem 10,3% de foto e 0% de descrição.

**Aceite.** Cobertura por nó da árvore, herdando a subárvore. Continua liberado de plano — leitura (contrato: nunca bloquear GET por plano).

---

## 4. Estacionamento

Itens **desacoplados da onda de propósito**, para revisitar no fim do projeto. Não são débito esquecido: têm critério de retomada escrito.

### P1 — Wiring da geração de descrição por IA (APP)

**Decisão de 18/08 (Caio):** o backend fica conectado e utilizável por rota; a interface entra **no fim do projeto**.

**O que já existe e está de pé** (PR #511): `product_description_drafts` (migration 287, aplicada), serviço de geração empacotado 20 por request, e as cinco rotas de gerar / listar / aprovar / rejeitar / medir cobertura. Nada disso depende do app para funcionar — dá para operar por chamada direta.

**O que falta.** Tela de revisão em lote: lista de rascunhos, aprovar/rejeitar, e o gatilho de geração.

**Critério de retomada.** Quando a fase de conteúdo entrar de fato — a revisão é o gargalo real (≈4h de trabalho humano para os 1.487 produtos da Davi), então a tela só rende junto com o resto do fluxo de produção de conteúdo.

**O que NÃO fazer enquanto está estacionado.** Não ligar geração automática em cadastro de produto: sem tela de revisão, texto gerado entraria no catálogo sem ninguém ver — exatamente o que o desenho de rascunho existe para impedir.

---

## 5. Ordem recomendada

Ordem por dependência, não por calendário — cruze com o git (§2.1) para saber onde a fase está.

**Duas frentes paralelas, assim que B estiver dentro:**
- **BE:** D3 e D4 — independentes entre si e do app.
- **APP:** C1 e C2 — arquivos disjuntos, o mesmo padrão que funcionou na Onda B.

**Depois de C1:** D1 e D2 (sequenciais entre si — os dois tocam `estoque.tsx`, que é o maior risco de regressão da fase).

**Fechando:** E1, depois E2.

**Fim do projeto:** P1.

### Regra de branch

**Saia sempre do `main` do momento, não de um `main` de ontem.** D3 saiu de um `main` anterior ao merge do D4 e conflitou por bookkeeping mesmo com código disjunto. Com duas frentes paralelas o `main` anda entre abrir e mergear um PR — rebasear na hora de abrir é mais barato que resolver na hora de fechar.

---

## 6. Pendências fora do escopo da F0, registradas para não sumirem

| # | O quê | Onde |
|---|---|---|
| 1 | `ai_enabled` / `ai_consent_at` / `ai_monthly_quota` existem em `companies` e **nenhum caminho do repo os checa** — inclusive `aiChat`. Ou valem para toda a superfície de IA, ou são schema morto. | PR #511 |
| 2 | `products.unit` é unidade de medida sobrecarregada como discriminador de tipo, com comparação sensível a caixa (`= 'srv'`). Dívida pré-existente. | `LEGACY_CATEGORY_CONSUMERS.md` §3.3 |
| 3 | Facetas (marca, cor, tamanho, faixa de preço) são o que torna a árvore de 3 níveis suficiente. `products.brand` nasceu na 261; `color` e `size` já existem. | fase de navegação |
| 4 | Os briefings originais (`BRIEFING_B1/B2/B3`, `PROMPT_ORQUESTRADOR_F0.md`) nunca foram versionados. Este arquivo passa a ser o lugar deles. | — |
