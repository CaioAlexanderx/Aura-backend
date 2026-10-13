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

## Painel da Gestão Aura: bloco Contatos, alerta e resumo das 8h (migration 376)

Lê o que o hub já grava (`hub_messages`, `hub_conversations`, `hub_agent_events` do tenant `AURA_COMPANY_ID`). Sem `AURA_COMPANY_ID` nada consulta o hub e tudo volta zero. Código: `src/services/contatosWhatsapp.js` (leitura única) → bloco, alerta e resumo.

**O que é um contato.** A conversa do hub é uma por telefone, para sempre; quem volta uma semana depois é contato novo. O contato é a janela de atendimento: abre numa mensagem do cliente sem nenhuma outra mensagem (de ninguém) nas 24h anteriores e fecha com 24h de silêncio. Fala nossa sem o cliente ter chamado antes não abre contato.

**Quem respondeu.** Humano = `hub_messages` autor `humano` + evento `mensagem_humana` + (na janela mais recente) `ultima_mensagem_humana_em`. Aurinha = `hub_messages` autor `aurinha` + evento `resposta_enfileirada` que não ficou parado nem foi pulado. Situação: Caio > Aurinha > sem resposta. "Sem resposta agora" = o cliente falou depois da última fala de um humano.

**Bloco `contatos`** (`painelBlocos/contatos.js`): `valor` = WhatsApp + site na semana; série por dia (14) e por hora do dia (24, Brasília); indicadores: sem resposta agora, mediana da primeira resposta humana, respondidos pela Aurinha, de madrugada (21h–8h). Na lista o telefone do WhatsApp vem mascarado (`+55 11 *****-0002`); `conversa_id` abre a ficha.

**Alerta `contato_sem_resposta`** (`painelAlertas.js`): sem resposta humana há mais de 2h (estritamente), em horário comercial (08:00 ≤ agora < 21:00 — a mesma fronteira do plantão), até 3 dias, no máximo 10. Verbo *Responder*; `detalhe` traz o telefone e o link `wa.me`. Como depende do relógio, `GET /admin/painel/hoje` recalcula só esse alerta a cada leitura em vez de usar o gravado às 06h.

**Ficha** `GET /admin/painel/contatos/:conversaId` (admin): telefone completo, link, empresa vinculada (telefone de empresa ou de dono), situação, e as últimas 200 mensagens.

**Resumo das 8h** (`services/resumoDaMadrugada.js` + `jobs/resumoDaMadrugadaJob.js`): às 08:00 BRT monta o que chegou entre 21h e 8h (quem, quando, o que disse em uma linha, o que a Aurinha respondeu), grava em `hub_agent_events` (tipo `resumo_madrugada`) e manda por e-mail (`mailer.sendMail`) para `contato@getaura.com.br` (`RESUMO_MADRUGADA_EMAIL` troca o destino). Idempotente por dia pelo índice único da 376; 8h é o piso (sobe depois, sai no primeiro tick, até 12h). Sem contatos na noite o dia é gravado e **não** se manda e-mail. Kill switch: `RESUMO_MADRUGADA_ENABLED=false`.

