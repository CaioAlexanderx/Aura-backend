-- ============================================================
-- 123_sales_crm_leads
-- CRM comercial da Aura -- prospects / leads pre-venda
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  phone                 TEXT,
  city                  TEXT,
  category              TEXT,
  address               TEXT,
  website               TEXT,
  google_rating         NUMERIC(2,1),
  google_reviews        INT,
  source                TEXT NOT NULL DEFAULT 'google_maps',
  status                TEXT NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','contacted','responded','interested','demo','converted','lost')),
  lost_reason           TEXT,
  last_contact_at       TIMESTAMPTZ,
  next_followup_at      TIMESTAMPTZ,
  converted_company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_interactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,
  body        TEXT NOT NULL,
  channel     TEXT CHECK (channel IN ('whatsapp','ligacao','email','visita','sem_resposta','outro')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_leads_status   ON sales_leads(status);
CREATE INDEX IF NOT EXISTS idx_sales_leads_city     ON sales_leads(city);
CREATE INDEX IF NOT EXISTS idx_sales_leads_category ON sales_leads(category);
CREATE INDEX IF NOT EXISTS idx_sales_leads_followup ON sales_leads(next_followup_at) WHERE next_followup_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_interactions_lead ON lead_interactions(lead_id);

CREATE OR REPLACE FUNCTION set_sales_leads_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_sales_leads_updated_at ON sales_leads;
CREATE TRIGGER trg_sales_leads_updated_at
  BEFORE UPDATE ON sales_leads
  FOR EACH ROW EXECUTE FUNCTION set_sales_leads_updated_at();
