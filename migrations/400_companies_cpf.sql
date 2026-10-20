-- ============================================================
-- 400 — companies.cpf: conta sem CNPJ, com CPF
--
-- Decisao do Caio em 20/10/2026: "vamos liberar para os clientes que
-- sinalizarem que nao tem CNPJ". O cadastro ganha "Nao tenho CNPJ", que pede
-- o CPF da pessoa e o nome da loja.
--
-- Medido antes (producao, 20/10): companies.cnpj e TEXT UNIQUE e nulavel;
-- nao havia coluna de CPF da empresa (so sensei_cpf, do karate, e tax_id,
-- que e o CNPJ formatado e vira emitente da NFC-e do Food). Guardar o CPF em
-- cnpj/tax_id faria a nota, o cupom e as telas tratarem CPF como CNPJ.
--
-- O que esta migration faz:
--   - coluna nova companies.cpf (11 digitos, so numeros), nulavel;
--   - indice UNICO parcial: dois cadastros nao usam o mesmo CPF (o
--     cadastro recusa antes com 409; o indice segura a corrida).
-- Nao toca em linha nenhuma: todas nascem com cpf NULL.
--
-- Idempotente: IF NOT EXISTS nos dois comandos.
-- Caminho de volta:
--   DROP INDEX IF EXISTS companies_cpf_key;
--   ALTER TABLE companies DROP COLUMN IF EXISTS cpf;
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS cpf TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS companies_cpf_key
  ON companies (cpf)
  WHERE cpf IS NOT NULL;

COMMENT ON COLUMN companies.cpf IS
  'CPF do dono quando a conta nao tem CNPJ (cadastro "Nao tenho CNPJ", 20/10/2026). So digitos. Unico entre as empresas.';
