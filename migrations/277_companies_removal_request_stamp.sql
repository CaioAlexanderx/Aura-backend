-- ============================================================
-- AURA — Migration 277: CARIMBO DO PEDIDO DE REMOÇÃO (retenção de 60 dias)
--
-- POR QUE ELA EXISTE
--   DELETE /api/v1/federation/:id/dojos/:dojoId apagava a linha de
--   `companies` de verdade e, com ?cascade=true, arrastava junto os
--   `customers` do dojô — e, por ON DELETE CASCADE do schema,
--   `karate_belt_history` (as GRADUAÇÕES), certificados e inscrições.
--   São 207 FKs CASCADE apontando para `companies`.
--
--   Os termos de uso do Aura obrigam a guardar os dados por 60 dias.
--   Decisão do dono do produto (11/08/2026): a rota passa a DESATIVAR
--   (companies.is_active = false), como já faz DELETE /me/companies/:id
--   em src/routes/userCompanies.js. Nada é apagado.
--
--   Desativar sozinho responde "este dojô está fora", mas não responde
--   "desde QUANDO e a pedido de QUEM" — que é exatamente o que a
--   contagem dos 60 dias precisa saber. É só isso que esta migration
--   acrescenta.
--
-- O QUE ELA **NÃO** É
--   Não é expurgo. Não cria job, não cria trigger, não agenda nada e não
--   apaga nada. A limpeza depois do prazo é fase própria.
--
-- POR QUE NÃO É deleted_at / archived_at
--   Não existe (e continua não existindo) um conceito de "apagado" em
--   `companies`: o padrão do produto é `is_active`. O nome aqui descreve
--   o EVENTO ("a remoção foi pedida"), não um estado paralelo de
--   existência — justamente para ninguém confundir com is_active nem
--   escrever um WHERE que ignore o soft delete que já existe.
--
-- POR QUE "removal_requested" E NÃO "deactivated"
--   `PATCH /dojos/:dojoId { is_active:false }` (o "Suspender" da UI) é
--   uma SUSPENSÃO — intenção temporária, sem relógio de retenção. O
--   DELETE é um pedido de REMOÇÃO. As duas escrevem is_active=false, mas
--   só a segunda carimba. Por isso o PATCH não foi tocado por este PR.
--
-- INVARIANTE PARA O JOB FUTURO (leia antes de escrever a fase de limpeza)
--   A fila de expurgo é
--     WHERE is_active = false AND removal_requested_at < now() - interval '60 days'
--   O `is_active = false` na condição é obrigatório: um dojô REATIVADO
--   por PATCH { is_active:true } sai da fila sozinho, mesmo que o carimbo
--   antigo continue na linha. E um novo pedido de remoção sobre um dojô
--   que estava ATIVO reinicia o relógio (ver o CASE em
--   src/services/karateDojoDeactivationService.js).
--
-- SEM FK EM removal_requested_by, DE PROPÓSITO
--   É carimbo de auditoria: ele tem de sobreviver à remoção da conta de
--   quem o fez. FK com ON DELETE SET NULL apagaria justamente a resposta
--   de "quem pediu".
--
-- IDEMPOTENTE (ADD COLUMN IF NOT EXISTS): pode rodar duas vezes sem erro.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS removal_requested_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS removal_requested_by UUID;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS removal_reason       TEXT;

COMMENT ON COLUMN companies.removal_requested_at IS
  'Quando a remoção desta empresa foi PEDIDA (DELETE que desativa). Inicia a contagem dos 60 dias de retenção dos termos de uso. NULL = nunca foi pedida. Não confundir com is_active (suspensão).';
COMMENT ON COLUMN companies.removal_requested_by IS
  'users.id de quem pediu a remoção. Sem FK de propósito: o carimbo de auditoria sobrevive à remoção da conta.';
COMMENT ON COLUMN companies.removal_reason IS
  'Texto de trilha do pedido de remoção (não é texto de UI).';

-- Índice parcial: a fila de retenção é minúscula perto de `companies`.
CREATE INDEX IF NOT EXISTS idx_companies_removal_requested_at
  ON companies (removal_requested_at)
  WHERE removal_requested_at IS NOT NULL;
