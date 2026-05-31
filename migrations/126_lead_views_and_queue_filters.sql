-- ============================================================
-- Migration 126: Saved Views (lentes salvas) + filtros extras
-- pra suportar a Fila do dia e priorizacao.
-- ============================================================

-- ── Tabela de lentes salvas ─────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_lead_views (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  filters      JSONB NOT NULL DEFAULT '{}'::jsonb,
  icon         TEXT,
  color        TEXT,
  is_pinned    BOOLEAN NOT NULL DEFAULT FALSE,
  is_system    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order   INT NOT NULL DEFAULT 100,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sales_lead_views_pinned_idx ON sales_lead_views (is_pinned, sort_order) WHERE is_pinned = TRUE;
CREATE INDEX IF NOT EXISTS sales_lead_views_system_idx ON sales_lead_views (is_system, sort_order);

-- Trigger pra atualizar updated_at
CREATE OR REPLACE FUNCTION touch_sales_lead_views_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sales_lead_views_updated_at_trg ON sales_lead_views;
CREATE TRIGGER sales_lead_views_updated_at_trg
  BEFORE UPDATE ON sales_lead_views
  FOR EACH ROW EXECUTE FUNCTION touch_sales_lead_views_updated_at();

-- ── Seed: 5 lentes builtin (is_system=true, nao deletaveis) ───
INSERT INTO sales_lead_views (name, description, filters, icon, color, is_pinned, is_system, sort_order)
VALUES
  ('Hoje',
   'Follow-ups vencendo + status ativos (exclui convertidos e perdidos)',
   '{"followup_due":true,"status_not_in":"converted,lost"}'::jsonb,
   'clock', '#ef4444', TRUE, TRUE, 10),

  ('Quentes esquecidos',
   'Score alto sem atividade ha mais de 7 dias',
   '{"min_score":50,"stale_days":7,"status_not_in":"converted,lost"}'::jsonb,
   'flame', '#f97316', TRUE, TRUE, 20),

  ('Funil critico',
   'Demos e interessados parados ha mais de 3 dias',
   '{"status_in":"demo,interested","stale_days":3}'::jsonb,
   'alert', '#a855f7', TRUE, TRUE, 30),

  ('Reativacao',
   'Rotten com score 30+ e telefone — vale uma nova tentativa',
   '{"is_rotten":true,"min_score":30,"has_phone":true}'::jsonb,
   'users', '#0891b2', TRUE, TRUE, 40),

  ('Recem-importados',
   'Criados nas ultimas 24h sem nenhum contato',
   '{"recent_hours":24,"no_contact":true}'::jsonb,
   'plus', '#10b981', TRUE, TRUE, 50)
ON CONFLICT DO NOTHING;
