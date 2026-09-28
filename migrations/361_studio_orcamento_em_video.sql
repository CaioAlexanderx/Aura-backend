-- 361_studio_orcamento_em_video.sql
-- Studio · Orçamento em vídeo 3D pelo WhatsApp (28/09/2026)
-- Desenho: aura-app docs/studio/orcamento-video-3d.md
--
-- A lojista grava, no painel, um vídeo da peça girando e manda o vídeo
-- embutido na mensagem do WhatsApp do cliente, com os valores e as
-- condições. NÃO existe página pública nem token neste fluxo: a conversa
-- é no WhatsApp da lojista, e o orçamento fica em aberto até ela Aprovar
-- (vira pedido) ou Fechar (encerra sem venda).
--
-- Tudo aditivo e opcional: backend sem esta migration segue como hoje.

-- ── Condições definidas pela lojista no orçamento ───────────────
-- Nada vem pré-preenchido da configuração da loja (decisão do PO, 28/09).
-- Formato: { pix_desconto_pct, parcelas, prazo_dias_uteis, observacao },
-- todos opcionais. Sinal e validade continuam em deposit_* e validity_days.
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS condicoes jsonb;

-- ── O vídeo guardado (30 dias, prorrogável) ─────────────────────
-- Só a CHAVE do R2: o painel baixa o arquivo por rota autenticada; nenhuma
-- URL do vídeo sai para fora. O job orcamentoVideoExpiryJob apaga o
-- arquivo e limpa estas colunas quando video_expira_em passa.
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS video_key          text;
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS video_content_type text;
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS video_bytes        integer;
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS video_formato      text;   -- telemetria: mp4-webcodecs | mp4-mediarecorder | webm
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS video_gerado_em    timestamptz;
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS video_expira_em    timestamptz;

-- Como a lojista mandou: compartilhar | whatsapp | baixar | copiar.
ALTER TABLE studio_quotes ADD COLUMN IF NOT EXISTS canal_envio text;

CREATE INDEX IF NOT EXISTS studio_quotes_video_expira_idx
  ON studio_quotes (video_expira_em)
  WHERE video_key IS NOT NULL;

-- ── Status 'closed': a lojista encerrou sem venda ───────────────
-- 'rejected' é a recusa do cliente pela página pública; "Fechar" é uma
-- decisão da loja e merece nome próprio na lista. O CHECK nasceu inline
-- na 138 (nome gerado pelo Postgres), então é encontrado pela definição:
-- só o CHECK da lista de status (tem 'converted'), nenhum outro.
-- Sem nada de sessão: o runner roda cada migration numa transação do
-- pooler (backend#769). Idempotente: rodar de novo recria o mesmo CHECK.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'studio_quotes'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
       AND pg_get_constraintdef(oid) ILIKE '%''converted''%'
  LOOP
    EXECUTE format('ALTER TABLE studio_quotes DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE studio_quotes
  ADD CONSTRAINT studio_quotes_status_check
  CHECK (status IN ('draft','sent','accepted','rejected','expired','converted','closed'));
