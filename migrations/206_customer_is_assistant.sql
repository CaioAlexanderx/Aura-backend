-- Adds is_assistant role flag to customers (practitioner "Auxiliar" role for dojo technical staff)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_assistant boolean NOT NULL DEFAULT false;
