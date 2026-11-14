# Recebe na Aura — checklist de Segurança da Informação (RASCUNHO)

> **Rascunho para a homologação da Asaas (RA-01, 12/11/2026).** Medido no
> código do backend (`main` em `216107a7`) e do app, só leitura. Nada foi
> consultado em produção: o que depende do painel do Railway, da Supabase ou
> da Cloudflare está marcado **a confirmar**. Este repositório é público:
> o documento não traz segredo, chave, IP, nome de cliente nem detalhe que
> sirva de roteiro de ataque.

**Legenda:** **feito** = existe no código e é usado · **parcial** = existe,
mas com lacuna conhecida · **falta** = não existe · **a confirmar** = depende
de configuração fora do repositório.

## Resumo

| Tema | Estado |
|---|---|
| 1. Cifragem de chaves e certificados | parcial |
| 2. Segredos fora do código | feito (rotação: a confirmar) |
| 3. HTTPS, cabeçalhos e CORS | parcial |
| 4. Autenticação | parcial |
| 5. Permissões e isolamento entre empresas | feito |
| 6. Controle de acesso da equipe | parcial |
| 7. Logs sem dado sensível | parcial |
| 8. Webhooks com verificação | parcial |
| 9. Backups do banco | a confirmar |
| 10. Resposta a incidente | parcial |
| 11. Dependências e esteira | falta |
| 12. Recebe na Aura atrás da flag | feito |

---

## 1. Cifragem de chaves e certificados — parcial

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Certificado A1 (.pfx) e senha | feito | AES-256-GCM com chave-mestra `CERT_MASTER_KEY` (`src/utils/secretCrypto.js:1-60`); colunas `pfx_enc`, `pfx_iv`, `password_enc` em `company_certificates` (`src/services/sefazSp/certStore.js:29-60`). A chave nunca vai ao banco, ao log nem ao Sentry (regras no topo do arquivo). | — |
| CSC da NFC-e | parcial | Grava cifrado em `csc_token_enc` e zera a coluna antiga (`src/routes/adminAuraNotas.js:493`). A leitura ainda aceita a coluna legada em claro `csc_token` (`src/services/sefazSp/index.js:61-64`). | Conferir no banco se resta `csc_token` preenchido, cifrar o que restar e retirar o fallback. |
| apiKey de subconta Asaas (dojô e Recebe na Aura) | feito | AES-256-GCM com `DOJO_BAAS_ENC_KEY` (`src/services/dojoBaasCrypto.js`), coluna `api_key_enc`; cifra na criação (`src/services/companyBaasService.js:219`, `src/services/karateDojoBaasService.js:141`). A apiKey nunca sai na resposta (`src/routes/companyRecebe.js`, cabeçalho). | Chave própria para o varejo, separada da do dojô, antes de sair do piloto. |
| Credenciais de NFS-e | feito | AES-256-GCM com `AURA_ENCRYPTION_KEY`; sem a chave em produção recusa com 500 controlado, sem chave fixa (`src/routes/nfse.js:165-200`, `__tests__/segredosFixos.recusas.test.js`). | — |
| Token do WhatsApp oficial | feito | `encrypt(accessToken)` antes de gravar (`src/routes/whatsappCloud.js:425`). | — |
| Mercado Pago por OAuth | feito | access e refresh token guardados cifrados com `CERT_MASTER_KEY` (`src/services/mpOAuth.js`, cabeçalho; `src/services/mpGateway.js`). | — |
| Mercado Pago por chave manual (legado) | falta | `access_token` gravado em claro em `companies_payment_gateways` (`src/routes/paymentGateways.js:216-236`); só a resposta da API sai mascarada. | Cifrar com o mesmo `secretCrypto` ou desligar o cadastro manual (o OAuth já existe). |
| Tokens de marketplaces e Instagram | falta | `access_token` e `refresh_token` em claro (`src/marketplaces/MarketplaceAdapter.js:69`); `ig_access_token` em claro (`migrations/061_instagram_hub_social.sql:13`). | Cifrar antes de ligar essas integrações para mais lojas. |
| Chave de provedor de pagamento do karatê | falta | `karate_payment_provider_api_key` em claro (`migrations/224_karate_payment_provider_config.sql:18`). | Cifrar ou remover se não houver uso. |
| Senhas de usuário | feito | bcrypt custo 12 (`src/routes/auth.js:510`, `src/routes/passwordReset.js:105`). | — |
| Tokens de sessão e links | feito | Refresh token guardado só como hash (`migrations/023_audit_log_refresh_tokens.sql:30`); links de portal e convites por `token_hash` (`migrations/239_karate_dojo_portal_links.sql:25`, `migrations/240_karate_dojo_owner_invites.sql:29`). | — |

## 2. Segredos fora do código — feito (rotação: a confirmar)

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Segredos só em variável de ambiente | feito | `.env*` no `.gitignore`; `.env.example` só com nomes e valores de exemplo; o boot recusa subir em produção sem `JWT_SECRET` e com `CERT_MASTER_KEY` malformada (`src/config/env.js:38-69`). | — |
| Nenhum segredo fixo no código | feito | Removidos no INC-2026-10-21-03 (tq-101): cada porta recusa sem a variável (`__tests__/segredosFixos.recusas.test.js`). | — |
| Onde ficam | a confirmar | Variáveis do serviço no Railway (deploy em `railway.toml`). | Listar quem tem acesso ao projeto no Railway e exigir 2FA nessas contas. |
| Rotação | a confirmar | Não há registro no repositório de quando cada chave foi trocada. | Manter, fora do repositório (que é público), um registro das chaves com a data da última rotação. |

## 3. HTTPS, cabeçalhos e CORS — parcial

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| HSTS na API | feito | helmet com `maxAge` de 1 ano, `includeSubDomains` e `preload` (`src/app.js`, bloco do helmet). | — |
| HSTS no painel | feito | `Strict-Transport-Security` só para `app.getaura.com.br` (`aura-app/public/_headers:51`). | — |
| Cabeçalhos de segurança | feito | API: CSP, `frameguard deny`, `nosniff`, `Referrer-Policy strict-origin-when-cross-origin` (`src/app.js`, helmet). Painel: `X-Frame-Options DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (`aura-app/public/_headers:22-25`). O Referrer-Policy nunca pode ser `no-referrer` (playbook da Asaas); teste em `__tests__/referrerPolicy.test.js` (RA-02). | — |
| CORS do painel | parcial | Lista de origens por `ALLOWED_ORIGINS`, obrigatória em produção (`src/config/env.js:46-50`), com `credentials: true` (`src/app.js:137-139`). O código ainda aceita `*` se a variável valer `*`. | Confirmar no Railway que o valor é a lista explícita; recusar `*` em produção no `env.js`. |
| CORS aberto das páginas públicas | feito | `*` só nas rotas públicas sem cookie (vitrine, aprovação de arte, acompanhamento do pedido, relatório por link), sem `Allow-Credentials` (`src/app.js`, blocos de CORS aberto). | — |
| TLS até o banco | parcial | Conexão com SSL, mas sem validar o certificado (`src/config/database.js:46`, `rejectUnauthorized: false`). | Fixar o certificado da Supabase e validar. |
| Redirecionar http para https | a confirmar | Configuração da Cloudflare e do Railway. | Conferir nos painéis. |

## 4. Autenticação — parcial

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Token de acesso | feito | JWT de 1 h (`src/routes/auth.js:143`); refresh token não serve como acesso (`src/middleware/auth.js:40-44`). | Fixar `algorithms: ['HS256']` no `jwt.verify`. |
| Refresh token | feito | Cookie `httpOnly`, `secure` e `sameSite=strict` em produção, só no caminho de auth (`src/routes/auth.js:214`); revogação no logout (`src/routes/auth.js:945`). | — |
| Onde o painel guarda o token | parcial | Na web, `localStorage`; no app nativo, `SecureStore` (`aura-app/stores/auth.ts:32-40`). | Avaliar manter o token de acesso só em memória na web (o refresh já é cookie httpOnly). |
| Limite de tentativas | feito | Login, cadastro e consulta de CNPJ com limite por IP; limite global de 600 por minuto (`src/app.js:184-220`). | — |
| 2FA | parcial | TOTP com códigos de reserva, opcional (`src/routes/twoFactor.js:87-150`). | Exigir 2FA para contas da equipe e para quem ativar o Recebe na Aura. |
| Confirmação de e-mail | feito | E-mail de verificação no cadastro (`src/routes/auth.js:726-733`, `src/routes/verification.js`). | — |

## 5. Permissões e isolamento entre empresas — feito

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Empresa da URL x usuário | feito | `requireCompanyAccess` confere o vínculo com a empresa do `:id` em toda rota privada (`src/middleware/auth.js:57`; achado B-01 de `docs/SECURITY_AUDIT.md`). | — |
| Papéis | feito | `requireRole`, `requirePlan`, `requireFeature` (`src/middleware/auth.js:112-144`). Recebe na Aura: só dono ou admin (`src/routes/companyRecebe.js:21-38`). | — |
| Multi-CNPJ | feito | Subconta por empresa, escopo sempre por `req.params.id`, nunca do corpo (`src/routes/companyRecebe.js`, cabeçalho). | — |
| Trilha de auditoria | feito | `audit_log` com usuário, empresa, ação, IP e user agent (`src/middleware/auditLog.js:52`). | Registrar também a ativação e as mudanças do Recebe na Aura. |

## 6. Controle de acesso da equipe — parcial

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Rotas internas só para a equipe | feito | `requireStaff` lê `is_staff` do token (ex.: `src/routes/adminAuraNotas.js:50-57`). | — |
| Como o acesso de equipe é concedido | parcial | A forma de concessão de `is_staff` está em revisão, tratada em PR à parte. | Concluir a revisão e conferir quem tem `is_staff` hoje. |
| Revisão periódica | falta | Sem rotina registrada. | Revisar a cada trimestre quem tem `is_staff` e quem acessa Railway, Supabase, Cloudflare, Asaas e GitHub. |

## 7. Logs sem dado sensível — parcial

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Webhook da Asaas | feito | Loga só o nome e o tamanho dos cabeçalhos de autenticação, nunca o valor (`src/routes/webhookAsaas.js:167-180`). | — |
| Segredos fiscais e apiKey | feito | Regra escrita e seguida: nunca logar texto puro (`src/utils/secretCrypto.js` e `src/services/dojoBaasCrypto.js`, cabeçalhos). | — |
| E-mail em log | parcial | A recuperação de senha loga o e-mail do usuário (`src/routes/passwordReset.js:27-29`). | Trocar pelo id do usuário. |
| Sentry | parcial | `beforeSend` só filtra ruído (404, token expirado, health), sem limpeza explícita de corpo e cabeçalhos (`src/config/sentry.js:47-60`). | Limpar `authorization`, cookies, CPF/CNPJ e dados de cartão e de conta antes do envio. |
| Diagnóstico do webhook | parcial | `GET /webhooks/asaas/_diag` responde sem autenticação com metadados da configuração (`src/routes/webhookAsaas.js:899`). | Restringir à equipe ou retirar. |

## 8. Webhooks com verificação — parcial

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Asaas (conta da Aura) | feito | Token do cabeçalho `asaas-access-token` comparado em tempo constante (`src/routes/webhookAsaas.js:189-215`); sem segredo configurado, não confia no corpo e reconsulta o pagamento na Asaas. | — |
| Asaas (subcontas BaaS) | feito | Token por subconta comparado por hash (`src/routes/karateDojoBaasWebhook.js:5-40`; `company_baas_accounts.webhook_token_hash`, migration 436). | Idempotência por id do evento nos avisos do Recebe na Aura (RA-07). |
| WhatsApp oficial | feito | Assinatura `X-Hub-Signature-256`; sem `WA_APP_SECRET`, recusa com 401 (`src/routes/webhookWhatsapp.js:67-73`). | — |
| Resend | feito | Assinatura svix, janela de 5 min; sem segredo, 503 (`src/routes/webhookResend.js:5-30`). | — |
| Mercado Pago | parcial | HMAC `x-signature` comparado em tempo constante (`src/routes/webhookMp.js:80-91`); sem segredo, cai na reverificação (`src/routes/webhookMp.js:144-154`). | Exigir o segredo em produção. |

## 9. Backups do banco — a confirmar

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Backup diário | a confirmar | Sem registro no repositório; depende do plano da Supabase. | Conferir no painel da Supabase o plano, a retenção e a data do último backup. |
| Recuperação a um ponto no tempo (PITR) | a confirmar | Item em aberto em `docs/ALPHA_TASKS.md:134`. | Decidir se liga o PITR antes da primeira subconta real. |
| Teste de restauração | falta | Sem registro de restauração testada. | Restaurar um backup num projeto separado e anotar tempo e resultado. |
| Migrations | feito | Rodam antes do deploy, e o deploy não sobe se falharem (`railway.toml`, `preDeployCommand`). | — |

## 10. Resposta a incidente — parcial

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Incidentes registrados | parcial | Houve um incidente de exposição de variáveis de ambiente no Railway em 21/10/2026. No repositório consta a parte de código (INC-2026-10-21-03, tq-101: retirada de segredos fixos, `__tests__/segredosFixos.recusas.test.js`). O estado da rotação das variáveis **não está documentado no repositório**. | Registrar, fora do repositório público, o que foi trocado e quando. |
| Plano escrito | falta | Não há procedimento de resposta a incidente no repositório. | Escrever: quem decide, como desligar `RECEBE_NA_AURA_ENABLED`, como trocar cada chave, quando avisar a Asaas, as lojistas e a ANPD (LGPD). |
| Desligamento rápido | feito | O Recebe na Aura inteiro desliga por uma variável (`RECEBE_NA_AURA_ENABLED`); com ela desligada as rotas respondem 404 antes de tocar o banco ou a Asaas (`src/routes/companyRecebe.js:25-31`). | — |
| Monitoramento | feito | Sentry e verificador de produção (`.github/workflows/verificador-producao.yml`). | Alerta para rajada de 401 nos webhooks. |

## 11. Dependências e esteira — falta

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Auditoria de dependências | falta | `.github/workflows/ci.yml` roda checagem de sintaxe, schema de teste e testes; sem `npm audit` nem Dependabot. | Ligar Dependabot e `npm audit --omit=dev` no CI. |
| Varredura de segredos | falta | Sem varredura no CI. | Ligar a varredura de segredos do GitHub no repositório. |
| Revisão antes do merge | feito | CI verde, diff lido e OK do responsável antes do merge. | — |

## 12. Recebe na Aura atrás da flag — feito

| Item | Estado | Evidência | Próximo passo |
|---|---|---|---|
| Flag desligada por padrão | feito | `RECEBE_NA_AURA_ENABLED=false` (`.env.example:41`); o serviço confere de novo (`src/services/companyBaasService.js`, `isEnabled`). | — |
| Dinheiro não passa pela Aura | feito | Subconta por empresa; o dinheiro vai da Asaas para a subconta da lojista (`src/services/companyBaasService.js`, cabeçalho; migration 436). | Manter o split só dentro do que a lojista aceitou. |
| Notificação da Asaas ao cliente final | feito | Desligada por padrão (`notificationDisabled` em `buildSubaccountCustomerPayload`, `src/services/companyBaasService.js`). | — |

---

## O que dá para levar à Asaas como "feito" hoje

Cifra AES-256-GCM de certificados, senhas de certificado, apiKey de subconta
e tokens do WhatsApp e do Mercado Pago por OAuth; segredos só em variável de
ambiente, sem segredo fixo no código; HTTPS com HSTS; isolamento por empresa
em toda rota privada; webhooks da Asaas, da Meta e do Resend verificados;
desligamento do produto por uma variável.

## O que fechar antes da primeira subconta real

1. Revisão do acesso de equipe (PR à parte) e 2FA obrigatório para a equipe.
2. Cifrar ou desligar o Mercado Pago manual e retirar o fallback do CSC em claro.
3. `ALLOWED_ORIGINS` sem `*` em produção e validação do certificado do banco.
4. Limpeza de dados sensíveis no Sentry e fim do e-mail em log.
5. Backup e PITR conferidos na Supabase, com uma restauração testada.
6. Plano de resposta a incidente escrito e registro da rotação de chaves.
7. Dependabot e varredura de segredos no GitHub.
