-- ============================================================
-- AURA KARATÊ — Migration 266: customers.guardian_email
--
-- NÃO aplicada por este PR (instrução explícita do pedido: só a rota e o
-- código chegam agora; a migration fica pronta para revisão e aplicação
-- separadas via Supabase MCP / apply_migration).
--
-- 100% aditiva: ADD COLUMN IF NOT EXISTS, nenhum dado tocado, nenhum DROP.
--
-- ============================================================
-- POR QUE ESTA COLUNA EXISTE, E POR QUE ELA NÃO É USADA AINDA (F8)
-- ============================================================
-- karate_dojo_guardians (dojô, migration 242) já tem email do responsável.
-- customers (federação) tem guardian_name/guardian_cpf/guardian_phone/
-- guardian_relationship (P7, migration 195) — mas NUNCA teve guardian_email.
--
-- A F8 fez nome/CPF/telefone/parentesco do responsável passarem a subir do
-- dojô para a federação (GUARDIAN_SYNC_FIELDS em
-- src/services/karateStudentIdentityLink.js, consumido por
-- src/services/karateIdentitySync.js). O e-mail é o único campo do
-- responsável que o dojô tem e a federação não tem ONDE receber.
--
-- DECISÃO (F8, 31/07/2026): criar a coluna agora, mas NÃO ligá-la ao sync
-- nem à guarda de identidade neste PR. Motivo prático, não de preferência:
--   - Este PR está proibido de aplicar migration. Se o código de
--     sync/guard passasse a depender de customers.guardian_email HOJE, ele
--     rodaria em produção ANTES da coluna existir — e teria que nascer
--     escondido atrás de outra flag module-level otimista
--     (HAS_GUARDIAN_EMAIL_COL) só para isso, aumentando a superfície de
--     "campo que degrada" por um dado que hoje é só um extra de contato
--     (nunca foi usado em nenhuma trava de identidade, diferente de nome/
--     CPF/telefone, que já eram campos do responsável na ficha do
--     praticante desde a P7).
--   - Criar a coluna agora e ligá-la depois (PR pequeno e isolado, assim
--     que a 266 for aplicada) é mais seguro que ligar tudo de uma vez atrás
--     de um cache otimista que ninguém vai lembrar de remover depois.
--
-- Quando este PR for aplicado e a 266 for aplicada em produção, o passo
-- seguinte (fora deste PR) é: acrescentar
-- { key: 'guardian_email', dojoCol: 'guardian_email', guardianCol: 'email',
--   fedCol: 'guardian_email' } em GUARDIAN_SYNC_FIELDS — o mecanismo de
-- sync (SYNC_FIELDS = IDENTITY_FIELDS.concat(GUARDIAN_SYNC_FIELDS)) e a
-- guarda (IDENTITY_LABEL_BY_COL derivado da mesma lista) já sabem tratar
-- qualquer entrada nova dessa lista — nenhum outro arquivo muda.
-- ============================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS guardian_email text;

COMMENT ON COLUMN customers.guardian_email IS
  'F8 (migration 266, aditiva): e-mail do responsável legal do praticante. Espelha karate_dojo_guardians.email (dojô). Coluna criada mas AINDA NÃO sincronizada nem protegida pela guarda de identidade neste PR — ver comentário no topo desta migration para o motivo e o passo seguinte (acrescentar a GUARDIAN_SYNC_FIELDS em src/services/karateStudentIdentityLink.js).';

-- ============================================================
-- FIM DA MIGRATION 266
-- ============================================================
