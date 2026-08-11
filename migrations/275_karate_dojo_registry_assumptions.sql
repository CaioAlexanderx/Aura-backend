-- ============================================================
-- AURA DOJÔ — F11: trilha da ASSUNÇÃO DO REGISTRO FEDERATIVO
-- (migration 275 — NÃO aplicada neste PR)
--
-- ── O ATO QUE ESTA TABELA REGISTRA ──────────────────────────
-- A FPKT tem 105 dojôs cadastrados como `companies`: o REGISTRO FEDERATIVO
-- (104 sem nenhum usuário, owner = user-sistema compartilhado). Quando um
-- sensei vira cliente, ele cria uma conta NOVA e pede vínculo. No aceite, a
-- federação APONTA qual dos 105 registros é aquele dojô — e a conta do
-- sensei PASSA A SER aquela linha:
--
--   • o usuário dono da company que pediu vira owner da company do registro;
--   • o que o sensei já tinha cadastrado (alunos, turmas, tags, cobranças…)
--     é reapontado para o registro;
--   • a company do cadastro é DESATIVADA (nunca apagada).
--
-- Move-se o USUÁRIO, não os 9.840 praticantes: `customers.dojo_id` já aponta
-- para o registro e não é tocado por este fluxo (é FEDERATION_OWNED, e um
-- assertIdentityFieldsAreSafe() derruba o boot se essa coluna entrar no sync).
--
-- É um ato irreversível na prática e que muda DE DONO uma company com
-- milhares de praticantes pendurados. Uma linha por ato, com de-onde,
-- para-onde, quem e o quê, é o mínimo para alguém responder a essa pergunta
-- daqui a seis meses sem reconstituir logs de aplicação.
--
-- ── UNIQUE(request_id) = IDEMPOTÊNCIA, NÃO SÓ ESTÉTICA ──────
-- Um pedido de filiação produz NO MÁXIMO uma assunção. O serviço já barra o
-- reprocessamento pelo status do pedido (FOR UPDATE + status='pending'), mas
-- a garantia estrutural mora aqui: o INSERT usa ON CONFLICT (request_id)
-- DO NOTHING. `request_id` é NULLABLE de propósito — um NULL não conflita com
-- outro NULL em índice único no Postgres, e um dia pode existir assunção
-- fora do fluxo de pedido (adoção em lote dos registros preexistentes).
--
-- ── SEM FOREIGN KEY, E ISSO É INTENCIONAL ───────────────────
-- Trilha não pode ser apagada em cascata pelo objeto que ela audita. Uma FK
-- para `companies` com ON DELETE CASCADE faria exatamente o contrário do que
-- a tabela existe para fazer. É a MESMA razão pela qual o fluxo desativa a
-- company em vez de apagá-la (e o mesmo tipo de dependência silenciosa que
-- `karate_annuities.dojo_id` já tem — lá por acidente, aqui de propósito e
-- documentado).
--
-- Idempotente / aditiva: CREATE TABLE/INDEX IF NOT EXISTS, sem DDL destrutivo,
-- sem tocar em nenhuma tabela existente. Padrão das 274/272/263.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_registry_assumptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Pedido de filiação que originou o ato (karate_affiliation_requests).
  -- NULL quando a assunção vier por outro caminho (adoção em lote).
  request_id             uuid,
  federation_id          uuid,
  -- De ONDE para ONDE: a company do cadastro (descartada) e a company do
  -- registro federativo (que passou a ser a conta do sensei).
  from_company_id        uuid,
  to_company_id          uuid,
  -- O usuário que se moveu — o sensei que virou owner do registro.
  user_id                uuid,
  -- Quem aprovou. actor_id é uuid (NULL quando o ator não é uuid, ex.: staff
  -- de plataforma em teste); actor_ref guarda o identificador cru, sempre.
  actor_id               uuid,
  actor_ref              text,
  fpkt_affiliation_id    text,
  -- "A conta do cadastro estava vazia?" — false significa que havia trabalho
  -- do sensei e ele foi migrado (o detalhe está em `migrated`).
  from_company_was_empty boolean,
  -- { migrated: {tabela: n}, kept_at_source: {...}, schema_pending: [...],
  --   migrated_rows: n, from_company_discarded: bool }
  migrated               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Um pedido, no máximo uma assunção (ON CONFLICT (request_id) DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_registry_assumptions_request
  ON karate_dojo_registry_assumptions (request_id)
  WHERE request_id IS NOT NULL;

-- "Quem virou dono deste registro?" — a pergunta mais provável.
CREATE INDEX IF NOT EXISTS idx_kdra_to_company
  ON karate_dojo_registry_assumptions (to_company_id, created_at DESC);

-- "Esta company descartada virou o quê?" — a pergunta inversa, para quando
-- alguém encontrar uma company desativada e precisar saber para onde foi.
CREATE INDEX IF NOT EXISTS idx_kdra_from_company
  ON karate_dojo_registry_assumptions (from_company_id);

CREATE INDEX IF NOT EXISTS idx_kdra_federation
  ON karate_dojo_registry_assumptions (federation_id, created_at DESC);

COMMENT ON TABLE karate_dojo_registry_assumptions IS
  'F11 Aura Dojô: trilha da assunção do registro federativo — a conta criada pelo sensei (from_company_id) foi descartada e ele passou a ser owner da company do registro apontado pela federação (to_company_id). Move-se o USUÁRIO, nunca os praticantes (customers.dojo_id já aponta para o registro e é FEDERATION_OWNED). SEM FK de propósito: trilha não some em cascata com o que audita.';

COMMENT ON COLUMN karate_dojo_registry_assumptions.from_company_was_empty IS
  'true = a conta do cadastro não tinha nenhuma linha nas tabelas de trabalho do dojô (alunos, turmas, tags, cobranças, presenças, exames, eventos, certificados) e foi apenas desativada. false = havia dado e ele foi reapontado para o registro; o detalhe por tabela está em `migrated`.';

COMMENT ON COLUMN karate_dojo_registry_assumptions.migrated IS
  'migrated: linhas reapontadas por tabela. kept_at_source: linhas de config uma-por-dojô que NÃO migraram porque o registro já tinha a dele (a do registro vence). schema_pending: tabelas ausentes no ambiente na hora do ato.';
