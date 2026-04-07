# AURA. — UAT Tests (User Acceptance Testing)
# Atualizado em: 07/04/2026
# Rodada: Alpha v2 (pos-fix B1-B9)

## Usuarios Beta

| User   | Codigo   | Plano   | Trial  |
|--------|----------|---------|--------|
| Lorena | LORENA01 | Negocio | 30 dias |
| Caio   | BETA02   | Negocio | 30 dias |

URL: https://app.getaura.com.br

---

## Historico de Bugs (Rodada 1 — 07/04/2026)

| # | Sev | Bug | Fix | Commit |
|---|-----|-----|-----|--------|
| B1 | BLOCKER | Financeiro: lancamento salva local, nao chama API | createTxMutation.mutate() | fix-uat-bugs.js |
| B2 | CRITICO | Financeiro: Tab Resumo crasha | Protegido contra dados API invalidos | fix-all-uat.js |
| B3 | CRITICO | PDV: "Nenhum produto" mesmo com estoque | Fallback para MOCK se API vazia | fix-uat-bugs.js |
| B3b | CRITICO | Estoque: produto salva local, nao API | addProductMutation.mutate() | fix-uat-bugs.js |
| B4 | CRITICO | Contabilidade: checkpoint click = tela branca | Refs TooltipBanner removidas | fix-uat-bugs.js |
| B5 | MEDIO | Theme toggle crasha | window.location.href + catch sem reload loop | colors.ts |
| B6 | MEDIO | Financeiro: lista mostra mock items | Array vazio em vez de localTx fallback | fix-all-uat.js |
| B7 | MEDIO | Contabilidade: subtitulo inconsistente | "Passo a passo com apoio da Aura" | fix-all-uat.js |
| B8 | MEDIO | Mobile overflow (Dashboard, Contab, Analista, Agentes) | overflow hidden + flexWrap (4 telas) | fix-b8-mobile.js |
| B9 | MENOR | Login em light mode apos logout | Logout reseta localStorage aura_theme = dark | fix-all-uat.js |
| AUTH-1 | BLOCKER | Register: spinner mas nao redireciona | router.replace + toast (nao Alert.alert) | register.tsx |
| AUTH-2 | BLOCKER | Login: nada acontece ao clicar Entrar | router.replace + toast + ToastContainer no auth layout | login.tsx + _layout.tsx |
| AUTH-3 | UX | "Nao tenho CNPJ" sem feedback | Toast + visual feedback + esconde campo | register.tsx |
| AUTH-4 | UX | Access code sem validacao visual | Valida onBlur com verde/vermelho + toast | register.tsx |
| AUTH-5 | UX | Form de registro alinhado esquerda | justifyContent: center | register.tsx |

---

## Checklist UAT — Rodada 2

### 1. AUTH — Criar conta

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 1.1 | Acessar app.getaura.com.br | Tela de login aparece, centralizada, dark mode | | |
| 1.2 | Clicar "Criar conta" | Formulario centralizado com todos os campos | | |
| 1.3 | Clicar "Nao tenho CNPJ" | Toast info + campo CNPJ esconde + mensagem "pode adicionar depois" | | |
| 1.4 | Preencher campos obrigatorios sem senha forte | Toast erro "Senha: minimo 8 caracteres, 1 maiuscula e 1 numero" | | |
| 1.5 | Inserir access code e sair do campo | Indicador verde "Validado" + toast "Codigo valido! Plano: negocio" | | |
| 1.6 | Inserir access code invalido | Indicador vermelho "Invalido" + toast erro | | |
| 1.7 | Preencher tudo corretamente + Criar conta | Toast "Conta criada com sucesso!" + redirect para onboarding | | |
| 1.8 | Completar onboarding (5 steps) | Redirect para dashboard | | |
| 1.9 | Logout -> Login com credenciais | Toast nenhum (sucesso silencioso) + redirect para dashboard | | |
| 1.10 | Apos login, onboarding NAO aparece | Dashboard direto | | |
| 1.11 | Login com senha errada | Toast "E-mail ou senha incorretos." | | |
| 1.12 | Login com email inexistente | Toast de erro claro | | |

### 2. DASHBOARD

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 2.1 | Dashboard carrega (conta nova) | Empty state com 3 CTAs (Receita, Produto, Cliente) | | |
| 2.2 | CTA "Lancar receita" | Abre Financeiro sem crash | | |
| 2.3 | CTA "Cadastrar produto" | Abre Estoque sem crash | | |
| 2.4 | CTA "Adicionar cliente" | Abre Clientes sem crash | | |
| 2.5 | Dashboard carrega (com dados) | Cards KPI (receita/despesa/lucro) com valores corretos | | |
| 2.6 | Ultimas vendas | Lista com nome, valor, hora, metodo | | |
| 2.7 | Obrigacoes contabeis | Cards com DAS, DASN, disclaimer "estimativa" | | |

### 3. FINANCEIRO

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 3.1 | Tela abre sem crash | Cards resumo + lista vazia (conta nova) | | |
| 3.2 | Lista NAO mostra itens mock | Apenas lancamentos reais ou lista vazia | | |
| 3.3 | Clicar "Novo lancamento" | Modal/form abre | | |
| 3.4 | Lancar receita R$100 | Toast "Receita lancada" + aparece na lista | | |
| 3.5 | Lancar despesa R$50 | Toast "Despesa lancada" + aparece na lista | | |
| 3.6 | Recarregar pagina | Lancamentos persistem (vieram da API, nao local) | | |
| 3.7 | Cards atualizam | Entradas R$100, Saidas R$50, Saldo R$50 | | |
| 3.8 | Tab "A Receber" | Renderiza sem crash | | |
| 3.9 | Tab "Minha Retirada" | Renderiza sem crash | | |
| 3.10 | Tab "Resumo" | Renderiza sem crash (protegido contra dados invalidos) | | |

### 4. ESTOQUE

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 4.1 | Tela abre sem crash | Cards + lista (vazia ou com produtos) | | |
| 4.2 | Clicar "+ Adicionar produto" | Formulario abre | | |
| 4.3 | Preencher e salvar produto | Toast "Produto cadastrado!" + aparece na lista | | |
| 4.4 | Recarregar pagina | Produto persiste (salvou na API) | | |
| 4.5 | Buscar por nome | Filtro funciona | | |
| 4.6 | Filtrar por categoria | Filtro funciona | | |
| 4.7 | Tab "Curva ABC" | Renderiza sem crash | | |
| 4.8 | Tab "Alertas" | Renderiza sem crash | | |

### 5. CLIENTES (CRM)

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 5.1 | Tela abre sem crash | Cards + lista clientes | | |
| 5.2 | Clicar "+ Adicionar cliente" | Formulario abre | | |
| 5.3 | Preencher e salvar cliente | Cliente aparece na lista | | |
| 5.4 | Expandir ficha do cliente | Detalhes, tags, acoes | | |
| 5.5 | Tab "Ranking" | Renderiza sem crash | | |
| 5.6 | Tab "Retencao" | Renderiza sem crash | | |
| 5.7 | Buscar por nome/telefone | Filtro funciona | | |

### 6. CONTABILIDADE

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 6.1 | Tela abre sem crash | Hero ring + checkpoints | | |
| 6.2 | Ring mostra progresso | Porcentagem visivel (ex: 0/8 ou 4/8) | | |
| 6.3 | Streak bar visivel | "X meses consecutivos" | | |
| 6.4 | Clicar checkpoint "Pagar DAS" | Guia abre com steps (NAO tela branca) | | |
| 6.5 | Marcar steps como feitos | Progresso atualiza no ring | | |
| 6.6 | Tab "Guias" | Titulo: "Aura facilita, voce resolve" + Subtitulo: "Passo a passo com apoio da Aura" | | |
| 6.7 | Tab "Historico" | Timeline + obrigacoes concluidas | | |
| 6.8 | Aviso "estimativa" visivel | Rodape com disclaimer legal | | |

### 7. PDV / CAIXA

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 7.1 | Tela abre sem crash | Grid de produtos (mock ou reais) + carrinho | | |
| 7.2 | Produtos aparecem | Lista com pelo menos os mock products | | |
| 7.3 | Clicar produto | Adiciona ao carrinho com quantidade 1 | | |
| 7.4 | Clicar mesmo produto novamente | Quantidade incrementa para 2 | | |
| 7.5 | Ajustar quantidade (+/-) | Total recalcula corretamente | | |
| 7.6 | Remover item (x) | Item sai do carrinho | | |
| 7.7 | Selecionar pagamento (Pix/Dinheiro/Cartao/Debito) | Chip ativo muda | | |
| 7.8 | Finalizar venda | Tela de sucesso com #ID + total + metodo | | |
| 7.9 | "Nova venda" | Reseta carrinho, volta ao grid | | |
| 7.10 | Scanner: digitar codigo de barras | Produto encontrado ou busca por codigo | | |

### 8. PLANOS / BILLING

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 8.1 | Tela abre sem crash | 3 planos + add-ons + trial banner | | |
| 8.2 | Trial banner visivel | "Trial ativo - XX dias restantes" (verde/amarelo) | | |
| 8.3 | Plano atual marcado | Borda verde + texto "Plano atual" no botao | | |
| 8.4 | Toggle Mensal/Anual | Precos atualizam com badge "15% OFF" | | |
| 8.5 | Add-ons visiveis | Modulo Vertical R$69, Usuario R$19, Consultoria R$149/h | | |
| 8.6 | Clicar "Escolher plano" em outro plano | Feedback: "Processando..." ou toast de sucesso/erro | | |

### 9. NAVEGACAO

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 9.1 | Sidebar desktop | Todas as abas visiveis, sem crash ao clicar | | |
| 9.2 | NF-e | Abre sem crash | | |
| 9.3 | Folha | Abre sem crash | | |
| 9.4 | Canal Digital | Abre sem crash | | |
| 9.5 | WhatsApp | Abre sem crash | | |
| 9.6 | Agendamento | Abre sem crash | | |
| 9.7 | Agentes IA | Abre sem crash | | |
| 9.8 | Configuracoes | Abre sem crash | | |
| 9.9 | Suporte (Analista) | Abre sem crash | | |
| 9.10 | Trocar tema (dark/light) | Tema muda sem crash, pagina recarrega | | |
| 9.11 | Logout | Volta para login em dark mode | | |
| 9.12 | Login apos logout | Dashboard direto (sem onboarding) | | |

### 10. RESPONSIVIDADE

| # | Teste | Esperado | Resultado | Comentario |
|---|-------|----------|-----------|------------|
| 10.1 | Desktop (1920px) | Layout wide, sidebar fixa, grid KPIs em row | | |
| 10.2 | Tablet (768px) | Layout adapta, sidebar colapsavel | | |
| 10.3 | Mobile (375px) — Dashboard | CTAs sem overflow, KPIs empilham | | |
| 10.4 | Mobile (375px) — Contabilidade | Header gamification sem overflow | | |
| 10.5 | Mobile (375px) — Analista (Suporte) | Conteudo sem overflow horizontal | | |
| 10.6 | Mobile (375px) — Agentes IA | Cards sem overflow, layout empilhado | | |
| 10.7 | Mobile (375px) — PDV | Grid produtos + carrinho empilhados | | |
| 10.8 | Mobile (375px) — Financeiro | Tabs e lista sem overflow | | |

---

## Criterios de Aprovacao

- **AUTH**: 100% dos testes 1.1-1.12 passando
- **Core (2-7)**: 90%+ dos testes passando, zero crashes
- **Billing (8)**: Trial banner visivel, plano correto marcado
- **Navegacao (9)**: Zero crashes em todas as telas
- **Responsividade (10)**: Zero overflow horizontal em mobile 375px

## Notas para o testador

1. Sempre testar em **aba anonima** (Ctrl+Shift+N) para evitar cache
2. Se algo nao funcionar, verificar **Console do navegador** (F12 > Console) e anotar erros vermelhos
3. Anotar bugs com: tela + acao + resultado esperado vs obtido
4. Feedback de UX tambem e valioso (textos confusos, botoes pequenos, etc)
