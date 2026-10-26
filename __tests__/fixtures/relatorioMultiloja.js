// ============================================================
// AURA. — Dados fictícios do relatório de várias lojas (26/10/2026)
//
// Monta o `relatorio` como o reportGenerator monta (blocos de cada loja
// pelas mesmas funções do serviço, consolidarBlocos com a base da
// comparação e o `grupo` de services/relatorioGrupo), sem banco. Usado nos
// testes de snapshot e no script de prévia (scripts/previaRelatorioMultiloja).
//
// Cenários: 1 loja, 2 lojas, 3 lojas com uma nova e 5 lojas ("outras N").
// Nomes e números inventados; os nomes no padrão MEI imitam o caso real
// (nome fantasia = razão social com o prefixo numérico) sem ser dele.
// ============================================================
'use strict';

const PERIODO = { inicio: '2026-10-19', fim: '2026-10-24' };
const PERIOD = { startDate: PERIODO.inicio, endDate: PERIODO.fim };
const DIAS = [['Seg', '2026-10-19'], ['Ter', '2026-10-20'], ['Qua', '2026-10-21'], ['Qui', '2026-10-22'], ['Sex', '2026-10-23'], ['Sab', '2026-10-24']];
const PESOS = [0.1, 0.12, 0.14, 0.12, 0.3, 0.22];

const ID = {
  matriz: '11111111-1111-4111-8111-111111111111',
  centro: '22222222-2222-4222-8222-222222222222',
  norte: '33333333-3333-4333-8333-333333333333',
  sul: '44444444-4444-4444-8444-444444444444',
  leste: '55555555-5555-4555-8555-555555555555',
};

function r2(v) { return Math.round(v * 100) / 100; }

/** Especificação de cada loja fictícia. */
const LOJAS = {
  matriz: {
    id: ID.matriz, trade_name: 'Matriz', legal_name: 'MODAS EXEMPLO LTDA', criada: '2025-03-10',
    vendas: 11, receita: 1830.40, vendasAnt: 9, receitaAnt: 1203.10,
    produtos: [['p-sand', 'Sandália salto elástico preto', 2, 459.8], ['p-tenis', 'Tênis Air Force branco', 1, 699.9], ['p-bolsa', 'Bolsa de couro caramelo', 2, 380.7], ['p-meia', 'Meia soquete', 4, 290]],
    pagamentos: [['credito', 790.40], ['pix', 620], ['debito', 350], ['dinheiro', 70]],
    contasPagar: [2340, 3], estoque: [4, [['Sandália salto elástico preto', 1, 3], ['Bolsa de couro caramelo', 0, 2]]],
    equipe: [['Ana', 1020, 6], ['Bruno', 810.4, 5]],
    margem: { rc: 1830.40, custo: 713.86, recAnt: 1203.10, rcAnt: 1203.10, custoAnt: 529.36 },
    clientes: { atendidos: 7, voltaram: 6, aniversariantes: 2, parados: 9 },
    online: { pedidos: 2, valor: 310 },
    cred: { saldo: 2100, vencido: 520, recebido: 300, novoFiado: 450, aVencer: [260, 3], atraso: 1, fiado: 2 },
  },
  centro: {
    id: ID.centro, trade_name: 'Centro', legal_name: 'MODAS EXEMPLO CENTRO LTDA', criada: '2025-08-02',
    vendas: 6, receita: 970.45, vendasAnt: 5, receitaAnt: 821.75,
    produtos: [['p-italia', 'Sandália salto Itália creme', 1, 329.9], ['p-meia', 'Meia soquete', 3, 217.5], ['p-cinto', 'Cinto trançado', 2, 423.05]],
    pagamentos: [['pix', 305.97], ['credito', 419.52], ['debito', 244.96]],
    contasPagar: [0, 0], estoque: [8, [['Cinto trançado', 1, 4]]],
    equipe: [['Carla', 970.45, 6]],
    margem: { rc: 970.45, custo: 446.41, recAnt: 821.75, rcAnt: 821.75, custoAnt: 372.25 },
    clientes: { atendidos: 4, voltaram: 4, aniversariantes: 1, parados: 8 },
    online: null,
    cred: { saldo: 1112.29, vencido: 266.15, recebido: 120, novoFiado: 0, aVencer: [193.95, 2], atraso: 0, fiado: 0 },
  },
  // Loja nova: criada na semana, sem venda e sem produto.
  norteNova: {
    id: ID.norte, trade_name: 'Norte', legal_name: 'MODAS EXEMPLO NORTE LTDA', criada: '2026-10-24',
    vendas: 0, receita: 0, vendasAnt: 0, receitaAnt: 0, produtosAtivos: 0,
  },
  // Nome fantasia = razão social de MEI; a loja online tem o nome que a lojista escolheu.
  norteMei: {
    id: ID.norte, trade_name: '12.345.678 MARIA EXEMPLO DA SILVA', legal_name: '12.345.678 MARIA EXEMPLO DA SILVA', site_name: 'Ateliê Norte',
    criada: '2025-11-20',
    vendas: 4, receita: 640, vendasAnt: 3, receitaAnt: 700,
    produtos: [['p-vest', 'Vestido midi floral', 2, 640]],
    pagamentos: [['pix', 640]], contasPagar: [0, 0], estoque: [0, []],
    equipe: [], margem: { rc: 300, custo: 120, recAnt: 700, rcAnt: 700, custoAnt: 350 },
    clientes: { atendidos: 3, voltaram: 1, aniversariantes: 0, parados: 2 },
    online: { pedidos: 1, valor: 160 }, cred: null,
  },
  // MEI sem loja online: a razão social sem o prefixo.
  sulMei: {
    id: ID.sul, trade_name: '98.765.432 JOSE EXEMPLO PEREIRA', legal_name: '98.765.432 JOSE EXEMPLO PEREIRA', criada: '2025-06-01',
    vendas: 2, receita: 210, vendasAnt: 0, receitaAnt: 0,
    produtos: [['p-meia', 'Meia soquete', 3, 210]],
    pagamentos: [['dinheiro', 210]], contasPagar: [0, 0], estoque: [3, [['Meia soquete', 2, 5]]],
    equipe: [['Davi', 210, 2]], margem: { rc: 210, custo: 90, recAnt: 0, rcAnt: 0, custoAnt: 0 },
    clientes: { atendidos: 2, voltaram: 0, aniversariantes: 0, parados: 1 },
    online: null, cred: { saldo: 300, vencido: 0, recebido: 50, novoFiado: 100, aVencer: [100, 1], atraso: 0, fiado: 1 },
  },
  leste: {
    id: ID.leste, trade_name: 'Shopping Leste', legal_name: 'MODAS EXEMPLO LESTE LTDA', criada: '2024-01-15',
    vendas: 3, receita: 450, vendasAnt: 4, receitaAnt: 520,
    produtos: [['p-cinto', 'Cinto trançado', 2, 450]],
    pagamentos: [['credito', 450]], contasPagar: [800, 1], estoque: [1, [['Cinto trançado', 0, 1]]],
    equipe: [['Eva', 450, 3]], margem: { rc: 450, custo: 200, recAnt: 520, rcAnt: 520, custoAnt: 240 },
    clientes: { atendidos: 3, voltaram: 2, aniversariantes: 1, parados: 4 },
    online: null, cred: { saldo: 900, vencido: 400, recebido: 0, novoFiado: 200, aVencer: [0, 0], atraso: 1, fiado: 1 },
  },
};

function crediario(c, vendas) {
  if (!c) return null;
  return {
    recebido: c.recebido, recebimentos: c.recebido > 0 ? 2 : 0, novoFiado: c.novoFiado, saldo: c.saldo, clientesComSaldo: 5,
    vencido: c.vencido, parcelasVencidas: c.vencido > 0 ? 2 : 0, pctVencido: c.saldo > 0 ? Math.min(100, Math.round((c.vencido / c.saldo) * 100)) : null,
    aVencer: { valor: c.aVencer[0], parcelas: c.aVencer[1], dias: 7 },
    clientesAtrasoLongo: c.atraso, diasAtrasoLongo: 30,
    fiadoNasVendas: { vendas: c.fiado, valor: c.novoFiado, pct: vendas > 0 ? Math.min(100, Math.round((c.fiado / vendas) * 100)) : null },
  };
}

/** Blocos de uma loja, montados pelas funções do serviço. */
function dadosDaLoja(RB, s, blocos) {
  const M = RB._montar;
  const diario = DIAS.map(([day, date], i) => ({ day, date, value: r2(s.receita * PESOS[i]) }));
  const out = { blocos };
  out.vendas = M.montarVendas({
    kpis: { revenue: s.receita, sales: s.vendas, avg_ticket: s.vendas ? r2(s.receita / s.vendas) : 0 },
    prevRevenue: s.receitaAnt, dailyRevenue: diario,
    semanas: [
      { inicio: '2026-09-28', fim: '2026-10-03', receita: r2(s.receitaAnt * 0.9) },
      { inicio: '2026-10-05', fim: '2026-10-10', receita: r2(s.receitaAnt * 0.95) },
      { inicio: '2026-10-12', fim: '2026-10-17', receita: s.receitaAnt },
      { inicio: '2026-10-19', fim: '2026-10-24', receita: s.receita },
    ],
  });
  if (s.vendas === 0) return out; // loja sem venda: os outros blocos não têm dado
  out.mais_vendidos = M.montarMaisVendidos(s.produtos.map(([id, nome, qtd, receita]) => ({ id, nome, qtd, receita })));
  out.pagamentos_estoque = M.montarPagamentosEstoque({
    byPayment: s.pagamentos.map(([method, total_revenue]) => ({ method, total_revenue })),
    contas: { pagar: { valor: s.contasPagar[0], qtd: s.contasPagar[1] }, receber: { valor: 0, qtd: 0 }, ate: '2026-11-01' },
    estoqueBaixo: { qtd: s.estoque[0], itens: s.estoque[1].map(([nome, estoque, minimo]) => ({ nome, estoque, minimo })) },
  });
  out.equipe_margem = M.montarEquipeMargem({
    equipe: s.equipe.map(([nome, receita, vendas]) => ({ nome, receita, vendas })),
    somas: {
      atual: { receita: s.receita, receitaComCusto: s.margem.rc, custo: s.margem.custo },
      anterior: { receita: s.margem.recAnt, receitaComCusto: s.margem.rcAnt, custo: s.margem.custoAnt },
    },
  });
  out.clientes = M.montarClientes(s.clientes);
  if (s.online) out.loja_online = { ...s.online };
  const c = crediario(s.cred, s.vendas);
  if (c) out.crediario = c;
  return out;
}

/** Relatório de UMA loja (o de sempre, com botões). */
function relatorioDeUmaLoja(RB, P) {
  return dadosDaLoja(RB, LOJAS.matriz, [...P.BLOCOS]);
}

/**
 * Relatório consolidado como o reportGenerator monta.
 * @param {string[]} chaves  chaves de LOJAS, na ordem do grupo (principal primeiro)
 */
function relatorioDoGrupo(chaves, { RB, P, G }) {
  const specs = chaves.map((k) => LOJAS[k]);
  const blocos = [...P.BLOCOS];
  const lojas = G.lojasDoGrupo(specs.map((s) => ({
    companyId: s.id, tradeName: s.trade_name, legalName: s.legal_name, siteName: s.site_name || null,
    criadaEm: s.criada, vendas: s.vendas, receita: s.receita, vendasAnterior: s.vendasAnt, receitaAnterior: s.receitaAnt,
    produtos: s.vendas === 0 ? (s.produtosAtivos || 0) : null,
  })), PERIOD);
  const base = G.baseDaComparacao(lojas);
  const porEmpresa = specs.map((s, i) => ({ companyId: s.id, nome: lojas[i].nome, dados: dadosDaLoja(RB, s, blocos) }));
  const receita = r2(specs.reduce((a, s) => a + s.receita, 0));
  const vendas = specs.reduce((a, s) => a + s.vendas, 0);
  const dailyRevenue = DIAS.map(([day, date], i) => ({
    day, date, value: r2(porEmpresa.reduce((a, x) => a + x.dados.vendas.diario[i].valor, 0)),
  }));
  const relatorio = RB.consolidarBlocos(porEmpresa, {
    kpis: { revenue: receita, sales: vendas, avg_ticket: vendas ? r2(receita / vendas) : 0 },
    dailyRevenue,
    prevRevenue: r2(specs.reduce((a, s) => a + s.receitaAnt, 0)),
    baseIds: base.ids,
  });
  relatorio.grupo = { nome: G.nomeDoGrupo(lojas), lojas, base };
  return RB.semInternos(relatorio);
}

const CENARIOS = {
  duas: ['matriz', 'centro'],
  tresComNova: ['matriz', 'centro', 'norteNova'],
  tresComMei: ['matriz', 'centro', 'norteMei'],
  cinco: ['matriz', 'centro', 'norteMei', 'sulMei', 'leste'],
};

module.exports = { PERIODO, PERIOD, ID, LOJAS, CENARIOS, relatorioDeUmaLoja, relatorioDoGrupo, dadosDaLoja };
