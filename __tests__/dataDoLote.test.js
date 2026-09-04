// ============================================================
// A data do orçamento em lote (QA de 04/09/2026)
//
// A vitrine sugere "Ex: 12/10/2026" e o servidor mandava o texto direto
// para uma coluna DATE: "20/09/2026" virava mês 20, a rota devolvia 500
// e a noiva perdia o pedido no último passo. O que este teste guarda:
// os dois formatos entram, o que não é data vira 400 com frase, e o
// campo vazio continua opcional.
// ============================================================
const fs = require('fs');
const path = require('path');
const { normalizarDataDoLote } = require('../src/services/dataDoLote');

describe('normalizarDataDoLote', () => {
  test('dia/mês/ano, como a tela sugere', () => {
    expect(normalizarDataDoLote('20/09/2026')).toEqual({ data: '2026-09-20' });
    expect(normalizarDataDoLote('1/2/2027')).toEqual({ data: '2027-02-01' });
    expect(normalizarDataDoLote('  12/10/2026 ')).toEqual({ data: '2026-10-12' });
  });

  test('AAAA-MM-DD continua valendo (e sobrevive a um horário atrás)', () => {
    expect(normalizarDataDoLote('2026-09-20')).toEqual({ data: '2026-09-20' });
    expect(normalizarDataDoLote('2026-09-20T03:00:00.000Z')).toEqual({ data: '2026-09-20' });
  });

  test('vazio é opcional', () => {
    expect(normalizarDataDoLote('')).toEqual({ data: null });
    expect(normalizarDataDoLote(null)).toEqual({ data: null });
    expect(normalizarDataDoLote(undefined)).toEqual({ data: null });
  });

  test('o que não é data vira frase para a cliente, não 500', () => {
    for (const ruim of ['20/13/2026', '31/02/2026', 'semana que vem', '2026/09/20', '20-09-2026']) {
      const r = normalizarDataDoLote(ruim);
      expect(r.data).toBeUndefined();
      expect(r.erro).toMatch(/dia\/mês\/ano/);
    }
  });

  test('29 de fevereiro só em ano bissexto', () => {
    expect(normalizarDataDoLote('29/02/2028')).toEqual({ data: '2028-02-29' });
    expect(normalizarDataDoLote('29/02/2027').erro).toBeDefined();
  });
});

describe('a rota do lote usa a regra', () => {
  const fonte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'studioStorefront.js'), 'utf8');

  test('o POST do lote normaliza as duas datas antes do INSERT', () => {
    expect(fonte).toContain("require('../services/dataDoLote')");
    const i = fonte.indexOf("'/:slug/studio/bulk-order'");
    const trecho = fonte.slice(i, fonte.indexOf('INSERT INTO studio_bulk_events', i));
    expect(trecho).toContain('normalizarDataDoLote(b.delivery_deadline)');
    expect(trecho).toContain('normalizarDataDoLote(b.event_date)');
    expect(trecho).toContain('res.status(400)');
  });
});
