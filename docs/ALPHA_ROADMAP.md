# AURA — ALPHA ROADMAP
## 118 tasks | 7 fases sequenciais | Target: Abril 2026

Ver documento completo em /mnt/user-data/outputs/ALPHA_ROADMAP.md

## FASES
- F0: Fundacao (12 tasks - infra, migrations, Supabase Pro)
- F1: Criar Conta (17 tasks - auth end-to-end)
- F2: Dashboard e Navegacao (12 tasks)
- F3: Financeiro (11 tasks)
- F4: PDV + Estoque (11 tasks)
- F5: CRM + Contabilidade + Folha (14 tasks)
- F6: Integracoes pos-CNPJ (18 tasks - Asaas, NFE.io, WhatsApp)
- F7: Polimento + Go-live (23 tasks)

## STATUS F6 (Asaas)
- [x] billing.js (subscribe/cancel/status/invoices/pix)
- [x] webhookAsaas.js (payment events handler)
- [x] migration 035 (billing fields + webhook_logs)
- [x] Registered in private.js + index.js
- [ ] Env vars Railway (ASAAS_API_KEY, ASAAS_WEBHOOK_SECRET)
- [ ] Testar ciclo completo

## CHECKLIST PRE-LANCAMENTO
- [ ] CNPJ aprovado -> FEITO!
- [ ] Asaas configurado
- [ ] Migrations 001-035 no Supabase
- [ ] Login > Onboarding > Dashboard end-to-end
- [ ] PDV venda real
- [ ] DRE calculando
- [ ] Linguagem fiscal 100% estimativa
