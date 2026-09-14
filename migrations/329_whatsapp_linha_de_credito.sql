-- ============================================================
-- 329 — WhatsApp: linha de crédito compartilhada (Tech Provider)
--
-- A Meta exige que o Tech Provider (Aura) compartilhe a PRÓPRIA linha
-- de crédito com cada WABA integrada pelo Embedded Signup. Sem isso o
-- número conecta, mostra selo verde, mas a Meta recusa o primeiro
-- envio de template PAGO — a WABA simplesmente não tem como ser
-- cobrada por mensagem nenhuma.
--
-- O connect chama POST /{extended_credit_id}/whatsapp_credit_sharing_and_attach
-- com o token do SISTEMA da Aura (WA_SYSTEM_TOKEN — nunca o token do
-- cliente que acabou de conectar). É best-effort: sem as duas envs
-- (WA_EXTENDED_CREDIT_ID + WA_SYSTEM_TOKEN) o passo é pulado em
-- silêncio, e falhar nele vira warning — nunca desfaz uma conexão que
-- já está boa.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_credit_shared_at TIMESTAMPTZ;

COMMENT ON COLUMN companies.wa_credit_shared_at IS
  'Quando a Aura compartilhou a propria linha de credito com a WABA desta empresa (whatsapp_credit_sharing_and_attach). NULL = ainda nao compartilhada (ou envs ausentes no momento do connect).';
