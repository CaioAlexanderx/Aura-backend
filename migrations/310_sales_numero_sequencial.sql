-- ============================================================
-- 310 — Numero sequencial da venda, por empresa (sales.sale_number)
--
-- Contexto (QA de usabilidade, 29/08/2026): a tela de sucesso do PDV
-- exibia o UUID cru da venda como se fosse o numero dela
-- (#6c66d000-5e95-4af8-887e-2d793eab8260). Numero de venda e algo que
-- a operadora LE EM VOZ ALTA pro cliente e anota no caderno; 36
-- caracteres de chave interna nao servem pra isso.
--
-- DECISOES:
--
-- (a) POR EMPRESA, nao global. Multi-CNPJ: a Matriz e a Filial contam
--     cada uma a partir de 1. Um sequencial global vazaria volume de
--     uma loja pra outra e comecaria a venda #1 da filial nova em
--     #48.291. O contador vive em company_sale_counters, uma linha por
--     company_id.
--
-- (b) CONTADOR EM TABELA, nao SEQUENCE nem MAX()+1.
--     - SEQUENCE por empresa exigiria DDL a cada empresa criada.
--     - MAX(sale_number)+1 nao e seguro sob concorrencia: duas vendas
--       simultaneas na mesma empresa leriam o mesmo MAX (o SELECT nao
--       bloqueia nada) e gravariam o mesmo numero.
--     O UPSERT com ON CONFLICT DO UPDATE ... RETURNING trava a LINHA do
--     contador daquela empresa ate o COMMIT. Duas vendas simultaneas na
--     MESMA empresa serializam (a segunda espera); em empresas
--     diferentes nao ha contencao nenhuma. Mesmo padrao de alocacao
--     atomica ja usado em nfce_config.next_number_nfe55 (migration 278).
--
-- (c) SEM BURACOS. Como o incremento acontece DENTRO da transacao da
--     venda, um ROLLBACK (estoque insuficiente, cupom invalido, erro no
--     crediario) desfaz tambem o incremento. A venda seguinte pega o
--     mesmo numero que a fracassada teria pego. Diferente da numeracao
--     fiscal (nfce), onde o gap e aceitavel porque a SEFAZ ja recebeu o
--     numero — aqui o numero e interno e nada externo o consumiu.
--
-- (d) TRIGGER, nao INSERT explicito em cada rota. Hoje existem 5
--     caminhos que gravam em `sales` (pdv.js POST /sale, foodOrders.js,
--     trocaV2.js x2, credit/refund.js) e nada garante que o sexto vai
--     lembrar. O BEFORE INSERT cobre todos, inclusive import e seed, e
--     o `RETURNING *` que o pdv.js ja faz devolve o numero de graca.
--     Se o INSERT vier com sale_number explicito, a trigger respeita
--     (caminho de migracao de dados).
--
-- (e) BACKFILL cronologico por empresa: as vendas que ja existem
--     recebem numero por ordem de created_at, entao o historico fica
--     coerente com a linha do tempo que a lojista ja conhece.
--
-- Idempotente (padrao do repo).
-- ============================================================

-- ── (1) Coluna ──────────────────────────────────────────────
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS sale_number INTEGER;

COMMENT ON COLUMN sales.sale_number IS
  'Numero sequencial da venda DENTRO da empresa (1, 2, 3...). Legivel em voz alta no balcao. Atribuido pela trigger trg_sales_assign_number a partir de company_sale_counters. NAO e numero fiscal (esse e nfce_emissions.numero).';

-- ── (2) Contador por empresa ────────────────────────────────
CREATE TABLE IF NOT EXISTS company_sale_counters (
  company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE company_sale_counters IS
  'Ultimo sale_number entregue por empresa. Alocacao atomica via UPSERT ... RETURNING (trava a linha ate o COMMIT da venda).';

-- ── (3) Backfill cronologico das vendas existentes ──────────
-- WHERE sale_number IS NULL torna o bloco um no-op na segunda execucao
-- e em banco novo (CI). row_number() por empresa ordenando por
-- created_at reproduz a ordem que a lojista viu acontecer.
DO $$
DECLARE
  v_rows BIGINT;
BEGIN
  WITH numerado AS (
    SELECT id,
           row_number() OVER (PARTITION BY company_id ORDER BY created_at ASC, id ASC) AS n
      FROM sales
     WHERE sale_number IS NULL
  )
  UPDATE sales s
     SET sale_number = numerado.n
    FROM numerado
   WHERE s.id = numerado.id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE '[migration 310] backfill: % vendas numeradas', v_rows;
END
$$;

-- Semeia o contador com o maior numero ja usado por empresa. GREATEST
-- protege contra rodar de novo depois de vendas novas terem passado
-- pela trigger (o contador nunca anda pra tras).
INSERT INTO company_sale_counters (company_id, last_number)
SELECT company_id, MAX(sale_number)
  FROM sales
 WHERE sale_number IS NOT NULL
 GROUP BY company_id
ON CONFLICT (company_id) DO UPDATE
  SET last_number = GREATEST(company_sale_counters.last_number, EXCLUDED.last_number),
      updated_at  = NOW();

-- ── (4) Unicidade por empresa ───────────────────────────────
-- Parcial: linhas legadas que por algum motivo fiquem sem numero nao
-- impedem a criacao do indice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_company_sale_number
  ON sales (company_id, sale_number)
  WHERE sale_number IS NOT NULL;

-- ── (5) Alocacao atomica ────────────────────────────────────
CREATE OR REPLACE FUNCTION next_sale_number(p_company_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_number INTEGER;
BEGIN
  INSERT INTO company_sale_counters AS c (company_id, last_number)
       VALUES (p_company_id, 1)
  ON CONFLICT (company_id) DO UPDATE
       SET last_number = c.last_number + 1,
           updated_at  = NOW()
    RETURNING c.last_number INTO v_number;

  RETURN v_number;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION next_sale_number(UUID) IS
  'Proximo numero de venda da empresa. Atomico: o UPSERT trava a linha do contador ate o COMMIT, entao duas vendas simultaneas na mesma empresa nunca recebem o mesmo numero, e um ROLLBACK devolve o numero.';

-- ── (6) Trigger de atribuicao ───────────────────────────────
CREATE OR REPLACE FUNCTION assign_sale_number()
RETURNS TRIGGER AS $$
BEGIN
  -- INSERT com numero explicito (migracao/import) e respeitado.
  IF NEW.sale_number IS NULL AND NEW.company_id IS NOT NULL THEN
    NEW.sale_number := next_sale_number(NEW.company_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sales_assign_number ON sales;
CREATE TRIGGER trg_sales_assign_number
  BEFORE INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION assign_sale_number();

-- ── Sanity check ────────────────────────────────────────────
DO $$
DECLARE
  v_sem_numero BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_sem_numero FROM sales WHERE sale_number IS NULL;
  RAISE NOTICE '[migration 310] vendas sem sale_number apos backfill: %', v_sem_numero;
END
$$;
