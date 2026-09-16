-- ============================================================
-- 339 — karate_member_standing junta a faixa atual TAMBÉM por federação
--
-- A view juntava karate_current_belt só por `student_id`. Quem consulta
-- filtra por `federation_id` (Saúde da Rede, cobrança de faixa preta), mas
-- esse filtro caía na coluna de customers, não na de karate_current_belt —
-- e só um filtro na coluna da VIEW entra no DISTINCT ON dela. Resultado: a
-- view recalculava o histórico de faixas de TODAS as federações.
--
-- Com estatística velha (federação recém-criada, poucas centenas de
-- praticantes — abaixo do limiar do autoanalyze) o planejador estimava 1
-- praticante e fazia esse recálculo UMA VEZ POR PRATICANTE. 16/09/2026:
-- statement timeout na Saúde da Rede e no Painel da conta JKA.
--
-- `cb.federation_id = c.federation_id` deixa o planejador propagar o
-- federation_id da consulta para dentro da view. Não muda resultado:
-- conferido em prod no mesmo dia — 0 linhas de karate_belt_history com
-- federação diferente da do aluno, 0 alunos com histórico em 2 federações.
--
-- Única mudança em relação à definição vigente: a condição do JOIN.
-- Colunas, ordem e tipos idênticos (exigência do CREATE OR REPLACE VIEW).
-- Idempotente: rodar de novo recria a mesma view.
-- ============================================================

CREATE OR REPLACE VIEW karate_member_standing AS
 SELECT c.id AS student_id,
    c.federation_id,
    c.dojo_id,
    c.name AS full_name,
    c.karate_registration_number,
    c.phone AS whatsapp,
    COALESCE(c.is_active, true) AS is_active,
    cb.belt_level,
    cb.belt_name,
    cb.belt_level = 'preta'::text AS is_black_belt,
    EXTRACT(year FROM now())::integer AS reference_year,
    fin.tx_id AS annuity_tx_id,
    fin.amount::numeric(12,2) AS annuity_amount,
    fin.due_date AS annuity_due_date,
    fin.paid AS annuity_paid,
        CASE
            WHEN cb.belt_level <> 'preta'::text THEN 'nao_aplicavel'::text
            WHEN NOT COALESCE(c.is_active, true) THEN 'nao_aplicavel'::text
            WHEN fin.tx_id IS NULL THEN 'sem_cobranca'::text
            WHEN fin.paid THEN 'em_dia'::text
            WHEN fin.overdue_open_count > 0 THEN 'atrasado'::text
            ELSE 'em_dia'::text
        END AS financeiro,
        CASE
            WHEN cb.belt_level = 'preta'::text AND COALESCE(c.is_active, true) AND fin.tx_id IS NOT NULL THEN COALESCE(fin.valor_em_aberto, 0::numeric)
            ELSE 0::numeric
        END::numeric(12,2) AS valor_em_aberto,
    fin.paid_amount::numeric(12,2) AS annuity_paid_amount,
        CASE
            WHEN cb.belt_level = 'preta'::text AND COALESCE(c.is_active, true) AND fin.tx_id IS NOT NULL THEN COALESCE(fin.valor_atrasado, 0::numeric)
            ELSE 0::numeric
        END::numeric(12,2) AS valor_atrasado
   FROM customers c
     JOIN karate_current_belt cb
       ON cb.student_id = c.id
      AND cb.federation_id = c.federation_id
     LEFT JOIN LATERAL ( SELECT hh.id AS tx_id,
            sum(i.amount) AS amount,
            sum(
                CASE
                    WHEN i.status = 'paid'::text THEN i.amount
                    ELSE 0::numeric
                END) AS paid_amount,
            min(i.due_date) AS due_date,
            bool_and(i.status = 'paid'::text) AS paid,
            count(*) FILTER (WHERE i.status <> 'paid'::text AND i.due_date IS NOT NULL AND i.due_date <= CURRENT_DATE) AS overdue_open_count,
            sum(
                CASE
                    WHEN i.status <> 'paid'::text THEN i.amount
                    ELSE 0::numeric
                END) AS valor_em_aberto,
            sum(
                CASE
                    WHEN i.status <> 'paid'::text AND i.due_date IS NOT NULL AND i.due_date <= CURRENT_DATE THEN i.amount
                    ELSE 0::numeric
                END) AS valor_atrasado
           FROM karate_dojo_annuity_history hh
             JOIN karate_annuity_installments i ON i.annuity_id = hh.id
          WHERE hh.practitioner_id = c.id AND hh.reference_period = EXTRACT(year FROM now())::text
          GROUP BY hh.id
          ORDER BY (bool_and(i.status = 'paid'::text)) DESC, (min(i.due_date)) DESC NULLS LAST
         LIMIT 1) fin ON true;
