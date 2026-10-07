-- ============================================================
-- AURA. — Migration 367: lembretes de fatura agendados
--
-- Pedido do Caio em 07/10/2026: o lembrete de pagamento da assinatura
-- aparece no sininho do cliente numa data marcada (2 dias antes do
-- vencimento), com o QR Code e o Pix copia e cola da fatura do Asaas; no
-- dia do vencimento, se o pagamento não entrou, a Aura é avisada no
-- próprio sininho.
--
-- app_notifications não tem "publicar em": um banner inserido hoje aparece
-- hoje. Esta tabela é a agenda. Quem a executa é
-- src/jobs/lembreteDeFaturaJob.js (services/lembreteDeFatura.js), que busca
-- valor, vencimento, situação e Pix no Asaas na hora de publicar — nada
-- disso é copiado para cá.
--
--   notify_on         dia (São Paulo) em que o banner passa a aparecer
--   due_date          vencimento; o job corrige pelo Asaas se divergir
--   send_email        manda o mesmo lembrete por e-mail (Resend), para o
--                     dono e o e-mail da empresa
--   alert_company_id  empresa que recebe "pagamento não recebido" no dia
--                     do vencimento (NULL = ninguém é avisado)
--   extra_note        frase a mais no corpo do banner
--   outcome           NULL = em andamento; paid | unpaid_alerted |
--                     unpaid | gone = encerrado, o job não olha mais
--
-- As linhas do fim são os cinco lembretes de outubro/2026. Entram por
-- SELECT em companies para o arquivo rodar igual num banco sem essas
-- empresas (CI). Idempotente.
--
-- Sem política de RLS: só o backend (service role) lê e escreve.
-- ============================================================

CREATE TABLE IF NOT EXISTS invoice_reminders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asaas_payment_id  TEXT        NOT NULL,
  notify_on         DATE        NOT NULL,
  due_date          DATE        NOT NULL,
  send_email        BOOLEAN     NOT NULL DEFAULT false,
  alert_company_id  UUID        REFERENCES companies(id) ON DELETE SET NULL,
  extra_note        TEXT,
  notified_at       TIMESTAMPTZ,
  notification_id   UUID        REFERENCES app_notifications(id) ON DELETE SET NULL,
  email_sent_at     TIMESTAMPTZ,
  outcome           TEXT        CHECK (outcome IN ('paid', 'unpaid_alerted', 'unpaid', 'gone')),
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, asaas_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_reminders_em_andamento
  ON invoice_reminders (notify_on)
  WHERE outcome IS NULL;

ALTER TABLE invoice_reminders ENABLE ROW LEVEL SECURITY;

-- Lembretes de outubro/2026. O id da cobrança é o final do link da fatura
-- (asaas.com/i/<id>) com o prefixo pay_. Quem recebe o alerta é a empresa
-- "Aura." (conta da equipe).
INSERT INTO invoice_reminders
  (company_id, asaas_payment_id, notify_on, due_date, send_email, alert_company_id, extra_note)
SELECT c.id, v.payment_id, v.notify_on::date, v.due_date::date, v.send_email, a.id, v.extra_note
  FROM (VALUES
    -- FPKT
    ('274994b3-6324-4e7b-942e-e6dd19666149', 'pay_siwzm4ng6oqzr88j', '2026-10-16', '2026-10-18', true,  NULL),
    -- Voulu Calçados (MHT Comércio de Alimentos)
    ('5334dd72-ab69-4099-8f6d-058ae7211200', 'pay_1wykxysitjm1kvfb', '2026-10-18', '2026-10-20', false, NULL),
    -- Maria Eduarda (Essencial Moda Feminina)
    ('e2d0243c-90dd-485f-a25c-4c8586a447fa', 'pay_djfsl51346yngroj', '2026-10-21', '2026-10-23', false, NULL),
    -- Davi Calçados: uma cobrança só, no CNPJ da Matriz, para as duas lojas
    ('08c05f0e-b75b-4c12-870e-d7fb65f1dca0', 'pay_5ueo0kl7grpvcape', '2026-10-21', '2026-10-23', false,
       'Um pagamento só cobre as duas empresas do grupo.'),
    ('ea68b4d2-f051-46b1-9ac5-b8438c6cd5fc', 'pay_5ueo0kl7grpvcape', '2026-10-21', '2026-10-23', false,
       'A cobrança está no CNPJ da Matriz e cobre as duas empresas.'),
    -- Fernanda dos Santos Rangel
    ('bb2ffcea-1ee0-4e81-8c9b-a065f651b9d3', 'pay_qqtlpvbrsathr8uk', '2026-10-28', '2026-10-30', false, NULL)
  ) AS v(company_id, payment_id, notify_on, due_date, send_email, extra_note)
  JOIN companies c ON c.id = v.company_id::uuid
  LEFT JOIN companies a ON a.id = '645c1325-8865-48be-af6f-430d93fb2b6c'
ON CONFLICT (company_id, asaas_payment_id) DO NOTHING;
