-- ============================================================
-- 330 — Crediário: interruptor do envio automático pelo WhatsApp oficial
--
-- A régua do crediário (credit_collection_rules) existe desde a 136, mas
-- nunca disparou sozinha: quem cobrava era uma pessoa, abrindo o wa.me
-- com o texto pronto. Agora a mesma régua pode enfileirar na wa_outbox e
-- sair pela Cloud API — e isso CUSTA DINHEIRO por mensagem.
--
-- Por que uma coluna nova em vez de reusar `whatsapp_connected`: aquela
-- flag é legada, escrita pela tela, e significa "a lojista disse que tem
-- WhatsApp" — nunca foi gate de nada. Sobrecarregá-la faria o valor
-- antigo de centenas de empresas virar, de uma migration para a outra,
-- autorização de envio pago. Estado declarado, não deduzido: o
-- interruptor do automático é um campo próprio, que nasce false para
-- todo mundo e só é ligado por quem passou pelos gates (plano/adicional,
-- número conectado, templates aprovados pela Meta).
--
-- `whatsapp_auto_since` é para o suporte: quando alguém perguntar "desde
-- quando essa loja manda mensagem sozinha?", a resposta está aqui.
-- ============================================================

ALTER TABLE credit_collection_rules
  ADD COLUMN IF NOT EXISTS whatsapp_auto BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE credit_collection_rules
  ADD COLUMN IF NOT EXISTS whatsapp_auto_since TIMESTAMPTZ;

COMMENT ON COLUMN credit_collection_rules.whatsapp_auto IS
  'Interruptor do envio AUTOMATICO da regua do crediario pela Cloud API (wa_outbox). false = a regua so alimenta a pista manual (wa.me, gratis). Nao confundir com whatsapp_connected, flag legada da tela que nunca foi gate.';

COMMENT ON COLUMN credit_collection_rules.whatsapp_auto_since IS
  'Quando o envio automatico foi ligado pela ultima vez. NULL = nunca ligado.';
