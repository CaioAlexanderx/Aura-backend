# Deploy do backend (Railway)

Como uma versão nova do backend chega à produção e o que precisa estar
configurado no painel da Railway para a troca de versão não estourar o pool
do Supavisor.

## Um deploy por merge (t1-01, 14/10/2026)

### Como era (até 13/10)

Cada merge em `main` criava **três** deploys na Railway. Como cada um
aparece na lista de deployments (os horários de 13 e 14/10 batem com esta
leitura):

| Gatilho | Na lista de deployments da Railway |
| --- | --- |
| Integração GitHub da Railway com **Wait for CI** (`checkSuites: true`) | **criado pelo Caio, com a mensagem do commit, no instante do push**; fica em WAITING até o CI e o workflow Deploy terminarem |
| `railway up` no workflow **Deploy** | criado pelo Caio, **sem mensagem**, uns 13 s depois do início de cada execução do Deploy |
| `railway variables set GIT_SHA=...` no fim do mesmo workflow (variável nova reinicia o serviço) | **sem criador, com a mensagem do commit**, no fim de cada execução do Deploy |

Medido em 13/10: 40 deploys para 13 merges (3,1 por merge). Cada troca de
versão deixa duas instâncias de pé, cada uma com até 15 conexões no pool do
Supavisor, e 19 de 20 rajadas de EMAXCONNSESSION em 7 dias começaram numa
troca de versão. Exemplo do #819 (13/10): integração às 15:18 (no merge, em
WAITING), `railway up` às 15:26 e reinício pelo `variables set` às 15:27.

Com merges em sequência fica pior. Cada execução do Deploy usa o commit do
**seu** CI: o `railway up` sobe a árvore daquele commit, e o `variables set`
grava o sha dele. Quem termina por último ganha, mesmo que seja o commit mais
velho. Em 14/10, entre 01:20 e 01:29 UTC, os merges #820 a #823 geraram 12
deploys. A última execução do Deploy a terminar era a do CI do #822 e gravou
`GIT_SHA=3bbe1bbd`.

### Como fica

- **Só a integração GitHub da Railway faz deploy.** Ela já estava ligada,
  com Wait for CI. Nada muda no painel para isso.
- O workflow **Deploy** (`.github/workflows/deploy.yml`) não fala mais com a
  Railway: só cria a release do Sentry. O job inteiro e o passo têm
  `continue-on-error`, porque a Railway espera este workflow e uma falha
  aqui pularia o deploy. Ele também não espera o `/health` mostrar o sha
  novo, porque a Railway só sobe depois que ele termina.
- O `/health` (campo `version`), o log de boot (`Release:`) e o Sentry leem
  o commit de `RAILWAY_GIT_COMMIT_SHA`, que a Railway injeta em todo deploy
  da integração, redeploy e rollback, com 8 caracteres
  (`shaDaVersao` em `src/config/env.js`). A variável `GIT_SHA` vira reserva
  para deploy feito à mão pela CLI (`railway up`), que não traz o commit.
- **Sem `RAILWAY_GIT_COMMIT_SHA`** (deploy pela CLI ou por imagem): o
  `/health` mostra o `GIT_SHA`, se a variável ainda existir, e senão
  `1.0.0`. O log de boot mostra `Release: local`, e a release do Sentry vira
  `aura-backend@<versão do package.json>`. **O boot não é afetado**: a
  versão é só informativa e nenhuma checagem de partida depende dela. O
  verificador de produção (t1-04) trata `1.0.0` como "sem sha", registra e
  não falha.
- Quem confere se a versão no ar é a de `main` é o verificador de produção
  (t1-04), não mais o workflow Deploy. O health check antigo só via 200 da
  versão anterior e ficava verde mesmo com deploy falho.

### Passos no painel (o Caio faz; não dá para fazer por arquivo)

1. **Conferir** em Aura-backend > Settings > Source: repositório
   `CaioAlexanderx/Aura-backend`, branch `main`, autodeploy ligado e
   **Wait for CI** ligado. Em 14/10 estava assim (`checkSuites: true`).
   Se o autodeploy estiver desligado, **não mergear** este PR: sem o
   `railway up` nada mais faria deploy.
2. **Depois** do primeiro deploy com este PR, quando o `/health` mostrar o
   sha do merge: apagar a variável `GIT_SHA` do serviço (Variables). Ela
   ficou com o valor do último `variables set` e não é mais lida enquanto
   existir `RAILWAY_GIT_COMMIT_SHA`. A exclusão fica "staged" e vai junto
   com o próximo deploy; não precisa disparar um só para isso. Se ficar,
   não quebra nada, só confunde.
3. Lembrete com prazo: o `railway.toml` é "Config as Code", que a Railway
   marca como obsoleto, com corte em **01/12/2026**. É nele que roda o
   `preDeployCommand` das migrations. Ver "Aviso: `railway.toml` tem prazo"
   abaixo.
4. Opcional, mais tarde: os segredos `RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`,
   `RAILWAY_SERVICE` e `RAILWAY_API_URL` do GitHub (Settings > Secrets >
   Actions) deixam de ser usados por este workflow. Dá para revogar o token
   na Railway quando ninguém mais precisar dele.

### Como conferir

- Na lista de deployments da Railway, um merge deve gerar **um** deploy:
  criado pelo Caio (a integração aparece com o usuário do GitHub), com a
  mensagem do commit, **criado no instante do merge** e em **WAITING** até
  o CI e o workflow Deploy terminarem. Depois disso ele constrói e fica
  ativo. Não devem aparecer deploys sem mensagem (`railway up`) nem deploys
  sem criador no fim do Deploy (`variables set`). Quando vários merges
  chegam juntos, os mais velhos podem aparecer como REMOVED ou SKIPPED, o
  que é normal.
- `curl -s https://aura-backend-production-f805.up.railway.app/health`
  deve mostrar `"version"` com os 8 primeiros caracteres do commit do merge.
- O workflow Deploy do merge fica verde em menos de 1 minuto.

### Se precisar voltar atrás

Reverter este PR traz de volta o `railway up` e o `variables set`. Os
segredos continuam no GitHub, então funciona sem passo no painel.

## Aviso: `railway.toml` tem prazo

A documentação da Railway (consultada em 14/10/2026) marca o "Config as
Code" (`railway.toml`) como obsoleto: os arquivos seguem valendo para
serviços antigos até **01/12/2026**, e a recomendação é migrar para
"Infrastructure as Code". O nosso `railway.toml` carrega o
`preDeployCommand` que roda as migrations (`node scripts/migrate.js up`),
o `startCommand`, o health check e a política de reinício. Se ele deixar de
ser lido, as migrations param de rodar no deploy **sem erro visível**.
Também chama atenção que o arquivo diz `builder = "NIXPACKS"` e o serviço
hoje mostra RAILPACK. Precisa de um cartão próprio antes de dezembro.

## Encerramento gracioso (t1-03, 14/10/2026)

Na troca de versão a Railway sobe a instância nova e, quando ela fica
saudável, manda SIGTERM para a antiga. Enquanto as duas estão de pé, cada uma
pode segurar até 15 conexões (`max` do pool em `src/config/database.js`)
contra o pool do Supavisor em modo sessão (`pool_size` 30 desde 13/10).

Desde t1-03 o processo trata SIGTERM e SIGINT (`src/utils/encerrar.js`,
instalado por `startServer()` em `src/server.js`):

1. para de aceitar conexões e fecha as keep-alive ociosas;
2. para os timers dos jobs (todo `stop*` exportado pelos módulos de
   `src/jobs/`) e derruba os WebSockets de assinatura;
3. espera as requisições em andamento, até 10 s; depois disso corta o que
   sobrou;
4. `pool.end()` (até 5 s), devolvendo as conexões ao Supavisor;
5. `process.exit(0)`.

No log da instância antiga aparecem as linhas `[shutdown] ...`.

### Passo no painel da Railway (o Caio faz uma vez)

A Railway manda SIGKILL logo depois do SIGTERM: o "draining time" padrão é
**0 s**. Sem ajustar, o processo antigo morre antes de terminar o passo 3.

- Serviço `Aura-backend` > **Variables** > nova variável
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` = `20`
  (ou **Settings > Deploy > Teardown > Draining time** = 20 s).
- A mudança fica "staged"; ela vale a partir do próximo deploy. Não precisa
  de deploy só para isso: pode ir junto com o próximo merge.
- 20 s = 10 s de espera das requisições + 5 s do `pool.end()` + folga.
  O processo sai assim que termina; os 20 s são só o teto.

### Como conferir depois do deploy

- Logs da instância antiga (Deployments > deploy anterior > Logs): as linhas
  `[shutdown] SIGTERM recebido`, `pool do banco: fechado` e
  `saindo após Nms`.
- Nenhuma linha `EMAXCONNSESSION` nos minutos da troca de versão.
