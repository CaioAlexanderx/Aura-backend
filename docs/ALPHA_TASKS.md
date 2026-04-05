# AURA — ALPHA LAUNCH TASKS
## Roadmap para primeiros usuarios
### Criado: 05/04/2026 | Target: Abril 2026

---

## BLOQUEADOR #1 — CNPJ (Caio, esta semana)

Tudo abaixo depende do CNPJ aprovado. Assim que sair:

- [ ] Abrir conta Asaas PJ (gateway pagamentos)
- [ ] Abrir conta Cora PJ (conta corrente)
- [ ] Ativar NFE.io com certificado digital A1
- [ ] Configurar WhatsApp Business API (Meta Business Manager)
- [ ] Protocolar marca "Aura" no INPI (Classe 36 + 42)

---

## SPRINT ALPHA-1: Integracoes Backend (pos-CNPJ)
### Prioridade: CRITICA | Estimativa: 3-4 dias

### A1-01: Asaas — Gateway de pagamentos
- [ ] Configurar env vars Railway: ASAAS_API_KEY, ASAAS_WEBHOOK_SECRET
- [ ] Criar rota POST /companies/:id/billing/subscribe (plano recorrente)
- [ ] Criar rota POST /companies/:id/billing/cancel
- [ ] Criar rota GET /companies/:id/billing/status
- [ ] Implementar webhook Asaas (pagamento confirmado/falhou/cancelado)
- [ ] Subconta por empresa (split automatico)
- [ ] Cobranca Pix + boleto + cartao
- [ ] Testar ciclo completo: assinar > pagar > confirmar > renovar

### A1-02: NFE.io — Notas fiscais reais
- [ ] Configurar env vars: NFEIO_API_KEY, NFEIO_COMPANY_ID
- [ ] Substituir mock por chamadas reais em nfe routes
- [ ] Emissao NF-e em producao (homologacao primeiro)
- [ ] Cancelamento NF-e
- [ ] Download XML + armazenar no R2
- [ ] Testar emissao + cancelamento + consulta status

### A1-03: WhatsApp Business API
- [ ] Configurar env vars: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
- [ ] Implementar envio de mensagem template (cobranca, lembrete, aniversario)
- [ ] Webhook recebimento de mensagens
- [ ] Resumo diario automatico (cron 8h + 20h)
- [ ] Testar envio + recebimento + webhook

### A1-04: Cora PJ
- [ ] Configurar recebimento de repasses Asaas
- [ ] Conciliacao automatica Cora <> Asaas

---

## SPRINT ALPHA-2: Frontend — Conectar dados reais
### Prioridade: CRITICA | Estimativa: 2-3 dias

### A2-01: Dashboard com dados reais
- [ ] useQuery conectando GET /dashboard
- [ ] Sparklines com dados de 7 dias
- [ ] Quick actions funcionais
- [ ] Alertas contabeis do periodo

### A2-02: Financeiro completo
- [ ] Lancamento receita/despesa salvando na API
- [ ] Lista de lancamentos com paginacao
- [ ] DRE gerencial com periodo selecionavel
- [ ] Minha Retirada com dados reais do backend
- [ ] Conciliacao bancaria (import CSV funcional)

### A2-03: PDV funcional
- [ ] Busca produtos da API
- [ ] Carrinho persistente
- [ ] Finalizar venda (POST /pdv/sale)
- [ ] Estoque decrementado apos venda
- [ ] Offline mode (cache + sync)

### A2-04: Estoque conectado
- [ ] CRUD produtos na API
- [ ] Import/Export CSV funcional
- [ ] Variantes funcionais
- [ ] Alerta estoque minimo

### A2-05: CRM conectado
- [ ] CRUD clientes na API
- [ ] Ranking LTV funcional
- [ ] Aniversariantes da semana
- [ ] Ficha completa com historico de vendas

### A2-06: Contabilidade conectada
- [ ] Calendario fiscal com dados do regime da empresa
- [ ] DAS estimado com QR Code Pix real
- [ ] Checklist com streak persistente
- [ ] Alertas de prazo

### A2-07: Onboarding completo
- [ ] 5 steps funcionais com validacao
- [ ] CNPJ lookup real (ReceitaWS)
- [ ] Regime tributario configurando obrigacoes
- [ ] Redirect para dashboard apos completar

### A2-08: Auth flow producao
- [ ] Login/register conectados ao backend Railway
- [ ] Refresh token automatico
- [ ] Logout limpando state + cookies
- [ ] Guard de rota (nao logado > login)

---

## SPRINT ALPHA-3: Infraestrutura producao
### Prioridade: ALTA | Estimativa: 1 dia

### A3-01: Migrations Supabase
- [ ] Aplicar migrations 001 a 034 em ordem no Supabase SQL Editor
- [ ] Verificar todas as tabelas criadas
- [ ] Seed data: access codes, TUSS codes
- [ ] Backup do schema

### A3-02: Railway producao
- [ ] Env vars: ASAAS_API_KEY, NFEIO_API_KEY, WHATSAPP_TOKEN, CLAUDE_API_KEY
- [ ] Env vars: ALLOWED_ORIGINS=https://getaura.com.br,https://app.getaura.com.br
- [ ] Env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
- [ ] Verificar health check endpoint
- [ ] Verificar Sentry capturando erros

### A3-03: Cloudflare producao
- [ ] app.getaura.com.br apontando para Cloudflare Pages
- [ ] SSL/TLS Full (Strict)
- [ ] WAF rules ativas
- [ ] R2 bucket criado para XMLs
- [ ] Cache rules para assets estaticos

### A3-04: Supabase producao
- [ ] Upgrade Free > Pro (US$25/mes)
- [ ] Connection pooling habilitado
- [ ] Point-in-time recovery ativo
- [ ] RLS policies revisadas

### A3-05: CI/CD
- [ ] GitHub Actions: ci.yml com ON_ERROR_STOP=1
- [ ] Sentry releases: set-commits --ignore-missing + fetch-depth 0
- [ ] Deploy automatico Railway on push main
- [ ] Deploy automatico Cloudflare Pages on push main

---

## SPRINT ALPHA-4: Qualidade e polimento
### Prioridade: ALTA | Estimativa: 1-2 dias

### A4-01: Error handling global
- [ ] ErrorBoundary em todas as telas
- [ ] Toast de erro generico para falhas de API
- [ ] Retry automatico (React Query)
- [ ] Loading skeletons em todas as listas
- [ ] Empty states em todas as telas

### A4-02: Responsividade
- [ ] Testar todas as telas em 375px (iPhone SE)
- [ ] Testar em 768px (iPad)
- [ ] Testar em 1440px (Desktop)
- [ ] Sidebar colapsa em mobile
- [ ] Tabs com scroll horizontal em mobile

### A4-03: Performance
- [ ] Lazy loading de telas (lazyScreens.ts)
- [ ] React Query cache configurado (staleTime, cacheTime)
- [ ] Images otimizadas (logo, avatars)
- [ ] Bundle size < 2MB web

### A4-04: Seguranca pre-lancamento
- [ ] Revisar CORS origins (so dominios permitidos)
- [ ] Rate limiting em todas as rotas publicas
- [ ] Webhook HMAC ativo
- [ ] PII masking no Sentry
- [ ] httpOnly cookies em producao
- [ ] CSP headers no Cloudflare

### A4-05: Testes criticos
- [ ] Implementar UAT-001 a UAT-006 (auth — criticos)
- [ ] Implementar UAT-012 (multi-tenant — critico)
- [ ] Implementar UAT-013/014 (lancamentos — criticos)
- [ ] Implementar UAT-026 (PDV venda — critico)
- [ ] Implementar UAT-042 (linguagem fiscal — critico)
- [ ] Implementar UAT-105 (onboarding — critico)
- [ ] Manual: testar fluxo completo registro > onboarding > venda > lancamento > DRE

---

## SPRINT ALPHA-5: Go-live
### Prioridade: CRITICA | Estimativa: 1 dia

### A5-01: Primeiro usuario beta
- [ ] Criar access code "ALPHA" com trial 30 dias plano Negocio
- [ ] Convidar 3-5 MEIs do Vale do Paraiba
- [ ] Acompanhar onboarding presencialmente
- [ ] Coletar feedback na primeira semana

### A5-02: Monitoramento
- [ ] Sentry alertas configurados (email Caio)
- [ ] Railway logs monitorados
- [ ] Supabase dashboard revisado diariamente
- [ ] Metricas: DAU, tempo sessao, features mais usadas

### A5-03: Documentacao usuario
- [ ] FAQ no site (getaura.com.br — ja tem)
- [ ] Tooltips primeira vez ativas (TooltipBanner)
- [ ] DemoTour funcional no primeiro acesso
- [ ] WhatsApp suporte ativo

### A5-04: Legal
- [ ] Contrato SaaS publicado no site
- [ ] Politica de Privacidade (LGPD)
- [ ] Termos de Uso
- [ ] Consentimento LGPD no onboarding

---

## CHECKLIST PRE-LANCAMENTO

### Bloqueadores (DEVE estar pronto)
- [ ] CNPJ aprovado
- [ ] Asaas configurado e testado
- [ ] Migrations aplicadas no Supabase
- [ ] Login > Onboarding > Dashboard funcional end-to-end
- [ ] PDV fazendo venda real
- [ ] Lancamento financeiro salvando
- [ ] DRE calculando corretamente
- [ ] Contabilidade mostrando obrigacoes do regime
- [ ] Linguagem fiscal 100% "estimativa" (nunca "oficial")

### Importantes (DEVERIA estar pronto)
- [ ] NF-e emitindo em homologacao
- [ ] WhatsApp enviando lembretes
- [ ] CRM com cadastro + ranking
- [ ] Estoque com import CSV
- [ ] Folha calculando INSS/IRRF
- [ ] Canal Digital com mini-site
- [ ] Theme toggle dark/light
- [ ] Offline PDV

### Nice-to-have (pode esperar)
- [ ] IA agentes
- [ ] Modulos verticais (odonto/barber/food)
- [ ] Conciliacao bancaria
- [ ] Marketplaces
- [ ] NFC-e
- [ ] 2FA
- [ ] Reserve with Google

---

## TIMELINE ESTIMADA

```
Semana 1 (07-11/04): CNPJ sai + ALPHA-1 (integracoes)
                      Caio: Asaas + Cora + NFE.io + WhatsApp
                      Claude: Rotas de billing + webhook

Semana 2 (14-18/04): ALPHA-2 (frontend conecta)
                      Claude: Dashboard + Financeiro + PDV + CRM
                      Caio: Migrations Supabase + env vars

Semana 3 (21-25/04): ALPHA-3 + ALPHA-4 (infra + polimento)
                      Claude: Error handling + testes criticos
                      Caio: Cloudflare + Supabase Pro

Semana 4 (28/04-02/05): ALPHA-5 (go-live)
                         Primeiros 3-5 usuarios beta
                         Monitoramento intensivo
```

---

## METRICAS DE SUCESSO ALPHA

| Metrica | Target |
|---------|--------|
| Usuarios beta ativos | 3-5 |
| Uptime | 99%+ |
| Erros Sentry nao resolvidos | < 5 |
| NPS primeiros usuarios | >= 8 |
| Fluxo completo sem erro | Registro > Venda > DRE |
| Tempo onboarding | < 5 min |
| Churn primeiro mes | 0% |

---

*Alpha Tasks compilado em 05/04/2026*
*Pronto para executar assim que o CNPJ sair*
