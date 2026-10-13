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

## corrigirVencimentosAsaas.js — vencimentos pela Asaas (13/10/2026)

Acerta `companies.next_billing_date` com o proximo vencimento que a Asaas
informa para cada assinatura. Dry-run por padrao; `--aplicar` grava e registra
em `audit_log` (`billing.next_due_corrected`). Idempotente. Precisa de
`DATABASE_URL` e `ASAAS_API_KEY`. A mesma rotina esta em
`POST /admin/painel/asaas/corrigir-vencimentos`.

    node scripts/corrigirVencimentosAsaas.js            # so mostra antes/depois
    node scripts/corrigirVencimentosAsaas.js --aplicar  # grava
