-- ============================================================
-- 404 — Empresa principal para todo dono (INC-2026-10-22-01, tq-103)
--
-- O caso: uma lojista em teste removeu a própria e única empresa. O
-- DELETE /me/companies/:id só recusava is_primary = true, e o POST
-- /auth/register não marcava a primeira empresa como principal. Em 22/10
-- eram 57 de 64 donos com empresa ativa sem nenhuma empresa principal.
--
-- O código já passou a recusar a última empresa (409 LAST_COMPANY) e o
-- cadastro já cria a empresa com is_primary = true. Esta migration acerta
-- quem ficou para trás: para cada dono que tem empresa ativa e NENHUMA
-- empresa ativa marcada como principal, marca a empresa ativa mais antiga
-- (created_at, desempate por id).
--
-- O que ela NÃO toca:
--   - empresa inativa (is_active = false), nem como candidata
--   - dono que já tem uma principal ativa
--   - billing_owner_company_id e qualquer outra coluna
--
-- Respeita uq_companies_primary_per_owner (migration 082: uma principal
-- ativa por dono): só escolhe uma empresa por dono, e só para quem não tem.
--
-- Idempotente: na segunda execução todo dono com empresa ativa já tem uma
-- principal, o UPDATE não acha linha e nada muda.
--
-- Contagem esperada na primeira execução em produção: 57 linhas (uma por
-- dono). Conferir antes com:
--   SELECT COUNT(DISTINCT c.owner_id) FROM companies c
--    WHERE c.is_active = true
--      AND NOT EXISTS (SELECT 1 FROM companies p
--                       WHERE p.owner_id = c.owner_id
--                         AND p.is_active = true AND p.is_primary = true);
--
-- Como desfazer: não há coluna que diga quem esta migration marcou. Antes
-- de aplicar, guarde os ids que ela vai marcar rodando só o SELECT do CTE
-- sem_principal abaixo. Para reverter:
--   UPDATE companies SET is_primary = false WHERE id IN (<ids guardados>);
-- O runner registra a 404 em schema_migrations; ao reverter, apague também
-- essa linha se quiser que ela rode de novo.
-- ============================================================

WITH sem_principal AS (
  SELECT DISTINCT ON (c.owner_id) c.id
    FROM companies c
   WHERE c.is_active = true
     AND c.owner_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM companies p
        WHERE p.owner_id = c.owner_id
          AND p.is_active = true
          AND p.is_primary = true
     )
   ORDER BY c.owner_id, c.created_at ASC NULLS LAST, c.id ASC
)
UPDATE companies c
   SET is_primary = true
  FROM sem_principal s
 WHERE c.id = s.id
   AND c.is_primary = false;
