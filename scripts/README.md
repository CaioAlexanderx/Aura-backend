# /scripts
Diretorio para scripts auxiliares de desenvolvimento.
Scripts de fix antigos foram removidos — fixes ja aplicados diretamente no source.

## migrate.js — runner de migrations (01/09/2026)

Nao e script auxiliar: e o passo de deploy (railway.toml -> preDeployCommand).

    npm run migrate            # aplica o que falta (node scripts/migrate.js up)
    npm run migrate:status     # lista aplicadas x pendentes
    npm run migrate:baseline   # registra as atuais SEM executar

PASSO UNICO EM PRODUCAO, antes do primeiro deploy com o runner: rodar o
`baseline` a partir de um checkout que ainda NAO tenha a migration nova
(ou seja, de `main`). As ~315 migrations ja foram aplicadas a mao; sem o
baseline o runner recusa e explica. Detalhes em src/utils/migrationRunner.js.
