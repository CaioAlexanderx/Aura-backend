const { tickNfceRefresh, backoffMs, MAX_ATTEMPTS } = require('../../src/jobs/nfceRefreshJob');

function makeDb(emissions) {
  const updates = [];
  return {
    updates,
    query: jest.fn(async (sql, params) => {
      if (sql.includes("FROM nfce_emissions e")) return { rows: emissions };
      if (sql.includes('FROM nfce_config')) return { rows: [{ company_id: params[0], uf: 'SP', ambiente: 'homologacao' }] };
      if (sql.startsWith('UPDATE') || sql.includes('UPDATE nfce_emissions')) {
        updates.push({ sql: sql.replace(/\s+/g, ' '), params });
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

const emBase = {
  id: 'em-1', company_id: 'c-1',
  chave_acesso: '35260611222333000181650010000002311123456786',
  refresh_attempts: 0, last_refresh_at: null,
  created_at: new Date(Date.now() - 10 * 60000).toISOString(), // 10min atrás
};

describe('S2.4 — backoff', () => {
  test('exponencial com cap de 30min', () => {
    expect(backoffMs(0)).toBe(30e3);
    expect(backoffMs(1)).toBe(60e3);
    expect(backoffMs(5)).toBe(960e3);
    expect(backoffMs(9)).toBe(30 * 60e3); // cap
  });
});

describe('S2.4 — tick da fila', () => {
  test('autorizada tardia: vira autorizada com protocolo e transmitted_at', async () => {
    const db = makeDb([{ ...emBase }]);
    const sefazSp = { queryNfce: jest.fn(async () => ({ status: 'autorizado', protocolo: '135999' })) };
    const s = await tickNfceRefresh({ db, sefazSp });
    expect(s.authorized).toBe(1);
    const upd = db.updates.find(u => u.sql.includes("status='autorizada'"));
    expect(upd).toBeDefined();
    expect(upd.params[0]).toBe('135999');
    expect(upd.sql).toContain('transmitted_at=COALESCE');
  });

  test('não consta ainda: incrementa tentativa, mantém processando', async () => {
    const db = makeDb([{ ...emBase, refresh_attempts: 3 }]);
    const sefazSp = { queryNfce: jest.fn(async () => ({ status: 'processando' })) };
    const s = await tickNfceRefresh({ db, sefazSp });
    expect(s.stillPending).toBe(1);
    expect(db.updates[0].sql).toContain('refresh_attempts=refresh_attempts+1');
    expect(db.updates[0].sql).not.toContain("status='erro'");
  });

  test('última tentativa sem sucesso: vira erro com orientação de reemissão', async () => {
    // tentativa 9: backoff = cap de 30min — última consulta há 31min
    const db = makeDb([{ ...emBase, refresh_attempts: MAX_ATTEMPTS - 1, last_refresh_at: new Date(Date.now() - 31 * 60e3).toISOString() }]);
    const sefazSp = { queryNfce: jest.fn(async () => ({ status: 'processando' })) };
    const s = await tickNfceRefresh({ db, sefazSp });
    expect(s.exhausted).toBe(1);
    expect(db.updates[0].sql).toContain("status='erro'");
    expect(db.updates[0].sql).toContain('Reemita a venda');
  });

  test('dentro do backoff: pula sem consultar', async () => {
    const db = makeDb([{
      ...emBase, refresh_attempts: 4,
      last_refresh_at: new Date(Date.now() - 60e3).toISOString(), // backoff(4)=8min
    }]);
    const sefazSp = { queryNfce: jest.fn() };
    const s = await tickNfceRefresh({ db, sefazSp });
    expect(s.scanned).toBe(0);
    expect(sefazSp.queryNfce).not.toHaveBeenCalled();
  });

  test('SEFAZ fora do ar: conta tentativa e não derruba o tick', async () => {
    const db = makeDb([{ ...emBase }, { ...emBase, id: 'em-2' }]);
    const sefazSp = { queryNfce: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    const s = await tickNfceRefresh({ db, sefazSp });
    expect(s.errors).toBe(2);
    expect(db.updates.length).toBe(2);
  });
});
