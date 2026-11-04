// ============================================================
// AURA. — E-mail de fechamento do mês com a planilha .xlsx (03/11/2026)
//
// services/fechamentoDoMes.js, services/planilhaXlsx.js e
// templates/fechamentoDoMes.js. Mockup: aura-app
// docs/mockups/relatorio-vendas-por-numeracao.html, tela 6.
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');
const X = require('../src/services/planilhaXlsx');
const F = require('../src/services/fechamentoDoMes');
const T = require('../src/templates/fechamentoDoMes');
const V = require('../src/services/vendasPorNumeracao');
const P = require('../src/services/emailPreferencias');

const PRIMARIA = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';

// Relatório do mockup (Tênis Runner) já montado pelo service de verdade.
const TAM = ['36', '37', '38', '39'];
const rel = (() => {
  const r = V.montarRelatorio({
    produtos: [{ id: 'p1', name: 'Tênis Runner Branco', sku: 'TR-100', category: 'Tênis', unit: 'un', size: null, stock_qty: 0, is_active: true, supplier: null }],
    variantes: TAM.map((t, i) => ({ id: 'v' + t, product_id: 'p1', stock_qty: [2, 3, 1, 0][i], is_active: true, color_name: null, valores: [{ a: 'Tamanho', v: t }] })),
    vendas: TAM.map((t, i) => ({ product_id: 'p1', variant_id: 'v' + t, qtd: [9, 12, 10, 6][i], receita: [9, 12, 10, 6][i] * 199.9 })),
    opts: { dias: 31, vendidosAnterior: 30 },
  });
  return { ...r, periodo: { inicio: '2026-10-01', fim: '2026-10-31', dias: 31, rotulo: 'Outubro de 2026' } };
})();

describe('planilha .xlsx sem dependência', () => {
  test('CRC-32 e letras de coluna', () => {
    expect(X.crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect([0, 25, 26, 27, 701, 702].map(X.letraDaColuna)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  test('zip válido com as 6 partes; texto escapado; número fica número', () => {
    const b = X.montarXlsx({
      aba: 'Out/2026', colunas: [{ titulo: 'Modelo' }, { titulo: 'Vendidos', tipo: 'inteiro' }],
      linhas: [['Sandália "Flat" & <Nude>', 35], ['Bota\u0007', null]],
    });
    expect(b.slice(0, 4).toString('binary')).toBe('PK\u0003\u0004');
    expect(b.readUInt32LE(b.length - 22)).toBe(0x06054b50);
    expect(b.readUInt16LE(b.length - 22 + 10)).toBe(6);
    const txt = b.toString('utf8');
    for (const parte of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) expect(txt).toContain(parte);
    expect(txt).toContain('Sandália &quot;Flat&quot; &amp; &lt;Nude&gt;');
    expect(txt).toContain('<c r="B2" s="3"><v>35</v></c>');
    expect(txt).toContain('<t xml:space="preserve">Bota</t>'); // o caractere de controle saiu
    expect(txt).toContain('<sheet name="Out 2026"'); // barra não pode em nome de aba
    expect(txt).toContain('<autoFilter ref="A1:B3"/>');
  });

  test('linhas: uma por modelo × numeração, repor por numeração', () => {
    const l = F.linhasDaPlanilha(rel);
    expect(l.map((x) => [x[4], x[5], x[7], x[9]])).toEqual([['36', 9, 2, 7], ['37', 12, 3, 9], ['38', 10, 1, 9], ['39', 6, 0, 6]]);
    expect(l[0][6]).toBeCloseTo(37 * 199.9, 2); // receita só na 1ª linha do modelo
    expect(l[1][6]).toBeNull();
    expect(F.nomeDoArquivo(rel.periodo)).toBe('vendas-por-numeracao-2026-10.xlsx');
  });
});

describe('template', () => {
  const env = { APP_URL: 'https://app.getaura.com.br', EMAIL_LINK_SECRET: 'x'.repeat(32), API_URL: 'https://api.getaura.com.br' };
  const e = T.montarEmailDoFechamento({ rel, companyId: PRIMARIA, nome: 'Loja Teste', env });

  test('assunto com pares e receita; prévia com a campeã', () => {
    expect(e.assunto).toBe(`Fechamento de Outubro de 2026: 37 pares · R$ 7.396,30`);
    expect(e.previa).toMatch(/Numeração campeã: 37/);
  });

  test('corpo: top, campeã, repor e o anexo', () => {
    expect(e.html).toMatch(/Fechamento de outubro/);
    expect(e.html).toMatch(/Tênis Runner Branco/);
    expect(e.html).toMatch(/Numeração campeã: <b>37<\/b> \(12 pares, 32%\)/);
    expect(e.html).toMatch(/Para repor o mês: <b>31 pares<\/b> em 1 modelo/);
    expect(e.html).toMatch(/vendas-por-numeracao-2026-10\.xlsx/);
    expect(e.html).toMatch(/\+23% em relação ao mês anterior/);
    expect(e.text).toMatch(/financeiro\/vendas-por-numeracao\?period=last_month&empresa=/);
  });
});

describe('preferência', () => {
  test('tipo novo, comercial e ligado por padrão (com o kill switch do relatório)', () => {
    expect(P.TIPOS.fechamento_mes).toBeTruthy();
    expect(P.TIPOS_COMERCIAIS).toContain('fechamento_mes');
    expect(P.preferenciaEfetiva('fechamento_mes', null, {}).ligado).toBe(true);
    expect(P.preferenciaEfetiva('fechamento_mes', null, { RELATORIO_PADRAO_LIGADO: 'false' }).ligado).toBe(false);
    expect(P.preferenciaEfetiva('fechamento_mes', { ligado: false }, {}).ligado).toBe(false);
  });

  test('a tela liga e desliga (validação aceita só "ligado")', () => {
    expect(P.validarMudancas({ fechamento_mes: { ligado: false } }, new Set())).toEqual({ ok: true, mudancas: { fechamento_mes: { ligado: false, config: {} } } });
    expect(P.validarMudancas({ fechamento_mes: { dia: 3 } }, new Set())).toMatchObject({ ok: false, codigo: 'CAMPO_DESCONHECIDO' });
  });
});

describe('agendamento e envio', () => {
  // 01/11/2026 08:00 em Brasília = 11:00 UTC.
  const DIA1_8H = Date.parse('2026-11-01T11:00:00Z');

  test('janela: dia 1º a partir das 8h (BRT)', () => {
    expect(F.naJanela(DIA1_8H)).toBe(true);
    expect(F.naJanela(Date.parse('2026-11-01T10:59:00Z'))).toBe(false);
    expect(F.naJanela(Date.parse('2026-11-02T15:00:00Z'))).toBe(false);
  });

  function banco({ jaEnviado = false } = {}) {
    const sqls = [];
    db.query.mockReset();
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      sqls.push({ s, params });
      const r = (rows) => Promise.resolve({ rows, rowCount: rows.length });
      if (/p\.tipo = 'fechamento_mes'/.test(s)) {
        return r([{ id: PRIMARIA, owner_id: 'dono', is_primary: true, name: 'Loja Teste', owner_email: 'Dono@Loja.com', pref_config: null }]);
      }
      if (/FROM email_log/.test(s) && /chave_idempotencia = \$1/.test(s)) return r(jaEnviado ? [{ '?column?': 1 }] : []);
      if (/FROM company_email_addresses/.test(s)) return r([]);
      if (/INSERT INTO email_log/.test(s)) return r([{ id: 'log1' }]);
      return r([]);
    });
    return sqls;
  }

  beforeEach(() => F._limparMemoria());

  test('envia com a planilha anexa, para o dono, uma vez só', async () => {
    banco();
    const enviar = jest.fn(async () => ({ id: 're_1' }));
    const gerar = jest.fn(async () => rel);
    const c1 = await F.enviarFechamentos({ now: DIA1_8H, env: {}, enviar, gerar });
    expect(c1).toMatchObject({ sent: 1, errors: 0 });
    expect(gerar.mock.calls[0][1]).toMatchObject({ companyId: PRIMARIA, companyIds: [PRIMARIA], periodo: { inicio: '2026-10-01', fim: '2026-10-31' } });
    const opts = enviar.mock.calls[0][0];
    expect(opts.to).toEqual(['dono@loja.com']);
    expect(opts.tipo).toBe('fechamento_mes');
    expect(opts.attachments[0].filename).toBe('vendas-por-numeracao-2026-10.xlsx');
    expect(opts.attachments[0].content.slice(0, 2).toString()).toBe('PK');
    expect(opts.headers && opts.headers['List-Unsubscribe']).toBeTruthy();

    const c2 = await F.enviarFechamentos({ now: DIA1_8H + 60000, env: {}, enviar, gerar });
    expect(c2.sent).toBe(0);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(gerar).toHaveBeenCalledTimes(1); // nem refaz a conta
  });

  test('já enviado por outra instância (email_log): não gera nem envia', async () => {
    banco({ jaEnviado: true });
    const enviar = jest.fn();
    const gerar = jest.fn();
    const c = await F.enviarFechamentos({ now: DIA1_8H, env: {}, enviar, gerar });
    expect(c.duplicate).toBe(1);
    expect(gerar).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  test('mês sem venda: nada sai', async () => {
    banco();
    const enviar = jest.fn();
    const c = await F.enviarFechamentos({ now: DIA1_8H, env: {}, enviar, gerar: async () => ({ ...rel, kpis: { ...rel.kpis, vendidos: 0 }, modelos: [] }) });
    expect(c.skipped).toBe(1);
    expect(enviar).not.toHaveBeenCalled();
  });

  test('fora do dia 1º: nem consulta o banco', async () => {
    const sqls = banco();
    const c = await F.enviarFechamentos({ now: Date.parse('2026-11-02T15:00:00Z'), env: {}, enviar: jest.fn(), gerar: jest.fn() });
    expect(c).toEqual({ sent: 0, skipped: 0, duplicate: 0, errors: 0 });
    expect(sqls).toHaveLength(0);
  });

  test('falha no envio marca falha no email_log (outra volta tenta de novo)', async () => {
    const sqls = banco();
    const c = await F.enviarFechamentos({ now: DIA1_8H, env: {}, enviar: async () => { throw new Error('Resend 500'); }, gerar: async () => rel });
    expect(c.errors).toBe(1);
    expect(sqls.some(({ s }) => /UPDATE email_log/.test(s) && /failed/.test(s))).toBe(true);
  });
});
