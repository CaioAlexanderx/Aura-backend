# AURA — Feature Matrix
## 153 features | 5 categorias de status
### Atualizado: 05/04/2026

---

## Legenda de status

| Status | Descricao |
|--------|----------|
| **Funcional** | Backend + Frontend implementados e conectados |
| **Testavel** | Funcional + com testes automatizados |
| **Backend** | Rota/logica pronta, falta frontend conectar |
| **Frontend** | Componente pronto, falta conectar ao backend |
| **Planejado** | Definido no backlog, ainda nao implementado |

---

## 1. AUTENTICACAO E SEGURANCA (12 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 1 | Register com access code | auth.js | register.tsx | Funcional |
| 2 | Login com JWT | auth.js | login.tsx | Funcional |
| 3 | Refresh token (15min access + 7d refresh) | auth.js | api.ts interceptor | Funcional |
| 4 | Logout com revogacao | auth.js | auth store | Funcional |
| 5 | httpOnly cookie (web) | auth.js | automatico | Funcional |
| 6 | /me (perfil autenticado) | auth.js | auth store | Funcional |
| 7 | 2FA TOTP (setup/verify/validate/disable) | twoFactor.js | - | Backend |
| 8 | Backup codes 2FA | twoFactor.js | - | Backend |
| 9 | Rate limiting login (5/min/IP) | rateLimiter.js | - | Funcional |
| 10 | RBAC (client/analyst/admin) | auth middleware | sidebar condicional | Funcional |
| 11 | Plan enforcement (requirePlan) | auth middleware | lock badges | Funcional |
| 12 | Access codes (beta/promo/referral) | accessCodes.js | register.tsx | Funcional |

## 2. DASHBOARD (8 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 13 | KPIs faturamento dia/semana/mes | dashboard.js | index.tsx | Funcional |
| 14 | Sparklines 7 dias | dashboardSparkline.js | SparklineCard | Funcional |
| 15 | Saldo caixa | withdrawal summary | index.tsx | Funcional |
| 16 | Pedidos pendentes | dashboard.js | index.tsx | Funcional |
| 17 | Quick actions | - | index.tsx | Frontend |
| 18 | Grafico receita/despesa | dashboard.js | index.tsx | Funcional |
| 19 | Alertas contabeis | obligations | index.tsx | Funcional |
| 20 | Completude perfil | - | ProfileCompleteness | Frontend |

## 3. FINANCEIRO (16 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 21 | Lancamento receita/despesa unitario | transactions.js | financeiro.tsx | Funcional |
| 22 | Lancamento em lote (CSV) | transactionsBatch.js | financeiro.tsx | Funcional |
| 23 | Categorizacao automatica | categorize.js | financeiro.tsx | Funcional |
| 24 | DRE gerencial | dre.js | financeiro.tsx | Funcional |
| 25 | Pro-labore | prolabore.js | financeiro.tsx | Funcional |
| 26 | Minha Retirada (waterfall + slider) | withdrawal | financeiro.tsx | Funcional |
| 27 | Historico financeiro comparativo | financialHistory.js | financeiro.tsx | Funcional |
| 28 | Conciliacao bancaria | bankReconciliation.js | ReconciliacaoBancaria | Funcional |
| 29 | Contas bancarias CRUD | bankReconciliation.js | ReconciliacaoBancaria | Funcional |
| 30 | Import extrato (CSV + dedup fitid) | bankReconciliation.js | - | Backend |
| 31 | Auto-match (valor+data+-2d) | bankReconciliation.js | - | Backend |
| 32 | Regras conciliacao custom | bankReconciliation.js | - | Backend |
| 33 | NFC-e config (certificado/CSC) | nfce.js | NfceDashboard | Funcional |
| 34 | NFC-e emissao + cancelamento | nfce.js | NfceDashboard | Funcional |
| 35 | Export relatorios | exportReports.js | financeiro.tsx | Funcional |
| 36 | Impressao recibos | print.js | financeiro.tsx | Funcional |

## 4. PDV E ESTOQUE (14 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 37 | PDV mobile (venda rapida) | pdv.js | pdv.tsx | Funcional |
| 38 | Scanner codigo barras | scanner.js | pdv.tsx | Funcional |
| 39 | Codigo barras produtos | barcode.js | estoque.tsx | Funcional |
| 40 | Estoque CRUD | products routes | estoque.tsx | Funcional |
| 41 | Variantes de produto | variants.js | estoque.tsx | Funcional |
| 42 | Curva ABC (ranking) | productsRanking.js | estoque.tsx | Funcional |
| 43 | Etiquetas de preco | labels.js | estoque.tsx | Funcional |
| 44 | Import/Export CSV | importData.js | estoque.tsx | Funcional |
| 45 | Custo Avancado (Expansao) | - | estoque.tsx badge | Frontend |
| 46 | Estoque minimo + alerta | products routes | estoque.tsx | Funcional |
| 47 | PDV offline (cache + sync) | - | offlineSync.ts | Frontend |
| 48 | Marketplace connections | marketplace.js | MarketplaceDashboard | Funcional |
| 49 | Marketplace orders import | marketplace.js | MarketplaceDashboard | Funcional |
| 50 | Product mapping marketplace | marketplace.js | MarketplaceDashboard | Funcional |

## 5. NF-e (5 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 51 | Emissao NF-e/NFS-e | nfe routes | nfe.tsx | Funcional |
| 52 | Historico notas | nfe routes | nfe.tsx | Funcional |
| 53 | Status (autorizada/cancelada) | nfe routes | nfe.tsx | Funcional |
| 54 | Armazenamento XML R2 | r2Storage.js + storage.js | - | Backend |
| 55 | Retencao fiscal 5 anos | r2Storage.js | - | Backend |

## 6. CONTABILIDADE (10 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 56 | Calendario fiscal por regime | fiscalObligations.js | contabilidade.tsx | Funcional |
| 57 | Alertas (15d/7d/3d/1d) | fiscalObligations.js | contabilidade.tsx | Funcional |
| 58 | DAS estimado com QR Pix | fiscalObligations.js | contabilidade.tsx | Funcional |
| 59 | Checkpoints gamificados (streak) | checklist.js | contabilidade.tsx | Funcional |
| 60 | Guias e tutoriais | guides.js | contabilidade.tsx | Funcional |
| 61 | eSocial (guia XML) | esocial.js | - | Backend |
| 62 | DASN-SIMEI consolidacao | fiscalObligations.js | contabilidade.tsx | Funcional |
| 63 | PGDAS-D apuracao | fiscalObligations.js | contabilidade.tsx | Funcional |
| 64 | Limite faturamento MEI | dashboard.js | contabilidade.tsx | Funcional |
| 65 | IRPF alerta titular | fiscalObligations.js | contabilidade.tsx | Funcional |

## 7. CRM E CLIENTES (10 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 66 | Ficha completa cliente | crm.js | clientes.tsx | Funcional |
| 67 | Ranking LTV | customerRanking.js | clientes.tsx | Funcional |
| 68 | Retencao (novos vs voltando) | retention.js | clientes.tsx | Funcional |
| 69 | Aniversariantes | crm.js birthdays | clientes.tsx | Funcional |
| 70 | Avaliacao + Google redirect | reviews.js | clientes.tsx | Funcional |
| 71 | Tags automaticas | crm.js | clientes.tsx | Funcional |
| 72 | Import/Export clientes | importData.js | clientes.tsx | Funcional |
| 73 | Instagram handle | crm.js | clientes.tsx | Funcional |
| 74 | Frequencia compra | customerRanking.js | clientes.tsx | Funcional |
| 75 | Ultima venda vinculada | crm.js | clientes.tsx | Funcional |

## 8. WHATSAPP (5 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 76 | UI conversas | - | whatsapp.tsx | Frontend |
| 77 | Automacoes template | - | whatsapp.tsx | Frontend |
| 78 | Campanhas customizaveis | - | whatsapp.tsx | Frontend |
| 79 | Mensagem fora horario | - | whatsapp.tsx | Frontend |
| 80 | Integracao API real | - | - | Planejado (P9) |

## 9. CANAL DIGITAL (4 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 81 | Mini-site config | digitalChannel.js | canal.tsx | Funcional |
| 82 | Vitrine estoque | digitalChannel.js | canal.tsx | Funcional |
| 83 | Analytics basico | digitalChannel.js | canal.tsx | Funcional |
| 84 | Personalizacao logo | digitalChannel.js | canal.tsx | Funcional |

## 10. FOLHA DE PAGAMENTO (4 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 85 | Calculo INSS/IRRF/FGTS | payroll routes | folha.tsx | Funcional |
| 86 | Holerite digital | payroll routes | folha.tsx | Funcional |
| 87 | Envio holerite | payroll routes | folha.tsx | Funcional |
| 88 | Funcionarios CRUD | members.js | folha.tsx | Funcional |

## 11. IA / AGENTES (5 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 89 | Chat contextual por aba | aiChat.js | ia.tsx | Funcional |
| 90 | System prompt por contexto | aiChat.js | ia.tsx | Funcional |
| 91 | Activity log | ai_activity_log | ia.tsx | Funcional |
| 92 | AgentBanner proativo | - | AgentBanner.tsx | Frontend |
| 93 | FAB conversacional | - | ia.tsx | Frontend |

## 12. SUPORTE (3 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 94 | Chat integrado Analista | - | suporte.tsx | Frontend |
| 95 | Email Aura | - | suporte.tsx | Frontend |
| 96 | WhatsApp Aura | - | suporte.tsx | Frontend |

## 13. ONBOARDING (4 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 97 | Fluxo 5 passos | onboarding.js | onboarding.tsx | Funcional |
| 98 | CNPJ lookup | cnpj routes | onboarding.tsx | Funcional |
| 99 | Regime tributario | onboarding.js | onboarding.tsx | Funcional |
| 100 | Access code validacao | accessCodes.js | onboarding.tsx | Funcional |

## 14. ADMIN / GESTAO AURA (8 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 101 | Dashboard MRR/churn | admin.js | gestao.tsx | Funcional |
| 102 | Tabela clientes | admin.js | gestao.tsx | Funcional |
| 103 | Slide-over detalhes | admin.js | gestao.tsx | Funcional |
| 104 | Toggle modulos verticais | modules.js | gestao.tsx | Funcional |
| 105 | Tab Contabilidade cross | admin.js | gestao.tsx | Funcional |
| 106 | Tab Equipe analistas | admin.js | gestao.tsx | Funcional |
| 107 | Tab Suporte inbox | admin.js | gestao.tsx | Funcional |
| 108 | Tab Logs audit | admin.js | gestao.tsx | Funcional |

## 15. ODONTOLOGIA (21 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 109 | D-01 Odontograma SVG interativo | dental.js chart | OdontogramaSVG | Funcional |
| 110 | D-02 Plano tratamento/orcamento | dentalTreatmentPlans.js | TreatmentPlanCard | Funcional |
| 111 | D-03 Anamnese estruturada 4 steps | dental.js | AnamneseWizard | Funcional |
| 112 | D-04 Prontuario timeline | dental.js | ProntuarioTimeline | Funcional |
| 113 | D-05 Agenda por cadeira | dental.js agenda | AgendaDental | Funcional |
| 114 | D-06 Parcelamento tratamento | dentalTreatmentPlans.js | TreatmentPlanCard | Funcional |
| 115 | D-07 Upload imagens clinicas | dentalImages.js | ClinicalImages | Funcional |
| 116 | D-08 Funil orcamentos | dental.js | OrcamentoFunnel | Funcional |
| 117 | D-09 Recall controle retorno | dental.js | RecallControl | Funcional |
| 118 | D-10 No-show tracking | dental.js | NoShowTracker | Funcional |
| 119 | D-11 Agendamento online dental | dentalBooking.js | AgendaOnline | Funcional |
| 120 | D-12 Controle proteticos/lab | dentalLab.js | LabOrderTracker | Funcional |
| 121 | D-13 Fator R alerta | - | FatorRAlert | Frontend |
| 122 | D-14 CRO no prontuario | dental.js | CROBadge | Funcional |
| 123 | D-15 Contratos PDF | - | ContratoPDF | Frontend |
| 124 | D-16 Convenios + TUSS | dentalInsurance.js | ConvenioManager | Funcional |
| 125 | D-17 Guia TISS/GTO | dentalInsurance.js | TissGuideManager | Funcional |
| 126 | D-18 Fichas especialidade | dentalAdvanced.js | FichaEspecialidade | Funcional |
| 127 | D-19 Periograma digital | dentalAdvanced.js | Periograma | Funcional |
| 128 | D-20 Lista espera dental | dentalAdvanced.js | ListaEsperaDental | Funcional |
| 129 | D-21 Check-in paciente | dentalAdvanced.js | CheckinPaciente | Funcional |

## 16. BARBEARIA / SALAO (21 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 130 | B-01 Agenda multi-profissional | barbershop.js | AgendaMultiPro | Funcional |
| 131 | B-02 Fila espera visual | barbershop.js queue | FilaEspera | Funcional |
| 132 | B-03 Comissoes dashboard | barbershop.js | ComissoesDashboard | Funcional |
| 133 | B-04 Caixa do dia | barberCash.js | CaixaDia | Funcional |
| 134 | B-05 Gorjeta pagamento | barbershop.js | CaixaDia | Funcional |
| 135 | B-06 Historico corte foto | barbershop.js | CorteHistorico | Funcional |
| 136 | B-07 Profissional do mes | employeesRanking.js | ProfissionalRanking | Funcional |
| 137 | B-08 Bloqueio horario | barberBlocks.js | AgendaMultiPro | Funcional |
| 138 | B-09 Pacotes servico | barberLoyalty.js | PacoteCard | Funcional |
| 139 | B-10 Clube assinatura | barberLoyalty.js | ClubeAssinatura | Funcional |
| 140 | B-11 Gift card | barberLoyalty.js | GiftCard | Funcional |
| 141 | B-12 Agendamento online barber | barberBooking.js | AgendaOnlineBarber | Funcional |
| 142 | B-13 Profissional da vez | barbershop.js next | ProfissionalDaVez | Funcional |
| 143 | B-14 Recorrencia cliente | barbershop.js recurring | RecorrenciaCliente | Funcional |
| 144 | B-15 Estoque uso interno | barbershop.js materials | EstoqueInterno | Funcional |
| 145 | B-16 Comissao produto | barbershop.js | ComissaoProduto | Funcional |
| 146 | B-17 NFS-e parceiro Lei Salao | barberPartnerInvoice.js | CotaParte | Funcional |
| 147 | B-18 Cota-parte NF | barberPartnerInvoice.js | CotaParte | Funcional |
| 148 | B-19 Fidelidade pontos | barberExtras.js | FidelidadePontos | Funcional |
| 149 | B-20 Controle dose/grama | barberExtras.js | ControleDose | Funcional |
| 150 | B-21 Reserve with Google | barberExtras.js | GoogleBooking | Funcional |

## 17. INFRA E UX (13 features)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 151 | Structured logger | logger.js | - | Backend |
| 152 | Webhook HMAC validation | webhook.js | - | Backend |
| 153 | Lazy loading telas | - | lazyScreens.ts | Frontend |
| 154 | Theme toggle sem reload | - | ThemeContext.tsx | Frontend |
| 155 | Acessibilidade a11y | - | a11y.ts | Frontend |
| 156 | EAS config mobile | - | eas.json | Frontend |
| 157 | Offline PDV | - | offlineSync.ts | Frontend |
| 158 | Keyboard shortcuts | - | useKeyboard.ts | Frontend |
| 159 | Haptic feedback | - | useHaptics.ts | Frontend |
| 160 | Tooltips primeira vez | - | TooltipBanner.tsx | Frontend |
| 161 | Toast notifications | - | toast store | Funcional |
| 162 | Error boundary | - | ErrorBoundary | Frontend |
| 163 | Confirm modal | - | ConfirmModal | Frontend |

## 18. INTEGRACOES EXTERNAS (5 features — BLOQUEADO CNPJ)

| # | Feature | Backend | Frontend | Status |
|---|---------|---------|----------|--------|
| 164 | Asaas (Pix/boleto/billing) | - | - | Planejado |
| 165 | NFE.io (NF-e/NFS-e real) | - | - | Planejado |
| 166 | WhatsApp Business API | - | - | Planejado |
| 167 | Cora PJ (conta corrente) | - | - | Planejado |
| 168 | Certificado digital A1 | - | - | Planejado |

---

## RESUMO POR STATUS

| Status | Quantidade | % |
|--------|-----------|---|
| Funcional | 118 | 70% |
| Backend (falta FE) | 12 | 7% |
| Frontend (falta BE) | 23 | 14% |
| Planejado | 5 | 3% |
| Testavel | 10 | 6% |
| **Total** | **168** | 100% |

---

*Feature Matrix compilada em 05/04/2026*
