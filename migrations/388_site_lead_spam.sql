-- ============================================================
-- 388 — Lixo eletrônico do formulário do site (anti-robô, card t2-12)
--
-- Contexto (15/10/2026, pedido do Marketing/Léo): 40 dos 46 contatos de
-- sales_leads (source 'site') eram robô (spam de "Rolls-Royce", SEO,
-- "Harryseeno / Roberthaupt / Robinscawl", mensagem-modelo traduzida). Eles
-- entravam na Prospecção, nas listas de lead do painel e nas contas de
-- conversão do site.
--
-- O endpoint público POST /api/v1/public/leads agora avalia cada envio
-- (services/leadSpam.js: honeypot, tempo de preenchimento, nome conhecido,
-- mensagem-modelo, inglês com link, Turnstile). O que for lixo NÃO entra em
-- sales_leads: fica aqui, com o motivo. Tabela à parte (e não uma coluna
-- is_spam em sales_leads) para que nenhuma lista, contagem, meta, cadência ou
-- aviso de lead precise saber da marca: quem lê sales_leads continua lendo só
-- lead de verdade, sem mexer em nenhuma das ~10 consultas que existem hoje.
--
-- Falso positivo é recuperável: a linha guarda tudo que a pessoa mandou.
-- Para ver o que o filtro barrou:
--   SELECT created_at, motivo, nome, telefone, left(mensagem, 80) FROM site_lead_spam ORDER BY created_at DESC;
--
-- Idempotente. O backend pode subir antes desta migration: o INSERT trata
-- 42P01 (tabela ausente) descartando o lixo sem gravar (o lead de verdade
-- nunca depende desta tabela).
-- ============================================================

CREATE TABLE IF NOT EXISTS site_lead_spam (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  motivo      TEXT NOT NULL,          -- rapido_demais | nome_conhecido | mensagem_modelo | mensagem_em_ingles | link_em_outra_lingua | nome_com_link | turnstile_invalido
  source      TEXT NOT NULL DEFAULT 'site',   -- 'site' (completo) | 'site_partial'
  nome        TEXT,
  telefone    TEXT,
  email       TEXT,
  empresa     TEXT,
  cargo       TEXT,
  vertical    TEXT,
  mensagem    TEXT,                   -- ate 2000 caracteres, como no lead
  elapsed_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_site_lead_spam_created ON site_lead_spam (created_at DESC);

COMMENT ON TABLE site_lead_spam IS
  'Envios do formulario do site barrados pelo filtro anti-robo (services/leadSpam.js). Nao entram em sales_leads. Guardados com o motivo para auditar falso positivo.';
