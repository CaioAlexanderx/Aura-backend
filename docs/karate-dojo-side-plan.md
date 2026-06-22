# Aura Karatê — Plano do lado Dojô (in-app · off-app · manual)

> Plano de arquitetura e execução para as trocas dojô↔federação. Pensado para execução incremental (Cowork). Escrito em 16/06/2026; prod do backend = `main`.

## 0. Contexto / estado da vertical

A vertical Aura Karatê (federação FPKT + dojôs) está muito construída (31 tabelas `karate_*`, ~40 rotas, ~25 telas) e foi **destravada em prod** pelo PR #214 (fix `companies.name/slug` + alinhamento `vertical`/`vertical_active` + atalho admin `PATCH /admin/clients/:cid/karate`) e pelo PR app #268 (federationId vem do JWT). Conta da FPKT criada e login validado.

Este doc cobre o **lado dojô**: como um dojô troca informação com a federação dentro (e fora) do app.

## 1. Os três canais

Cada troca pode acontecer por um de três canais, conforme o dojô:

| Canal | Quem | Auth | UI |
|---|---|---|---|
| **A — In-app (Aura Dojô)** | Dojô que usa o Aura Dojô (company `karate_dojo` no mesmo backend) | JWT (membro da company do dojô) | Shell do sensei no app (`app/karate/sensei/*`) |
| **B — Off-app (web)** | Dojô **sem** Aura Dojô, mas self-service | **Dojo Portal Token** (OTP/magic-link do responsável) | Páginas públicas web por federação (`/karate/:slug/dojo/*`) |
| **C — Manual** | Dojô sem Aura e sem self-service | — | Federação opera no lado admin (`app/karate/(federation)/*`), já existe |

Princípio: **A e B servem as MESMAS regras de negócio dojô-escopadas**; muda só o **adaptador de autenticação** que resolve `req.dojoId`. C é o fallback que já existe (zero trabalho novo).

## 2. Arquitetura

### 2.1 Mesmo-backend, escopo por RBAC
O dojô (com ou sem Aura) é uma company `karate_dojo` com `federation_id` apontando à federação-mãe, **na mesma base** da federação. Não há sistema externo. Toda query dojô filtra por `dojo_id` **no servidor** (nunca confiar em `dojo_id` do cliente).

### 2.2 Adaptador de auth duplo → `req.dojoId`
Os endpoints dojô-escopados aceitam DUAS formas de identidade, ambas resolvendo `req.dojoId` (+ `federation_id` da mãe):

- **Canal A (JWT):** novo guard `requireDojoOfFederation` — aceita usuário owner/membro ativo de um `karate_dojo` cujo `federation_id = :id`; injeta `req.dojoId`. Hoje **não existe** (todo `/federation/:id/*` resolve papel na company da federação → dojô toma 403). `resolveKarateContext` já calcula `federation_id` do pai; falta propagar `dojo_id`.
- **Canal B (Dojo Portal Token):** OTP/magic-link enviado ao contato do dojô (registrado pela federação). Espelha o `karatePortalAuthService` existente (que hoje é só do **praticante**, escopo `practitioner_id`+`federation_id`) — criar a variante **dojô** (escopo `dojo_id`+`federation_id`). Middleware `requireDojoPortalToken`.

Ambos os middlewares terminam setando `req.dojoId` + `req.federationId`; daí pra frente o handler é o mesmo.

### 2.3 Onde moram as páginas off-app (Canal B)
Reusar a superfície pública que já existe no **app** (Expo web, servido em app.getaura.com.br): rotas públicas sob `app/karate/[slug]/*` (já há `inscricao`, `ranking`, portal do praticante). Criar o segmento **`app/karate/[slug]/dojo/*`** (login leve por OTP), reaproveitando `karatePublic.js` + o padrão do portal. **Não** construir no `aura-site` (vanilla/marketing). _(Decisão a confirmar.)_

### 2.4 Track F (motor de sync) = FORA DE ESCOPO
O webhook `POST /webhooks/karate-sync` + `sync_token` + fila `karate_sync_events` + `applyEvent` foram desenhados para dojô com **sistema externo separado** empurrando dados. No modelo atual (Aura Dojô é interno, mesma base; não-Aura usa off-app/manual) **isso não é usado**. Não construir em cima; candidato a parquear/deprecar. A "conexão" do Aura Dojô é um **vínculo interno** (não um handshake de sync com token).

### 2.5 Pagamentos
Reusar `karatePaymentProvider` (PIX/Asaas) + componente `PixQRCode` (já usado no portal). Recebedor = subconta Asaas da federação. O `POST /federation/:id/financial/payments/:intentId/confirm` é o primitivo de confirmação (idempotente) — ponto de hook para ativação de filiação.

## 3. As 6 trocas × canais (o que existe / falta)

> Veredito por canal. "✅ existe / 🟡 parcial / ❌ falta". C (manual) já existe para tudo via telas da federação.

### Troca 1 — Inscrição em eventos (exames/cursos/competições)
- Backend hoje: inscrição pública por slug `POST /public/karate/:slug/inscricao/:eventId` (anônima, 1 CPF, **competição=501**); autenticada só `staffWrite`.
- A (in-app): ❌ falta `POST /federation/:id/dojo/events/:eventId/enroll` (lote, valida alunos do `dojo_id`, gera cobrança).
- B (off-app): 🟡 base pública existe; falta versão **dojô-escopada** (responsável inscreve a relação do dojô) + resolver competição.
- Falta comum: resolver inscrição de **competição** (hoje 501).

### Troca 2 — Envio de candidatos a exame de faixa → certificado
- Backend hoje: lançar **resultado** existe (`examResults` = banca/examinador) e **deve continuar na federação** (dojô não auto-gradua). Trigger 158 grava faixa (não cria certificado).
- A/B: ❌ falta `POST /federation/:id/dojo/belt-exams/:examId/candidates` (dojô **submete candidatos**, não notas), escopado a `dojo_id`.

### Troca 3 — Status dos certificados
- Backend hoje: `karate_certificate_orders` com estados `requested→in_production→printed→shipped`(+`refused`); endpoints **já com `dojoScope`/`/mine`** (`getOrdersByDojo`). Mas `dojo_id` nunca é populado e o gate barra o dojô.
- A/B: 🟡 **quase pronto** — só falta o keystone (popular `dojo_id`) e, no app, corrigir bugs (`res.data`→`res.orders`; federationId do contexto) + tirar `MOCK_APTOS`. **Melhor piloto.**

### Troca 4 — Anuidade de filiação (ver status + pagar PIX)
- Backend hoje: lado federação completo (charge, PIX/Asaas, status, NFSe) mas **tudo `adminOnly`**.
- A/B: ❌ falta `GET /federation/:id/dojo/annuity` + `POST /dojo/annuity/pix` (status + PIX dinâmico) escopado a `dojo_id`. App `anuidade.tsx` hoje 100% mock (botão copiar sem `onPress`).

### Troca 5 — Eventos: chaves/katas/participantes/categorias
- Backend hoje: módulo completo (competições/brackets), `read`/`staffWrite` da federação, **sem `dojoScope`**.
- A/B: ❌ falta leitura `dojoScope` (reusa competitions/brackets, destacando entries do `dojo_id`). Pode ser **read-only** e até majoritariamente público (linkável).

### Troca 6 — Conexão / filiação do dojô (validada por pagamento)
- Backend hoje: **não existe**. (`karate_dojo_connections` é o handshake do **motor de sync** — Track F, fora de escopo; não reusar a semântica de token.)
- A (Aura Dojô): conexão = **vínculo interno** gated por pagamento. Fluxo: dojô pede conexão → gera PIX de filiação → **no confirm do pagamento, ativa** (seta `federation_id` + gera `fpkt_affiliation_id` + cria 1ª anuidade paga + pedido `active`).
- B (off-app): mesma ideia como **"filie seu dojô"** público (página de pagamento) → no confirm, federação recebe o dojô cadastrado.
- Modelagem: **tabela nova `karate_affiliation_requests`** (`federation_id`, dojô/aplicante, `status` pending_payment→paid→active/rejected, `payment_intent_id`, `fpkt_affiliation_id`). Pré-aceite da federação opcional/configurável (vetar dojôs). **Hook de ativação no confirm de pagamento**, idempotente. Inbox de pedidos na federação pode reusar a UI de `conexoes` (trocando a semântica de sync por filiação).

## 4. Keystone (Fase 0) — pré-requisito de tudo

1. **Contexto dojô:** `resolveKarateContext` devolve também `dojo_id` (= `company.id` quando `vertical='karate_dojo'`); propagar no JWT + `shapeCompany`.
2. **Guard A (JWT):** `requireDojoOfFederation` (membership no `karate_dojo` filho ⇒ acesso escopado na federação-mãe; injeta `req.dojoId`).
3. **Guard B (OTP):** `karateDojoPortalAuthService` + `requireDojoPortalToken` (OTP/magic-link do responsável → `req.dojoId`). Espelha o portal do praticante.
4. **Forma de rota:** endpoints dojô-facing sob `/federation/:id/dojo/*`, auto-escopados a `req.dojoId`, aceitando A **ou** B.
5. **App:** expor `dojoId` no `KarateFederationContext` (já provê `federationId` pós-#268); criar segmento público `app/karate/[slug]/dojo/*` para o Canal B.

## 5. Fases de execução

| Fase | Escopo | Canais | Depende de |
|---|---|---|---|
| **0 — Keystone** | dojo_id no contexto/JWT; `requireDojoOfFederation` (A); dojo portal OTP (B); `dojoId` no app + segmento `[slug]/dojo/*` | A+B | — |
| **1 — Certificados (piloto)** | `/dojo/cert-orders` + `/dojo/aptos`; corrigir bugs do app; tirar `MOCK_APTOS` | A+B | 0 |
| **2 — Anuidade** | `/dojo/annuity` + `/dojo/annuity/pix` (status+PIX+NFSe); religar `anuidade.tsx`; página off-app de pagamento | A+B | 0 |
| **3 — Inscrição em eventos** | `/dojo/events` + `/dojo/events/:id/enroll` (lote); telas A e B; resolver competição (501) | A+B | 0 |
| **4 — Submissão de exame** | `/dojo/belt-exams/:id/candidates` (dojô envia candidatos→banca); fecha ciclo com Fase 1 | A+B | 0,1 |
| **5 — Eventos read (chaves/katas/categorias)** | leitura `dojoScope`/pública; telas read-only A e B | A+B | 0 |
| **6 — Conexão/filiação** | `karate_affiliation_requests`; pedido (A interno / B "filie seu dojô"); **hook de ativação no confirm**; inbox na federação | A+B | 0,2 |

Regras por fase: handler filtra por `req.dojoId` no servidor; teste por fase (padrão `karate.track*.test.js`, mock do pool); remover os `MOCK_*` da tela só quando o endpoint real existir; OTP com rate-limit; pagamento idempotente.

## 6. Decisões em aberto (confirmar antes/junto da Fase 0)
- **Local das páginas off-app:** `app/karate/[slug]/dojo/*` (Expo web) — confirmar vs microsite próprio.
- **Auth off-app do dojô:** OTP por e-mail/WhatsApp do responsável (registrado pela federação) vs magic-link. Rate-limit + expiração.
- **Pré-aceite de filiação:** federação veta antes do pagamento, ou pagar-para-filiar aberto? (provável: FPKT veta.)
- **Recebedor Asaas** da filiação/anuidade (subconta da federação) — confirmar configuração.
- **Competição (inscrição):** implementar agora (hoje 501) ou adiar a sub-parte.
- **Track F:** confirmar deprecação/parque (não construir em cima).

## 7. Segurança (transversal)
- Escopo `dojo_id` **sempre** derivado do token/guard no servidor (nunca do corpo/query).
- OTP do dojô: rate-limit, expiração curta, 1 uso; não vazar existência de e-mail.
- Pagamento: idempotência no confirm (já trata "já pago"); ativação de filiação dentro da transação do confirm.
- Webhook Asaas (quando ligado): validar assinatura.
