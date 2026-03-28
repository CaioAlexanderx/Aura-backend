# Aura Backend — Auditoria de Segurança

Auditoria realizada em 28/03/2026. Tasks priorizadas para execução antes do Alpha.

---

## 🔴 BLOQUEADORES (resolver antes do Alpha)

### B-01 — IDOR: Isolamento multi-tenant incompleto

**Risco:** Um usuário autenticado pode trocar o `company_id` na URL e acessar dados de outra empresa.

**Causa raiz:** `requireAuth` valida apenas o JWT. Não verifica se o usuário pertence à empresa do `:id` da rota.

**Onde ocorre:**
- `src/routes/members.js` — listar membros, billing e roles usam apenas `requireAuth`
- `src/services/members.js` — `listMembers(companyId)` consulta `company_members WHERE company_id=$1` sem validar chamador
- `src/routes/reviews.js` — mesmo padrão
- `src/routes/exportReports.js` — mesmo padrão
- Todos os módulos de rota privada com `:id`

**Correção:**
```js
// src/middleware/auth.js — adicionar:
async function requireCompanyAccess(opts = {}) {
  return async (req, res, next) => {
    const companyId = req.params.id;
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT role FROM company_members
       WHERE company_id=$1 AND user_id=$2 AND active=true
       UNION
       SELECT 'owner' AS role FROM companies WHERE id=$1 AND owner_id=$2`,
      [companyId, userId]
    );
    if (!rows.length) return res.status(403).json({ error: 'Acesso negado' });
    if (opts.roles && !opts.roles.includes(rows[0].role))
      return res.status(403).json({ error: 'Permissão insuficiente' });
    req.companyRole = rows[0].role;
    next();
  };
}
```

**Checklist:**
- [ ] Middleware `requireCompanyAccess` implementado em `src/middleware/auth.js`
- [ ] Aplicado em todos os endpoints privados com `:id` de empresa
- [ ] Teste cross-tenant: usuário A retorna 403 ao acessar empresa B

---

### B-02 — Mismatch schema ↔ rotas: barcode vs scanner

**Risco:** Endpoints de barcode falham em runtime por nome de coluna errado.

**Causa raiz:** O schema define `stock_qty` e `is_active` em `products`, mas `src/routes/barcode.js` consulta `stock_quantity` e `active`. Já `src/routes/scanner.js` usa os nomes corretos.

**Correção:**
- Varredura de compatibilidade rota ↔ schema atual nos módulos: `barcode / scanner / products`, `members / role_templates`, `reviews / purchase_reviews`, `food / variants / recipes`
- Padronizar `barcode.js` e `scanner.js` em um único módulo usando colunas do schema real

**Checklist:**
- [ ] `src/routes/barcode.js` corrigido para `stock_qty` e `is_active`
- [ ] Varredura completa dos módulos listados
- [ ] Teste de integração real (sem mock) para barcode/scanner

---

### B-03 — CI mascara erros de migration

**Risco:** Pipeline fica verde enquanto produção quebra.

**Causa raiz:**
1. `--on-error-continue` no `psql` da CI faz continuar mesmo com erro SQL
2. `tests/integration/setup.js` mocka database, redis, sentry e dentalWs globalmente — testes "de integração" não batem no banco real

**Correção:**
```yaml
# ci.yml — trocar:
psql $DB_URL -f migrations/001_initial_schema.sql --on-error-continue
# por:
psql $DB_URL -v ON_ERROR_STOP=1 -f migrations/001_initial_schema.sql
```

- Separar claramente testes unitários (com mocks) e integração real (sem mocks)
- Manter suíte mínima sem mocks para: auth, onboarding, PDV, transactions, barcode

**Checklist:**
- [ ] `ci.yml` trocado para `ON_ERROR_STOP=1`
- [ ] Pelo menos 5 testes de integração real sem mocks para módulos críticos
- [ ] CI falha explicitamente se migration quebrar

---

### B-04 — README descreve rotas de auth que não existem no código

**Risco:** Front/documentação aponta para endpoints inexistentes. Revisão de segurança fica ambígua.

**Causa raiz:** README declara `POST /api/v1/auth/register` e `POST /api/v1/auth/login`, mas `src/routes/index.js` não monta `/auth`. Não aparecem arquivos de rota/controller de auth na árvore.

**Correção:**
- Se as rotas existem fora do repo: normalizar e incluir
- Se não existem: remover do README e criar o módulo `src/routes/auth.js`

**Checklist:**
- [ ] `src/routes/auth.js` implementado com register e login
- [ ] Montado em `src/routes/index.js`
- [ ] README atualizado para refletir o estado real

---

### B-05 — `setup_supabase.sh` aplica apenas migration 001, ignora as demais

**Risco:** Dev/ops segue o script oficial e termina com banco incompleto. Alpha pode subir sem tabelas necessárias.

**Causa raiz:** O script aplica somente `001_initial_schema.sql` e o seed. Existem migrations 005, 006, 007, 008, 009, 010, 011, 013, 014, 015, 016, 017, 018 que não são aplicadas.

**Correção:**
```bash
# setup_supabase.sh — substituir bloco de migrations por:
for f in migrations/*.sql; do
  echo "Applying $f..."
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

**Checklist:**
- [ ] `setup_supabase.sh` atualizado para aplicar todas as migrations em ordem
- [ ] Testado em banco limpo end-to-end

---

## 🟠 ALTA PRIORIDADE

### A-01 — JWT: claims sensíveis no token, sem invalidação

**Risco:** Token com `role`, `plan` e `features` do payload. Se o plano/role mudar no banco, token antigo continua válido até expirar. Sem revogação, blacklist ou `jti`.

**Correção:**
- Claims mínimos no token: `sub`, `iat`, `exp`, `jti`
- Lookup rápido de usuário/empresa em endpoints sensíveis
- Invalidação por `token_version` ou `last_password_change`
- TTL mais curto para access token (ex: 1h com refresh)

**Checklist:**
- [ ] Claims reduzidos no JWT
- [ ] Campo `token_version` em `users` para invalidação
- [ ] Lookup de `token_version` no `requireAuth`
- [ ] TTL do access token configurável por env

---

### A-02 — CORS permissivo demais em produção

**Risco:** `ALLOWED_ORIGINS='*'` como fallback permite requests de qualquer origem.

**Arquivos:** `src/config/env.js`, `src/app.js`

**Correção:**
- Remover fallback `'*'`
- Falhar no startup se `ALLOWED_ORIGINS` não estiver configurado em produção
- Listar explicitamente: `https://getaura.com.br`, domínio do painel

**Checklist:**
- [ ] CORS sem fallback `'*'`
- [ ] `validateRuntimeEnv()` exige `ALLOWED_ORIGINS` em produção
- [ ] Testado com origem não permitida (deve retornar 403)

---

### A-03 — Shutdown gracioso ausente

**Risco:** Em deploy Railway, processo pode encerrar sem fechar conexões de banco e Redis, causando erros em requests em andamento.

**Arquivo:** `src/server.js`

**Correção:**
```js
process.on('SIGTERM', async () => {
  server.close(async () => {
    await db.end();
    await redis.quit();
    process.exit(0);
  });
});
```

**Checklist:**
- [ ] Handler `SIGTERM` e `SIGINT` implementados
- [ ] Fecha HTTP server, pool do banco e Redis em ordem
- [ ] Timeout de força (30s) se não fechar limpo

---

### A-04 — `/health/db` expõe detalhe de infraestrutura

**Risco:** `err.message` retornado no corpo expõe informações de conexão em falha.

**Arquivo:** `src/app.js`

**Correção:** Mensagem genérica para clientes, detalhe apenas em log/Sentry.

**Checklist:**
- [ ] `/health/db` retorna `{ status: 'error', message: 'Database unavailable' }` sem detalhes internos
- [ ] Erro real registrado no Sentry/logs

---

### A-05 — Sentry recebe PII e tokens de URL

**Risco:** Middleware de erro envia `body`, `params` e `query` para Sentry em erros 5xx, podendo vazar dados sensíveis.

**Arquivo:** `src/middleware/sentryContext.js`

**Correção:** Mascarar campos sensíveis antes do envio:
```js
const MASK_FIELDS = ['password', 'token', 'cpf', 'cnpj', 'card', 'secret'];
function maskSensitive(obj) {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) =>
      MASK_FIELDS.some(f => k.toLowerCase().includes(f)) ? [k, '***'] : [k, v]
    )
  );
}
```

**Checklist:**
- [ ] Função `maskSensitive` aplicada em body/query/params antes do Sentry
- [ ] Campos: password, token, cpf, cnpj, card, secret, key

---

## 🟡 MÉDIA PRIORIDADE

### M-01 — Validação formal de payload (Zod/Joi)

**Risco:** Validação manual inline inconsistente. Edge cases passam sem tratamento.

**Módulos afetados:** onboarding, members, food, categorize, barcode, reviews

**Correção:** Adotar `zod` como padrão:
```js
const schema = z.object({
  tax_regime: z.enum(['mei', 'simples_nacional', 'lucro_presumido', 'lucro_real']),
  cnpj: z.string().length(14),
});
const parsed = schema.safeParse(req.body);
if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
```

**Checklist:**
- [ ] `zod` instalado
- [ ] Schema de validação nos módulos: onboarding, members, transactions, payroll
- [ ] Middleware genérico `validate(schema)` para reuso

---

### M-02 — Extração de regras de negócio das rotas (fat routes)

**Módulos afetados:** `guides.js`, `food.js`, `importData.js`, `transactionsBatch.js`

**Checklist:**
- [ ] `src/services/guides.js` extraído
- [ ] `src/services/food.js` extraído
- [ ] `src/services/importData.js` extraído

---

### M-03 — Redis: fallback silencioso sem warning

**Risco:** Perda de rate limit, cache e idempotência sem visibilidade operacional.

**Arquivo:** `src/config/redis.js`

**Correção:**
```js
if (!process.env.REDIS_URL) {
  logger.warn('[REDIS] REDIS_URL não configurado — rate limit e idempotência desativados');
  // Sentry.captureMessage em produção
}
```

**Checklist:**
- [ ] Warning explícito no startup quando Redis não configurado
- [ ] Captura no Sentry em ambiente de produção

---

### M-04 — SSL do banco sem verificação de certificado

**Arquivo:** `src/config/database.js` — `ssl: { rejectUnauthorized: false }`

**Checklist:**
- [ ] Configurar `rejectUnauthorized: true` com certificado do Supabase
- [ ] Ou ao menos documentar a decisão com justificativa explícita

---

### M-05 — Seed de dev/demo não separado do seed de produção

**Arquivo:** `001_seed_2026.sql`

**Checklist:**
- [ ] Separar `seeds/dev.sql` e `seeds/prod.sql`
- [ ] CI usa `seeds/dev.sql`; deploy de produção não aplica seed de demo

---

## Resumo executivo

| # | Task | Prioridade | Estimativa |
|---|------|------------|------------|
| B-01 | IDOR / multi-tenant | 🔴 Bloqueador | 1 dia |
| B-02 | Mismatch schema ↔ barcode | 🔴 Bloqueador | 4h |
| B-03 | CI mascara erros de migration | 🔴 Bloqueador | 2h |
| B-04 | Rotas de auth ausentes no código | 🔴 Bloqueador | 4h |
| B-05 | setup_supabase.sh incompleto | 🔴 Bloqueador | 1h |
| A-01 | JWT invalidação | 🟠 Alta | 4h |
| A-02 | CORS produção | 🟠 Alta | 1h |
| A-03 | Shutdown gracioso | 🟠 Alta | 1h |
| A-04 | /health/db expõe erros | 🟠 Alta | 30min |
| A-05 | Sentry PII masking | 🟠 Alta | 1h |
| M-01 | Validação Zod | 🟡 Média | 1 dia |
| M-02 | Fat routes → services | 🟡 Média | 2 dias |
| M-03 | Redis fallback warning | 🟡 Média | 30min |
| M-04 | SSL banco | 🟡 Média | 30min |
| M-05 | Seed dev/prod separado | 🟡 Média | 1h |

**Total estimado para Alpha:** ~3 dias focados nos bloqueadores + alta prioridade.
