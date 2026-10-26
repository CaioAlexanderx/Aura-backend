// ============================================================
// AURA. — Relatório semanal longo: snapshot do e-mail e da página (tq-85)
//
// Dados fixos (sem banco): o e-mail da versão completa com todos os blocos,
// com só alguns, a versão resumo, a página completa (empresa única e
// consolidado) e as regras:
//   - bloco que o plano não tem não aparece (nada de cadeado ou upgrade);
//   - todo link para o app leva ?empresa=<company_id>;
//   - nenhum nome de cliente final; sem a letra do Caio; modo claro;
//   - sem a "saúde do negócio" (era um número fixo).
// ============================================================
'use strict';

const ENV = { ...process.env };
const EMPRESA = '11111111-1111-4111-8111-111111111111';
const FILIAL = '22222222-2222-4222-8222-222222222222';
const URL_RELATORIO = 'https://app.getaura.com.br/relatorios/semanal/tok';
const LETRA = 'assinatura-caio-alexander-v1.png';
const NOW = Date.UTC(2026, 9, 26, 11, 0, 0); // segunda 26/10, 8h BRT

function carregar() {
  jest.resetModules();
  process.env = { ...ENV, RESEND_API_KEY: 'k', API_URL: 'https://api.exemplo.test/api/v1' };
  delete process.env.AURA_WHATSAPP;
  delete process.env.EMAIL_LINK_SECRET;
  delete process.env.MAIL_FROM;
  delete process.env.SMTP_FROM;
  delete process.env.APP_URL;
  delete process.env.RELATORIO_BLOCOS_DESLIGADOS;
  delete process.env.RELATORIO_LONGO_ENABLED;
  const corpos = [];
  global.fetch = jest.fn(async (url, init) => {
    corpos.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id: 're_' + corpos.length }) };
  });
  return {
    mailer: require('../src/services/mailer'),
    RB: require('../src/services/relatorioBlocos'),
    B: require('../src/templates/relatorioSemanalBlocos'),
    pagina: require('../src/templates/weeklyReport'),
    P: require('../src/services/emailPreferencias'),
    corpos,
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

const PERIODO = { inicio: '2026-10-19', fim: '2026-10-24' };
const KPIS = { revenue: 4820, sales: 31, avg_ticket: 155.48, health_score: 71 };

/** Os sete blocos com dado (montados pelas mesmas funções do serviço). */
function relatorioCompleto(RB, blocos) {
  const M = RB._montar;
  return {
    blocos,
    vendas: M.montarVendas({
      kpis: KPIS,
      prevRevenue: 4310,
      dailyRevenue: [
        { day: 'Seg', date: '2026-10-19', value: 380 },
        { day: 'Ter', date: '2026-10-20', value: 520 },
        { day: 'Qua', date: '2026-10-21', value: 610 },
        { day: 'Qui', date: '2026-10-22', value: 640 },
        { day: 'Sex', date: '2026-10-23', value: 1430 },
        { day: 'Sab', date: '2026-10-24', value: 1240 },
      ],
      semanas: [
        { inicio: '2026-09-28', fim: '2026-10-03', receita: 3890 },
        { inicio: '2026-10-05', fim: '2026-10-10', receita: 4120 },
        { inicio: '2026-10-12', fim: '2026-10-17', receita: 4310 },
        { inicio: '2026-10-19', fim: '2026-10-24', receita: 4820 },
      ],
    }),
    mais_vendidos: M.montarMaisVendidos([
      { id: 'p1', nome: 'Vestido midi floral', qtd: 9, receita: 1530 },
      { id: 'p2', nome: 'Blusa tricot caramelo', qtd: 7, receita: 980 },
      { id: 'p3', nome: 'Calça pantalona preta', qtd: 6, receita: 900 },
      { id: 'p4', nome: 'Saia plissada', qtd: 4, receita: 560 },
      { id: 'p5', nome: 'Cinto de couro', qtd: 5, receita: 450 },
      { id: 'p6', nome: 'Meia', qtd: 10, receita: 400 },
    ]),
    pagamentos_estoque: M.montarPagamentosEstoque({
      byPayment: [
        { method: 'pix', total_revenue: 2314 },
        { method: 'credito', total_revenue: 1500 },
        { method: 'debito', total_revenue: 283 },
        { method: 'dinheiro', total_revenue: 723 },
      ],
      contas: { pagar: { valor: 2340, qtd: 3 }, receber: { valor: 0, qtd: 0 }, ate: '2026-11-01' },
      estoqueBaixo: { qtd: 5, itens: [{ nome: 'Vestido midi floral', estoque: 1, minimo: 3 }, { nome: 'Blusa tricot caramelo', estoque: 2, minimo: 3 }] },
    }),
    equipe_margem: M.montarEquipeMargem({
      equipe: [
        { nome: 'Ana', receita: 1980, vendas: 13 },
        { nome: 'Paulo', receita: 1610, vendas: 10 },
        { nome: 'Joana', receita: 1230, vendas: 8 },
      ],
      somas: {
        atual: { receita: 4820, receitaComCusto: 4820, custo: 2843.8 },
        anterior: { receita: 4310, receitaComCusto: 4100, custo: 2501 },
      },
    }),
    clientes: M.montarClientes({ atendidos: 17, voltaram: 11, aniversariantes: 3, parados: 4 }),
    loja_online: { pedidos: 4, valor: 612 },
    crediario: {
      recebido: 860, recebimentos: 7, novoFiado: 1150, saldo: 6480, clientesComSaldo: 22,
      vencido: 1240, parcelasVencidas: 5, pctVencido: 19,
      aVencer: { valor: 980, parcelas: 6, dias: 7 },
      clientesAtrasoLongo: 3, diasAtrasoLongo: 30,
      fiadoNasVendas: { vendas: 9, valor: 1150, pct: 29 },
    },
  };
}

function regras(html) {
  expect(html).toContain('<meta name="color-scheme" content="light dark">');
  expect(html).toContain('@media (prefers-color-scheme: dark)');
  expect(html).toContain('background:#f4f1fb');
  expect(html).not.toContain(LETRA); // o relatório não leva a letra do Caio
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<svg');
  expect(html).not.toMatch(/sa[uú]de do neg[oó]cio/i);
  expect(html).not.toMatch(/upgrade|cadeado|fa[cç]a o upgrade/i);
  expect(html).not.toMatch(/nada se perde|tudo volta na hora/i);
}

/** Todo link para o app (menos o do relatório e o de ajustar e-mails) tem ?empresa=. */
function linksDoApp(html) {
  return [...html.matchAll(/href="(https:\/\/app\.getaura\.com\.br[^"]*)"/g)]
    .map((m) => m[1].replace(/&amp;/g, '&'))
    .filter((u) => !u.includes('/relatorios/semanal/') && !u.includes('/email/'));
}

describe('e-mail do relatório longo (versão completa)', () => {
  test('todos os blocos: resumo de cada um, links com ?empresa=, snapshot', async () => {
    const { mailer, RB, P, corpos } = carregar();
    const relatorio = relatorioCompleto(RB, [...P.BLOCOS]);
    await mailer.sendWeeklyReport(
      { id: EMPRESA, name: 'Modas da Maria', email: 'dona@exemplo.com' },
      KPIS, URL_RELATORIO,
      { relatorio, versao: 'completa', periodo: PERIODO, config: { dia: 1, hora: 8 } }
    );
    const c = corpos[0];
    regras(c.html);
    expect(c.subject).toBe('Sua semana na Modas da Maria: R$ 4.820,00 (+12%)');
    expect(c.html).toContain('Vendas, mais vendidos, estoque e contas, equipe e margem, clientes, loja online e crediário da semana');
    expect(c.html).toContain('>Ver o relatório completo</a>');
    expect(c.html).not.toContain('&rarr;'); // botões, não "Ver X →" (26/10)
    expect(c.html).toContain(`href="${URL_RELATORIO}"`);
    for (const t of ['Vendas da semana', 'O que mais saiu', 'Como pagaram', 'Pede atenção', 'Sua equipe', 'Margem bruta da semana', 'Clientes da semana', 'Loja online', 'Crediário da semana']) {
      expect(c.html).toContain(t);
    }
    expect(c.html).toContain('&#9650; 12% a mais</span> que na semana anterior (R$&nbsp;4.310,00)');
    expect(c.html).toContain('Sexta foi o melhor dia: R$&nbsp;1.430,00, 30% da semana.');
    expect(c.html).toContain('3 produtos fazem');
    expect(c.html).toContain('41%'); // margem (4820-2843,8)/4820
    expect(c.html).toContain('R$&nbsp;1.240,00 · 19%');
    expect(c.html).toContain('R$&nbsp;980,00 vencem nos próximos 7 dias (6 parcelas)');
    expect(c.html).toContain('3 clientes com mais de 30 dias de atraso');
    expect(c.html).toContain('9 vendas no fiado esta semana, 29% das vendas');
    // O e-mail é resumo: 3 produtos, não 5; a página tem o resto.
    expect(c.html).not.toContain('Saia plissada');
    expect(c.html).not.toContain('Últimas 4 semanas');

    const links = linksDoApp(c.html);
    const rotas = ['/vendas', '/vendas?tab=ranking', '/financeiro/produtos', '/financeiro', '/clientes', '/clientes/reativacao', '/crediario', '/estoque', '/canal'];
    for (const r of rotas) {
      const sep = r.includes('?') ? '&' : '?';
      expect(links).toContain(`https://app.getaura.com.br${r}${sep}empresa=${EMPRESA}`);
    }
    for (const u of links) expect(u).toMatch(new RegExp(`[?&]empresa=${EMPRESA}(&|$)`));
    expect(c.text).toContain('Sua semana na Modas da Maria');
    expect(c.html).toMatchSnapshot();
  });

  test('só alguns blocos ligados: os outros não aparecem', async () => {
    const { mailer, RB, corpos } = carregar();
    const relatorio = relatorioCompleto(RB, ['vendas', 'crediario']);
    await mailer.sendWeeklyReport(
      { id: EMPRESA, name: 'Modas da Maria', email: 'dona@exemplo.com' },
      KPIS, URL_RELATORIO, { relatorio, versao: 'completa', periodo: PERIODO }
    );
    const { html } = corpos[0];
    regras(html);
    expect(html).toContain('Vendas da semana');
    expect(html).toContain('Crediário da semana');
    for (const t of ['O que mais saiu', 'Como pagaram', 'Sua equipe', 'Clientes da semana', 'Pedidos confirmados']) {
      expect(html).not.toContain(t);
    }
    expect(html).toContain('Vendas e crediário da semana');
    expect(html).toMatchSnapshot();
  });

  test('bloco que o plano não tem não aparece (Essencial: nada de crediário, equipe, clientes, loja online)', () => {
    const { RB, B } = carregar();
    const blocos = RB.blocosEfetivos({ blocos: ['vendas', 'mais_vendidos', 'pagamentos_estoque', 'crediario', 'equipe_margem', 'clientes', 'loja_online'] }, 'essencial');
    expect(blocos).toEqual(['vendas', 'mais_vendidos', 'pagamentos_estoque']);
    // Mesmo com os dados presentes, só o que está em `blocos` sai.
    const html = B.renderBlocos(relatorioCompleto(RB, blocos), { modo: 'email', companyId: EMPRESA });
    expect(html).toContain('Vendas da semana');
    for (const t of ['Crediário', 'Sua equipe', 'Margem bruta', 'Clientes da semana', 'Loja online', '/crediario', '/canal', 'tab=ranking']) {
      expect(html).not.toContain(t);
    }
    expect(RB.blocosEfetivos({ blocos: ['vendas', 'crediario'] }, 'negocio')).toEqual(['vendas', 'crediario']);
    expect(RB.blocosEfetivos({ blocos: ['vendas', 'crediario'] }, 'expansao')).toEqual(['vendas', 'crediario']);
  });

  test('RELATORIO_BLOCOS_DESLIGADOS tira o bloco de todos; RELATORIO_LONGO_ENABLED=false manda o resumo', () => {
    const { RB } = carregar();
    const env = { RELATORIO_BLOCOS_DESLIGADOS: 'crediario, equipe_margem' };
    expect(RB.blocosEfetivos({}, 'negocio', env)).toEqual(['vendas', 'mais_vendidos', 'pagamentos_estoque', 'clientes', 'loja_online']);
    expect(RB.versaoDoRelatorio({ versao: 'completa' }, {})).toBe('completa');
    expect(RB.versaoDoRelatorio({ versao: 'resumo' }, {})).toBe('resumo');
    expect(RB.versaoDoRelatorio({ versao: 'completa' }, { RELATORIO_LONGO_ENABLED: 'false' })).toBe('resumo');
  });

  test('versão resumo: o e-mail curto de sempre, sem blocos e sem a saúde fixa', async () => {
    const { mailer, RB, P, corpos } = carregar();
    await mailer.sendWeeklyReport(
      { id: EMPRESA, name: 'Modas da Maria', email: 'dona@exemplo.com' },
      KPIS, URL_RELATORIO,
      { relatorio: relatorioCompleto(RB, [...P.BLOCOS]), versao: 'resumo', periodo: PERIODO }
    );
    const c = corpos[0];
    regras(c.html);
    expect(c.subject).toBe('Relatório semanal — Modas da Maria');
    expect(c.html).toContain('R$ 4.820,00');
    expect(c.html).not.toContain('Vendas da semana');
    expect(c.html).not.toContain('Crediário');
  });

  test('semana sem venda: frase curta e verdadeira, sem número inventado', () => {
    const { RB, B } = carregar();
    const vendas = RB._montar.montarVendas({
      kpis: { revenue: 0, sales: 0, avg_ticket: 0 }, prevRevenue: 0,
      dailyRevenue: [{ day: 'Seg', date: '2026-10-19', value: 0 }], semanas: [],
    });
    const html = B.renderBlocos({ blocos: ['vendas'], vendas }, { modo: 'email', companyId: EMPRESA });
    expect(html).toContain('Nenhuma venda registrada nesta semana.');
    expect(html).not.toContain('melhor dia');
    // Sem custo cadastrado: a margem não sai; sai a frase.
    const em = RB._montar.montarEquipeMargem({ equipe: [], somas: { atual: { receita: 500, receitaComCusto: 100, custo: 40 }, anterior: null } });
    const h2 = B.renderBlocos({ blocos: ['equipe_margem'], equipe_margem: em }, { modo: 'email', companyId: EMPRESA });
    expect(h2).toContain('A margem aparece aqui quando os produtos vendidos tiverem o custo cadastrado.');
    expect(h2).not.toContain('Margem bruta da semana'); // nenhum % de margem
    // Sem nada nos outros blocos: eles somem.
    expect(RB._montar.montarMaisVendidos([])).toBeNull();
    expect(RB._montar.montarClientes({ atendidos: 0, voltaram: 0, aniversariantes: 0, parados: 0 })).toBeNull();
    expect(RB._montar.montarPagamentosEstoque({ byPayment: [], contas: { pagar: { qtd: 0 }, receber: { qtd: 0 } }, estoqueBaixo: { qtd: 0 } })).toBeNull();
  });
});

describe('página "Ver relatório completo"', () => {
  test('empresa única: todos os blocos no detalhe, modo claro, snapshot', () => {
    const { RB, P, pagina } = carregar();
    const html = pagina.buildWeeklyReportHtml({
      company: { name: 'Modas da Maria' }, companyId: EMPRESA, periodo: PERIODO,
      relatorio: relatorioCompleto(RB, [...P.BLOCOS]), now: NOW,
    });
    regras(html);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('Sua semana na Modas da Maria');
    expect(html).toContain('De 19/10 a 24/10.');
    expect(html).toContain('Últimas 4 semanas');
    expect(html).toContain('Saia plissada'); // top 5 na página
    expect(html).toContain('Curva C');
    expect(html).toContain('1 de mínimo 3');
    expect(html).toContain('Gerado pela Aura em 26/10/2026.');
    for (const u of linksDoApp(html)) expect(u).toMatch(new RegExp(`[?&]empresa=${EMPRESA}(&|$)`));
    expect(html).toMatchSnapshot();
  });

  test('consolidado: a página de várias lojas (uma linha por loja, equipe e crediário por loja)', () => {
    const { RB, P, pagina } = carregar();
    const G = require('../src/services/relatorioGrupo');
    const F = require('./fixtures/relatorioMultiloja');
    const relatorio = F.relatorioDoGrupo(F.CENARIOS.duas, { RB, P, G });
    const html = pagina.buildWeeklyReportHtml({
      company: { name: relatorio.grupo.nome }, companyId: F.ID.matriz, periodo: PERIODO, relatorio, now: NOW,
    });
    regras(html);
    expect(html).toContain('Sua semana nas suas 2 lojas');
    expect(html).toContain(`/vendas?tab=ranking&amp;empresa=${F.ID.centro}`);
    expect(html).toContain(`/crediario?empresa=${F.ID.centro}`);
    expect(html).toContain('/vendas?empresa=todas');
    expect(html).toContain('Carla · R$&nbsp;970,45 em 6 vendas');
  });

  test('sem nenhum bloco com dado: frase curta', () => {
    const { pagina } = carregar();
    const html = pagina.buildWeeklyReportHtml({ company: { name: 'Loja' }, companyId: EMPRESA, periodo: PERIODO, relatorio: { blocos: ['vendas'] }, now: NOW });
    expect(html).toContain('Não há dados para mostrar nesta semana.');
  });
});

describe('links e números', () => {
  test('linkDoApp sempre com ?empresa=, respeitando a query que já existe', () => {
    const { B } = carregar();
    expect(B.linkDoApp('/vendas', EMPRESA)).toBe(`https://app.getaura.com.br/vendas?empresa=${EMPRESA}`);
    expect(B.linkDoApp('/vendas?tab=ranking', EMPRESA)).toBe(`https://app.getaura.com.br/vendas?tab=ranking&empresa=${EMPRESA}`);
    expect(B.linkDoApp('/canal', EMPRESA, { APP_URL: 'https://app.exemplo.test/' })).toBe(`https://app.exemplo.test/canal?empresa=${EMPRESA}`);
  });

  test('margem só sai com custo em ao menos 80% do faturamento', () => {
    const { RB } = carregar();
    expect(RB.margemDasSomas({ receita: 1000, receitaComCusto: 1000, custo: 600 })).toEqual({ pct: 40, cobertura: 100 });
    expect(RB.margemDasSomas({ receita: 1000, receitaComCusto: 800, custo: 400 })).toEqual({ pct: 50, cobertura: 80 });
    expect(RB.margemDasSomas({ receita: 1000, receitaComCusto: 790, custo: 400 })).toEqual({ pct: null, cobertura: 79 });
    expect(RB.margemDasSomas({ receita: 0, receitaComCusto: 0, custo: 0 })).toBeNull();
  });

  test('consolidar: vendas, produtos e clientes somam; produto do grupo (mesmo id) soma; margem refeita', () => {
    const { RB } = carregar();
    const M = RB._montar;
    const dadosA = {
      blocos: ['vendas', 'mais_vendidos', 'clientes', 'equipe_margem'],
      vendas: M.montarVendas({ kpis: { revenue: 100, sales: 2, avg_ticket: 50 }, prevRevenue: 80, dailyRevenue: [], semanas: [{ inicio: 'a', fim: 'b', receita: 10 }, { inicio: 'c', fim: 'd', receita: 20 }] }),
      mais_vendidos: M.montarMaisVendidos([{ id: 'comp', nome: 'Compartilhado', qtd: 2, receita: 60 }, { id: 'a1', nome: 'Só A', qtd: 1, receita: 40 }]),
      clientes: M.montarClientes({ atendidos: 3, voltaram: 1, aniversariantes: 1, parados: 2 }),
      equipe_margem: M.montarEquipeMargem({ equipe: [{ nome: 'Ana', receita: 100, vendas: 2 }], somas: { atual: { receita: 100, receitaComCusto: 100, custo: 50 }, anterior: null } }),
    };
    const dadosB = {
      blocos: ['vendas', 'mais_vendidos', 'clientes', 'equipe_margem'],
      vendas: M.montarVendas({ kpis: { revenue: 300, sales: 3, avg_ticket: 100 }, prevRevenue: 120, dailyRevenue: [], semanas: [{ inicio: 'a', fim: 'b', receita: 5 }, { inicio: 'c', fim: 'd', receita: 7 }] }),
      mais_vendidos: M.montarMaisVendidos([{ id: 'comp', nome: 'Compartilhado', qtd: 3, receita: 90 }]),
      clientes: M.montarClientes({ atendidos: 2, voltaram: 2, aniversariantes: 0, parados: 1 }),
      equipe_margem: M.montarEquipeMargem({ equipe: [{ nome: 'Bia', receita: 300, vendas: 3 }], somas: { atual: { receita: 300, receitaComCusto: 300, custo: 210 }, anterior: null } }),
    };
    const c = RB.consolidarBlocos(
      [{ companyId: EMPRESA, nome: 'A', dados: dadosA }, { companyId: FILIAL, nome: 'B', dados: dadosB }],
      { kpis: { revenue: 400, sales: 5, avg_ticket: 80 }, dailyRevenue: [], prevRevenue: 200 }
    );
    expect(c.vendas.receita).toBe(400);
    expect(c.vendas.variacaoPct).toBe(100);
    expect(c.vendas.semanas.map((s) => s.receita)).toEqual([15, 27]);
    expect(c.mais_vendidos.top[0]).toEqual({ nome: 'Compartilhado', qtd: 5, receita: 150, lojas: ['A', 'B'] });
    expect(Object.keys(c.porLoja)).toEqual([EMPRESA, FILIAL]);
    expect(c.clientes).toEqual({ atendidos: 5, novos: 2, voltaram: 3, aniversariantes: 1, parados: 3, diasParado: 30 });
    expect(c.equipe_margem.margem.atual).toEqual({ pct: 35, cobertura: 100 }); // (400-260)/400
    expect(c.equipe_margem.porEmpresa.map((x) => x.nome)).toEqual(['A', 'B']);
    const limpo = RB.semInternos(c);
    expect(limpo.mais_vendidos._todos).toBeUndefined();
    expect(limpo.equipe_margem._somas).toBeUndefined();
  });

  test('nenhum nome de cliente final nos blocos', () => {
    const { RB, P, B } = carregar();
    const html = B.renderBlocos(relatorioCompleto(RB, [...P.BLOCOS]), { modo: 'pagina', companyId: EMPRESA });
    // Os dados de clientes e crediário só têm números: nada de nome para vazar.
    const r = relatorioCompleto(RB, [...P.BLOCOS]);
    expect(Object.keys(r.clientes)).toEqual(['atendidos', 'novos', 'voltaram', 'aniversariantes', 'parados', 'diasParado']);
    expect(JSON.stringify(r.crediario)).not.toMatch(/nome|name|customer/i);
    expect(html).toContain('Crediário da semana');
  });
});
