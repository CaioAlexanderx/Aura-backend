-- 229_karate_current_belt_rank_fix.sql
--
-- Traz para o repo duas correções de karate_current_belt aplicadas
-- DIRETO em produção hoje (via Supabase MCP) e que ainda não existiam em
-- nenhum arquivo versionado — sem isso, o CI (que reconstrói o schema do
-- zero a partir de migrations/*.sql) recriaria a view ANTIGA e quebrada.
--
-- Este arquivo é uma TRANSCRIÇÃO fiel da definição atual em produção
-- (conferida via `SELECT pg_get_viewdef('public.karate_current_belt', true)`
-- em 13/07/2026), não uma reescrita — a intenção é fechar o drift, não
-- introduzir uma terceira versão.
--
-- karate_member_standing DEPENDE desta view (JOIN direto) — por isso
-- CREATE OR REPLACE VIEW (mesmas colunas/tipos da 189/151), nunca DROP.
-- DROP VIEW derrubaria os GRANTs de anon/authenticated/service_role (que
-- nem existem no CI) e o JOIN em karate_member_standing; já quebramos o
-- CI assim antes (ver 222_karate_annuity_installments.sql).
--
-- ── Correção 1: faixa não regride mais por data (substitui a 189) ──────
-- A 189 (karate_current_belt_tiebreak) ordenava por `graduated_at DESC`
-- PRIMEIRO e usava a hierarquia de faixa só como desempate. Faixa nunca
-- regride no karatê — mas o histórico importado tem 6.498 eventos
-- datados antes de 1950 (sentinela '1900-01-01' usada pelo import),
-- além de datas em 2028 e 2201. Resultado: uma faixa preta datada de
-- 1900 perdia de uma branca de 1998 porque a ORDER BY olhava a data
-- antes da hierarquia. Fix: hierarquia de faixa (belt_level) vira o
-- CRITÉRIO PRIMÁRIO do ORDER BY; graduated_at só entra no fim, como
-- desempate final. Também faltavam 'azul_claro' e 'azul_escuro' no mapa
-- de graus da 189 — caíam no ELSE 0 (mesmo peso da vermelha/legada) e
-- podiam perder pra faixas abaixo delas. Ordem canônica FPKT confirmada:
-- branca(1) < amarela(2) < laranja(3) < verde(4) < roxa(5) < azul_claro(6)
-- < azul_escuro(7) < marrom(8) < preta(9); vermelha(0) fica fora da
-- progressão (legada).
--
-- ── Correção 2: grau da preta mora em belt_name, não em belt_level ─────
-- belt_level de uma faixa preta é sempre o literal 'preta' — o grau
-- ('Preta 1°' ... 'Preta 7°') mora em belt_name. Sem extrair o número de
-- belt_name, todas as pretas empatavam no desempate de grau e a ORDER BY
-- caía direto pra graduated_at — uma 'Preta 7°' com data desconhecida
-- perdia pra uma 'Preta 3°' de 2000. Caso real: Yasuyuki Sasaki
-- (matrícula 1-Y-SHICHI, sufixo "SHICHI" = 7 em japonês) exibia Preta 3°
-- em vez de Preta 7°. Fix: extrai o grau numérico de belt_name via
-- regexp_replace (dígitos), tanto pra preta (dan, ordem CRESCENTE — dan
-- maior vence) quanto pra marrom com "Xº Kyu" em belt_name (kyu, ordem
-- DECRESCENTE — 1º kyu > 3º kyu, por isso o `10 - kyu`).
--
-- Desempate final (ordem de critérios no ORDER BY): faixa (hierarquia)
-- → grau (dan crescente na preta / kyu decrescente no marrom) →
-- graduated_at DESC NULLS LAST. NULLS LAST é proposital: o padrão do
-- Postgres em DESC é NULLS FIRST, o que faria uma data DESCONHECIDA
-- (NULL) vencer uma data CONHECIDA no desempate — o oposto do desejado
-- (data conhecida vence data desconhecida).
--
-- Idempotente: CREATE OR REPLACE VIEW. Já aplicada em produção — este
-- arquivo só sincroniza o repo/CI com o que já está no ar.

CREATE OR REPLACE VIEW karate_current_belt AS
SELECT DISTINCT ON (student_id, federation_id)
  student_id,
  federation_id,
  belt_level,
  belt_name,
  belt_schema,
  graduated_at AS current_since,
  exam_id
FROM karate_belt_history
ORDER BY
  student_id,
  federation_id,
  (
    CASE lower(belt_level)
      WHEN 'branca' THEN 1
      WHEN 'amarela' THEN 2
      WHEN 'laranja' THEN 3
      WHEN 'verde' THEN 4
      WHEN 'roxo' THEN 5
      WHEN 'roxa' THEN 5
      WHEN 'azul_claro' THEN 6
      WHEN 'azul_escuro' THEN 7
      WHEN 'marrom' THEN 8
      WHEN 'preta' THEN 9
      WHEN 'vermelha' THEN 0
      ELSE 0
    END
  ) DESC,
  (
    CASE
      WHEN lower(belt_level) = 'preta' THEN
        COALESCE(NULLIF(regexp_replace(COALESCE(belt_name, ''), '\D', '', 'g'), '')::integer, 0)
      WHEN belt_name ILIKE '%kyu%' THEN
        10 - COALESCE(NULLIF(regexp_replace(COALESCE(belt_name, ''), '\D', '', 'g'), '')::integer, 10)
      ELSE 0
    END
  ) DESC,
  graduated_at DESC NULLS LAST;

-- ============================================================
-- FIM DA MIGRATION 229
-- ============================================================
