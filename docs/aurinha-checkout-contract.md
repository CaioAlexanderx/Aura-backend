# Contrato de checkout — Aurinha → Loja virtual

**Status:** vigente desde a migration 313 (30/08/2026). O lado da Aurinha já cumpre o contrato; a loja repaginada precisa implementar os itens marcados **[loja]**.

## O fluxo

1. Cliente demonstra intenção de compra na DM → a Aurinha chama a ferramenta `link_do_produto` e envia ao cliente um link da loja virtual.
2. O cliente abre o link, finaliza no checkout normal da loja (Pix com desconto cadastrado, cartão, retirada/entrega).
3. O pedido nasce **atribuído à conversa** — é a métrica de conversão do hub social (e a base de comissão/ROI do add-on).

## O link (gerado pela Aurinha — não mudar sem versão)

```
https://loja.getaura.com.br/{slug}?produto={productId}&variante={sku_suffix}&origem=aurinha&conversa={conversationId}
```

| Parâmetro | Obrigatório | Significado |
|---|---|---|
| `produto` | sim | UUID de `products.id` (validado contra a company antes de gerar) |
| `variante` | não | `sku_suffix` de `product_variants` escolhido na conversa (ex.: `M-vinho`) |
| `origem` | sim | Sempre `aurinha` neste fluxo. Outros canais podem usar outros valores (máx. 32 chars) |
| `conversa` | não | UUID de `hub_conversations.id` |

## O que a loja repaginada deve fazer **[loja]**

1. **Abrir o produto**: com `?produto=`, abrir a página/modal do produto direto (não a home). Com `variante`, pré-selecionar a variação. Parâmetro desconhecido/produto inexistente → degradar para a home, sem erro.
2. **Propagar a atribuição**: guardar `origem` e `conversa` (sessionStorage sobrevivendo à navegação do funil) e enviá-los no `POST /storefront/:slug/order` como:
   ```json
   { "origem": "aurinha", "hub_conversation_id": "<uuid>" }
   ```
3. **Nunca bloquear**: atribuição ausente ou inválida não impede o pedido (o backend valida e ignora silenciosamente o que for inválido).

## O que o backend já faz (pronto)

- `POST /storefront/:slug/order` aceita `origem` (≤32 chars) e `hub_conversation_id` (UUID) e grava em `digital_orders.origem` / `digital_orders.hub_conversation_id` (migration 313) — best-effort, fora da transação do pedido, guardado `42703`.
- A vitrine **atual** ignora os parâmetros sem erro (o link degrada para a home da loja) — o contrato pode ir ao ar antes da repaginação.

## Consulta de conversão (referência)

```sql
SELECT COUNT(*) AS pedidos, COALESCE(SUM(total),0) AS receita
  FROM digital_orders
 WHERE company_id = $1 AND origem = 'aurinha' AND created_at >= NOW() - interval '30 days';
```

## v2 (não implementado — decidir depois)

- Evento na conversa quando o pedido é criado/pago ("pedido #N criado" na thread, via `hub_conversation_id`).
- Aura Pay como meio de pagamento do checkout (quando existir) — não muda este contrato.
- Carrinho pré-montado multi-item (`?cart=<token>`) — só se a conversa pedir mais de um produto com frequência real no piloto.
