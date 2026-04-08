# AURA. — Plano de Execucao Unificado
# Atualizado: 08/04/2026
# Status: Sprint Fix R3 parcialmente completo + Decomposicao aprovada

---

## METODOLOGIA OBRIGATORIA

1. **Decompor** arquivo grande em hook + componentes pequenos (3-8KB cada)
2. **Hook com useMemo** — dados derivados do React Query, SEM useState+useEffect
3. **Push via API** — cada arquivo pequeno o suficiente para create_or_update_file
4. **Curl-test** backend antes de tocar no frontend
5. **Caio testa local** (npx expo start --web) antes de push para producao
6. **Verify** em aba anonima apos deploy

**NUNCA MAIS:**
- Scripts de find-and-replace em arquivos grandes
- useState + useEffect para sync de dados da API
- Push de arquivos > 10KB sem decomposicao

---

## STATUS ATUAL (pos-sessao 08/04)

### Concluido nesta sessao
- [x] A1: Onboarding removido → ProfileBanner no Dashboard
- [x] A4: PDV finalizeSale chama API (saleMutation)
- [x] A5: Contabilidade Guide com localStorage + completeCheckpoint
- [x] B5: Scroll to top ao trocar tab (4 telas)
- [x] P1: SPA redirect (public/_redirects)
- [x] P3: Theme toggle simplificado (window.location.reload)
- [x] P4: Logout volta dark mode (window.location.href = "/")
- [x] CORS: localhost:8081 adicionado ao ALLOWED_ORIGINS

### Pendente (causa raiz identificada)
- [ ] Estoque: produto some ao trocar aba (structural sharing do React Query)
- [ ] Clientes: CRUD nao funciona (mesmo bug de estado)
- [ ] Financeiro: tabs incompletas (mesmo padrao)

---

## FASE 1 — DECOMPOSICAO CORE (resolve todos os bugs de CRUD)

### D1: Estoque (44KB → ~5KB + 7 arquivos)
**Prioridade:** CRITICA — pior caso, mais bugs
**Bug:** Produto some ao trocar aba (useState+useEffect nao sincroniza)
**Solucao:** useMemo no hook

```
components/screens/estoque/
  useProducts.ts          ← useMemo + mutations (3KB)
  AddProductForm.tsx      ← Form isolado (5KB)
  ProductRow.tsx          ← Display expandivel (3KB)
  ProductList.tsx         ← Lista filtrada + busca (3KB)
  AbcSummary.tsx          ← Tab Curva ABC (3KB)
  AlertsList.tsx          ← Tab Alertas (2KB)
  constants.ts            ← CATEGORIES, UNITS, types (1KB)
app/(tabs)/estoque.tsx    ← Orquestrador (5KB)
```

**Inclui fixes:**
- Produto persiste ao trocar aba (useMemo)
- Excluir com ConfirmDialog
- Alert.alert → toast.error
- Empty state + loading skeleton
- ScreenHeader padronizado

---

### D2: Clientes (20KB → ~5KB + 6 arquivos)
**Prioridade:** CRITICA — CRUD 100% quebrado
**Bug:** Mesmo problema de estado do estoque

```
components/screens/clientes/
  useCustomers.ts         ← useMemo + mutations (3KB)
  AddCustomerForm.tsx     ← Form com masks telefone/data (4KB)
  CustomerRow.tsx         ← Display expandivel + delete (3KB)
  CustomerList.tsx        ← Tab lista + busca (2KB)
  RankingTab.tsx          ← Tab ranking LTV/visitas (2KB)
  RetentionTab.tsx        ← Tab retencao (2KB)
app/(tabs)/clientes.tsx   ← Orquestrador (5KB)
```

**Inclui fixes:**
- CRUD funcional (add/edit/delete via API)
- Formatacao telefone (12) 99999-0000
- Formatacao data DD/MM
- useMemo para persistencia

---

### D3: Financeiro (33KB → ~5KB + 6 arquivos)
**Prioridade:** ALTA — tabs A Receber/Retirada/Resumo incompletas

```
components/screens/financeiro/
  useTransactions.ts      ← useMemo + mutations (3KB)
  TransactionModal.tsx    ← Form lancamento unit+lote (5KB)
  TransactionRow.tsx      ← Display com delete (2KB)
  TransactionList.tsx     ← Tab Lancamentos (3KB)
  DreView.tsx             ← Tab Resumo DRE (3KB)
  EmptyTabs.tsx           ← Tabs A Receber + Retirada (2KB)
app/(tabs)/financeiro.tsx ← Orquestrador (5KB)
```

**Inclui fixes:**
- Excluir lancamento com ConfirmDialog
- Tab Resumo sem crash
- Empty states para tabs nao conectadas
- ScreenHeader padronizado

---

### D4: PDV (23KB → ~5KB + 5 arquivos)
**Prioridade:** ALTA — depende do estoque funcionar

```
components/screens/pdv/
  useCart.ts              ← Cart state + sale mutation (3KB)
  ProductCard.tsx         ← Card produto no grid (2KB)
  CartPanel.tsx           ← Painel carrinho + pagamento (4KB)
  SaleComplete.tsx        ← Tela pos-venda (2KB)
  ScannerBar.tsx          ← Barra de codigo de barras (2KB)
app/(tabs)/pdv.tsx        ← Orquestrador (5KB)
```

**Inclui fixes:**
- Produtos do estoque via useProducts hook (reuso!)
- Venda cria transacao no financeiro
- Empty state diferenciado
- Remover MOCK_PRODUCTS

---

## FASE 2 — DECOMPOSICAO SECUNDARIA

### D5: Contabilidade (30KB → ~5KB + 5 arquivos)
```
components/screens/contabilidade/
  useObligations.ts       ← useMemo + completeCheckpoint (3KB)
  HeroRing.tsx            ← Ring SVG + stats (3KB)
  Checkpoint.tsx          ← Card checkpoint (3KB)
  Guide.tsx               ← Passo a passo com localStorage (5KB)
  HistoryTab.tsx          ← Tab historico (3KB)
app/(tabs)/contabilidade.tsx ← Orquestrador (5KB)
```

### D6: Folha (26KB → ~5KB + 4 arquivos)
### D7: WhatsApp (29KB → ~5KB + 4 arquivos)

---

## FASE 3 — LIMPEZA + ADMIN

### D8: gestao-aura.tsx (23KB) — Admin panel
### D9: canal.tsx (23KB) — Canal Digital
### D10: _layout.tsx (20KB) — Extrair Sidebar + MobileBar
### DEL: onboarding.tsx (24KB) — DELETAR (codigo morto)

---

## BLOCO B — UX (executar JUNTO com decomposicao)

| # | Fix | Onde aplicar | Sprint |
|---|-----|-------------|--------|
| B1 | Theme crash 1a vez | colors.ts | F1-D1 |
| B2 | Mask telefone/data | AddCustomerForm.tsx, register.tsx | F1-D2 |
| B3 | Sidebar scroll | _layout.tsx (ja implementado com ScrollView) | Verificar |
| B4 | Form registro scroll/split | register.tsx | F1-D2 |
| B5 | Scroll to top tabs | Ja implementado | ✅ Feito |
| B6 | Caminho para Planos | sidebar + configuracoes | F1-D1 |

## BLOCO C — POLISH (pos-decomposicao)

| # | Fix | Sprint |
|---|-----|--------|
| C1 | Hover animations botoes/CTAs | F2 |
| C2 | Contabilidade guias UX (instrucao visual) | F2-D5 |
| C3 | Remover INITIAL_PRODUCTS mock | F1-D1 |

---

## BACKLOG POS-ALPHA

| # | Item | Prioridade |
|---|------|-----------|
| NFE-REDESIGN | Redesenhar estrategia NF-e (NFE.io nao suporta emissao em nome do cliente) | Alta |
| FE-BUG-06 | Icones dashboard nao condizentes com tipo lancamento | Baixa |
| FE-BUG-07 | Sparklines/graficos dashboard (dados reais) | Baixa |
| P9 | Integracoes externas (Asaas billing, NFE.io, WhatsApp API) | Pos-CNPJ |

---

## ORDEM DE EXECUCAO — PROXIMA SESSAO

### Sessao 1: D1 Estoque
1. Criar `components/screens/estoque/useProducts.ts` (hook com useMemo)
2. Extrair `AddProductForm.tsx`
3. Extrair `ProductRow.tsx`
4. Extrair `ProductList.tsx` + `AbcSummary.tsx` + `AlertsList.tsx`
5. Reescrever `app/(tabs)/estoque.tsx` como orquestrador fino
6. Deletar `onboarding.tsx` (codigo morto)
7. Testar local: add → trocar aba → voltar → produto persiste
8. Curl-test: produto aparece no GET /products

### Sessao 2: D2 Clientes + D3 Financeiro
1. Criar hooks + componentes para ambas as telas
2. Incluir masks telefone/data (B2)
3. Testar CRUD completo local

### Sessao 3: D4 PDV + B restante
1. PDV reutiliza useProducts do D1
2. Fixes B1 (theme), B4 (registro), B6 (planos)
3. UAT Rodada 4

### Sessao 4: D5-D7 (Fase 2)
1. Contabilidade, Folha, WhatsApp

---

## METRICAS DE SUCESSO

| Metrica | Antes | Meta |
|---------|-------|------|
| Maior arquivo | 44.5KB | < 8KB |
| Arquivos > 20KB | 10 | 0 |
| Hooks reutilizaveis | 0 | 4+ |
| CRUD funcional | 0/3 telas | 3/3 |
| Produto persiste ao trocar aba | NAO | SIM |
| UAT pass rate | ~60% | > 90% |
