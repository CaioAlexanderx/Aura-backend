-- ============================================================
-- 384 — Check-in do prospect (companies.checkin)
--
-- Contexto (14/10/2026, pedido do Caio em 13/10, prioridade 0 da Cassie e da
-- Nina): depois de escolher a frente e antes do Painel, o cadastro novo
-- responde 3 perguntas em chip (por onde começar, onde anota o que tem,
-- quantos produtos). Vale para TODOS os cadastros novos, sem teste A/B; no
-- lugar do sinalizador de grupo existe um interruptor (CHECKIN_ENABLED) e a
-- tela tem sempre o "Pular".
--
-- Campo único jsonb, com a mesma forma para a tela do cliente (PUT parcial
-- por chave) e para a seção "Check-in" do Registrar contato da Gestão Aura:
--
--   comeco          por onde começar (chip da pergunta 1)
--   onde_anota      onde anota o que tem hoje (chip da pergunta 2)
--   produtos_faixa  quantos produtos (chip da pergunta 3)
--   como_chegou     como chegou à Aura (preenchido pela equipe, 1x por conta)
--   fiado           vende fiado? (equipe)
--   quem_decide     quem decide a compra (equipe)
--   versao          versão do questionário (1)
--   exibido_em      1ª vez que a tela foi oferecida (carimbo do servidor)
--   respondido_em   quando respondeu OU pulou (carimbo do servidor)
--   pulou           true quando tocou em "Pular"
--   grupo           reservado (sinalizador A/B, não usado: ver decisão acima)
--
-- Os valores dos chips NÃO têm CHECK de propósito: quem define as opções é a
-- tela (frente do app); a coluna só guarda texto curto.
--
-- NULL = nunca foi exibida nem respondida. Nenhuma conta existente muda:
-- quem decide se a tela aparece é CHECKIN_DESDE (data de corte, no código).
--
-- Idempotente. O backend sobe antes desta migration: o código trata 42703
-- como "tela desabilitada" (habilitado: false) em vez de quebrar.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS checkin JSONB NULL;

COMMENT ON COLUMN companies.checkin IS
  'Check-in do prospect (jsonb): comeco, onde_anota, produtos_faixa, como_chegou, fiado, quem_decide, versao, exibido_em, respondido_em, pulou, grupo. NULL = nunca exibido.';
