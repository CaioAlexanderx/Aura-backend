# Deploy do backend (Railway)

Como uma versão nova do backend chega à produção e o que precisa estar
configurado no painel da Railway para a troca de versão não estourar o pool
do Supavisor.

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
