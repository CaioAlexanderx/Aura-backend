# Indicação: concessão do mês do indicador (script manual)

Cartão t2-19, fallback do t2-17. Regras da Célia (13/10/2026) e decisão do Caio
(opção C: excluir a cobrança do mês do indicador na Asaas). Enquanto a automação
não existe, a concessão é feita **à mão, por este script**, e nunca no painel da
Asaas.

## Antes do primeiro uso real

1. A migration `385_indicacao_concessoes.sql` precisa estar aplicada (o deploy aplica).
2. **Testar no sandbox da Asaas** antes de qualquer cobrança real:
   `ASAAS_URL=https://sandbox.asaas.com/api/v3` e a chave do sandbox em `ASAAS_API_KEY`,
   com um banco que não seja o de produção. Conferir o que acontece com a assinatura
   depois de excluir a segunda cobrança (t2-17) e se a primeira cobrança nunca é tocada.
3. Quem roda precisa de `SUPABASE_DB_URL` e `ASAAS_API_KEY` no ambiente.
   Nenhuma chave vai para arquivo.

## As regras que o script aplica

| Regra | Como |
|---|---|
| Indicado pagou | primeira cobrança do plano com `PAYMENT_RECEIVED` em `webhook_logs` (CONFIRMED não conta; estornada ou contestada não conta; pedido do Canal Digital e pacote de mensagens não contam) |
| Indicador em dia | nenhum `PAYMENT_OVERDUE` sem RECEIVED/CONFIRMED/DELETED posterior há mais de 3 dias em `webhook_logs` **e** nenhuma cobrança `OVERDUE` na Asaas vencida há mais de 3 dias |
| Qual cobrança | a próxima cobrança **futura e pendente** da assinatura do indicador; nunca a primeira dele (indicador em trial: o mês grátis sai na segunda) |
| Valor | a cobrança inteira, com acesso extra |
| Teto mensal | R$ 230 somando as concessões `padrao` vivas do mês (`--teto-mensal 400` quando o caixa passar de R$ 1.500) |
| Teto anual | 3 concessões `padrao` por indicador por ano (`--max-por-ano`) |
| Fila | pela data do pagamento do indicado; quando uma não cabe no mês, ela e as de trás esperam o mês seguinte (sem perder a vez). Cobrança maior que o teto sozinha fica para decisão manual e não trava a fila |
| Antifraude | indicador e indicado com CNPJ, e-mail e telefone diferentes e donos diferentes |
| Indicador em trial | a indicação espera a assinatura por 60 dias contados do pagamento do indicado; depois vence |
| Uma por indicado | uma concessão viva por indicação e por indicado (inclusive combinada) |
| Uma por execução | o mesmo indicador recebe no máximo uma por execução (as duas cairiam na mesma cobrança) |

## Uso

```bash
# 1. Ver a fila (DRY-RUN, padrão: não grava nada, não exclui nada)
node scripts/indicacao-concessao.js

# 2. Conceder as prontas, uma a uma
node scripts/indicacao-concessao.js --apply --operador "Célia"
```

Com `--apply`, para cada indicação pronta o script mostra indicador, indicado, cobrança,
vencimento e valor e pede para **digitar o valor**. Qualquer outra resposta pula aquela.
Só funciona em terminal interativo (não aceita confirmação por pipe).

Ordem de cada concessão:

1. lê a cobrança na Asaas de novo (pendente, futura, do indicador, mesmo valor);
2. **grava** a linha em `indicacao_concessoes` com status `registrada`, dentro de uma
   transação com trava, revalidando teto e unicidade;
3. só então **exclui** a cobrança na Asaas;
4. marca a linha como `aplicada` (ou `falhou`, se a Asaas recusou; a cobrança continua lá).

Se a linha ficar `registrada` (queda no meio), o relatório a mostra "em conferência":
conferir no painel da Asaas se a cobrança foi excluída e corrigir a linha à mão.

Depois de cada concessão o script imprime o aviso para mandar à Célia no mesmo dia.

### Estorno (exclusão errada)

```bash
node scripts/indicacao-concessao.js --estornar <id-da-concessao>            # mostra o que faria
node scripts/indicacao-concessao.js --estornar <id-da-concessao> --apply    # faz
node scripts/indicacao-concessao.js --estornar <id> --apply --vencimento 2026-11-20  # se o vencimento já passou
```

Cria uma cobrança avulsa de mesmo valor e vencimento para o mesmo cliente, grava o
`pay_...` novo em `estorno_pay_id` e a concessão sai do teto do mês (status `estornada`).
A linha é marcada `estornando` antes da chamada à Asaas.

### Concessão combinada (antes de 15/10)

```bash
node scripts/indicacao-concessao.js --combinada \
  --indicador <company_id> --indicado <company_id> --cobranca pay_... \
  --observacao "Fernanda com o Valen, combinado antes de 15/10" --apply
```

Mesmo caminho (grava antes, exclui depois), tipo `combinada`, **fora do teto mensal e
anual** (conforme o cartão; a confirmar com a Célia). Um benefício por indicado.
A extensão de 30 dias (Jenny com o Luis) não é exclusão de cobrança e **não** é feita
por este script: aguarda a Célia dizer como registrar.

## Relatório semanal (somente leitura)

```bash
node scripts/indicacao-relatorio.js                   # últimos 7 dias
node scripts/indicacao-relatorio.js --desde 2026-10-01
node scripts/indicacao-relatorio.js --json
```

1. concessões do período (linha "desconto de indicação" do DRE);
2. **`PAYMENT_DELETED` sem concessão**: cobrança excluída na Asaas sem linha no livro;
3. concessões em conferência (`registrada`/`estornando`);
4. indicações pendentes e valor potencial (estimado pela última cobrança paga do indicador);
5. teto do mês: usado e restante.

Não escreve no banco e não chama a Asaas.

## Tabela `indicacao_concessoes`

| status | significado | ocupa o teto |
|---|---|---|
| `registrada` | gravada, exclusão não confirmada | sim |
| `aplicada` | cobrança excluída na Asaas | sim |
| `falhou` | a Asaas recusou a exclusão | não |
| `estornando` | estorno em curso | sim |
| `estornada` | cobrança refeita (`estorno_pay_id`) | não |

Unicidade: uma concessão viva por cobrança (`asaas_payment_id`), por indicação e por indicado.
