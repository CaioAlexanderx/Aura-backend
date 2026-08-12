-- ============================================================
-- 278 — NF-e 55 de devolução: série própria por empresa + updated_at
--        em nfce_emissions (schema drift).
--
-- Contexto (12/08/2026, auditoria troca fiscal):
--
-- (a) Rejeição 539 recorrente: a numeração da NF-e 55 de devolução era
--     MAX(numero)+1 sobre nfce_emissions, série 1 fixa. Mas o CNPJ pode
--     ter queimado números da série 1 num ERP anterior — a Davi Calçados
--     Matriz tem NF-e 55 série 1 de 2023, e TODA tentativa de devolução
--     (03/07 nº1, 04/07 nº2, 11/08 nº3) morreu com "539 - Duplicidade de
--     NF-e com diferença na Chave de Acesso". Solução: série DEDICADA por
--     empresa (default 2, configurável) + contador atômico, mesmo padrão
--     de serie_sefaz_sp/next_number_sefaz_sp da NFC-e própria.
--     Se a série 2 também tiver histórico no CNPJ, basta ajustar
--     serie_nfe55 na linha da empresa (sem deploy).
--
-- (b) updated_at: trocaV2.js (pós-commit e reemitirEmissao) faz
--     UPDATE nfce_emissions ... SET updated_at = NOW(), mas a coluna
--     nunca existiu → 42703 → o catch marcava a emissão pendente como
--     'falha' com o erro de banco, MESMO quando a SEFAZ autorizava.
--     Mesma classe de drift do incidente 01/06 (migration 142).
--
-- Idempotente (padrão do repo).
-- ============================================================

ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE nfce_config
  ADD COLUMN IF NOT EXISTS serie_nfe55 INTEGER NOT NULL DEFAULT 2;

ALTER TABLE nfce_config
  ADD COLUMN IF NOT EXISTS next_number_nfe55 INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN nfce_config.serie_nfe55 IS
  'Série da NF-e 55 de devolução emitida pelo Aura. Default 2 — série 1 costuma ter números queimados por ERPs anteriores do CNPJ (Rejeição 539). Ajustar por empresa se necessário.';

COMMENT ON COLUMN nfce_config.next_number_nfe55 IS
  'Próximo nNF da NF-e 55 de devolução. Alocação atômica em trocaDevolucao55 (UPDATE ... RETURNING). Gaps por falha de emissão são aceitáveis (inutilização cobre).';

COMMENT ON COLUMN nfce_emissions.updated_at IS
  'Última atualização de status (pós-commit da troca, reemissão manual, jobs). Adicionada na 278 — antes o UPDATE com updated_at quebrava com 42703 e mascarava o resultado fiscal real.';
