// ============================================================
// AURA. — Bloco "Check-in" do painel (services/painelBlocos/checkin.js)
//
// A leitura da Cassie (rodada das 7h30): produto em 24 h, venda em 7 dias,
// tempo até o 5º produto, importação assistida e a REGRA DE PARADA.
//
//   1. janela ainda aberta é "aguardando", nunca "não"
//   2. regra de parada: 15 cadastros que viram a tela, limiar por parâmetro
//   3. sem a migration 384 / 383 o bloco continua (só sem as respostas)
//   4. a consulta filtra por CHECKIN_DESDE e tira contas internas e dojôs
// ============================================================
const bloco = require('../../src/services/painelBlocos/checkin');

const AGORA = Date.parse('2026-10-30T12:00:00.000Z');
const HOJE = '2026-10-30';
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();

const AMBIENTE = ['CHECKIN_DESDE', 'CHECKIN_LIMIAR_PRODUTO_24H', 'CHECKIN_ENABLED'];
let guardado;
beforeEach(() => {
  guardado = Object.fromEntries(AMBIENTE.map((k) => [k, process.env[k]]));
  AMBIENTE.forEach((k) => delete process.env[k]);
  process.env.CHECKIN_DESDE = '2026-10-16';
});
afterEach(() => {
  AMBIENTE.forEach((k) => { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; });
});

// cadastro: n-ésimo, criado `dias` dias antes de AGORA.
function cadastro(n, { dias = 10, produtoApos = null, quintoApos = null, vendaApos = null, json = null } = {}) {
  const criado = AGORA - dias * 24 * H;
  return {
    linha: {
      company_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      nome: `Loja ${n}`,
      telefone: null,
      created_at: iso(criado),
      primeiro_produto: produtoApos === null ? null : iso(criado + produtoApos * H),
      quinto_produto: quintoApos === null ? null : iso(criado + quintoApos * H),
      primeira_venda: vendaApos === null ? null : iso(criado + vendaApos * H),
    },
    json,
  };
}

const VIU = { exibido_em: '2026-10-20T12:00:00.000Z', respondido_em: '2026-10-20T12:01:00.000Z', pulou: false, comeco: 'vender' };

function banco(cadastros, { importacao = [], semJson = false, semMarcador = false } = {}) {
  const vistos = [];
  return {
    vistos,
    query: async (sql, params) => {
      vistos.push({ sql, params });
      if (sql.includes('-- checkin:cadastros')) return { rows: cadastros.map((c) => c.linha) };
      if (sql.includes('-- checkin:json')) {
        if (semJson) throw Object.assign(new Error('column c.checkin does not exist'), { code: '42703' });
        return { rows: cadastros.filter((c) => c.json).map((c) => ({ company_id: c.linha.company_id, checkin: c.json })) };
      }
      if (sql.includes('-- checkin:importacao')) {
        if (semMarcador) throw Object.assign(new Error('column marcador does not exist'), { code: '42703' });
        return { rows: importacao };
      }
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
}

const indicador = (b, rotulo) => b.detalhe.indicadores.find((i) => i.rotulo === rotulo);

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { console.warn.mockRestore(); });

describe('produto em 24 h e venda em 7 dias', () => {
  test('conta quem passou da janela; quem ainda está dentro dela aguarda', async () => {
    const db = banco([
      cadastro(1, { dias: 10, produtoApos: 2, vendaApos: 30 }),          // sim / sim
      cadastro(2, { dias: 10, produtoApos: 26 }),                        // não (26 h) / não
      cadastro(3, { dias: 10 }),                                          // não / não
      cadastro(4, { dias: 0.5 }),                                         // 12 h: aguarda / aguarda
      cadastro(5, { dias: 3, produtoApos: 1 }),                           // sim / aguarda (3 dias)
    ]);
    const r = await bloco.calcular({ hoje: HOJE, db, agora: AGORA });

    expect(r.valor).toBe(50); // 2 de 4 decididos
    expect(indicador(r, 'Produto em 24 h')).toMatchObject({ valor: '50%' });
    expect(indicador(r, 'Produto em 24 h').nota).toContain('2 de 4');
    expect(indicador(r, 'Produto em 24 h').nota).toContain('1 aguardando');
    // venda: 1 sim, 2 não, 2 aguardando (12 h e 3 dias)
    expect(indicador(r, 'Venda em 7 dias')).toMatchObject({ valor: '33%' });
    expect(indicador(r, 'Venda em 7 dias').nota).toContain('1 de 3');

    const por = Object.fromEntries(r.lista.map((l) => [l.nome, [l.produto_24h, l.venda_7d]]));
    expect(por).toEqual({
      'Loja 1': ['Sim', 'Sim'], 'Loja 2': ['Não', 'Não'], 'Loja 3': ['Não', 'Não'],
      'Loja 4': ['Aguardando', 'Aguardando'], 'Loja 5': ['Sim', 'Aguardando'],
    });
  });

  test('exatamente 24 h conta; 24 h e meia não', async () => {
    const db = banco([
      cadastro(1, { dias: 5, produtoApos: 24 }),
      cadastro(2, { dias: 5, produtoApos: 24.5 }),
    ]);
    const r = await bloco.calcular({ hoje: HOJE, db, agora: AGORA });
    const por = Object.fromEntries(r.lista.map((l) => [l.nome, l.produto_24h]));
    expect(por).toEqual({ 'Loja 1': 'Sim', 'Loja 2': 'Não' });
  });

  test('tempo até o 5º produto: mediana de quem chegou lá; lote conta a hora da importação', async () => {
    const db = banco([
      cadastro(1, { dias: 5, produtoApos: 1, quintoApos: 1 }),   // importou tudo de uma vez: 1 h
      cadastro(2, { dias: 5, produtoApos: 2, quintoApos: 10 }),
      cadastro(3, { dias: 5, produtoApos: 3, quintoApos: 30 }),
      cadastro(4, { dias: 5, produtoApos: 3 }),                  // nunca chegou ao 5º
    ]);
    const r = await bloco.calcular({ hoje: HOJE, db, agora: AGORA });
    expect(indicador(r, 'Tempo até o 5º produto (mediana)')).toMatchObject({ valor: 10 });
    expect(indicador(r, 'Tempo até o 5º produto (mediana)').nota).toContain('3 chegaram');
    const l1 = r.lista.find((l) => l.nome === 'Loja 1');
    expect(l1).toMatchObject({ horas_ate_1o_produto: 1, horas_ate_5o_produto: 1 });
  });

  test('sem cadastros: valor 0, aviso no insight e nada quebra', async () => {
    const r = await bloco.calcular({ hoje: HOJE, db: banco([]), agora: AGORA });
    expect(r.valor).toBe(0);
    expect(r.lista).toEqual([]);
    expect(r.detalhe.insight).toContain('Nenhum cadastro desde 2026-10-16');
    expect(indicador(r, 'Produto em 24 h').valor).toBeNull();
    expect(indicador(r, 'Regra de parada').valor).toBe('aguardando');
  });
});

describe('regra de parada (primeiros 15 cadastros que viram a tela)', () => {
  // `com` cadastros com produto em 24 h e `sem` sem, todos maduros e com a tela.
  const amostra = (com, sem) => [
    ...Array.from({ length: com }, (_, i) => cadastro(i + 1, { dias: 10, produtoApos: 3, json: VIU })),
    ...Array.from({ length: sem }, (_, i) => cadastro(100 + i, { dias: 10, json: VIU })),
  ];

  test('abaixo do limiar padrão (57%): acionada, e o texto diz o que fazer', async () => {
    // 8 de 15 = 53%
    const r = await bloco.calcular({ hoje: HOJE, db: banco(amostra(8, 7)), agora: AGORA });
    expect(indicador(r, 'Regra de parada').valor).toBe('ACIONADA');
    expect(r.detalhe.insight).toContain('8 de 15');
    expect(r.detalhe.insight).toContain('53%');
    expect(r.detalhe.insight).toContain('57%');
    expect(r.detalhe.insight).toContain('CHECKIN_ENABLED');
  });

  test('o limiar é parâmetro: com 40% (proposta da Cassie) os mesmos 53% passam', async () => {
    process.env.CHECKIN_LIMIAR_PRODUTO_24H = '0.40';
    const r = await bloco.calcular({ hoje: HOJE, db: banco(amostra(8, 7)), agora: AGORA });
    expect(indicador(r, 'Regra de parada').valor).toBe('ok');
    expect(r.detalhe.insight).toContain('acima do limite de 40%');
  });

  test('exatamente no limiar não aciona (só estritamente abaixo)', async () => {
    process.env.CHECKIN_LIMIAR_PRODUTO_24H = '0.6';
    const r = await bloco.calcular({ hoje: HOJE, db: banco(amostra(9, 6)), agora: AGORA }); // 9/15 = 60%
    expect(indicador(r, 'Regra de parada').valor).toBe('ok');
  });

  test('menos de 15 cadastros com a tela: aguardando, mesmo com taxa baixa', async () => {
    const r = await bloco.calcular({ hoje: HOJE, db: banco(amostra(2, 12)), agora: AGORA }); // 14 cadastros
    expect(indicador(r, 'Regra de parada').valor).toBe('aguardando');
    expect(r.detalhe.insight).toContain('14 de 15');
  });

  test('15 cadastros mas algum ainda dentro das 24 h: aguardando (a taxa ainda muda)', async () => {
    const db = banco([...amostra(2, 13), cadastro(200, { dias: 0.3, json: VIU })]);
    // 15 maduros ruins + 1 recente: a amostra são os 15 primeiros por ordem de cadastro
    const r = await bloco.calcular({ hoje: HOJE, db, agora: AGORA });
    // o recente entra por último (ordem da consulta), fora da amostra de 15: aciona
    expect(indicador(r, 'Regra de parada').valor).toBe('ACIONADA');

    // se o recente é o 15º, a taxa ainda não fecha
    const db2 = banco([...amostra(2, 12), cadastro(200, { dias: 0.3, json: VIU })]);
    const r2 = await bloco.calcular({ hoje: HOJE, db: db2, agora: AGORA });
    expect(indicador(r2, 'Regra de parada').valor).toBe('aguardando');
  });

  test('quem nunca viu a tela não conta para a regra, mas conta no acumulado', async () => {
    const semTela = Array.from({ length: 20 }, (_, i) => cadastro(300 + i, { dias: 10 }));
    const r = await bloco.calcular({ hoje: HOJE, db: banco([...semTela, ...amostra(14, 0)]), agora: AGORA });
    expect(indicador(r, 'Regra de parada').valor).toBe('aguardando');
    expect(indicador(r, 'Regra de parada').nota).toContain('14 de 15');
    expect(indicador(r, 'Cadastros desde a subida').valor).toBe(34);
    expect(indicador(r, 'Produto em 24 h').nota).toContain('14 de 34');
    expect(indicador(r, 'Produto em 24 h · só quem viu a tela').valor).toBe('100%');
  });

  test('o interruptor desligado aparece na nota da regra', async () => {
    process.env.CHECKIN_ENABLED = 'false';
    const r = await bloco.calcular({ hoje: HOJE, db: banco(amostra(15, 0)), agora: AGORA });
    expect(indicador(r, 'Regra de parada').nota).toContain('interruptor desligado');
  });
});

describe('fontes que ainda não existem', () => {
  test('sem companies.checkin (384): o bloco calcula produto e venda, sem respostas', async () => {
    const db = banco([cadastro(1, { dias: 10, produtoApos: 2, json: VIU })], { semJson: true });
    const r = await bloco.calcular({ hoje: HOJE, db, agora: AGORA });
    expect(r.valor).toBe(100);
    expect(r.lista[0]).toMatchObject({ viu_tela: false, comeco: null });
  });

  test('sem company_admin_notes.marcador (383): importação assistida vazia', async () => {
    const db = banco([cadastro(1, { dias: 10, produtoApos: 2 })], { semMarcador: true });
    const r = await bloco.calcular({ hoje: HOJE, db, agora: AGORA });
    expect(indicador(r, 'Importação assistida')).toMatchObject({ valor: 0 });
    expect(r.detalhe.listas[1].linhas).toEqual([]);
  });
});

describe('importação assistida', () => {
  test('tempo é a diferença entre os dois registros; sem entrega fica em aberto', async () => {
    const db = banco([], {
      importacao: [
        { company_id: 'a', nome: 'Loja A', telefone: null, pedida_em: '2026-10-20T10:00:00.000Z', entregue_em: '2026-10-20T16:30:00.000Z' },
        { company_id: 'b', nome: 'Loja B', telefone: null, pedida_em: '2026-10-22T10:00:00.000Z', entregue_em: null },
        { company_id: 'c', nome: 'Loja C', telefone: null, pedida_em: '2026-10-23T10:00:00.000Z', entregue_em: '2026-10-24T10:00:00.000Z' },
      ],
    });
    const r = await bloco.calcular({ hoje: HOJE, db, agora: AGORA });
    const linhas = r.detalhe.listas[1].linhas;
    expect(linhas.map((l) => [l.nome, l.horas])).toEqual([['Loja A', 6.5], ['Loja B', null], ['Loja C', 24]]);
    const ind = indicador(r, 'Importação assistida');
    expect(ind.valor).toBe(3);
    expect(ind.nota).toContain('1 sem entrega registrada');
    expect(ind.nota).toContain('15,3 h'); // mediana de 6,5 e 24 = 15,25 → 15,3
  });
});

describe('a consulta', () => {
  test('filtra por CHECKIN_DESDE (00h de Brasília) e deixa fora contas internas e dojôs', async () => {
    const db = banco([]);
    await bloco.calcular({ hoje: HOJE, db, agora: AGORA });
    const q = db.vistos.find((v) => v.sql.includes('-- checkin:cadastros'));
    expect(q.params).toEqual(['2026-10-16T03:00:00.000Z']);
    expect(q.sql).toContain("NOT ILIKE '%@getaura.com.br'");
    expect(q.sql).toContain('is_sandbox IS NOT TRUE');
    // multi-CNPJ: federação, filial (billing_owner) e dono com empresa mais antiga
    expect(q.sql).toContain('c.federation_id IS NOT NULL');
    expect(q.sql).toContain('c.billing_owner_company_id <> c.id');
    expect(q.sql).toContain('o_ck.owner_id = c.owner_id');
    expect(q.sql).toContain('(o_ck.created_at, o_ck.id) < (c.created_at, c.id)');
  });
});
