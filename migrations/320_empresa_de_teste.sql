-- ============================================================
-- 320 — Empresa de teste (sandbox)
--
-- POR QUE: metade do produto so pode ser verificada fechando um pedido —
-- checkout, cobranca, aprovacao de arte, cancelamento. Ate hoje nao havia
-- onde fazer isso: na loja de um cliente real e proibido, e a conta de
-- demonstracao nao espelha uma loja Studio de verdade. Na rodada de QA de
-- 03/09/2026 NENHUM checkout foi concluido, e o caminho mais importante
-- do produto foi avaliado por leitura de codigo.
--
-- A flag e uma COLUNA e nao uma chave dentro de `pdv_settings` de
-- proposito: e uma trava de seguranca, e trava de seguranca se le com um
-- `WHERE`, nao com um parse de jsonb. Estado declarado, nao deduzido.
--
-- O QUE ELA TRAVA (ver services/lojaDeTeste.js):
--   - notificacao ao lojista e ao cliente (push, e-mail, WhatsApp)
--   - criacao de cobranca real em gateway
--
-- O que ela NAO muda: precos, estoque, fila de producao e financeiro
-- continuam funcionando de verdade. Uma loja de teste que nao baixa
-- estoque nao testa o que interessa.
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_sandbox boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.is_sandbox IS
  'Empresa de teste: nao dispara notificacao real nem cria cobranca em gateway. Ver services/lojaDeTeste.js.';

-- Indice parcial: a consulta e sempre "esta empresa e sandbox?" e as
-- linhas true sao pouquissimas.
CREATE INDEX IF NOT EXISTS idx_companies_sandbox
  ON companies (id) WHERE is_sandbox = true;
