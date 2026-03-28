# Aura. — Backend API

> SaaS all-in-one para MEI e pequenas empresas — Vale do Paraíba/SP  
> Node.js + Express + PostgreSQL (Supabase) + Redis

[![CI](https://github.com/CaioAlexanderx/Aura-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/CaioAlexanderx/Aura-backend/actions/workflows/ci.yml)
[![Deploy](https://github.com/CaioAlexanderx/Aura-backend/actions/workflows/deploy.yml/badge.svg)](https://github.com/CaioAlexanderx/Aura-backend/actions/workflows/deploy.yml)

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express 4 |
| Banco de dados | PostgreSQL 16 via Supabase |
| Cache / Idempotência | Redis (Railway) |
| Autenticação | JWT + RBAC |
| Monitoramento | Sentry |
| CI/CD | GitHub Actions → Railway |
| Storage | Cloudflare R2 (XMLs NF-e) |

---

## Setup local

### Pré-requisitos

- Node.js 20+
- PostgreSQL 16+ (ou conexão com o Supabase)
- Redis (opcional — rate limiting e idempotência)

### Instalação

```bash
git clone https://github.com/CaioAlexanderx/Aura-backend.git
cd Aura-backend
npm install
cp .env.example .env
# edite .env com suas variáveis
```

### Variáveis de ambiente obrigatórias

```env
SUPABASE_DB_URL=postgresql://...
JWT_SECRET=string-aleatoria-forte
```

Variáveis opcionais (sem elas o sistema usa fallback seguro):

```env
REDIS_URL=redis://localhost:6379
SENTRY_DSN=https://...@sentry.io/...
ANTHROPIC_API_KEY=sk-ant-...   # CORE-04: categorização via IA
HEALTH_SECRET=...              # protege /health/sentry em produção
```

### Aplicar migrations

```bash
# Via psql (local)
for f in migrations/*.sql; do psql $SUPABASE_DB_URL -f "$f"; done

# Via script (Supabase)
bash setup_supabase.sh
```

### Rodar em desenvolvimento

```bash
npm run dev      # nodemon com hot-reload
npm test         # todos os testes
npm run test:coverage  # cobertura
```

---

## Endpoints principais

### Autenticação
```
POST /api/v1/auth/register
POST /api/v1/auth/login
```

### Onboarding
```
POST /api/v1/onboarding/cnpj-lookup          # público — consulta CNPJ na RF
GET  /api/v1/companies/:id/onboarding        # status do onboarding
POST /api/v1/companies/:id/onboarding/step/cnpj
POST /api/v1/companies/:id/onboarding/step/regime
POST /api/v1/companies/:id/onboarding/step/perfil
POST /api/v1/companies/:id/onboarding/step/vertical
```

### Financeiro / DRE
```
GET  /api/v1/companies/:id/dre               # DRE gerencial (plano Negócio+)
GET  /api/v1/companies/:id/dre/monthly       # evolução mensal
GET  /api/v1/companies/:id/dre/cashflow      # fluxo projetado
```

### PDV
```
POST /api/v1/companies/:id/pdv/sale          # venda atômica
GET  /api/v1/companies/:id/pdv/sales         # histórico
GET  /api/v1/companies/:id/pdv/summary       # resumo do dia
GET  /api/v1/companies/:id/pdv/scan/:code    # scanner de código de barras
```

### Exportações (CORE-05)
```
GET  /api/v1/companies/:id/export/dre?format=pdf|csv
GET  /api/v1/companies/:id/export/sales?format=pdf|csv
GET  /api/v1/companies/:id/export/payroll?period=YYYY-MM&format=pdf|csv
GET  /api/v1/companies/:id/export/prolabore?format=pdf|csv  # plano Negócio+
```

### Categorização via IA (CORE-04)
```
POST /api/v1/companies/:id/transactions/categorize         # lote (até 50)
POST /api/v1/companies/:id/transactions/:txId/categorize   # individual
```

### Obrigações fiscais
```
GET  /api/v1/companies/:id/obligations
GET  /api/v1/companies/:id/obligations/calendar
GET  /api/v1/companies/:id/obligations/das/preview
```

### Health checks
```
GET  /health                          # status geral
GET  /health/db                       # conexão banco
GET  /health/sentry?token=SECRET      # teste Sentry
```

---

## Arquitetura

```
src/
├── index.js          # entry point (require.main guard)
├── server.js         # HTTP + WebSocket + process handlers
├── app.js            # Express app + middlewares
├── config/
│   ├── database.js   # Pool PostgreSQL
│   ├── redis.js      # Cliente Redis
│   ├── sentry.js     # Inicialização Sentry
│   └── env.js        # Validação de variáveis no startup
├── middleware/
│   ├── auth.js       # JWT + requireRole + requirePlan + requireFeature
│   └── sentryContext.js
├── routes/
│   ├── index.js      # roteador público
│   ├── private.js    # roteador privado (requireAuth global)
│   └── ...           # 30+ módulos de rota
└── services/         # lógica de negócio desacoplada das rotas
```

### Controle de acesso (RBAC)

| Role | Acesso |
|---|---|
| `client` | próprias empresas |
| `analyst` | empresas do portfólio (CRC) |
| `admin` | Gestão Aura completa |

### Planos

| Plano | Features |
|---|---|
| `essencial` | PDV, Financeiro básico, Obrigações |
| `negocio` | + DRE, Pró-labore, Multi-usuário, Exportações |
| `expansao` | + Assistente IA, Custo Avançado, Verticais |

---

## Testes

```bash
npm test                 # 26 suites, ~230 testes
npm run test:coverage    # com relatório de cobertura
```

Cobertura atual: `exportReports.js` 97% · `payroll.js` 95% · `payments.js` 95%

---

## Deploy

Todo push em `main` dispara automaticamente:

1. **CI** — syntax check + migrations + testes
2. **Deploy** — `railway up` (só se CI verde)
3. **Health check** — 5 tentativas em 60s
4. **Sentry release** — vincula erros ao commit

---

## Regras invioláveis do produto

- Linguagem fiscal: sempre **"estimativa"** — nunca "declaração oficial"
- Transmissões oficiais (PGDAS-D, eSocial): sempre pelo analista CRC
- PCI-DSS: dados de cartão nunca passam pelo servidor Aura
- Webhooks: sempre com validação HMAC-SHA256
- Review gating: proibido — avaliações vão para todos os clientes
