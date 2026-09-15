-- ============================================================
-- 333 — Ordem de Serviço ganha override próprio ("os")
--
-- Até 14/09/2026 o item /os do app usava a chave "pdv" emprestada: quem
-- tinha module_overrides.pdv = false (Caixa escondido pelo admin) também
-- perdia a OS do menu. O app passou a ter a chave "os" e o backend
-- (services/modules.js) passou a aceitá-la no PUT /admin/clients/:cid/modules.
--
-- Para ninguém ganhar acesso que não tinha, a empresa com pdv = false e SEM
-- chave "os" recebe os = false. Quem já tem "os" gravado (qualquer valor)
-- não é tocado. Depois disto o app pode remover o fallback transitório
-- OVERRIDE_HIDE_FALLBACK (hooks/useVisibleModules.ts).
--
-- Idempotente: a segunda execução não encontra linha sem "os".
-- Guard de coluna: module_overrides nasce em src/migrations/041, que o
-- Postgres do CI não aplica.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'companies'
       AND column_name  = 'module_overrides'
  ) THEN
    UPDATE companies
       SET module_overrides = module_overrides || '{"os": false}'::jsonb
     WHERE module_overrides->>'pdv' = 'false'
       AND NOT (module_overrides ? 'os');
  END IF;
END $$;
