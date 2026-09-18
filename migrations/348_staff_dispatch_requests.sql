-- ============================================================
-- AURA. — Migration 348: pedidos de disparo preparados para aprovação
--
-- Decisão do Caio em 18/09/2026: o Claude pode PREPARAR um disparo (hoje, o
-- e-mail de uma notificação de empresa específica) a partir de um pedido
-- do Caio na conversa, mas nada sai sem alguém da equipe aprovar no painel
-- (Gestão Aura › Endomarketing › "Aprovar e enviar"). Não há job que
-- execute esta tabela sozinho: o envio acontece na rota de aprovação, com
-- o login de quem aprovou (src/routes/adminDispatchRequests.js).
--
-- Ciclo: awaiting_approval → processing → done | failed
--        awaiting_approval → rejected
-- Pedido não decidido até expires_at não pode mais ser aprovado.
--
-- payload de 'notification_email':
--   { "notification_id": uuid, "recipients"?: [email], "subject"?: text,
--     "pix"?: { "code": text, "amount"?: number, "due_date"?: "AAAA-MM-DD" } }
--   recipients ausente = os endereços sugeridos pelo painel (dono e empresa).
--
-- Sem política de RLS: só o backend (service role) lê e escreve.
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_dispatch_requests (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action         TEXT        NOT NULL,
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  requested_via  TEXT        NOT NULL DEFAULT 'claude',
  note           TEXT,           -- o pedido em linguagem natural, para quem aprova
  status         TEXT        NOT NULL DEFAULT 'awaiting_approval'
                 CHECK (status IN ('awaiting_approval', 'processing', 'done', 'failed', 'rejected')),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
  decided_by     UUID        REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  result         JSONB,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_dispatch_requests_awaiting
  ON staff_dispatch_requests (created_at DESC)
  WHERE status = 'awaiting_approval';

ALTER TABLE staff_dispatch_requests ENABLE ROW LEVEL SECURITY;
