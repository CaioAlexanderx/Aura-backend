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

## vitrine-featured-para-ocultos.js — lista de inclusao -> ocultos (tq-57, 29/10/2026)

Troca a lista de inclusao da vitrine (`featured_product_ids` cheio) pelo
inverso dela em `hidden_product_ids`, sem mudar o que a loja mostra hoje: o
script compara o fragmento real `NA_VITRINE` antes e depois, produto a produto,
e faz ROLLBACK na menor divergencia. Dry-run por padrao; `--apply` so com
`--lojas` (um slug por vez ou separados por virgula). Antes de cada UPDATE grava
o backup em JSON; `--desfazer <arquivo> --apply` volta. Precisa do ambiente do
backend (SUPABASE_DB_URL e as variaveis que src/config/database.js exige).

    node scripts/vitrine-featured-para-ocultos.js                                  # so mostra, todas
    node scripts/vitrine-featured-para-ocultos.js --lojas felic-adega --apply      # converte
    node scripts/vitrine-featured-para-ocultos.js --desfazer <backup.json> --apply # volta
