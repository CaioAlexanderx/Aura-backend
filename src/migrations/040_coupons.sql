-- Migration 040: Cupons de desconto
CREATE TABLE IF NOT EXISTS coupons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(30) NOT NULL,
  description TEXT,
  discount_type VARCHAR(10) NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','fixed')),
  discount_value NUMERIC(10,2) NOT NULL DEFAULT 0,
  min_order_value NUMERIC(10,2) DEFAULT 0,
  max_uses INTEGER DEFAULT NULL,
  current_uses INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_coupons_company ON coupons (company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons (company_id, code);

-- Add coupon_id to sales table
ALTER TABLE sales ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(30);
