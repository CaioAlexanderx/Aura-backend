# Check-in do prospect

Três perguntas em chip depois da escolha da frente e antes do Painel. Código:
`src/services/checkin.js` (regras), `src/routes/checkin.js` (GET/PUT),
`src/services/painelBlocos/checkin.js` (leitura da Cassie). Migration 384.

## Contrato com o app

- `GET /api/v1/companies/:id/checkin` → `{ habilitado, respondido, pulou, versao: 1, respostas | null }`
- `PUT /api/v1/companies/:id/checkin` com `{ comeco?, onde_anota?, produtos_faixa?, pulou? }`
  (texto de até 40 caracteres, sem enum) → `{ checkin }`.
  - `{ pulou: false }` sozinho não grava nada e não fecha a tela (200 com o json atual).
  - O servidor carimba `versao` e `respondido_em` na primeira resposta ou em `pulou: true`.

## Quem vê a tela (`habilitado`)

1. `CHECKIN_ENABLED` ligado (padrão ligado);
2. empresa criada a partir de `CHECKIN_DESDE`;
3. sem `respondido_em` nem `pulou`;
4. não é staff em modo admin;
5. **multi-CNPJ**: só a primeira (mais antiga) empresa do dono é cadastro novo.
   Filial (`billing_owner_company_id` de outra empresa, ou dono que já tinha
   empresa mais antiga) e a federação do Karatê (sede e dojôs,
   `federation_id` preenchido) ficam de fora, tanto da tela quanto do bloco do
   painel. Fonte única: `sqlForaDoCheckin()`.

## Ligar em produção

- **`CHECKIN_DESDE` é a data em que a TELA do app sobe** (aura-app#1068), não a do
  backend. Se o backend subir antes e a variável ficar no padrão, cadastros do
  intervalo entram na conta ("cadastros desde a subida") sem terem visto a tela.
  Defina a variável com o dia em que o app foi ao ar.
- **`exibido_em` é gravado em qualquer `GET` com `habilitado: true`** (e o evento
  `checkin.exibido` registrado uma vez). O app só deve chamar o `GET` no ponto em
  que a tela de fato aparece (depois da escolha da frente); chamá-lo em outro
  lugar marca a tela como exibida sem o cliente tê-la visto.
- Desligar: `CHECKIN_ENABLED=false` (restart da Railway). A regra de parada do
  bloco só avisa; quem desliga é o Caio. Limiar: `CHECKIN_LIMIAR_PRODUTO_24H`
  (0.57 padrão; 0.4 proposta da Cassie).
