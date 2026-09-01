-- ============================================================
-- 315 — Notificações da loja online: eventos duráveis + preferências
--
-- Criado: 01/09/2026
--
-- O PROBLEMA. Até aqui o sino da loja online (GET /companies/:id/notifications)
-- só sabia dizer "chegou pedido", e olhando uma janela de 24h em digital_orders.
-- Duas consequências: (1) quem não abre o app em 24h PERDE o aviso — é polling
-- de janela, não log; (2) tudo que acontece DEPOIS do pedido (pagou, PIX
-- expirou, mandou comprovante, saiu pra entrega, entregou, cancelou) é
-- invisível.
--
-- A DECISÃO: NÃO criar tabela de eventos. Os eventos entram em app_notifications
-- com `type` = 'loja_<evento>' e `dedupe_key` = 'loja:<evento>:<order_id>'.
-- Assim herdamos de graça o que já está construído e testado: o índice único
-- parcial de dedupe (migration 285), notification_reads (lido/não lido), o
-- filtro por empresa/plano/shell da rota, e o card do app.
--
-- ESTE ARQUIVO ADICIONA DUAS COISAS:
--
-- 1. company_notification_prefs — quais eventos cada empresa quer receber.
--    Sem isso, uma loja com 200 pedidos/dia recebe 200 sinos.
--
--    A tabela é ESPARSA de propósito: só guarda a linha de quem DIVERGE do
--    default. Ausência de linha = default da taxonomia (src/services/lojaEvents.js,
--    campo `defaultOn`). O motivo é operacional: quando um evento novo for
--    adicionado à taxonomia, ele já nasce com o default certo para TODAS as
--    empresas, sem backfill e sem migration. O preço é que o default vive no
--    código, não no banco — aceitável, porque a taxonomia (severidade, título,
--    rota) já vive lá de qualquer jeito e ter as duas metades separadas é que
--    daria divergência.
--
--    Não há FK para um catálogo de tipos: o catálogo é o objeto congelado em
--    lojaEvents.js. A rota PUT valida contra ele antes de gravar.
--
-- 2. app_notifications.entity_ref / entity_label — a QUAL coisa o evento se
--    refere, para o app agrupar os cards ("3 avisos do Pedido #1042" em vez
--    de três cards soltos).
--
--    entity_ref vem PREFIXADO ('pedido:<uuid>', 'produto:<uuid>'), acordado
--    com o frontend em 01/09/2026. O prefixo não é decoração: sem ele um
--    evento de estoque e um de pedido, com ids de TABELAS diferentes, podem
--    coincidir por acidente e o app agrupa duas coisas sem relação.
--
--    Estas duas SÃO colunas (ao contrário de severity, derivada do type)
--    porque são atributos da LINHA: cada evento aponta para um pedido
--    diferente. Não há como derivá-las do tipo.
--
-- 3. Índice (target_company_id, type) para o novo bloco da rota, que passa a
--    fazer duas leituras em app_notifications por poll (banners e eventos,
--    separados por type). O poll é a cada 30s de TODA empresa — a rota é o
--    caminho quente do app.
--
-- SEVERIDADE: não tem coluna aqui, é derivada do `type` no backend. O porquê
-- está no cabeçalho de src/services/lojaEvents.js.
--
-- Idempotente (padrão do repo).
-- ============================================================

CREATE TABLE IF NOT EXISTS company_notification_prefs (
  company_id UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type TEXT        NOT NULL,
  enabled    BOOLEAN     NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, event_type)
);

COMMENT ON TABLE company_notification_prefs IS
  'Preferências de notificação por empresa. ESPARSA: só existe linha para o que diverge do default da taxonomia (src/services/lojaEvents.js). Ausência = default do código.';
COMMENT ON COLUMN company_notification_prefs.event_type IS
  'Tipo do evento, igual a app_notifications.type (ex.: loja_pedido_pago). Validado pela rota contra a taxonomia — sem FK de propósito.';

-- A rota carrega TODAS as preferências de uma empresa de uma vez (cache de
-- 60s em processo), então a PK (company_id, event_type) já serve de índice.
--
-- event_type aceita, além dos tipos 'loja_*', a pseudo-chave 'app_banner':
-- é como a lojista desliga as "Novidades da Aura" (os banners de
-- endomarketing). Não é um evento — não existe em app_notifications.type —,
-- é um interruptor de LEITURA aplicado no GET. Mora na mesma tabela porque é
-- a mesma tela de preferências e o mesmo escopo (empresa).

ALTER TABLE app_notifications
  ADD COLUMN IF NOT EXISTS entity_ref   TEXT,
  ADD COLUMN IF NOT EXISTS entity_label TEXT;

COMMENT ON COLUMN app_notifications.entity_ref IS
  'A que o evento se refere, PREFIXADO: pedido:<uuid> | produto:<uuid>. O app agrupa os cards por ele. NULL em banner e em evento sem entidade.';
COMMENT ON COLUMN app_notifications.entity_label IS
  'Rotulo humano da entidade, ex.: "Pedido #1042". So para exibicao.';

-- Dois blocos de leitura por poll (banners: type NOT LIKE 'loja\_%';
-- eventos: type LIKE 'loja\_%'), ambos filtrando por empresa.
CREATE INDEX IF NOT EXISTS idx_app_notifications_company_type
  ON app_notifications (target_company_id, type)
  WHERE target_company_id IS NOT NULL;
