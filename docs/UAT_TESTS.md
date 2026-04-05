# AURA — Plano de Testes UAT
## 111 cenarios de teste | Todas as funcionalidades
### Atualizado: 05/04/2026

---

## Formato dos testes

```
UAT-XXX | [Modulo] Nome do teste
Pre-condicao: ...
Passos:
  1. ...
  2. ...
Resultado esperado: ...
Severidade: Critica | Alta | Media | Baixa
```

---

## 1. AUTENTICACAO (UAT-001 a UAT-012)

### UAT-001 | Registro com dados validos
Pre-condicao: Nenhuma conta com o email
Passos: 1. Acessar /register 2. Preencher nome, email, senha (8+ chars), nome empresa 3. Clicar Cadastrar
Resultado: Conta criada, redirecionado ao onboarding, token JWT retornado
Severidade: Critica

### UAT-002 | Registro com email duplicado
Pre-condicao: Email ja cadastrado
Passos: 1. Tentar registrar com mesmo email
Resultado: Erro 409 "Email ja cadastrado"
Severidade: Critica

### UAT-003 | Login com credenciais validas
Passos: 1. Acessar /login 2. Email + senha corretos 3. Clicar Entrar
Resultado: Token retornado, redirecionado ao dashboard, dados do usuario e empresa no response
Severidade: Critica

### UAT-004 | Login com senha incorreta
Resultado: Erro 401 "Credenciais invalidas", audit log registrado
Severidade: Critica

### UAT-005 | Refresh token
Pre-condicao: Logado, access token expirado
Passos: 1. Fazer request com token expirado 2. Sistema automaticamente usa refresh
Resultado: Novo access token emitido sem re-login
Severidade: Critica

### UAT-006 | Logout revoga refresh
Passos: 1. Fazer logout 2. Tentar usar refresh token antigo
Resultado: Refresh token invalido, obriga re-login
Severidade: Alta

### UAT-007 | Rate limit login
Passos: 1. Tentar login errado 6x em 1 min
Resultado: Bloqueado com 429 apos 5 tentativas
Severidade: Alta

### UAT-008 | Access code beta
Passos: 1. Registrar com access code tipo beta 2. Verificar plano aplicado
Resultado: Plano do code aplicado, trial ativo se configurado
Severidade: Media

### UAT-009 | 2FA setup
Passos: 1. POST /auth/2fa/setup 2. Escanear QR no Google Authenticator 3. Enviar codigo para /auth/2fa/verify
Resultado: 2FA ativado, 8 backup codes retornados
Severidade: Alta

### UAT-010 | 2FA login flow
Pre-condicao: 2FA ativo
Passos: 1. Login com email/senha 2. Receber requires_2fa:true 3. Enviar TOTP code
Resultado: Login completo apos validacao do codigo
Severidade: Alta

### UAT-011 | 2FA backup code
Passos: 1. Usar backup code ao inves de TOTP
Resultado: Login OK, backup code consumido, saldo decrementado
Severidade: Media

### UAT-012 | Multi-tenant isolation
Pre-condicao: 2 empresas diferentes
Passos: 1. Logado como empresa A 2. Tentar acessar dados empresa B
Resultado: Erro 403, nenhum dado vazado
Severidade: Critica

---

## 2. FINANCEIRO (UAT-013 a UAT-025)

### UAT-013 | Lancamento receita
Passos: 1. Financeiro > Lancamentos > + Receita 2. Preencher descricao, valor, data 3. Salvar
Resultado: Lancamento criado, saldo atualizado, aparece na lista
Severidade: Critica

### UAT-014 | Lancamento despesa
Similar ao UAT-013 com tipo despesa
Severidade: Critica

### UAT-015 | Lancamento em lote (CSV)
Passos: 1. Upload CSV com 10 lancamentos 2. Confirmar preview
Resultado: 10 lancamentos criados, totais corretos
Severidade: Alta

### UAT-016 | DRE gerencial
Passos: 1. Acessar aba DRE 2. Selecionar periodo
Resultado: Receitas, despesas, lucro/prejuizo calculados corretamente
Severidade: Alta

### UAT-017 | Minha Retirada waterfall
Passos: 1. Acessar Minha Retirada 2. Ajustar slider pro-labore
Resultado: Waterfall atualiza em tempo real, valores coerentes
Severidade: Media

### UAT-018 | Conciliacao bancaria - import
Passos: 1. Cadastrar conta bancaria 2. Importar extrato CSV 3. Verificar dedup
Resultado: Entradas importadas, duplicatas ignoradas, batch_id gerado
Severidade: Alta

### UAT-019 | Conciliacao bancaria - auto match
Pre-condicao: Extrato importado + lancamentos na Aura
Passos: 1. Clicar "Conciliar automatico"
Resultado: Matches por valor+data encontrados, taxa de conciliacao exibida
Severidade: Alta

### UAT-020 | Conciliacao bancaria - match manual
Passos: 1. Selecionar entrada do extrato 2. Selecionar lancamento Aura 3. Vincular
Resultado: Match manual registrado, status atualizado
Severidade: Media

### UAT-021 | NFC-e emissao
Pre-condicao: NFC-e configurada
Passos: 1. Emitir NFC-e com items 2. Verificar numero auto-incrementado
Resultado: NFC-e autorizada (homologacao), chave acesso gerada
Severidade: Alta

### UAT-022 | NFC-e cancelamento
Passos: 1. Cancelar NFC-e autorizada com motivo
Resultado: Status cancelada, motivo registrado
Severidade: Media

### UAT-023 | Marketplace conexao
Passos: 1. Conectar plataforma (ex: Mercado Livre) 2. Verificar status ativo
Resultado: Conexao criada com taxa pre-configurada
Severidade: Media

### UAT-024 | Marketplace import pedidos
Passos: 1. Importar pedidos do marketplace 2. Verificar calculo de taxa
Resultado: Pedidos importados, fee calculado, net revenue correto, dedup funciona
Severidade: Alta

### UAT-025 | R2 upload + retention
Passos: 1. Upload XML NF-e 2. Tentar deletar antes de 5 anos
Resultado: Upload OK, delete bloqueado com erro Art. 174 CTN
Severidade: Media

---

## 3. PDV E ESTOQUE (UAT-026 a UAT-035)

### UAT-026 | Venda rapida PDV
Passos: 1. Buscar produto 2. Adicionar ao carrinho 3. Finalizar venda
Resultado: Venda registrada, estoque decrementado, transacao criada
Severidade: Critica

### UAT-027 | Estoque minimo alerta
Pre-condicao: Produto com estoque = 3, minimo = 5
Resultado: Badge "Baixo" visivel, alerta no dashboard
Severidade: Alta

### UAT-028 | Variantes de produto
Passos: 1. Criar produto 2. Adicionar variante (cor/tamanho) 3. Verificar estoque separado
Resultado: Variantes com estoque independente
Severidade: Media

### UAT-029 | Curva ABC
Passos: 1. Acessar ranking produtos
Resultado: Classificacao A/B/C baseada em receita, percentuais corretos
Severidade: Media

### UAT-030 | Import CSV produtos
Passos: 1. Upload CSV com 50 produtos
Resultado: 50 produtos importados, campos mapeados
Severidade: Media

### UAT-031 | Scanner codigo barras
Passos: 1. Escanear EAN-13 2. Produto localizado
Resultado: Produto encontrado e adicionado ao carrinho
Severidade: Media

### UAT-032 | Etiqueta de preco
Passos: 1. Selecionar produtos 2. Gerar etiquetas
Resultado: PDF gerado com etiquetas formatadas
Severidade: Baixa

### UAT-033 | PDV offline
Passos: 1. Desconectar internet 2. Fazer venda 3. Reconectar
Resultado: Venda salva local, sincronizada ao reconectar
Severidade: Alta

### UAT-034 | Marketplace product mapping
Passos: 1. Vincular produto Aura ao listing ML 2. Verificar sync
Resultado: Mapeamento criado, preco/estoque sincronizavel
Severidade: Media

### UAT-035 | Marketplace order tracking
Passos: 1. Atualizar status pedido ML para "enviado" 2. Adicionar tracking
Resultado: Status atualizado, shipped_at registrado
Severidade: Media

---

## 4. CONTABILIDADE (UAT-036 a UAT-042)

### UAT-036 | Calendario fiscal
Passos: 1. Acessar contabilidade 2. Verificar obrigacoes do mes
Resultado: Lista de obrigacoes com prazos, status por cor
Severidade: Alta

### UAT-037 | DAS estimado
Passos: 1. Ver DAS do mes 2. Verificar QR Code Pix
Resultado: Valor estimado correto por regime, QR funcional
Severidade: Alta

### UAT-038 | Alertas de prazo
Pre-condicao: Obrigacao vence em 3 dias
Resultado: Alerta amarelo visivel no dashboard e contabilidade
Severidade: Alta

### UAT-039 | Checkpoint streak
Passos: 1. Completar obrigacao 2. Verificar streak incrementou
Resultado: Streak atualizado, animacao de confetti
Severidade: Baixa

### UAT-040 | Limite faturamento MEI
Pre-condicao: Faturamento proximo de R$81k
Resultado: Alerta no dashboard com percentual usado
Severidade: Alta

### UAT-041 | DASN-SIMEI consolidacao
Passos: 1. Acessar DASN-SIMEI 2. Verificar valores consolidados
Resultado: Faturamento anual correto, link portal pre-preenchido
Severidade: Media

### UAT-042 | Linguagem fiscal
Passos: 1. Revisar todos os textos de contabilidade
Resultado: Sempre "estimativa" e "apoio contabil", nunca "declaracao oficial"
Severidade: Critica

---

## 5. CRM (UAT-043 a UAT-050)

### UAT-043 | Cadastro cliente completo
Passos: 1. + Cliente 2. Preencher nome, tel, email, aniversario, Instagram
Resultado: Cliente criado com todos os campos
Severidade: Alta

### UAT-044 | Ranking LTV
Resultado: Clientes ordenados por valor total gasto, top 10 destacados
Severidade: Media

### UAT-045 | Retencao novos vs voltando
Resultado: Dashboard mostra taxa retencao, novos vs recorrentes
Severidade: Media

### UAT-046 | Aniversariantes
Resultado: Lista de aniversariantes proximos 7 dias
Severidade: Baixa

### UAT-047 | Google review redirect
Passos: 1. Enviar link avaliacao 2. Cliente avalia 5 estrelas
Resultado: Redirect para Google sem review gating
Severidade: Media

### UAT-048 | Import clientes CSV
Passos: 1. Upload CSV 2. Mapear colunas
Resultado: Clientes importados sem duplicatas
Severidade: Media

### UAT-049 | Tags automaticas
Resultado: Tags baseadas em comportamento (frequente, inativo, VIP)
Severidade: Baixa

### UAT-050 | Ficha completa
Passos: 1. Abrir ficha do cliente
Resultado: Todas as vendas, LTV, ultima compra, tags visiveis
Severidade: Alta

---

## 6. ODONTOLOGIA (UAT-051 a UAT-070)

### UAT-051 | Cadastro paciente com LGPD
Passos: 1. + Paciente 2. Preencher dados 3. Aceitar LGPD Art.11
Resultado: Paciente criado com lgpd_consent=true
Severidade: Critica

### UAT-052 | Odontograma - marcar carie
Passos: 1. Selecionar dente 36 2. Face O 3. Status carie
Resultado: Dente muda cor vermelha, registro salvo
Severidade: Alta

### UAT-053 | Orcamento digital
Passos: 1. Criar orcamento 2. Adicionar 3 procedimentos 3. Aplicar desconto
Resultado: Total calculado, desconto aplicado
Severidade: Alta

### UAT-054 | Orcamento aprovacao
Passos: 1. Aprovar orcamento 2. Gerar parcelas
Resultado: Status aprovado, parcelas criadas
Severidade: Alta

### UAT-055 | Anamnese 4 steps
Passos: 1. Iniciar anamnese 2. Preencher 4 etapas 3. Confirmar LGPD
Resultado: Dados salvos como JSONB estruturado
Severidade: Alta

### UAT-056 | Timeline prontuario
Resultado: Historico unificado consultas + procedimentos + receitas em timeline visual
Severidade: Media

### UAT-057 | Agenda por cadeira
Resultado: Visualizacao colunas = cadeiras, slots por horario
Severidade: Alta

### UAT-058 | Receituario
Passos: 1. Criar receita 2. Tipo receituario
Resultado: Documento salvo, disponivel no prontuario
Severidade: Media

### UAT-059 | Convenio cadastro + TUSS
Passos: 1. Cadastrar convenio 2. Adicionar 5 procedimentos TUSS
Resultado: Convenio com tabela de precos diferenciados
Severidade: Media

### UAT-060 | Guia TISS criacao
Passos: 1. Criar guia GTO 2. Vincular paciente + convenio + procedimentos
Resultado: Guia com numero auto, total calculado
Severidade: Media

### UAT-061 | Guia TISS status
Passos: 1. Enviar guia 2. Marcar autorizada 3. Verificar valor autorizado
Resultado: Status atualizado, timestamps corretos
Severidade: Media

### UAT-062 | Periograma registro
Passos: 1. Registrar sondagem 32 dentes 2. 6 sites por dente
Resultado: Indice sangramento calculado, cores por profundidade
Severidade: Media

### UAT-063 | Periograma historico
Resultado: Comparativo entre exames anteriores
Severidade: Baixa

### UAT-064 | Ficha especialidade
Passos: 1. Criar ficha ortodontia 2. Preencher classificacao Angle
Resultado: Ficha salva com JSONB por especialidade
Severidade: Media

### UAT-065 | Lista espera
Passos: 1. Adicionar paciente urgente 2. Verificar priorizacao
Resultado: Paciente urgente aparece primeiro
Severidade: Media

### UAT-066 | Check-in manual
Passos: 1. + Check-in 2. Nome paciente
Resultado: Status "Chegou", timestamp registrado
Severidade: Media

### UAT-067 | Check-in QR code
Passos: 1. Paciente escaneia QR 2. Preenche nome 3. Confirma
Resultado: Check-in registrado como metodo "qrcode"
Severidade: Media

### UAT-068 | Agendamento online dental
Passos: 1. Acessar link publico 2. Escolher profissional + servico + horario 3. Enviar
Resultado: Solicitacao criada com status pendente
Severidade: Media

### UAT-069 | Lab order tracking
Passos: 1. Criar pedido lab 2. Atualizar status enviado > producao > pronto
Resultado: Status tracked com timestamps
Severidade: Baixa

### UAT-070 | Upload imagem clinica
Passos: 1. Selecionar paciente 2. Upload foto intraoral
Resultado: Imagem vinculada ao paciente, armazenada R2
Severidade: Media

---

## 7. BARBEARIA / SALAO (UAT-071 a UAT-090)

### UAT-071 | Agenda multi-pro
Resultado: Grid colunas = profissionais, slots com cor por profissional
Severidade: Alta

### UAT-072 | Agendamento com servicos
Passos: 1. + Agendamento 2. Selecionar profissional + servico 3. Salvar
Resultado: Agendamento criado, comissao calculada
Severidade: Critica

### UAT-073 | Fila walk-in
Passos: 1. + Fila 2. Nome + servico 3. Verificar posicao
Resultado: Posicao auto-incrementada, tempo estimado exibido
Severidade: Alta

### UAT-074 | Chamar da fila
Passos: 1. Clicar Chamar 2. Verificar status
Resultado: Status "called", called_at registrado
Severidade: Alta

### UAT-075 | Profissional da vez
Passos: 1. Walk-in sem preferencia
Resultado: Profissional com menor fila sugerido
Severidade: Media

### UAT-076 | Comissao calculo
Pre-condicao: Profissional com 45% comissao
Passos: 1. Concluir atendimento R$ 100
Resultado: Comissao R$ 45 registrada
Severidade: Critica

### UAT-077 | Caixa abertura/fechamento
Passos: 1. Abrir caixa 2. Registrar vendas 3. Fechar caixa
Resultado: Saldo batido, conferencia OK
Severidade: Alta

### UAT-078 | Gorjeta
Passos: 1. Adicionar gorjeta R$ 10 no pagamento
Resultado: Gorjeta vinculada ao profissional, separada no caixa
Severidade: Media

### UAT-079 | Pacote venda
Passos: 1. Vender pacote 4 cortes 2. Usar 1 sessao
Resultado: sessions_used=1, progress bar atualizada
Severidade: Alta

### UAT-080 | Gift card criar + resgatar
Passos: 1. Criar gift card R$ 150 2. Resgatar R$ 50 com codigo
Resultado: Saldo R$ 100, codigo AURA-XXXXXXXX validado
Severidade: Alta

### UAT-081 | Clube assinatura
Passos: 1. Criar plano mensal 2. Assinar cliente
Resultado: MRR incrementado, next_billing setado
Severidade: Media

### UAT-082 | Recorrencia cliente
Passos: 1. Criar recorrencia "Joao sexta 18h" 2. Verificar na agenda
Resultado: Recorrencia ativa, dia da semana correto
Severidade: Media

### UAT-083 | Estoque uso interno
Pre-condicao: Servico com material vinculado
Passos: 1. Concluir atendimento
Resultado: Estoque do material decrementado automaticamente
Severidade: Alta

### UAT-084 | Comissao produto
Passos: 1. Profissional vende produto 2. Verificar comissao
Resultado: Comissao sobre produto registrada separadamente
Severidade: Media

### UAT-085 | Agendamento online barber
Passos: 1. Ativar 2. Acessar link publico 3. Cliente agenda
Resultado: Solicitacao criada, admin notificado
Severidade: Media

### UAT-086 | Bloqueio horario
Passos: 1. Bloquear almoco 12-13h para profissional
Resultado: Slot bloqueado na agenda, nao agendavel
Severidade: Media

### UAT-087 | Cota-parte Lei Salao
Passos: 1. Gerar fatura parceiro 2. Verificar split
Resultado: Cota parceiro + cota salao calculados com % correto
Severidade: Alta

### UAT-088 | Fidelidade pontos
Passos: 1. Ativar programa 2. Cliente gasta R$ 100 3. Verificar pontos
Resultado: Pontos creditados conforme taxa (ex: 100 pts)
Severidade: Media

### UAT-089 | Fidelidade resgate
Pre-condicao: Cliente com 500 pontos
Passos: 1. Resgatar 200 pts
Resultado: Desconto aplicado, saldo 300 pts
Severidade: Media

### UAT-090 | Controle dose
Passos: 1. Registrar uso 50ml tintura 2. Verificar estoque
Resultado: stock_fraction decrementado 50
Severidade: Media

---

## 8. FOOD SERVICE (UAT-091 a UAT-100)

### UAT-091 | Abrir mesa
Passos: 1. + Abrir mesa 2. Selecionar mesa 01 3. Qtd pessoas
Resultado: Mesa status ocupada
Severidade: Critica

### UAT-092 | Pedido para cozinha
Passos: 1. Anotar 2 itens 2. Enviar cozinha
Resultado: Pedido aparece na visao cozinha com timer
Severidade: Critica

### UAT-093 | Pedido pronto
Passos: 1. Marcar pedido pronto na cozinha
Resultado: Notificacao garcom, status atualizado
Severidade: Alta

### UAT-094 | Fechar conta
Passos: 1. Fechar conta mesa 2. Dividir pagamento
Resultado: Total correto, formas de pagamento registradas
Severidade: Critica

### UAT-095 | Delivery pedido
Passos: 1. Receber pedido delivery 2. Preparar 3. Despachar
Resultado: Status tracked, entregador vinculado
Severidade: Alta

### UAT-096 | iFood sync
Passos: 1. Conectar iFood 2. Importar pedidos
Resultado: Pedidos importados com taxa calculada
Severidade: Media

### UAT-097 | Cardapio gestao
Passos: 1. + Item 2. Preco + categoria 3. Pausar item esgotado
Resultado: Item visivel/oculto conforme status
Severidade: Alta

### UAT-098 | Garcom digital QR
Passos: 1. Gerar QR mesa 2. Cliente escaneia 3. Cliente faz pedido
Resultado: Pedido aparece na cozinha automaticamente
Severidade: Media

### UAT-099 | NFC-e food
Passos: 1. Fechar conta 2. Emitir NFC-e
Resultado: Cupom fiscal emitido vinculado a venda
Severidade: Alta

### UAT-100 | Reserva mesa
Passos: 1. Cliente reserva online 2. Confirmar 3. Alocar mesa
Resultado: Mesa pre-alocada no horario
Severidade: Media

---

## 9. ADMIN E INFRA (UAT-101 a UAT-111)

### UAT-101 | Gestao Aura dashboard
Resultado: MRR, churn, clientes ativos visiveis
Severidade: Alta

### UAT-102 | Toggle modulo vertical
Passos: 1. Ativar modulo odonto para empresa X
Resultado: Empresa X ve aba odontologia na sidebar
Severidade: Alta

### UAT-103 | Plan gate
Passos: 1. Tentar acessar CRM com plano Essencial
Resultado: Lock icon + modal upgrade
Severidade: Alta

### UAT-104 | Theme toggle
Passos: 1. Alternar dark/light
Resultado: Tema muda sem reload, persiste no localStorage
Severidade: Media

### UAT-105 | Onboarding completo
Passos: 1. Novo usuario 2. Passar 5 steps 3. Chegar ao dashboard
Resultado: Empresa criada, onboarding_step atualizado
Severidade: Critica

### UAT-106 | Toast notifications
Passos: 1. Criar lancamento 2. Verificar toast sucesso
Resultado: Toast verde aparece e some em 3s
Severidade: Baixa

### UAT-107 | Error boundary
Passos: 1. Componente com erro JS
Resultado: Tela de erro amigavel, nao crash total
Severidade: Alta

### UAT-108 | Keyboard shortcuts
Passos: 1. Pressionar Esc em modal 2. Ctrl+N para novo
Resultado: Modal fecha, novo item abre
Severidade: Baixa

### UAT-109 | Responsividade mobile
Passos: 1. Acessar em tela 375px
Resultado: Todas as telas usaveis, sem overflow horizontal
Severidade: Alta

### UAT-110 | Acessibilidade basica
Passos: 1. Navegar com screen reader 2. Verificar labels
Resultado: Todos botoes e inputs tem accessibilityLabel
Severidade: Media

### UAT-111 | Webhook signature
Passos: 1. Enviar webhook com HMAC correto 2. Enviar com HMAC errado
Resultado: Correto aceito, errado rejeitado 403
Severidade: Alta

---

## RESUMO

| Modulo | Testes | Criticos | Altos | Medios | Baixos |
|--------|--------|----------|-------|--------|--------|
| Auth | 12 | 5 | 4 | 3 | 0 |
| Financeiro | 13 | 2 | 6 | 5 | 0 |
| PDV/Estoque | 10 | 1 | 3 | 5 | 1 |
| Contabilidade | 7 | 1 | 4 | 1 | 1 |
| CRM | 8 | 0 | 2 | 4 | 2 |
| Odontologia | 20 | 1 | 3 | 14 | 2 |
| Barber/Salao | 20 | 2 | 5 | 11 | 2 |
| Food | 10 | 3 | 4 | 3 | 0 |
| Admin/Infra | 11 | 1 | 5 | 3 | 2 |
| **TOTAL** | **111** | **16** | **36** | **49** | **10** |

---

*UAT Plan compilado em 05/04/2026*
