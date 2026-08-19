# F1_CONTEUDO_STUDIO — quadro de execução da Loja Digital do Studio

**Fase:** F1 — Página de produto personalizável · **Piloto:** Sheid Mania (`sheid-mania`), categoria Canecas · **Atualizado:** 18/08/2026

> Este documento diz **o que falta fazer e em que ordem** na vitrine do Studio.
> A F0 (`F0_EXECUCAO.md`) entrega a taxonomia que esta fase consome; onde os dois divergirem, a F0 vence sobre forma de categoria e este quadro vence sobre a página.

---

## 0. Como retomar esta fase

1. **§1 (o alvo) e §2 (o que já existe)** — mais da metade da página já está construída. Ler §2 antes de escrever código evita reimplementar motor visual, upload e serviço de arte.
2. **§3 (o que está quebrado)** — há um bug **em loja publicada** que impede compra hoje. É o primeiro item, não um detalhe.
3. **§4 (registro de itens)** e o briefing do item que você vai tocar na §5.
4. **§6 (decisões fechadas)** — as três respostas do lojista e o que cada uma custa. A `DEC-10` em particular aumenta o S3; leia antes de dimensioná-lo.

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
| Desconto progressivo | `studio_pricing_rules.qty_tiers` | **Só o armazenamento existia** — ver §3.7. Entregue no S6 |
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

### 3.1 Bloqueio de compra em loja publicada — resolvido pelo S0

**Corrigido em 18/08/2026** (`Aura-backend#521` e `aura-app#707`). Fica registrado porque explica a forma da validação de hoje.

`sheid-mania` está publicada, com 13 produtos personalizáveis na vitrine. Toda caneca tem os 4 campos marcados `required: true` ao mesmo tempo: *Texto*, *Foto do cliente*, *Escolher template da galeria* e *Cor*. A validação exigia cada campo required isoladamente, dos dois lados — então o cliente precisava digitar um texto **e** enviar uma foto **e** escolher um template para fechar o pedido. Como `image` e `template` preenchem o mesmo slot de arte, era condição que ninguém satisfaz.

A correção foi em código, não no dado da Sheid: o painel de personalização oferece o checkbox *Obrigatório* por campo sem impedir a combinação impossível, então consertar só as linhas da loja deixaria a armadilha para a próxima lojista. `image` e `template` do mesmo lado passaram a formar um **grupo de origem da arte** — basta um preenchido —, e `art_service = 'designer'` satisfaz o grupo inteiro.

Dois efeitos colaterais registrados: o backend também passou a pular campos do verso quando o verso está inativo (divergência que dava 400 no fechamento de item aceito no carrinho), e a validação do app virou a função pura `validateRequiredFields`, exportada, para poder ser testada contra os mesmos casos do servidor.

**A causa raiz continua aberta**, fora do escopo da F1: há dois editores de personalização gravando formatos diferentes (§7).

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

### 3.7 O desconto progressivo nunca chegou à loja — corrigido pelo S6

Registro de um erro meu neste documento: a §2 dizia "motor pronto" para o desconto por quantidade. Não era verdade.

`qty_tiers` existia desde o configurador de preço do lojista, mas **o único código que lia o campo** era o simulador de custo em `studioPricing.js` — que calcula preço sugerido a partir de custo, mão de obra e margem. É outra conta, e não podia ser reusada na vitrine justamente por misturar dado que não pode ir para o público.

Na prática: a lojista configurava a escada, e nem a página exibia, nem o pedido aplicava. O S6 fechou os dois lados, com a faixa incidindo sobre o **preço de venda** e nenhum campo de custo atravessando para o payload.

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
| S4 | Três caminhos de arte, todos com preço antes do fechamento | APP | — (`DEC-09` fechada) |
| S5 | Triagem da arte do cliente pela lojista (não bloqueante) | BE + APP | — (`DEC-11` fechada) |
| S6 | Desconto progressivo: escada no payload e faixa aplicada no pedido | BE + APP | — |
| S7 | Conteúdo do piloto: árvore, swatches, deltas, textos | DADO | S0 |
| S8 | Retirada por app de entrega (Uber, 99) com nome e placa | BE + APP | S2 |

---

## 5. Briefings

### S0 — Destravar a compra (APP)
*Texto*, *Foto* e *Template da galeria* são **alternativas** de personalização; hoje são exigidos juntos. Introduzir a noção de grupo de alternativas na validação de `commitConfigure` (ao menos um preenchido), ou reclassificar os campos no dado. A decisão entre código e dado é parte do item — a validação por grupo é mais robusta, porque protege qualquer lojista futura do mesmo erro de configuração.

### S1 — Página por categoria (APP)
Uma rota por categoria da F0. O seletor de Modelo lista os produtos da categoria; trocar de modelo troca preço, fotos, `print_area` e template visual. Produto sem categoria mantém a página individual de hoje — a F1 não pode depender de a taxonomia estar 100% preenchida.

### S2 — Frete no Studio (BE)
Portar de `storefront.js`. Verificar antes se o cálculo de lá assume peso/dimensão que o produto personalizável não preenche.

### S3 — Mockup no carrossel (APP)
O mockup entra como **item do carrossel de fotos**, não como painel separado — é o pedido explícito e é também o pico da demonstração para a lojista. Passar `garmentColor` do valor do campo de cor até `Mug3DPreview` (hoje o parâmetro existe e ninguém o alimenta).

Por `DEC-10`, cada modelo tem seu template — o que exige, **antes** de cadastrar qualquer um, mover a geometria do código para o `spec`. Ver a §6 para os três passos; é o que faz do S3 o item mais caro da fase.

### S4 — Três caminhos de arte (APP)
Não são dois: (a) cliente envia arte pronta; (b) cliente envia e a lojista ajusta — cobrado; (c) a lojista cria do zero — cobrado mais caro. Os três precisam aparecer no preço **antes** do fechamento; hoje a lojista absorve (b) silenciosamente. O motor de (c) já existe em `FieldArtService`; falta (b) e falta o dado dos dois.

### S5 — Triagem (BE + APP)
Fila da arte recebida com três saídas: aceitar como está, ajustar, ou devolver para novo envio. **Não bloqueia o pedido** (§3.5, `DEC-11`): é metadado do item, sem estado novo de pedido e sem prazo suspenso.

Backend entregue (migration 289): `art_review_status` no item, fila e decisão em `/companies/:id/studio/art-review`. Só entra na fila quem mandou arte **própria** — quem contratou a criação fica fora, porque ali quem produz é a lojista e o fluxo lojista → cliente já cobre.

Falta o app: a tela da fila. E fica registrado o que **não** foi feito: avisar o cliente de que a arte voltou continua manual, pelo WhatsApp que a loja já coleta. Um fluxo de reenvio pelo cliente é item próprio, não meio-caminho escondido aqui.

### S6 — Desconto progressivo (BE + APP)
Era o item que eu tinha dado como quase pronto e que se revelou o mais fundo depois do S0 — ver §3.7. O backend está entregue: escada no payload público (`qty_tiers` por produto, só preço e percentual) e faixa aplicada no fechamento, relida do banco e nunca aceita do cliente.

Falta o app: exibir a escada na página, que é argumento de venda para atacado e some se ficar escondido no carrinho.

Duas regras que valem além do S6: faixa mal cadastrada **nunca encarece** (multiplicador acima de 1 é ignorado), e com faixas sobrepostas vence a de maior `min_qty` — quem compra mais não paga mais.

### S8 — Retirada por app de entrega (BE + APP)

Terceiro `delivery_type`, ao lado de `pickup` e `delivery`: o **cliente** contrata o entregador e informa quem vai buscar. A loja não cobra frete — quem paga o app é o cliente — e não precisa de endereço.

Os dois campos são do **entregador**, não do cliente, e é isso que dá o item sua razão de ser: sem nome e placa, a lojista entrega a personalização de alguém para o primeiro motoboy que citar o número do pedido. Numa loja que imprime arte sob encomenda, o pacote trocado não tem segunda via.

Backend entregue: `courier_pickup_enabled` no config (default `false`), `courier_name`/`courier_plate` no pedido, validação compartilhada em `services/courierPickup.js` e as três modalidades expostas no payload público dos **dois** storefronts. Falta o consumo no app — o chip da modalidade e os dois campos no checkout —, que vai junto com o S1.

### S7 — Conteúdo do piloto (DADO)
Árvore de categoria da Sheid (hoje: 36 produtos em "Produtos", 36 sem categoria, 0 links), swatches reais por modelo, `price_delta`, `qty_tiers`, preço de arte, descrição e tamanho de impressão. É o item de maior prazo e o que menos depende de código.

---

## 6. Decisões fechadas

As três foram respondidas em 18/08/2026. Nenhuma decisão da F1 segue aberta.

### `DEC-09` — preço de criação de arte é **por produto**

Criar arte de caneca e de camiseta não dá o mesmo trabalho, então o preço acompanha o produto.

**Já está implementado.** `art_service` vive em `products.customization_config`, que é coluna do produto — o editor grava `art_service_price` por produto. A frase da versão anterior desta seção, que agrupava `FieldArtService` com `pdv_settings` como se fosse configuração por empresa, estava errada: `pdv_settings` guarda só a política de **revisão**, não o preço de criação.

Consequência para S4: nada de storage novo. O caminho (b) — cliente envia e a lojista ajusta — entra como mais uma choice no mesmo campo, com seu próprio `price_delta`. `studio_pricing_rules` não é necessário aqui.

### `DEC-10` — um template 3D **por modelo de caneca**

Cada modelo tem o seu. Chopp, Alça Coração e Com Colher deixam de ser representadas por uma caneca genérica.

**Isso aumenta o S3, e vale dizer por quê.** Não é semear 9 linhas em `studio_visual_templates`: a geometria hoje está **fixa no código** (`compose3dMug.ts`, `CylinderGeometry(1, 0.94, 2.3)` mais alça `TorusGeometry(0.52, 0.11)`), e o `spec` não tem onde carregar forma. Para haver template por modelo é preciso, antes:

1. estender o `spec` com parâmetros de geometria (diâmetro, altura, conicidade, forma e posição da alça, presença de colher);
2. fazer `createMugViewer` ler esses parâmetros em vez das constantes;
3. só então cadastrar um template por modelo.

O passo 1 muda o `schema` do `spec` (hoje `schema: 1`) e precisa manter `caneca-classica` funcionando — os campos novos entram opcionais, com os valores atuais como default.

### `DEC-11` — a triagem é **parte do processo**, não um portão

Corre junto com o pedido. Não existe estado "aguardando arte" nem prazo suspenso: o pedido segue e o ajuste da arte é uma etapa de trabalho como qualquer outra.

Consequência para S5: nenhum estado novo de pedido, nenhuma mudança no prazo. A fila de triagem é uma visão sobre pedidos que já existem, com as três saídas da §5 (aceitar, ajustar cobrando, devolver).

---

## 7. Pendências fora do escopo, registradas para não sumirem

- **Dois editores de personalização gravam o mesmo `customization_config` em formatos diferentes.** `produtos/[id]/personalizacao.tsx` gera ids estáveis (`text`, `image`, `template`, `art_service`) com `required: false` e config rico; `StudioPersonalizacaoPanel.tsx` gera ids voláteis `f_<timestamp>`, config vazio e checkbox *Obrigatório* livre. Foi o segundo que produziu a config da Sheid (§3.2). Importa além do S0: o motor visual lê os valores por **nome** de campo, então config com id volátil não alimenta o mockup. Tarefa registrada em separado.
- `threeLoader.ts` carrega three.js por CDN (§3.6).
- Sheid tem 0 `studio_pricing_rules` e 0 `product_category_links` — a base do piloto é greenfield nos dois eixos.
- 36 dos 74 produtos ativos da Sheid estão na categoria genérica "Produtos", que não é taxonomia.
