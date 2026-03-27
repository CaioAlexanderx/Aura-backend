# Aura. — Cronograma de Go-live

> Atualizado em: 26/03/2026

---

## Fase 1 — Alpha (UAT Interno)
**2 usuários controlados · semanas 1–3 após CNPJ aprovado**

Objetivo: validar integrações, funções principais e módulos verticais em ambiente real.

### Infraestrutura
- [x] Railway deployado
- [x] Cloudflare DNS + SSL ativo
- [ ] **Migrations 001–018 aplicadas no Supabase** ← pendente desta sessão
- [ ] Sentry instalado (INF-03)
- [ ] CI/CD GitHub Actions (INF-02)

### Funcionalidades Core
- [x] Auth + RBAC (JWT + requireAuth + requirePlan)
- [x] Onboarding CNPJ + detecção de regime (CORE-01)
- [x] PDV — venda atômica + baixa de estoque (PDV-01)
- [x] Financeiro — lançamentos, DRE, fluxo de caixa (FIN-01/02)
- [x] Checklist mensal inteligente (CORE-02)
- [x] 18 guias assistidos (BE-26 + GUIDE-01)
- [x] Folha de pagamento + INSS/IRRF/FGTS
- [ ] NF-e real via NFE.io (stub hoje → integração real)

### Módulos Verticais
- [x] Odontologia — odontograma interativo + prontuário (BE-25)
- [x] Barbearia/Salão — agenda + comissões (BE-11)
- [x] Food Service — KDS + cardápio + motoboys (FOOD-00 a 09)
- [ ] Protótipo v7 conectado ao backend real

### Blocker crítico
- [ ] **CNPJ aprovado no Redesim (JUCESP)** — desbloqueia tudo abaixo

---

## Fase 2 — Beta (UAT com Clientes Reais)
**5 empresas early adopters · semanas 4–8 após Alpha**

Objetivo: testar cenários reais de uso, entregas contábeis com validade legal e billing ativo.

### Integrações Reais (BE-12)
- [ ] NFE.io — emissão real de NF-e e NFS-e
- [ ] Asaas — billing recorrente (planos Essencial/Negócio/Expansão) ← requer CNPJ
- [ ] Cora PJ — conta corrente da empresa ← requer CNPJ
- [ ] WhatsApp Business API ativo (CORE-03)
- [ ] DAS MEI com QR Code Pix real

### Entregas Contábeis Reais
- [ ] DAS MEI gerado + pago via app
- [ ] PGDAS-D pré-preenchido (Simples Nacional)
- [ ] eSocial — admissão + folha mensal (guiado passo a passo)
- [ ] DASN-SIMEI via portal guiado
- [ ] Exportação PDF DRE + folha com branding Aura (CORE-05)
- [ ] Categorização automática de lançamentos via IA (CORE-04)

### Produto + Compliance
- [x] Multi-usuário RBAC (BE-09)
- [x] DPA publicado (getaura.com.br/dpa.html)
- [x] Política de Privacidade ativa
- [x] Contrato SaaS pronto
- [ ] Consentimento granular LGPD Art.11 (dados odonto)
- [ ] Supabase Free → Pro (US$25/mês) antes do go-live
- [ ] Testes unitários e de integração QA-01/02
- [ ] INPI — protocolo marca "Aura" Classe 36

### Blockers desta fase
- CNPJ aprovado (Asaas + Cora)
- NFE.io integração real
- WhatsApp API habilitada no Meta Business Manager

---

## Fase 3 — Open (Prospecção e Comercialização)
**Mercado aberto — MEI/ME do Vale do Paraíba · semanas 9–12+**

Objetivo: produto estável em produção, precificação ativa, primeiras vendas recorrentes.

### Produto Completo
- [ ] Todos os módulos core estáveis (0 bugs críticos)
- [ ] PDV-02: Pix automático + integração maquininhas
- [ ] Billing recorrente Asaas ativo e testado
- [ ] Onboarding self-service funcional (sem intervenção manual)
- [ ] Todos os 18 guias testados em cenários reais

### Go-to-Market
- [ ] getaura.com.br com pricing público
- [ ] Checkout self-service (Asaas)
- [ ] Trial gratuito de 14 dias configurado
- [ ] Aceite de Termos de Uso no fluxo de onboarding
- [ ] Google Ads / Meta Ads direcionados ao Vale do Paraíba
- [ ] Programa de indicação (R$50 por indicado convertido)

### Operação + Legal
- [ ] SLA de suporte definido (chat + e-mail, resposta em 24h úteis)
- [ ] Uptime monitoring via Sentry (INF-03)
- [ ] Backup automático Supabase Pro
- [ ] INPI — marcas Classe 36 + 42 protocoladas

---

## Status dos Blockers Globais

| Blocker | Status | Desbloqueia |
|---------|--------|-------------|
| CNPJ aprovado (Redesim/JUCESP) | 🔴 Em análise | Asaas, Cora PJ, billing |
| Migrations 016–018 aplicadas | 🟡 Pendente (manual) | FIN-01/02, GUIDE-01, PDV-01 |
| Integrações reais (NFE.io, Asaas, WhatsApp) | 🔴 Aguarda CNPJ | Beta completo |

---

## Migrations Pendentes de Aplicação Manual

Aplicar no **Supabase SQL Editor** na ordem:

```
migrations/016_fin_prolabore_dre.sql
migrations/017_guide_configs_fin.sql
migrations/018_pdv_sale_payments.sql
```

---

## Backlog por Fase

### Alpha (sem blocker de CNPJ)
- `INF-02` CI/CD GitHub Actions
- `INF-03` Sentry + monitoring
- `CORE-04` Categorização IA (Claude Haiku)
- `CORE-05` Exportação PDF/Excel com branding
- `QA-01/02` Testes unitários + integração

### Beta (pós-CNPJ)
- `PDV-02` Pix automático + maquininhas
- `CORE-03` WhatsApp automático (resumo diário)
- `BE-12` Integração real NFE.io + Asaas + WhatsApp

### Open
- Módulos verticais adicionais (Pet Shop, Estética, Academia)
- App mobile (PWA)
- Parceria com contadores locais
- ISO 27001 roadmap (longo prazo)
