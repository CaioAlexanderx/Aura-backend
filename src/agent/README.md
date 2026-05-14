# Vendedor IA Aura (SDR Conversacional B2B)

Modulo do Aura-backend que atende leads B2B da propria Aura via WhatsApp/Instagram:
**Processar Leads** (inbound) + **Buscar Leads** (outbound Phibo + scraping GMaps/Instagram).

Decisao consolidada: **Haiku 4.5 puro**, sem roteamento adaptativo pra Sonnet. Quando Haiku for insuficiente, escalation correta e `markForHumanHandoff`, nao trocar modelo.

Doc completo: `../../Aura/BACKLOG_VENDEDOR_IA_AURA.md`

## Estrutura

```
src/agent/
  core/          orchestrator, promptBuilder, toolDispatcher, guardrails
  tools/         searchAuraKb, qualifyLead, markForHumanHandoff, recordOptOut, enrichLead
  kb/            knowledge base markdown (auraKnowledge, pricing, objections, verticals, comparativos)
  outbound/      Phibo importer, GMaps/Instagram scrapers, scheduler, templates
  inbound/       webhook Meta + conversation handler
```

Jobs em `../jobs/agent*.js`. Rotas em `../routes/adminAgent.js`.

## Fases

- **Fase 0** (atual): schema + scaffolding + killswitch + replay basico
- **Fase 1**: Processar Leads — atendimento inbound + Phibo respondendo
- **Fase 2**: Buscar Leads — outbound scheduler + scrapers GMaps/Instagram
- **Fase 3**: Polish — A/B tom, metricas, audio diario, snooze/followup

## Variaveis de ambiente

Fase 1 em diante:

- `ANTHROPIC_API_KEY_AURA` — chave do workspace Anthropic dedicado da Aura (NAO usar plano Max)
- `META_WABA_PHONE_NUMBER_ID_AURA` — numero WhatsApp Business da Aura
- `META_ACCESS_TOKEN_AURA` — token de acesso Meta Cloud API

Fase 2:

- `GOOGLE_MAPS_API_KEY` — Places API pra scraping
- `APIFY_TOKEN` — pra scraping de Instagram

## Killswitch

`agent_settings.killswitch_global=true` para o agente em ~30s (cache TTL).
Endpoint admin pra toggle: `POST /api/v1/admin/agent/killswitch` (Fase 1).

## Armadilhas conhecidas (cf. memorias)

- `armadilha_schema_pre_migration`: codigo defensivo em 42P01 / 42703 nos primeiros 7 dias apos deploy da migration 113. Helpers em `core/guardrails.js` ja tratam.
- `armadilha_plano_stale_jwt`: se a UI admin gating por plano usar JWT, deve revalidar antes de exibir leads.
