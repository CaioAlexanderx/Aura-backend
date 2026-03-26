-- ============================================================
-- AURA. — Migration 014d: Food Service (extras)
-- Cardápio por período + índice de avaliação pós-entrega
-- Aplicar manualmente no Supabase SQL Editor
-- ============================================================

-- ── 1. HORÁRIOS DO CARDÁPIO (cardápio por período) ───────────
-- Permite que um cardápio tenha janelas de ativação automática
-- Ex: Cardápio Almoço → seg–sex 11h–15h
CREATE TABLE IF NOT EXISTS food_menu_schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id     UUID NOT NULL REFERENCES food_menus(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,             -- 'Almoço', 'Jantar', 'Final de semana'
  -- day_of_week: 0=Dom, 1=Seg ... 6=Sáb. NULL = todos os dias
  days_of_week INTEGER[],               -- ex: [1,2,3,4,5] = seg–sex
  start_time  TIME NOT NULL,            -- ex: '11:00'
  end_time    TIME NOT NULL,            -- ex: '15:00'
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. CAMPO: cardápio ativo por padrão fora de horário ──────
-- Se FALSE: fora do horário o cardápio fica inativo para pedidos online
-- Se TRUE: ativo o tempo todo (horário é apenas exibição)
ALTER TABLE food_menus
  ADD COLUMN IF NOT EXISTS always_available BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 3. TRACKING: review enviado após entrega ─────────────────
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS review_sent_at TIMESTAMPTZ;

-- ── 4. COMANDA: controle de impressão ────────────────────────
-- Rastreia quantas vezes a comanda foi impressa por pedido
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS comanda_print_count INTEGER NOT NULL DEFAULT 0;

-- ── 5. ÍNDICES ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_food_schedules_menu    ON food_menu_schedules(menu_id);
CREATE INDEX IF NOT EXISTS idx_food_schedules_company ON food_menu_schedules(company_id);

-- ── 6. RLS ────────────────────────────────────────────────────
ALTER TABLE food_menu_schedules ENABLE ROW LEVEL SECURITY;
