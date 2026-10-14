// Bloco "Check-in": o que a tela de 3 perguntas deu e se o cadastro andou.
//
// Pedido do Caio em 13/10 (prioridade 0; leitura da Cassie na rodada das
// 7h30). Para cada cadastro a partir de CHECKIN_DESDE:
//   - "tem produto em 24 h": primeiro products.created_at menos
//     companies.created_at, até 24 h (cadastro em lote conta o horário da
//     importação, que é o created_at dos produtos);
//   - "tem venda em 7 dias": primeira venda válida até 7 dias do cadastro;
//   - "tempo até o 5º produto": 5º products.created_at por empresa;
//   - respostas 1, 2 e 3 (e como_chegou, fiado, quem_decide da equipe).
//
// Contagem acumulada, e a REGRA DE PARADA como parâmetro
// (CHECKIN_LIMIAR_PRODUTO_24H, padrão 0.57): nos primeiros 15 cadastros que
// viram a tela, se "produto em 24 h" ficar abaixo do limiar, o bloco avisa
// que é hora de desligar o interruptor (CHECKIN_ENABLED). O bloco só avisa;
// quem desliga é o Caio.
//
// Janela ainda aberta não entra na taxa: cadastro com menos de 24 h e sem
// produto está "aguardando", não é um "não". Idem os 7 dias da venda.
//
// Linha de base (Nina, 13/10): 57 % com produto em 24 h e 17 % com venda em
// 7 dias.
//
// Importação assistida (marcadores do Registrar contato, migration 383):
// pedida e entregue vêm de company_admin_notes.marcador; o tempo é a
// diferença entre os dois registros. Sem a migration a seção fica vazia.
'use strict';

const b = require('./_base');
const regra = require('../checkin');

const H = 3600000;
const BASE_PRODUTO_24H = 57;
const BASE_VENDA_7D = 17;

const horas = (de, ate) => {
  if (!de || !ate) return null;
  const ms = new Date(ate).getTime() - new Date(de).getTime();
  return Number.isFinite(ms) ? Math.round((ms / H) * 10) / 10 : null;
};
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const sim = (v) => (v === true ? 'Sim' : v === false ? 'Não' : 'Aguardando');

// Uma linha por cadastro. Cada janela vira true (aconteceu dentro dela),
// false (fechou sem acontecer) ou null (ainda aberta).
function classificar(r, json, agora) {
  const criado = new Date(r.created_at).getTime();
  const idade = agora - criado;
  const h1 = horas(r.created_at, r.primeiro_produto);
  const h5 = horas(r.created_at, r.quinto_produto);
  const hv = horas(r.created_at, r.primeira_venda);

  const produto24 = h1 !== null && h1 <= 24 ? true : (idade >= 24 * H ? false : null);
  const venda7 = hv !== null && hv <= 7 * 24 ? true : (idade >= 7 * 24 * H ? false : null);
  const viuTela = !!(json.exibido_em || json.respondido_em || json.pulou === true);

  return {
    company_id: r.company_id,
    nome: r.nome,
    telefone: r.telefone || null,
    criado_em: new Date(criado).toISOString(),
    viu_tela: viuTela,
    respondeu: !!json.respondido_em && json.pulou !== true,
    pulou: json.pulou === true,
    comeco: json.comeco || null,
    onde_anota: json.onde_anota || null,
    produtos_faixa: json.produtos_faixa || null,
    como_chegou: json.como_chegou || null,
    fiado: json.fiado || null,
    quem_decide: json.quem_decide || null,
    horas_ate_1o_produto: h1,
    horas_ate_5o_produto: h5,
    produto_24h: sim(produto24),
    venda_7d: sim(venda7),
    _produto24: produto24,
    _venda7: venda7,
  };
}

// { sim, nao, aguardando, taxa } de um recorte, para uma das janelas.
function taxa(linhas, campo) {
  const s = linhas.filter((l) => l[campo] === true).length;
  const n = linhas.filter((l) => l[campo] === false).length;
  return { sim: s, nao: n, aguardando: linhas.length - s - n, taxa: pct(s, s + n) };
}

function contar(linhas, campo) {
  const m = new Map();
  for (const l of linhas) if (l[campo]) m.set(l[campo], (m.get(l[campo]) || 0) + 1);
  return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([rotulo, valor]) => ({ rotulo, valor }));
}

// Regra de parada sobre os cadastros que viram a tela (em ordem de cadastro).
// Só vale com `cfg.amostra` cadastros FECHADOS (nenhum "aguardando"): antes
// disso a taxa ainda pode mudar. `abaixo` = taxa estritamente menor que o
// limiar.
function avaliarParada(comTela, cfg) {
  const amostra = taxa(comTela.slice(0, cfg.amostra), '_produto24');
  const n = comTela.slice(0, cfg.amostra).length;
  const fechada = n >= cfg.amostra && amostra.aguardando === 0;
  const abaixo = fechada && amostra.sim / (amostra.sim + amostra.nao) < cfg.limiar;
  return { fechada, abaixo, amostra, n };
}

async function calcular({ hoje, periodo = 30, db = b.pool, agora = Date.now() } = {}) {
  const cfg = regra.configuracao();
  const desdeTs = regra.inicioDoDia(cfg.desde);

  // Cadastros a partir da subida da tela, sem contas internas/teste, sem a
  // federação do Karatê e sem filial de dono antigo (multi-CNPJ: só a primeira
  // empresa do dono é cadastro novo). Produto e venda saem de subconsultas
  // correlacionadas: as tabelas são índice por company_id.
  const rows = await b.consultar(
    db,
    `-- checkin:cadastros
     SELECT c.id AS company_id,
            ${b.NOME} AS nome,
            ${b.TELEFONE} AS telefone,
            c.created_at,
            (SELECT MIN(p.created_at) FROM products p WHERE p.company_id = c.id) AS primeiro_produto,
            (SELECT p.created_at FROM products p WHERE p.company_id = c.id ORDER BY p.created_at OFFSET 4 LIMIT 1) AS quinto_produto,
            (SELECT MIN(s.created_at) FROM sales s WHERE s.company_id = c.id AND ${b.VENDA_VALIDA.replace(/\bstatus\b/g, 's.status')}) AS primeira_venda
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.created_at >= $1::timestamptz
        AND ${b.SEM_INTERNAS}
        AND NOT ${regra.sqlForaDoCheckin('c')}
      ORDER BY c.created_at, c.id`,
    [desdeTs.toISOString()]
  );

  // O json do check-in vem à parte: sem a migration 384 a coluna não existe e
  // a consulta acima precisa continuar valendo (o bloco mostra só produto e
  // venda, sem respostas).
  const jsonRows = rows.length ? await b.opcional(
    db,
    `-- checkin:json
     SELECT c.id AS company_id, c.checkin FROM companies c WHERE c.id = ANY($1::uuid[])`,
    [rows.map((r) => r.company_id)]
  ) : [];
  const jsons = new Map(jsonRows.map((r) => [r.company_id, r.checkin && typeof r.checkin === 'object' ? r.checkin : {}]));

  const linhas = rows.map((r) => classificar(r, jsons.get(r.company_id) || {}, agora));
  const comTela = linhas.filter((l) => l.viu_tela);

  const acumulado = { produto: taxa(linhas, '_produto24'), venda: taxa(linhas, '_venda7') };
  const dosQueViram = { produto: taxa(comTela, '_produto24'), venda: taxa(comTela, '_venda7') };

  // Regra de parada: os primeiros N cadastros que viram a tela.
  const parada = avaliarParada(comTela, cfg);
  const limiarPct = Math.round(cfg.limiar * 100);
  const { fechada, abaixo, amostra: tAmostra } = parada;

  // Tempo até o 5º produto (mediana de quem chegou lá).
  const ate5 = linhas.map((l) => l.horas_ate_5o_produto).filter((h) => h !== null);

  // Importação assistida: pedida × entregue.
  const impRows = await b.opcional(
    db,
    `-- checkin:importacao
     SELECT m.company_id, ${b.NOME} AS nome, ${b.TELEFONE} AS telefone, m.pedida_em, m.entregue_em
       FROM (SELECT company_id,
                    MIN(created_at) FILTER (WHERE marcador = 'importacao_assistida_pedida') AS pedida_em,
                    MAX(created_at) FILTER (WHERE marcador = 'importacao_assistida_entregue') AS entregue_em
               FROM company_admin_notes
              WHERE marcador IS NOT NULL
              GROUP BY company_id) m
       JOIN companies c ON c.id = m.company_id
       LEFT JOIN users u ON u.id = c.owner_id
      ORDER BY m.pedida_em DESC NULLS LAST`,
    []
  );
  const importacoes = impRows.map((r) => {
    const h = horas(r.pedida_em, r.entregue_em);
    return {
      company_id: r.company_id,
      nome: r.nome,
      telefone: r.telefone || null,
      pedida_em: r.pedida_em ? new Date(r.pedida_em).toISOString() : null,
      entregue_em: r.entregue_em ? new Date(r.entregue_em).toISOString() : null,
      horas: h !== null && h >= 0 ? h : null,
    };
  });
  const entregues = importacoes.filter((i) => i.horas !== null);

  // Semana de cadastro → quantos e quantos com produto em 24 h.
  const semanas = b.ultimasSemanas(hoje, 6);
  const serieSemanas = semanas.map((s) => ({
    rotulo: b.rotuloDia(s),
    valor: linhas.filter((l) => b.inicioDaSemana(b.diaDe(l.criado_em)) === s).length,
  }));

  const publico = linhas.map(({ _produto24, _venda7, ...l }) => l);

  const viram = comTela.length;
  const respondeu = comTela.filter((l) => l.respondeu).length;
  const pularam = comTela.filter((l) => l.pulou).length;

  let insight = null;
  if (abaixo) {
    insight = `Regra de parada acionada: ${tAmostra.sim} de ${tAmostra.sim + tAmostra.nao} dos primeiros ${cfg.amostra} cadastros com a tela tiveram produto em 24 h (${tAmostra.taxa}%), abaixo do limite de ${limiarPct}%. Decisão do Caio: desligar CHECKIN_ENABLED.`;
  } else if (!linhas.length) {
    insight = `Nenhum cadastro desde ${cfg.desde}. A leitura começa com o primeiro cadastro novo.`;
  } else if (!fechada) {
    insight = `${comTela.length} de ${cfg.amostra} cadastros com a tela para fechar a regra de parada (limite ${limiarPct}% com produto em 24 h).`;
  } else {
    insight = `Regra de parada avaliada: ${tAmostra.taxa}% com produto em 24 h nos primeiros ${cfg.amostra} cadastros com a tela, acima do limite de ${limiarPct}%.`;
  }

  return b.montarBloco({
    valor: acumulado.produto.taxa === null ? 0 : acumulado.produto.taxa,
    unidade: '% com produto em 24 h',
    resumo: `${b.plural(linhas.length, 'cadastro', 'cadastros')} desde ${b.rotuloDia(cfg.desde)} · ${b.plural(respondeu, 'respondeu', 'responderam')} · ${b.plural(pularam, 'pulou', 'pularam')}`,
    serie: serieSemanas,
    linhas: publico,
    fonte: 'companies, products, sales, audit_log',
    indicadores: [
      b.indicador('Cadastros desde a subida', linhas.length, `a partir de ${b.rotuloDia(cfg.desde)} · ${viram} viram a tela`),
      b.indicador('Produto em 24 h', acumulado.produto.taxa === null ? null : `${acumulado.produto.taxa}%`,
        `${acumulado.produto.sim} de ${acumulado.produto.sim + acumulado.produto.nao} · ${acumulado.produto.aguardando} aguardando · base ${BASE_PRODUTO_24H}%`),
      b.indicador('Venda em 7 dias', acumulado.venda.taxa === null ? null : `${acumulado.venda.taxa}%`,
        `${acumulado.venda.sim} de ${acumulado.venda.sim + acumulado.venda.nao} · ${acumulado.venda.aguardando} aguardando · base ${BASE_VENDA_7D}%`),
      b.indicador('Produto em 24 h · só quem viu a tela', dosQueViram.produto.taxa === null ? null : `${dosQueViram.produto.taxa}%`,
        `${dosQueViram.produto.sim} de ${dosQueViram.produto.sim + dosQueViram.produto.nao}`),
      b.indicador('Tempo até o 5º produto (mediana)', ate5.length ? b.mediana(ate5) : null, ate5.length ? `horas · ${b.plural(ate5.length, 'chegou', 'chegaram')} ao 5º` : 'ninguém chegou ao 5º ainda'),
      b.indicador('Regra de parada', abaixo ? 'ACIONADA' : (fechada ? 'ok' : 'aguardando'),
        `limite ${limiarPct}% · ${Math.min(comTela.length, cfg.amostra)} de ${cfg.amostra} cadastros com a tela · interruptor ${cfg.ligado ? 'ligado' : 'desligado'}`),
      b.indicador('Importação assistida', importacoes.length,
        `${importacoes.length - entregues.length} sem entrega registrada · mediana ${entregues.length ? `${String(b.mediana(entregues.map((i) => i.horas))).replace('.', ',')} h` : 'sem dado'}`),
    ],
    listas: [
      b.lista('Cadastros desde a subida', [
        b.colLoja(), b.col('criado_em', 'Cadastro', 'data_hora'), b.col('viu_tela', 'Viu a tela', 'booleano'),
        b.col('comeco', 'Por onde começar'), b.col('onde_anota', 'Onde anota'), b.col('produtos_faixa', 'Quantos produtos'),
        b.col('como_chegou', 'Como chegou'), b.col('fiado', 'Fiado'), b.col('quem_decide', 'Quem decide'),
        b.col('produto_24h', 'Produto em 24 h'), b.col('horas_ate_1o_produto', 'Horas até o 1º produto', 'numero'),
        b.col('horas_ate_5o_produto', 'Horas até o 5º produto', 'numero'), b.col('venda_7d', 'Venda em 7 dias'),
      ], publico.slice().reverse()),
      b.lista('Importação assistida', [
        b.colLoja(), b.col('pedida_em', 'Pedida', 'data_hora'), b.col('entregue_em', 'Entregue', 'data_hora'),
        b.col('horas', 'Horas', 'numero'),
      ], importacoes),
    ],
    series: [
      b.serieDe('Cadastros por semana', 'barras', serieSemanas),
      b.serieDe('Tela do check-in', 'barras_h', [
        { rotulo: 'Viram a tela', valor: viram },
        { rotulo: 'Responderam', valor: respondeu },
        { rotulo: 'Pularam', valor: pularam },
      ]),
      b.serieDe('Por onde começar', 'barras_h', contar(comTela, 'comeco')),
      b.serieDe('Onde anota o que tem', 'barras_h', contar(comTela, 'onde_anota')),
      b.serieDe('Quantos produtos', 'barras_h', contar(comTela, 'produtos_faixa')),
    ],
    insight,
  });
}

module.exports = { calcular, classificar, taxa, avaliarParada };
