const { lookup, cStatFromErrorMessage, CATALOG } = require('../../src/services/sefazSp/rejectionCatalog');

describe('S2.2 — catálogo de rejeições (critério: 10 simuladas com mensagem correta)', () => {
  const casos = [
    ['778', /NCM/, 'config'],                       // real Davi (12×)
    ['391', /cart[ãa]o/i, 'aura'],                  // real Davi (3×)
    ['442', /pagamento/i, 'aura'],                  // real Davi (1×)
    ['204', /duplicada/i, 'aura'],
    ['539', /duplicada/i, 'aura'],
    ['217', /n[ãa]o consta/i, 'sefaz'],
    ['280', /certificado/i, 'config'],
    ['501', /prazo/i, 'lojista'],
    ['704', /futuro/i, 'lojista'],
    ['786', /CPF/, 'lojista'],
  ];

  test.each(casos)('cStat %s → título correto e dono certo', (cStat, regex, quem) => {
    const r = lookup(cStat);
    expect(r.conhecida).toBe(true);
    expect(r.titulo).toMatch(regex);
    expect(r.quem).toBe(quem);
    expect(r.acao.length).toBeGreaterThan(20); // ação concreta, não genérica
  });

  test('cStat desconhecido: fallback com o xMotivo da SEFAZ, sem jargão "Rejeição:"', () => {
    const r = lookup('912', 'Rejeição: Algum motivo exótico da SEFAZ');
    expect(r.conhecida).toBe(false);
    expect(r.titulo).toContain('Algum motivo exótico');
    expect(r.titulo).not.toMatch(/Rejei[cç][aã]o:/);
    expect(r.acao).toContain('912');
  });

  test('sem cStat nem motivo: ainda devolve orientação', () => {
    const r = lookup(null, null);
    expect(r.titulo).toBeTruthy();
    expect(r.acao).toBeTruthy();
  });

  test('cStatFromErrorMessage extrai do formato persistido "[778] ..."', () => {
    expect(cStatFromErrorMessage('[778] Rejeição: Informado NCM inexistente [nItem:1]')).toBe('778');
    expect(cStatFromErrorMessage('{"id":"nfc_..."}')).toBe(null);
    expect(cStatFromErrorMessage(null)).toBe(null);
  });

  test('catálogo cobre as 3 rejeições reais mineradas da base', () => {
    for (const real of ['778', '391', '442']) expect(CATALOG[real]).toBeDefined();
  });

  test('toda entrada tem titulo/acao/quem válidos', () => {
    for (const [code, e] of Object.entries(CATALOG)) {
      expect(code).toMatch(/^\d{3}$/);
      expect(e.titulo.length).toBeGreaterThan(10);
      expect(e.acao.length).toBeGreaterThan(20);
      expect(['lojista', 'config', 'aura', 'sefaz']).toContain(e.quem);
    }
  });
});
