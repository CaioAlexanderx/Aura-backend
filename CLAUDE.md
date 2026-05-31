# CLAUDE.md — Aura Backend

Instruções para o Claude ao trabalhar neste repositório.

---

## ⚠️ REGRA CRÍTICA — MCP GitHub e base64

> **Todo arquivo lido via MCP GitHub vem com `content` em base64.**
> **NUNCA commitar o campo `content` diretamente. SEMPRE decodificar antes.**

O campo `content` da API do GitHub é sempre base64 — isso inclui `.js`, `.ts`, `.sql`, `.json`, qualquer extensão. Se você passar o valor bruto para `create_or_update_file`, o arquivo no repo ficará com base64 puro no lugar do código, quebrando o CI silenciosamente (psql syntax error, Jest `Unexpected token`, etc).

**Fluxo correto ao editar um arquivo via MCP:**
1. `get_file_contents` → recebe `{ content: "<base64>", sha: "..." }`
2. Decodificar o base64 para obter o texto real
3. Aplicar as edições no texto decodificado
4. `create_or_update_file` com o texto editado (não base64) + o `sha` original

---

## Arquitetura

- **Runtime:** Node.js + Express
- **Banco:** PostgreSQL via Supabase (prod) / container local (CI)
- **Deploy:** Railway — push em `main` faz deploy automático
- **Migrations:** arquivos `migrations/NNN_nome.sql`, numerados, idempotentes (`IF NOT EXISTS` em tudo). O backend **não roda migrations automaticamente no boot** — aplicar via Supabase MCP (`apply_migration`) ou manualmente.

---

## Armadilhas recorrentes

### 1. Schema antes da migration (42703 / 42P01)
O backend sobe antes da migration ser aplicada. Toda nova coluna ou tabela exige código defensivo:
```js
try { /* usa a coluna nova */ }
catch (e) { if (e.code === '42703') { /* coluna ausente, fallback */ } else throw e; }
```
Use cache module-level para não repetir o try/catch em cada request.

### 2. `companies` não tem coluna `name`
Sempre usar `COALESCE(trade_name, legal_name)` em qualquer SELECT/JOIN que precise do nome da empresa.

### 3. `planLimit` gating só em POST/criação
Nunca bloquear GET de listagem por limite de plano — o usuário perderia acesso a dados já cadastrados. Gate só em cadastro/criação de novos registros.

### 4. Visibilidade de produto em rotas adjacentes
As rotas de imagem, categorias, links e variantes de produto ficam fora do `visibilityWhere` se não forem importadas explicitamente de `products.js`. Verificar em qualquer nova rota adjacente.

### 5. Troca infla agregados de receita
`sales.total_amount` de vendas do tipo `troca` representa o valor do produto novo, não a entrada de caixa. Todo `SUM(sales.total_amount)` que representa receita deve filtrar `WHERE type != 'troca'` (ou usar `sales_liquid` view).

### 6. `sale_date` deve sincronizar `created_at`
`POST /pdv/sale` com `sale_date` explícito precisa sincronizar `sales.created_at` via `sale_date::date + interval '3h'`; caso contrário Vendas e Financeiro divergem.

### 7. Group shared — write path deve espelhar o read path
Rotas `PATCH`/`DELETE` de produtos precisam usar a mesma visibilidade do `GET` (próprio + shared do billing_owner). Subsidária que lista o produto mas leva 404 ao editar é sintoma desse bug.

### 8. Regex em template literals
Dentro de `` `...` `` (template literal), um backslash na regex precisa de **2 backslashes na fonte** (não 4). Sempre testar com `node -e "console.log(/regex/.test('valor'))"` antes de commitar.

### 9. Plano stale no JWT
O auth store carrega `plan` / `module_overrides` do JWT e **nunca revalida automaticamente**. Qualquer rota de backend que dependa de plano atualizado deve buscar o valor direto do banco, não confiar no JWT.

### 10. Retry chains em tabelas inexistentes
Chains de `DELETE`/`UPDATE` com múltiplos steps quebram com `42P01` se a tabela não existir ainda (deployment parcial). Usar try/catch específico para `42P01` com fallback seguro.

---

## Convenções de migration

- Arquivo: `migrations/NNN_descricao_curta.sql`
- Numeração sequencial; se número já ocupado, incrementar
- Tudo idempotente: `IF NOT EXISTS`, `DO $$ BEGIN ... EXCEPTION WHEN duplicate_column THEN NULL; END $$`
- Comentar o propósito no topo do arquivo
- Aplicar via Supabase MCP antes de mergear o PR do backend

## Padrão de features

1. Migration SQL idempotente
2. Rota(s) Express em `src/routes/`
3. Registrar em `src/routes/private.js` (ou `public.js`)
4. PRs não-draft; backend mergeado antes do frontend
