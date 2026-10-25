-- ============================================================
-- 412 — Motivo "motivo_externo" no Registrar contato (tq-111, 24/10/2026)
--
-- Contexto (Caio, 24/10: "Concordo"): quem disse "não quer" por um motivo
-- de fora da Aura (fechou a loja, mudou de cidade, problema pessoal...)
-- recebe, no dia em que o teste termina, o e-mail 4.5 "Sua conta da Aura
-- fica guardada" no lugar do 4.4 (services/relacionamento.js). Para a
-- equipe marcar isso na Gestão Aura, o CHECK de company_admin_notes.motivo
-- (migration 383) ganha 'motivo_externo'.
--
-- DROP do CHECK antigo pelo nome real (company_admin_notes_motivo_check,
-- criado na 383) e ADD com a lista antiga + 'motivo_externo'. Idempotente:
-- rodar de novo só troca o CHECK pelo mesmo. Nenhuma linha muda: as notas
-- existentes têm motivo da lista antiga, que continua aceita. NADA aqui
-- reclassifica nota.
-- ============================================================

DO $$ BEGIN
  IF to_regclass('public.company_admin_notes') IS NOT NULL THEN
    ALTER TABLE company_admin_notes DROP CONSTRAINT IF EXISTS company_admin_notes_motivo_check;
    ALTER TABLE company_admin_notes ADD CONSTRAINT company_admin_notes_motivo_check
      CHECK (motivo IS NULL OR motivo IN
        ('estoque_na_entrada', 'preco_plano', 'fiscal', 'atrito_produto', 'funcionalidade',
         'frente_errada', 'ritmo_do_cliente', 'concorrente', 'elogio', 'motivo_externo'));
    COMMENT ON COLUMN company_admin_notes.motivo IS
      'O que pesou (10 classes; motivo_externo desde a 412). Obrigatorio quando resultado = nao_quer.';
  END IF;
END $$;
