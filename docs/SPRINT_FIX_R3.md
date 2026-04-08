# AURA. — Sprint Fix R3 (pos-UAT Rodada 3)
# Atualizado: 08/04/2026
# Metodologia: Rewrite → Curl-test → Local-test → Deploy → Verify

## Metodologia obrigatoria para cada fix

1. **Ler** arquivo inteiro via GitHub API
2. **Reescrever** completo (nao patch) via create_or_update_file
3. **Curl-test** backend antes de tocar no frontend
4. **Caio testa local** com `npx expo start --web` antes do push
5. **Push** para producao so apos validacao local
6. **Verify** em aba anonima apos deploy

---

## BLOCO A — CRITICOS (bloqueiam uso do app)

### A1: Onboarding — revisao profunda
**Problema:** Instavel, as vezes inicia, as vezes nao. Sem padrao definido.
**Causa provavel:** Estado hibrido (onboarding_step no backend vs localStorage vs Zustand).
**Acao:** Reescrever logica de onboarding:
  - Backend: unica fonte de verdade (onboarding_step na tabela companies)
  - Frontend: verificar onboarding_step no login/hydrate, redirect se != "complete"
  - Remover dependencia de localStorage para onboarding state
**Arquivos:** stores/auth.ts, app/(tabs)/onboarding.tsx, app/(tabs)/_layout.tsx
**Validacao:** Criar conta → onboarding → completar → logout → login → dashboard direto

### A2: Clientes — CRUD completo
**Problema:** Nao e possivel inserir, excluir ou editar cliente.
**Causa:** addCustomerMutation pode nao estar chamando API corretamente.
**Acao:** Reescrever clientes.tsx:
  - Curl-test: POST /customers, GET /customers, DELETE /customers/:id
  - Garantir createCustomer, deleteCustomer funcionam
  - Adicionar editCustomer (PATCH /customers/:id)
  - Formatacao automatica de telefone e data no formulario
**Arquivos:** app/(tabs)/clientes.tsx, services/api.ts
**Validacao:** Criar → aparece na lista → expandir → editar → excluir → persistir apos F5

### A3: Financeiro — revisao profunda
**Problema:** Funcionalidades nao estao 100%. Tab Resumo/Retirada/A Receber incompletas.
**Acao:** Reescrever financeiro.tsx:
  - Tab Lancamentos: CRUD completo (add/edit/delete) com API
  - Tab Resumo: proteger contra dados invalidos, usar DRE real quando disponivel
  - Tab A Receber: empty state (API nao implementada ainda)
  - Tab Retirada: empty state (API nao implementada ainda)
  - Botao excluir com ConfirmDialog funcional
**Arquivos:** app/(tabs)/financeiro.tsx
**Validacao:** Lancar receita → aparece na lista → excluir → F5 → persistiu

### A4: PDV → Financeiro conexao
**Problema:** Vendas do PDV nao aparecem no Financeiro.
**Causa:** PDV finaliza venda localmente (setLastSale), nao chama API.
**Acao:**
  - Backend: POST /pdv/sales deve criar transaction automaticamente
  - Frontend: finalizeSale() deve chamar saleMutation (ja existe mas pode nao estar conectado)
  - Apos venda, invalidar queries de transactions e dashboard
**Arquivos:** app/(tabs)/pdv.tsx, src/routes/pdv.js (backend)
**Validacao:** Vender no PDV → abrir Financeiro → receita da venda aparece

### A5: Contabilidade — revisao profunda
**Problema:** Interface truncada, cards nao mostram linha de execucao, progresso nao salva.
**Acao:** Reescrever contabilidade.tsx:
  - Checkpoint click abre Guide com steps (ja corrigido R4, verificar)
  - Progresso dos steps deve salvar no backend (POST /checklist/:id/complete)
  - Cards com visual claro de sequencia (numeracao, setas, cores)
  - Layout menos denso, mais respiracao
**Arquivos:** app/(tabs)/contabilidade.tsx
**Validacao:** Clicar checkpoint → marcar steps → sair → voltar → progresso mantido

---

## BLOCO B — IMPORTANTES (impactam UX)

### B1: Theme toggle crash na primeira vez
**Problema:** Crasha na primeira vez, funciona nas seguintes.
**Causa:** Colors resolve IS_DARK no import time. Primeiro toggle muda localStorage mas reload falha.
**Acao:** Investigar se o _redirects SPA fix resolveu (redirect para / pode causar o crash).
  Alternativa: remover auto-reload, mostrar toast "Recarregue a pagina para aplicar o tema".
**Arquivos:** constants/colors.ts
**Validacao:** Toggle dark→light→dark sem crash em nenhuma das vezes

### B2: Formularios — formatacao automatica
**Problema:** Telefone e data nao formatam automaticamente nos forms de cadastro.
**Acao:**
  - Clientes: maskPhone e maskDate no AddForm
  - Register: ja tem maskPhone, verificar se funciona
  - Estoque: nao precisa (nao tem telefone/data)
**Arquivos:** app/(tabs)/clientes.tsx, app/(auth)/register.tsx
**Validacao:** Digitar "12999990000" → aparece "(12) 99999-0000"

### B3: Sidebar com barra de rolagem
**Problema:** Sidebar nao tem scroll, itens podem ficar cortados.
**Acao:** Adicionar ScrollView na sidebar para telas menores.
**Arquivos:** app/(tabs)/_layout.tsx ou components/Sidebar.tsx
**Validacao:** Sidebar com muitos itens → scroll funciona

### B4: Formulario de cadastro (registro) — scroll ou split
**Problema:** Formulario muito longo, cortado na visualizacao.
**Acao:** Adicionar ScrollView no container do formulario OU dividir em 2 steps.
**Arquivos:** app/(auth)/register.tsx
**Validacao:** Todos os campos visiveis e acessiveis

### B5: Scroll to top ao trocar de aba
**Problema:** Ao trocar de aba, pagina inicia no meio.
**Acao:** Adicionar scrollRef.current?.scrollTo({ y: 0 }) no onSelect das tabs.
**Arquivos:** Todas as telas com tabs (financeiro, estoque, clientes, contabilidade)
**Validacao:** Trocar tab → scroll vai para o topo

### B6: Caminho para Planos (upgrade/downgrade)
**Problema:** So acessivel pelo header "Assine agora".
**Acao:** Adicionar link na sidebar + settings + trial banner.
**Arquivos:** app/(tabs)/_layout.tsx, app/(tabs)/configuracoes.tsx
**Validacao:** Pelo menos 2 caminhos para chegar nos Planos

---

## BLOCO C — MELHORIAS UX (polimento)

### C1: Hover animations em botoes/CTAs
**Problema:** Botoes e CTAs nao reagem ao mouseover.
**Acao:** Garantir que PressableScale ou hover states estao aplicados.
**Arquivos:** Componentes compartilhados
**Validacao:** Mouse over em qualquer botao → feedback visual

### C2: Contabilidade — UX dos guias
**Problema:** Nao e intuitivo que o cliente pode clicar nas etapas para marcar como concluidas.
**Acao:**
  - Adicionar instrucao visual "Clique em cada etapa para marcar como concluida"
  - Checkbox ou toggle visivel em cada step
  - Animacao ao completar step
**Arquivos:** app/(tabs)/contabilidade.tsx (Guide component)
**Validacao:** Testador entende sozinho que precisa clicar nos steps

### C3: Estoque — remover INITIAL_PRODUCTS
**Problema:** Array mock de 10 produtos ainda no codigo (ocupa espaco).
**Acao:** Remover completamente o array INITIAL_PRODUCTS.
**Arquivos:** app/(tabs)/estoque.tsx
**Validacao:** Arquivo menor, sem flash de mock

---

## Ordem de execucao sugerida

1. A1 (Onboarding) — desbloqueia todos os testes
2. A2 (Clientes CRUD) — tela 100% quebrada
3. A3 (Financeiro) — core do produto
4. A4 (PDV → Financeiro) — integracao critica
5. A5 (Contabilidade) — feature completa
6. B1-B6 (UX fixes) — polimento
7. C1-C3 (Melhorias) — bonus

## Estimativa

- Bloco A: 3-4 sessoes (rewrite completo de cada tela)
- Bloco B: 1-2 sessoes
- Bloco C: 1 sessao
