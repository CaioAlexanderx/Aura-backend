# INF-02: Workflows GitHub Actions
#
# INSTRUCAO: Copie os dois arquivos abaixo para o repositorio:
#
#   docs/workflows/ci.txt     -> .github/workflows/ci.yml
#   docs/workflows/deploy.txt -> .github/workflows/deploy.yml
#
# O token MCP nao tem escopo 'workflow' para criar esses arquivos
# diretamente. Voce pode criar via GitHub web (Add file) ou via
# git push local.
#
# SECRETS necessarios em Settings -> Secrets -> Actions:
#
#   RAILWAY_TOKEN      Railway -> Account Settings -> Tokens
#   RAILWAY_API_URL    URL publica do servico (ex: https://aura-backend-production-f805.up.railway.app)
#   SENTRY_AUTH_TOKEN  Sentry -> Settings -> Auth Tokens
#   SENTRY_ORG         Slug da org no Sentry
#   SENTRY_PROJECT     Slug do projeto no Sentry
