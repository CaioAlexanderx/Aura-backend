// ============================================================
// AURA. — Relatório semanal de várias lojas e botões (26/10/2026)
//
// Dados fictícios (fixtures/relatorioMultiloja), sem banco. Cobre:
//   - snapshot do e-mail e da página: 1 loja, 2 lojas, 3 lojas com uma
//     nova e 5 lojas ("outras N lojas");
//   - comparação com a semana anterior só das lojas que venderam nas duas;
//   - nome da loja: nome fantasia, nome da loja online, razão social sem o
//     prefixo do MEI; nunca o número do CNPJ;
//   - links: por loja ?empresa=<id>, do grupo ?empresa=todas; equipe e
//     crediário sempre por loja;
//   - os botões têm o markup à prova de cliente de e-mail (sem "→");
//   - mais de 3 lojas: as 3 maiores e "outras N lojas".
// ============================================================
'use strict';

const ENV = { ...process.env };
const F = require('./fixtures/relatorioMultiloja');

const URL_RELATORIO = 'https://app.getaura.com.br/relatorios/semanal/tok';
const NOW = Date.UTC(2026, 10, 2, 11, 0, 0); // segunda 02/11, 8h BRT

function carregar() {
  jest.resetModules();
  process.env = { ...ENV, RESEND_API_KEY: 'k', API_URL: 'https://api.exemplo.test/api/v1' };
  for (const k of ['AURA_WHATSAPP', 'EMAIL_LINK_SECRET', 'MAIL_FROM', 'SMTP_FROM', 'APP_URL', 'RELATORIO_BLOCOS_DESLIGADOS', 'RELATORIO_LONGO_ENABLED']) {
    delete process.env[k];
  }
  return {
    mailer: require('../src/services/mailer'),
    RB: require('../src/services/relatorioBlocos'),
    P: require('../src/services/emailPreferencias'),
    G: require('../src/services/relatorioGrupo'),
    M: require('../src/templates/relatorioMultiloja'),
    B: require('../src/templates/relatorioSemanalBlocos'),
    pagina: require('../src/templates/weeklyReport'),
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

function grupo(chave, m) {
  return F.relatorioDoGrupo(F.CENARIOS[chave], m);
}

function email(m, relatorio, nome) {
  return m.mailer.montarEmailDoRelatorio(
    { id: F.ID.matriz, name: nome || (relatorio.grupo && relatorio.grupo.nome) || 'Modas Exemplo' },
    {}, URL_RELATORIO,
    { relatorio, versao: 'completa', periodo: F.PERIODO, config: { dia: 1, hora: 8 }, grupo: !!relatorio.grupo }
  );
}

function paginaDe(m, relatorio, nome) {
  return m.pagina.buildWeeklyReportHtml({
    company: { name: nome || (relatorio.grupo && relatorio.grupo.nome) || 'Modas Exemplo' },
    companyId: F.ID.matriz, periodo: F.PERIODO, relatorio, now: NOW,
  });
}

/** Links para o app (menos o do relatório, o de ajustar e-mails e as imagens). */
function linksDoApp(html) {
  return [...html.matchAll(/href="(https:\/\/app\.getaura\.com\.br[^"]*)"/g)]
    .map((x) => x[1].replace(/&amp;/g, '&'))
    .filter((u) => !u.includes('/relatorios/semanal/') && !u.includes('/email/') && !u.includes('/configuracoes'));
}

const BOTAO = /<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="display:inline-block;[^"]*"><tr><td align="center" valign="middle" bgcolor="#f1ecfd" class="a-lkbg" style="[^"]*border:1px solid #d8c9fa;border-radius:9px;mso-padding-alt:12px 16px;"><a href="([^"]+)" class="a-lk" style="display:block;padding:12px 16px;[^"]*font-size:14px;line-height:18px;[^"]*">([^<]+)<\/a><\/td><\/tr><\/table>/g;

function botoesDe(html) {
  return [...html.matchAll(BOTAO)].map((x) => ({ href: x[1].replace(/&amp;/g, '&'), texto: x[2] }));
}

/** Regras de todo relatório: modo claro, sem seta, botões bulletproof, um botão preenchido. */
function regras(html) {
  expect(html).toContain('@media (prefers-color-scheme: dark)');
  expect(html).toContain('.a-lkbg {');
  expect(html).not.toContain('&rarr;');
  expect(html).not.toContain('→');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<svg');
  expect(html).not.toMatch(/upgrade|cadeado/i);
  // Nunca o número de CNPJ (nem o prefixo do MEI).
  expect(html).not.toMatch(/\d{2}\.\d{3}\.\d{3}/);
  // Todo link do app fora do botão principal (relatório completo no e-mail,
  // Painel na página) é um botão bulletproof.
  expect((html.match(/class="a-btn"/g) || []).length).toBe(1);
  const nosBotoes = new Set(botoesDe(html).map((b) => b.href));
  // Um botão por tela de destino (Nina, 26/10): nenhum href repetido.
  expect(nosBotoes.size).toBe(botoesDe(html).length);
  for (const u of linksDoApp(html)) {
    if (u === URL_RELATORIO || /^https:\/\/app\.getaura\.com\.br\/\?empresa=/.test(u)) continue;
    expect([u, nosBotoes.has(u)]).toEqual([u, true]);
  }
  for (const u of linksDoApp(html)) expect(u).toMatch(/[?&]empresa=[^&]+/);
}

describe('botões no relatório de uma loja', () => {
  test('cada "Ver X →" virou botão; snapshot do e-mail e da página', () => {
    const m = carregar();
    const relatorio = F.relatorioDeUmaLoja(m.RB, m.P);
    const e = email(m, relatorio, 'Modas Exemplo');
    regras(e.html);
    expect(e.assunto).toBe('Sua semana na Modas Exemplo: R$ 1.830,40 (+52%)');
    const b = botoesDe(e.html).map((x) => x.texto);
    expect(b).toEqual(expect.arrayContaining(['Ver as vendas', 'Ver a curva ABC completa', 'Ver o estoque', 'Ver o financeiro',
      'Ver o relatório da equipe', 'Chamar de volta', 'Ver os aniversariantes', 'Ver a loja online', 'Ver o crediário']));
    // O único botão preenchido é o do relatório completo; o do WhatsApp continua contornado.
    expect((e.html.match(/class="a-btn"/g) || []).length).toBe(1);
    expect(e.html).toContain('>Ver o relatório completo</a>');
    expect(e.html).toContain('class="a-wa"');
    for (const x of botoesDe(e.html)) expect(x.href).toContain(`empresa=${F.ID.matriz}`);
    // "Ver o financeiro" uma vez só: com as contas a pagar, não na margem.
    expect(b.filter((t) => t === 'Ver o financeiro')).toHaveLength(1);
    expect(e.html).toMatchSnapshot('email');
    const p = paginaDe(m, relatorio, 'Modas Exemplo');
    regras(p);
    expect(p).toContain('>Abrir meu Painel</a>');
    expect(p).toMatchSnapshot('pagina');
  });

  test('botao(): href só http(s); texto escapado; altura de 44 px (12 + 18 + 12 + 2)', () => {
    const { B } = carregar();
    expect(B.botao('Ver', 'javascript:alert(1)')).toBe('');
    const h = B.botao('Ver <a>', 'https://app.getaura.com.br/vendas?empresa=x');
    expect(h).toContain('Ver &lt;a&gt;');
    expect(h).toContain('padding:12px 16px');
    expect(h).toContain('line-height:18px');
    expect(h).toContain('mso-padding-alt:12px 16px');
    expect(h).toContain('border:1px solid #d8c9fa');
    expect(h).toContain('bgcolor="#f1ecfd"');
  });
});

describe('relatório de várias lojas', () => {
  test('2 lojas: total do grupo, uma linha por loja, links por loja e do grupo', () => {
    const m = carregar();
    const r = grupo('duas', m);
    const e = email(m, r);
    regras(e.html);
    expect(e.assunto).toBe('Sua semana nas suas 2 lojas: R$ 2.800,85 (+38%)');
    expect(e.html).toContain('De 19/10 a 24/10 · Matriz e Centro.');
    expect(e.html).toContain('Comparado com a semana anterior das mesmas 2 lojas (R$&nbsp;2.024,85).');
    expect(e.html).toContain('Sexta foi o melhor dia do grupo');
    expect(e.html).toContain('Grupo 58,6%');
    expect(e.html).toContain('Semana passada, das mesmas 2 lojas: 55,5%.');
    expect(e.previa).toMatch(/^Total do grupo e cada loja: vendas/);
    const b = botoesDe(e.html);
    const por = (t) => b.find((x) => x.texto === t);
    expect(por('Ver as vendas do grupo').href).toBe('https://app.getaura.com.br/vendas?empresa=todas');
    // Formas de pagamento não repetem o botão das contas (mesma tela).
    expect(por('Ver as contas do grupo').href).toBe('https://app.getaura.com.br/financeiro?empresa=todas');
    expect(por('Ver o financeiro do grupo')).toBeUndefined();
    expect(por('Ver o estoque da Matriz').href).toBe(`https://app.getaura.com.br/estoque?empresa=${F.ID.matriz}`);
    expect(por('Ver o estoque do Centro').href).toBe(`https://app.getaura.com.br/estoque?empresa=${F.ID.centro}`);
    expect(por('Chamar de volta os clientes do Centro').href).toBe(`https://app.getaura.com.br/clientes/reativacao?empresa=${F.ID.centro}`);
    // Equipe, crediário e curva ABC: sempre por loja (no app não há consolidado).
    for (const x of b.filter((y) => /ranking|crediário|curva ABC/.test(y.texto))) {
      expect(x.href).not.toContain('empresa=todas');
    }
    expect(por('Ver o ranking da Matriz').href).toBe(`https://app.getaura.com.br/vendas?tab=ranking&empresa=${F.ID.matriz}`);
    expect(por('Ver o crediário do Centro').href).toBe(`https://app.getaura.com.br/crediario?empresa=${F.ID.centro}`);
    expect(e.html).toContain('>Ver o relatório completo do grupo</a>');
    expect(e.text).toContain('- Matriz: R$ 1.830,40 em 11 vendas');
    expect(e.html).toMatchSnapshot('email');
    const p = paginaDe(m, r);
    regras(p);
    expect(p).toContain('Sua semana nas suas 2 lojas');
    expect(p).toContain('Últimas 4 semanas, todas as lojas');
    expect(p).toContain('Sandália salto elástico preto · 1 de mínimo 3');
    expect(p).toContain(`href="https://app.getaura.com.br/?empresa=todas"`);
    expect(p).toContain('>Abrir o Painel do grupo</a>');
    expect(p).not.toContain('Por unidade');
    expect(p).toMatchSnapshot('pagina');
  });

  test('3 lojas com uma nova: "começou em", fora da comparação, um passo; o assunto conta a loja', () => {
    const m = carregar();
    const r = grupo('tresComNova', m);
    const e = email(m, r);
    regras(e.html);
    // O valor é só das lojas que venderam; o assunto conta as 3.
    expect(e.assunto).toBe('Sua semana nas suas 3 lojas: R$ 2.800,85 (+38%)');
    expect(e.html).toContain('De 19/10 a 24/10 · Matriz, Centro e Norte.');
    expect(e.html).toContain('começou em 24/10');
    expect(e.html).toContain('ainda sem vendas');
    expect(e.html).toContain('Comparado com a semana anterior das mesmas 2 lojas');
    expect(e.html).toContain('Norte, a loja nova');
    expect(e.html).toContain('Criada em 24/10, ainda sem vendas e sem produtos.');
    const passo = botoesDe(e.html).find((x) => x.texto === 'Cadastrar os produtos do Norte');
    expect(passo.href).toBe(`https://app.getaura.com.br/estoque?empresa=${F.ID.norte}`);
    expect(r.grupo.base.ids).toEqual([F.ID.matriz, F.ID.centro]);
    expect(e.html).toMatchSnapshot('email');
    const p = paginaDe(m, r);
    regras(p);
    expect(p).toContain('começou em 24/10');
    expect(p).toMatchSnapshot('pagina');
  });

  test('5 lojas: as 3 maiores e "outras N lojas" no e-mail; a página mostra todas', () => {
    const m = carregar();
    const r = grupo('cinco', m);
    const e = email(m, r);
    regras(e.html);
    expect(e.assunto).toMatch(/^Sua semana nas suas 5 lojas: /);
    expect(e.html).toContain('De 19/10 a 24/10.'); // "suas 5 lojas" não repete na linha
    expect(e.html).toContain('Outras 2 lojas');
    expect(e.html).not.toContain('JOSE EXEMPLO PEREIRA'); // 5ª maior, entra em "outras"
    expect(e.html).toContain('Ateliê Norte'); // nome da loja online no lugar da razão social do MEI
    expect(e.html).toContain('Comparado com a semana anterior das 4 lojas que venderam nas duas semanas');
    expect(e.html).toMatchSnapshot('email');
    const p = paginaDe(m, r);
    regras(p);
    expect(p).toContain('JOSE EXEMPLO PEREIRA');
    expect(p).not.toContain('Outras 2 lojas');
    expect(p).toMatchSnapshot('pagina');
  });

  test('comparação só da base comum: a loja que não vendeu na semana passada fica fora', () => {
    const { G, RB, P } = carregar();
    const r = F.relatorioDoGrupo(['matriz', 'sulMei'], { G, RB, P });
    // Sul vendeu R$ 210 nesta semana e nada na anterior: fora da base.
    expect(r.grupo.base).toMatchObject({ ids: [F.ID.matriz], lojas: 1, todasQueVenderam: false, receita: 1830.4, receitaAnterior: 1203.1 });
    expect(r.vendas.receita).toBe(2040.4); // o total do grupo tem as duas
    expect(r.vendas.receitaAnterior).toBe(1203.1);
    expect(r.vendas.variacaoPct).toBe(52.1); // (1830,40 / 1203,10) - 1, não (2040,40 / 1203,10) - 1
    // A margem da semana passada também só da base (Sul sem venda anterior).
    expect(r.equipe_margem.margem.anterior.pct).toBe(56);
    const lojas = G.lojasDoGrupo([
      { companyId: 'a', tradeName: 'A', vendas: 3, receita: 300, vendasAnterior: 2, receitaAnterior: 200, criadaEm: '2025-01-01' },
      { companyId: 'b', tradeName: 'B', vendas: 0, receita: 0, vendasAnterior: 4, receitaAnterior: 400, criadaEm: '2025-01-01' },
      { companyId: 'c', tradeName: 'C', vendas: 0, receita: 0, vendasAnterior: 0, receitaAnterior: 0, criadaEm: '2026-10-20' },
    ], F.PERIOD);
    expect(lojas.map((l) => [l.naBase, l.nova, l.semVenda])).toEqual([[true, false, false], [false, false, true], [false, true, true]]);
    expect(G.baseDaComparacao(lojas)).toMatchObject({ ids: ['a'], variacaoPct: 50, todasQueVenderam: true });
  });
});

describe('nome da loja', () => {
  test('nome fantasia; senão o nome da loja online; senão a razão social sem o prefixo do MEI', () => {
    const { G } = carregar();
    const MEI = '53.000.000 LUIS EXEMPLO FERREIRA'; // fictício, no formato do caso real
    expect(G.nomeDaLojaNoRelatorio({ trade_name: MEI, legal_name: MEI }, { site_name: 'Adega Exemplo' })).toBe('Adega Exemplo');
    expect(G.nomeDaLojaNoRelatorio({ trade_name: '68.000.000 JORGE EXEMPLO', legal_name: '68.000.000 JORGE EXEMPLO' }, null)).toBe('JORGE EXEMPLO');
    expect(G.nomeDaLojaNoRelatorio({ trade_name: 'Matriz', legal_name: 'MODAS LTDA' }, { site_name: 'Loja Online' })).toBe('Matriz');
    expect(G.nomeDaLojaNoRelatorio({ trade_name: 'MODAS LTDA', legal_name: 'MODAS LTDA' }, { site_name: 'Modas da Ana' })).toBe('Modas da Ana');
    expect(G.nomeDaLojaNoRelatorio({ trade_name: '', legal_name: '12.345.678 ANA EXEMPLO' }, { site_name: '  ' })).toBe('ANA EXEMPLO');
    expect(G.nomeDaLojaNoRelatorio({ trade_name: null, legal_name: 'MODAS LTDA' }, null)).toBe('MODAS LTDA');
  });

  test('nome do grupo: as lojas até 3; acima, "suas N lojas"', () => {
    const { G } = carregar();
    const l = (n) => ({ nome: n });
    expect(G.nomeDoGrupo([l('Matriz'), l('Centro')])).toBe('Matriz e Centro');
    expect(G.nomeDoGrupo([l('Matriz'), l('Centro'), l('Norte')])).toBe('Matriz, Centro e Norte');
    expect(G.nomeDoGrupo([l('A'), l('B'), l('C'), l('D')])).toBe('suas 4 lojas');
    expect(G.daLoja({ nome: 'Matriz' })).toBe('da Matriz');
    expect(G.daLoja({ nome: 'Centro' })).toBe('do Centro');
    expect(G.daLoja({ nome: 'Finesse Moda' })).toBe('da loja Finesse Moda');
  });

  test('cenário MEI: a loja sai pelo nome da loja online, sem número', () => {
    const m = carregar();
    const r = grupo('tresComMei', m);
    expect(r.grupo.nome).toBe('Matriz, Centro e Ateliê Norte');
    const e = email(m, r);
    regras(e.html);
    expect(e.html).not.toContain('MARIA EXEMPLO');
    expect(e.html).toContain('Ver a loja online do Ateliê Norte');
  });
});
