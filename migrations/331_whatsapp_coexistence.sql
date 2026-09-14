-- ============================================================
-- 331 — WhatsApp: Coexistence (número que continua no app do celular)
--
-- Hoje só existe o modo "padrão" do Embedded Signup: ele EXIGE um número
-- que não esteja no app WhatsApp Business do celular — mas é exatamente
-- esse app que a maioria das lojas já usa no dia a dia. A Meta oferece
-- "Coexistence" (doc "Onboard WhatsApp Business app users"): o MESMO
-- número fica no app do celular E na Cloud API ao mesmo tempo.
--
-- Regra que essa coluna espelha: quando o número já está no app
-- (is_on_biz_app=true via GET /{phone_number_id}?fields=is_on_biz_app)
-- ou o frontend pediu o modo coexistence explicitamente, o backend NÃO
-- chama POST /{phone_number_id}/register — o número já está registrado
-- na Cloud API, e registrar de novo quebra o app do celular. wa_coexistence
-- marca esse caso para a tela explicar por que não existe PIN de registro
-- aqui (diferente do modo padrão, migration 328).
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS wa_coexistence BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.wa_coexistence IS
  'true quando o numero do WhatsApp Cloud API desta empresa tambem continua ativo no app WhatsApp Business do celular (modo Coexistence da Meta) — nesse caso o connect pula o /register (o numero ja esta registrado) e o webhook pode receber smb_message_echoes/history/smb_app_state_sync para este numero.';
