-- ============================================================
-- AURA DOJÔ — Migration 252: solicitação de CONEXÃO/FILIAÇÃO do dojô à
-- federação (F6 — "pedido → inbox → aceite")
-- ------------------------------------------------------------
-- MODELO (fechado com o Caio, 26/07/2026):
--
--  - companies.federation_id           = vínculo TÉCNICO. É o que faz as
--    rotas /federation/:id/dojo/* roteia rem e o guard requireDojoAccess
--    (Canal A = JWT, Canal B = portal) aceitar o token. NÃO é conexão.
--
--  - companies.karate_dojo_linked_at   = VISIBILIDADE para a federação
--    (migration 251). NULL = dojô self-serve NÃO conectado: invisível nas
--    listas/contagens/agregados/campanhas da federação (PR #420) e, do
--    lado dele, /dojo/events e /dojo/annuity respondem vazio com
--    not_linked:true e POST /dojo/practitioner-requests dá 409
--    DOJO_NAO_CONECTADO (PR #422).
--
--  - Até aqui SÓ a federação (POST /federation/:id/dojos) ou o admin
--    (PATCH /admin/clients/:cid/karate mode='dojo') conseguiam setar o
--    vínculo. O dojô que entra sozinho ficava preso: não via nada e não
--    tinha como pedir. Esta tabela é a porta que faltava.
--
-- É o MESMO formato de karate_practitioner_requests (migration 231, H1):
-- solicitação → inbox da federação → aprovar/recusar com motivo.
--
-- DECISÃO 1 (Caio) — o vínculo é setado NO ACEITE da federação, e NÃO
--   depende de pagamento. Aprovou → karate_dojo_linked_at = NOW() →
--   eventos/anuidade/solicitações destravam na hora. A anuidade segue o
--   fluxo que já existe (a federação lança, o dojô paga por PIX, a régua
--   cobra) — cobrança não é pré-requisito de existir na rede.
--
-- DECISÃO 2 (Caio) — o número de filiação (FPKT-NNN) é SEMPRE DIGITADO
--   pela federação na aprovação e gravado em companies.fpkt_affiliation_id.
--   O backend NUNCA gera/inventa número — mesma filosofia do número de
--   praticante (migration 231). Sem número no approve → 422
--   FPKT_NUMBER_REQUIRED; número já em uso na federação → 409
--   FPKT_NUMBER_TAKEN.
--
-- Idempotente e defensiva (CLAUDE.md): CREATE ... IF NOT EXISTS e
-- DO $$ ... EXCEPTION WHEN duplicate_object para constraints/FKs, de modo
-- que rodar duas vezes seja inofensivo.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_affiliation_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ambos vêm SEMPRE do token do dojô (req.federationId / req.dojoId),
  -- nunca do corpo da requisição.
  federation_id     uuid NOT NULL,
  dojo_id           uuid NOT NULL,

  -- Contato de quem está pedindo. Só nome + telefone são obrigatórios: o
  -- resto é "dado faltante ≠ pendência" (ausente é neutro, não erro) — a
  -- federação decide fora do sistema o que exigir antes de aprovar.
  contact_name      text NOT NULL,
  contact_phone     text,
  contact_email     text,

  -- Identificação do dojô como pessoa jurídica OU física (muito dojô real
  -- é CPF do sensei, não CNPJ) — os dois opcionais, nunca ambos exigidos.
  cnpj              text,
  cpf               text,

  address           text,
  city              text,
  state             text,

  -- Quantos alunos o dojô declara ter. Declaratório, nunca validado —
  -- serve para a federação dimensionar a análise.
  students_count    integer,

  notes             text,

  status            text NOT NULL DEFAULT 'pending',
  rejection_reason  text,
  reviewed_at       timestamptz,
  reviewed_by       uuid,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_affiliation_requests
    ADD CONSTRAINT karate_affiliation_requests_status_check
    CHECK (status IN ('pending','approved','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- FKs defensivas (mesma filosofia da migration 231): CASCADE nas empresas
-- (some a federação/dojô, some o pedido) e SET NULL em quem revisou (o
-- pedido resolvido não pode sumir porque um usuário foi desligado).
DO $$ BEGIN
  ALTER TABLE karate_affiliation_requests
    ADD CONSTRAINT karate_affiliation_requests_federation_id_fkey
    FOREIGN KEY (federation_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_affiliation_requests
    ADD CONSTRAINT karate_affiliation_requests_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_affiliation_requests
    ADD CONSTRAINT karate_affiliation_requests_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotência real do pedido: UM pedido PENDENTE por dojô. Parcial de
-- propósito — depois de resolvido (aprovado OU recusado) o dojô PODE pedir
-- de novo. Recusa não é banimento: o sensei corrige o que a federação
-- apontou em rejection_reason e reenvia (cria um pedido NOVO; o histórico
-- da recusa fica).
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_affiliation_requests_pending
  ON karate_affiliation_requests (dojo_id)
  WHERE status = 'pending';

-- Inbox da federação (filtra por status) e consulta do próprio dojô.
CREATE INDEX IF NOT EXISTS idx_karate_affiliation_requests_fed_status
  ON karate_affiliation_requests (federation_id, status);

CREATE INDEX IF NOT EXISTS idx_karate_affiliation_requests_dojo
  ON karate_affiliation_requests (dojo_id);

COMMENT ON TABLE karate_affiliation_requests IS
  'F6 Aura Dojô — pedido de CONEXÃO/FILIAÇÃO de um dojô self-serve à federação. federation_id (companies) é vínculo TÉCNICO de roteamento; a VISIBILIDADE para a federação é companies.karate_dojo_linked_at (migration 251). O aceite desta solicitação é o que seta karate_dojo_linked_at — não o pagamento da anuidade. O número de filiação (companies.fpkt_affiliation_id) é SEMPRE digitado pela federação na aprovação: o backend nunca gera número.';

COMMENT ON COLUMN karate_affiliation_requests.status IS
  'pending | approved | rejected. Índice único parcial garante no máximo UM pending por dojô; resolvido libera novo pedido (recusa não é banimento).';

COMMENT ON COLUMN karate_affiliation_requests.students_count IS
  'Quantidade de alunos DECLARADA pelo dojô no pedido. Nunca validada — dimensiona a análise da federação.';

COMMENT ON COLUMN karate_affiliation_requests.rejection_reason IS
  'Motivo da recusa. Obrigatório no POST /reject (422 sem ele): o sensei precisa ver o porquê para corrigir e reenviar.';
