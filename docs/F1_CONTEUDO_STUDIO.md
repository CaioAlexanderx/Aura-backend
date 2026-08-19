# F1_CONTEUDO_STUDIO — quadro de execução da Loja Digital do Studio

**Fase:** F1 — Página de produto personalizável · **Piloto:** Sheid Mania (`sheid-mania`), categoria Canecas · **Atualizado:** 18/08/2026

> Este documento diz **o que falta fazer e em que ordem** na vitrine do Studio.
> A F0 (`F0_EXECUCAO.md`) entrega a taxonomia que esta fase consome; onde os dois divergirem, a F0 vence sobre forma de categoria e este quadro vence sobre a página.

---

## 0. Como retomar esta fase

1. **§1 (o alvo) e §2 (o que já existe)** — mais da metade da página já está construída. Ler §2 antes de escrever código evita reimplementar motor visual, upload e serviço de arte.
2. **§3 (o que está quebrado)** — há um bug **em loja publicada** que impede compra hoje. É o primeiro item, não um detalhe.
3. **§4 (registro de itens)** e o briefing do item que você vai tocar na §5.
4. **§6 (decisões em aberto)** — três escolhas do lojista que travam desenho, não código.

Namespace herdado da F0 (`F0_EXECUCAO.md` §1): item de execução = letra + número (aqui a família **`S`**); decisão = `DEC-nn`, numeração **contínua com a F0** (última fechada: `DEC-08`).

---

## 1. O alvo

Uma página por **categoria da F0**, não por SKU. As 9 canecas da Sheid viram **uma** página com seletor de modelo — o padrão de UI da Shopee, com acabamento melhor.

Composição da página:

| Região | Conteúdo |
|---|---|
| Esquerda | Carrossel de fotos do produto **+ o mockup 3D** como um item do carrossel, habilitado quando o cliente personaliza |
| Direita, topo | Mini-carrossel **Modelo** (= produtos da categoria) e mini-carrossel **Cor** |
| Direita, meio | Preço que **muda** com modelo/personalização; quantidade com desconto progressivo visível |
| Direita, baixo | Frete por CEP |
| Abaixo | Descrição + tamanho da área de impressão |

Conteúdo textual é deliberadamente curto: descrição e tamanho da imagem. O peso está em design, animação e qualidade de hover/botão.

**Para quem é esse cuidado:** o cliente final se beneficia, mas quem compra a Aura é a **lojista**. A vitrine é a demonstração do produto — ela se vende sozinha quando é bonita. Isso é critério de aceite, não preferência estética.

---

## 2. O que já existe (não reimplementar)

Auditado em 18/08/2026 no código e na base de produção.

| Peça | Onde | Estado |
|---|---|---|
| Agrupamento por categoria | F0 · `product_category_links` + payload público (D3) | Pronto no backend |
| Seletor de cor com `price_delta` | `fields/FieldColor.tsx` — lê `config.colors` + `config.choices[].price_delta` | Motor pronto, **sem dados** (§3.2) |
| Preço variável por escolha | `computeChoicesDelta` no storefront | Pronto |
| Desconto progressivo | `studio_pricing_rules.qty_tiers` | Motor pronto, **0 regras na Sheid** |
| Mockup 3D | `visualEngine/compose3dMug.ts` + `Mug3DPreview.tsx`, template global `caneca-classica` (`model3d`, published) | Pronto e **verificado ponta a ponta** (§2.1) |
| Upload da arte do cliente | `fields/FieldImage.tsx` | Pronto |
| **Lojista cria a arte, com preço** | `fields/FieldArtService.tsx` — `art_service` = `none` \| `designer`, `price_delta` na choice, mais briefing em `art_service_brief` | **Pronto**, sem dados |
| Política de revisão | `pdv_settings` (jsonb): `max_revisions_included`, `extra_revision_price`, `revision_policy_text` | Pronto |

### 2.1 Teste do template 3D — resultado

Vinculei `caneca-classica` à *CANECA BRANCA* em produção, consultei o endpoint público e **reverti para `NULL`** logo depois. A base voltou ao estado original.

`GET /storefront/sheid-mania/studio/products/:pid/visual-template` devolveu o template completo. **O caminho lojista → template → vitrine funciona.** O que o teste revelou sobre o motor:

- A geometria é **procedural e fixa no código**, não no `spec`: `CylinderGeometry(1, 0.94, 2.3)` mais alça `TorusGeometry(0.52, 0.11)`. O `spec` só carrega áreas UV e tamanho da textura.
- **Portanto um template não é um modelo.** `caneca-classica` representa bem as canecas de parede reta (Branca, Alça Colorida, Cromada, Vintage). Renderiza **errado** a Chopp (maior, cônica), e apaga justamente o argumento de venda da *Alça Coração* e da *Com Colher* — a alça e a colher são o produto.
- A cor da louça (`garmentColor`) é opção de runtime com default `#F5F2EA`, e **`LivePreview` não a passa**. Hoje toda caneca renderiza bege, independentemente da cor escolhida.

---

## 3. O que está quebrado

### 3.1 Bloqueio de compra em loja publicada — prioridade máxima

`sheid-mania` está **publicada**, com 13 produtos personalizáveis na vitrine. Toda caneca tem os 4 campos marcados `required: true` ao mesmo tempo: *Texto*, *Foto do cliente*, *Escolher template da galeria* e *Cor*.

`useStorefront.ts:281` (`commitConfigure`) exige todos os obrigatórios antes de adicionar ao carrinho. Ou seja: **o cliente precisa digitar um texto E enviar uma foto E escolher um template da galeria para conseguir comprar.** São caminhos alternativos tratados como cumulativos — na prática, ninguém fecha o pedido.

### 3.2 A configuração das canecas é boilerplate, não configuração

Os campos têm id `f_<timestamp>` gerados em sequência de milissegundos — foram semeados em lote. Todo `config` está vazio (`{}`). Consequências: sem swatches (`FieldColor` cai no fallback branco/preto), sem `price_delta` em lugar nenhum, sem `is_art_service`, sem `max_chars` além do texto.

O motor descrito na §2 está inteiro; **falta dado**. Isso é trabalho de conteúdo com a lojista, não de engenharia — e é o gargalo real do piloto.

### 3.3 Área de impressão: três fontes que discordam

| Fonte | Valor |
|---|---|
| `spec.areas[panel].width_cm` | 20 cm |
| `spec.areas[panel].uv` (0,36→0,64 de 21 cm) | ≈ 5,9 cm |
| `products.customization_config.print_area` | 9 × 9 cm |

O `wrap` é coerente (0,02→0,98 ≈ 21 cm, declarado 21). Só o `panel` diverge. Como a página precisa exibir "tamanho da imagem" como conteúdo, é preciso eleger **uma** fonte antes de escrever o texto.

### 3.4 Sem frete no Studio

`studioStorefront.js` não tem nenhuma referência a frete; `storefront.js` (loja comum) tem. É lacuna confirmada e vital.

### 3.5 Triagem da arte não existe no sentido necessário

Hoje o fluxo de aprovação é **lojista → cliente** (`/aprovacao/:token`: a lojista manda o render, o cliente aprova ou pede ajuste). O sentido inverso — a lojista avaliar a arte que o cliente enviou — não existe.

E ele **não é um portão de qualidade**: ajustar a arte do cliente para caber no produto e adequar às cores de impressão é rotina, acontece na maioria dos pedidos. A pergunta da lojista não é "aprovo ou rejeito", é "ajusto por conta ou cobro por isso". Consequência de desenho: a triagem **não bloqueia** o pedido; ela escolhe entre caminhos que já estão precificados.

### 3.6 Risco registrado — three.js por CDN

`threeLoader.ts` injeta `three.min.js` do cdnjs em runtime, por decisão consciente (evitar regenerar o lockfile). Numa vitrine pública isso é dependência externa no caminho crítico do mockup. Não bloqueia a F1; registrar para revisitar quando o lockfile puder ser regenerado.

---

## 4. Registro de itens

Lado: **BE** = `aura-backend`, **APP** = `aura-app`, **DADO** = conteúdo com a lojista.

| Item | O quê | Lado | Depende de |
|---|---|---|---|
| S0 | Destravar a compra: campos alternativos deixam de ser cumulativos | APP | — |
| S1 | Página única por categoria, com seletor de modelo | APP | F0 D3 |
| S2 | Frete por CEP no storefront do Studio | BE | — |
| S3 | Mockup 3D no carrossel mais cor da louça ligada ao seletor | APP | S1 |
| S4 | Três caminhos de arte, todos com preço antes do fechamento | APP | `DEC-09` |
| S5 | Triagem da arte do cliente pela lojista (não bloqueante) | BE + APP | `DEC-11` |
| S6 | Desconto progressivo visível na página | APP | dados de `qty_tiers` |
| S7 | Conteúdo do piloto: árvore, swatches, deltas, textos | DADO | S0 |

---

## 5. Briefings

### S0 — Destravar a compra (APP)
*Texto*, *Foto* e *Template da galeria* são **alternativas** de personalização; hoje são exigidos juntos. Introduzir a noção de grupo de alternativas na validação de `commitConfigure` (ao menos um preenchido), ou reclassificar os campos no dado. A decisão entre código e dado é parte do item — a validação por grupo é mais robusta, porque protege qualquer lojista futura do mesmo erro de configuração.

### S1 — Página por categoria (APP)
Uma rota por categoria da F0. O seletor de Modelo lista os produtos da categoria; trocar de modelo troca preço, fotos, `print_area` e template visual. Produto sem categoria mantém a página individual de hoje — a F1 não pode depender de a taxonomia estar 100% preenchida.

### S2 — Frete no Studio (BE)
Portar de `storefront.js`. Verificar antes se o cálculo de lá assume peso/dimensão que o produto personalizável não preenche.

### S3 — Mockup no carrossel (APP)
O mockup entra como **item do carrossel de fotos**, não como painel separado — é o pedido explícito e é também o pico da demonstração para a lojista. Passar `garmentColor` do valor do campo de cor até `Mug3DPreview` (hoje o parâmetro existe e ninguém o alimenta). Ver `DEC-10` sobre quantos templates serão necessários.

### S4 — Três caminhos de arte (APP)
Não são dois: (a) cliente envia arte pronta; (b) cliente envia e a lojista ajusta — cobrado; (c) a lojista cria do zero — cobrado mais caro. Os três precisam aparecer no preço **antes** do fechamento; hoje a lojista absorve (b) silenciosamente. O motor de (c) já existe em `FieldArtService`; falta (b) e falta o dado dos dois.

### S5 — Triagem (BE + APP)
Fila da arte recebida com três saídas: aceitar como está, ajustar (aplica o preço de (b) e notifica), ou devolver para novo envio. Não bloqueia o pedido (§3.5). Reaproveitar o link público de aprovação já existente para comunicar o resultado.

### S6 — Desconto progressivo (APP)
`qty_tiers` já existe e está vazio na Sheid. Exibir a escada de preço na própria página — é argumento de venda para atacado e some se ficar escondido no carrinho.

### S7 — Conteúdo do piloto (DADO)
Árvore de categoria da Sheid (hoje: 36 produtos em "Produtos", 36 sem categoria, 0 links), swatches reais por modelo, `price_delta`, `qty_tiers`, preço de arte, descrição e tamanho de impressão. É o item de maior prazo e o que menos depende de código.

---

## 6. Decisões em aberto

| Código | Pergunta | Por que trava |
|---|---|---|
| `DEC-09` | Preço de criação de arte é **por empresa** ou **por produto**? | Criar arte de caneca e de camiseta não dá o mesmo trabalho. Por empresa segue o padrão de `pdv_settings`/`FieldArtService`; por produto exige `studio_pricing_rules` (que já tem `setup_fee` e `labor_cost` sem uso). Define S4. |
| `DEC-10` | Um template 3D genérico ou um por família de caneca? | A geometria é fixa no código (§2.1). Um só template renderiza errado Chopp, Alça Coração e Com Colher. Alternativa: manter foto 2D nesses e 3D só nas de parede reta. Define S3. |
| `DEC-11` | A triagem **atrasa** o pedido ou corre em paralelo? | Se atrasa, precisa de estado de pedido "aguardando arte" e de prazo. Se corre em paralelo, o pedido segue e o ajuste vira item de trabalho. Define S5. |

---

## 7. Pendências fora do escopo, registradas para não sumirem

- `threeLoader.ts` carrega three.js por CDN (§3.6).
- Sheid tem 0 `studio_pricing_rules` e 0 `product_category_links` — a base do piloto é greenfield nos dois eixos.
- 36 dos 74 produtos ativos da Sheid estão na categoria genérica "Produtos", que não é taxonomia.
