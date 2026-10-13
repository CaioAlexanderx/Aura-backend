# Aurinha de plantão — WhatsApp da Aura no hub

**Status:** infraestrutura pronta e **dormente** (migration 375, 13/10/2026). Nada liga sozinho: sem `AURA_COMPANY_ID` no ambiente o webhook e o job nem consultam o banco. A persona de suporte e as ferramentas ficam para a f3-05.

## O fluxo

```
Meta → POST /webhooks/whatsapp
        │  phone_number_id == hub_agent_settings.wa_phone_number_id da empresa AURA_COMPANY_ID ?
        ├─ não → fluxo das lojas, sem mudança
        └─ sim → hub
              mensagem do cliente → hub_conversations (whatsapp, telefone) + hub_messages
                                    + evento mensagem_recebida
                                    └ plantao.deveResponderAgora ?
                                        sim → hubWhatsapp.responderNoHub → wa_outbox (origem hub)
                                        não → aguardando_resposta_desde; job por minuto reavalia
              eco do app do celular → mensagem humana: limpa a pendência e cancela a
                                      resposta da Aurinha que estava na fila
```

## Relógio (`src/services/plantao.js`)

Horário de Brasília. **21:00→08:00** a Aurinha responde na hora. **08:00→21:00** espera 15 minutos pelo humano e só então entra. 21:00 é noite; 08:00 já é dia. Em qualquer horário, se o humano já falou depois da última mensagem do cliente, ela não entra.

`hub_agent_settings.plantao` (jsonb, tudo opcional; campo inválido cai no default):

```json
{
  "ativo": true,
  "noite_inicio": "21:00",
  "noite_fim": "08:00",
  "espera_minutos": 15,
  "template": { "nome": "aurinha_retorno", "idioma": "pt_BR" }
}
```

`template` é o que sai quando a janela de 24h da conversa já fechou. Sem ele (ou sem aprovação na Meta) a mensagem fica `pending` na `wa_outbox` com o motivo em `skip_reason` (`JANELA_FECHADA_SEM_TEMPLATE` | `TEMPLATE_NAO_APROVADO`) e `next_attempt_at = 'infinity'` — o dispatcher não a pega.

## Fila (`waOutbox.enqueueHub`, linhas com `hub_conversation_id`)

- A janela de 24h é a da **conversa** (`hub_conversations.last_inbound_at`).
- Opt-out de marketing e o teto de 2/dia por contato **não** se aplicam a atendimento; continuam valendo telefone inválido na Meta, fila pausada e o teto diário da empresa.
- A Aurinha não fala por cima: conversa assumida por humano → `CONVERSA_NAO_IA`; humano respondeu depois que a resposta entrou na fila → `HUMANO_RESPONDEU`.
- Idempotência: `dedupe_key = hub:aurinha:<conversa>:<last_inbound_at>`.

## Ponto de extensão (f3-05)

`hubWhatsapp.responderNoHub(conversa, { agora, config })` — hoje devolve o texto fixo do stub quando o relógio libera, no máximo uma vez a cada 6 h por conversa. A persona de suporte, as ferramentas e a base de conhecimento entram aqui (e o stub e o intervalo somem).

## Operação

- Kill switch do job: `PLANTAO_ENABLED=false`. Desligar a Aurinha: `hub_agent_settings.enabled = false` (as mensagens continuam sendo gravadas no hub, sem resposta).
- `wa_phone_number_id` **não** é editável pela API da loja (`PUT /hub/settings` o ignora): quem aponta um número para o hub é SQL/admin.
