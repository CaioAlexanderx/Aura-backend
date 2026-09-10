// ============================================================
// AURA CRÉDITO — desfazer lançamento manual não pode deixar parcela órfã
// (guarda-corpo estático, 10/09/2026)
//
// O BUG (Jenniffer / Ana Lucia): DELETE /credit/transaction/:txid fazia um
// DELETE seco em customer_credit_transactions. As parcelas criadas junto pelo
// /manual-entry ficavam 'pending', o FIFO seguia cobrindo-as e a ficha
// mostrava EM ABERTO R$199 (ledger) com parcelas somando R$938.
//
// Este arquivo não precisa de banco: garante que a rota passou a delegar ao
// serviço transacional e que o /manual-entry grava o vínculo transaction_id.
// A semântica (cancelar, realocar cobertura, apagar) vive em
// credito.desfazerLancamentoSemParcelaOrfa.test.js, com Postgres real.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const ROTA = fs.readFileSync(path.join(__dirname, '..', 'src/routes/credit.js'), 'utf8');

function trechoDaRota(marcador) {
  const ini = ROTA.indexOf(marcador);
  expect(ini).toBeGreaterThan(-1);
  const fim = ROTA.indexOf('\nrouter.', ini + marcador.length);
  return ROTA.slice(ini, fim === -1 ? undefined : fim);
}

describe('DELETE /credit/transaction/:txid', () => {
  const trecho = trechoDaRota("router.delete('/transaction/:txid'");

  test('não faz mais o DELETE seco no ledger', () => {
    expect(trecho).not.toMatch(/DELETE FROM customer_credit_transactions/);
  });

  test('roda dentro de uma transação e delega ao serviço que cancela as parcelas', () => {
    expect(trecho).toContain("client.query('BEGIN')");
    expect(trecho).toContain("client.query('COMMIT')");
    expect(trecho).toContain('undoManualEntry(client');
  });
});

describe('serviço undoManualEntry', () => {
  const fonte = fs.readFileSync(
    path.join(__dirname, '..', 'src/services/credit/undoManualEntry.js'), 'utf8');

  test('cancela as parcelas ligadas antes de apagar o débito', () => {
    const cancela = fonte.indexOf("SET status = 'cancelled'");
    const apaga   = fonte.indexOf('DELETE FROM customer_credit_transactions');
    expect(cancela).toBeGreaterThan(-1);
    expect(apaga).toBeGreaterThan(cancela);
  });

  test('só aceita débito (pagamento e devolução têm outros efeitos)', () => {
    expect(fonte).toContain("tx.type !== 'debit'");
    expect(fonte).toContain('NOT_MANUAL_DEBIT');
  });

  test('acha as parcelas pelo vínculo novo e pelos dois caminhos de legado', () => {
    expect(fonte).toContain('transaction_id = $3');            // migration 324
    expect(fonte).toContain('created_at = $3');                // mesmo NOW()
    expect(fonte).toMatch(/HAVING ABS\(SUM\(amount_due\) - \$4::numeric\) < 0\.005/); // soma
  });
});

describe('POST /credit/manual-entry', () => {
  test('grava transaction_id nas parcelas que cria', () => {
    const trecho = trechoDaRota("router.post('/manual-entry'");
    expect(trecho).toContain('insertManualInstallment(client');
    expect(trecho).toContain('transactionId: transaction.id');
    expect(ROTA).toMatch(/INSERT INTO credit_installments \(\$\{cols\}, account_id, transaction_id\)/);
  });
});

describe('migration 324', () => {
  test('existe e cria a coluna com o backfill inequívoco', () => {
    const dir = path.join(__dirname, '..', 'migrations');
    const arq = fs.readdirSync(dir).find((f) => f.startsWith('324_'));
    expect(arq).toBeDefined();
    const sql = fs.readFileSync(path.join(dir, arq), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS transaction_id UUID/);
    expect(sql).toMatch(/ON DELETE SET NULL/);
    expect(sql).toMatch(/t\.created_at\s*=\s*ci\.created_at/);
  });
});
