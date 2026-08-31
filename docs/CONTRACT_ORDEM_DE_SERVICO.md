# CONTRACT_ORDEM_DE_SERVICO — contrato do backend

**Backend:** migrations `313` + `314`, `src/routes/serviceOrders.js`, `src/utils/buildServiceOrderHtml.js` · **Data:** 31/08/2026

> Este documento diz **o que a API é**, pro trabalho do `aura-app` poder começar sem esperar o backend subir. O backend é mergeado antes do frontend (convenção do repo).

---

## 0. Decisão de escopo — a OS nasce **antes** da venda

Foi a decisão de produto de 31/08. A OS é o documento que **autoriza o serviço** e fica com o cliente enquanto o aparelho está na loja: ela existe desde a **entrada do equipamento**, quando ainda não há venda nenhuma, e só encosta numa venda ao ser **entregue**.

Consequências que o frontend precisa absorver:

| | |
|---|---|
| A OS **não** é criada a partir da tela de sucesso do PDV | ela já existe muito antes |
| `sale_id` é `null` na maior parte da vida da OS | isso é o estado normal, não dado faltando |
| A tela pós-venda **oferece vincular** uma OS pronta do cliente | `GET ?status=pronta&customer_id=…` |
| Uma venda pode fechar **várias** OS | o cliente deixou dois aparelhos e retira os dois juntos |

### Por que `status` não é deduzido de `sale_id`

Seria tentador ler "tem venda ⇒ entregue". Não serve — existem cinco situações distintas e uma coluna de dois valores não representa cinco:

- OS **entregue sem venda** (garantia, retrabalho, cortesia)
- OS **cancelada com venda** (o cliente pagou a análise e desistiu do conserto)
- OS **pronta** esperando o cliente aparecer

---

## 1. Toggle

`companies.pdv_settings.os_enabled` (boolean, default `false`), via `GET`/`PUT /companies/:id/pdv-settings`.

O gate vale **só na escrita**. `GET` da listagem e a impressão funcionam com o toggle desligado — senão uma loja que desativa o módulo perderia de vista os aparelhos que ainda estão no balcão dela. Mesmo raciocínio da armadilha #3 do `CLAUDE.md`.

Escrita com o toggle desligado responde **403** com `code: "OS_DISABLED"`.

---

## 2. Máquina de status

```
aberta ──► em_execucao ──► pronta ──► entregue
   │            │            │  ▲
   │            │            │  └── retrabalho: pronta ──► em_execucao
   └────────────┴────────────┴──► cancelada
```

`entregue` e `cancelada` são terminais.

`pronta → em_execucao` existe porque retrabalho existe: o técnico marca pronta, o cliente testa no balcão e o defeito continua lá. Sem essa aresta a loja teria que cancelar e abrir OS nova, perdendo o histórico do aparelho — que é justamente o que importa num retrabalho. A volta limpa `delivered_at`.

Transição inválida responde **409** com `code: "TRANSICAO_INVALIDA"` e a lista `permitidas`.

---

## 3. Endpoints

Todos sob `/api/v1/companies/:id`.

| Método | Rota | Observação |
|---|---|---|
| `GET` | `/service-orders` | filtros: `status`, `customer_id`, `q`, `days` (≤730), `limit` (≤500) |
| `POST` | `/service-orders` | abre em `aberta`; exige `customer_id` e `reported_issue` |
| `GET` | `/service-orders/:osId` | `{ order, items }` |
| `PATCH` | `/service-orders/:osId` | campos do equipamento, diagnóstico, técnico, prazo, garantia |
| `PUT` | `/service-orders/:osId/items` | substitui a lista e recalcula `estimated_amount` |
| `POST` | `/service-orders/:osId/approve` | cliente aprovou o orçamento; idempotente |
| `POST` | `/service-orders/:osId/status` | transição; `entregue` aceita `sale_id` e `pickup_signature_url` |
| `DELETE` | `/service-orders/:osId` | só `aberta` e sem venda |
| `GET` | `/print/os/:osId` | HTML A4; `?autoprint=1` abre o diálogo |

`q` busca por nome do cliente, marca, modelo, número de série **e número da OS** — que é como o cliente se identifica quando esqueceu o papel.

### Erros com `code` (o front deve tratar)

| `code` | HTTP | Quando |
|---|---|---|
| `OS_DISABLED` | 403 | toggle desligado, em escrita |
| `TRANSICAO_INVALIDA` | 409 | transição fora da máquina |
| `ORCAMENTO_APROVADO` | 409 | tentou editar itens depois do aceite do cliente |
| `OS_FECHADA` | 409 | editar OS entregue ou cancelada |
| `OS_NAO_EXCLUIVEL` | 409 | excluir OS que já saiu de `aberta` |

---

## 4. Regras que o backend impõe (não reimplementar no front, só refletir na UI)

1. **Orçamento aprovado é um acordo, não rascunho.** Depois de `approve`, `PUT /items` responde 409. Mudar o valor exige reabrir a aprovação — senão a loja troca o preço por baixo de um "sim" que já foi dado.
2. **Itens da OS são documento, não movimento de estoque.** Quem baixa estoque é a venda, no fluxo do `pdv.js`. `product_id` no item é só rastreabilidade de qual peça foi orçada. Se a OS também baixasse, a peça sairia duas vezes.
3. **`entregue` não exige `sale_id`.** Ver §0.
4. **Cliente, técnico e venda são checados contra a empresa.** As FKs só olham o `id`; sem o `SELECT` de escopo a OS nasceria apontando pra fora do tenant.
5. **OS que saiu de `aberta` não se apaga, cancela.** É o histórico do que aconteceu com um bem de terceiro.

---

## 5. O documento A4

`GET /print/os/:osId` devolve HTML pronto pra `window.print()`.

- **Logo e cor do lojista no topo.** Fonte: `digital_channel_config` (logo, `primary_color`) com fallback em `companies.logo_url`; sem nenhum dos dois, iniciais do nome. Cor inválida cai num neutro — o valor não é interpolado cru no CSS.
- **Aura só no rodapé**, uma linha. Há teste travando isso.
- **Duas assinaturas**: entrega e retirada. Se já houver `signature_url`, sai a imagem; senão sai a linha pra assinar no balcão. O mesmo documento serve nos dois momentos.
- **Garantia sai como data**, não como "90 dias" — o cliente guarda o papel por meses.
- **Datas em `America/Sao_Paulo` explícito.** Railway roda em UTC; sem o fuso o documento diria que o aparelho entrou 3h depois do que entrou.
- **A largura não diverge entre tela e print.** Foi essa divergência que escondeu o corte da DANFE térmica (PR #634) por meses.

Assinaturas são PNG no R2 (`intake_signature_url`, `pickup_signature_url`) — mesmo padrão de `dental_consents`. **A captura em si é do frontend**; o backend só guarda a URL e carimba o horário.

---

## 6. O que ainda não existe (fora deste PR)

- Tela de abertura/edição da OS no `aura-app`
- Captura de assinatura (canvas → R2)
- Botão "vincular OS" na tela pós-venda do PDV
- Relatório de prazo (OS estouradas), se for pedido
