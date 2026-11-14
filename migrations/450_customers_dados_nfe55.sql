-- ============================================================
-- 450 — Cliente com os dados que a NF-e modelo 55 de venda pede
-- (14/11/2026, CP2 da NF-e 55 de venda pela emissão própria).
--
-- A NF-e 55 tem destinatário completo: além de CPF/CNPJ e endereço (que o
-- cadastro já guarda — street, number, complement, neighborhood, city,
-- state, zip_code), ela exige o indicador da inscrição estadual
-- (indIEDest), a IE quando o cliente é contribuinte e o código IBGE do
-- município (enderDest/cMun). Nada disso existia em customers.
--
--   ie                     IE do cliente, só dígitos, ou 'ISENTO'
--   ind_ie_dest            1 = contribuinte com IE, 2 = isento, 9 = não
--                          contribuinte (NULL = ainda não informado; a
--                          emissão deduz: IE → 1, sem IE → 9)
--   codigo_municipio_ibge  7 dígitos; preenchido pelo CEP (ViaCEP) na
--                          emissão quando o lojista pede "salvar no cadastro"
--
-- O backend tolera a migration ausente (42703 → lê e grava sem as colunas,
-- services/nfe55Venda.js). Idempotente.
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS ie text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ind_ie_dest smallint;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS codigo_municipio_ibge text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_ind_ie_dest_check'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_ind_ie_dest_check
      CHECK (ind_ie_dest IS NULL OR ind_ie_dest IN (1, 2, 9));
  END IF;
END
$$;

COMMENT ON COLUMN customers.ie IS
  'Inscrição estadual do cliente (só dígitos) ou ISENTO. Usada no dest da NF-e 55 de venda (migration 450).';
COMMENT ON COLUMN customers.ind_ie_dest IS
  'indIEDest da NF-e: 1 contribuinte com IE, 2 isento, 9 não contribuinte. NULL = não informado (migration 450).';
COMMENT ON COLUMN customers.codigo_municipio_ibge IS
  'Código IBGE do município do endereço (7 dígitos), enderDest/cMun da NF-e 55 (migration 450).';
