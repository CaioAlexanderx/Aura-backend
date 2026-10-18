// ============================================================
// AURA. — Painel da Gestão Aura: o passo diário (13/10/2026)
//
// rodarPainelDiario() é a única função que recalcula o painel. Quem chama:
//   - o job das 06h BRT (jobs/painelDiarioScheduler.js);
//   - POST /admin/painel/recalcular (botão "Recalcular agora").
//
// Ordem: health score → MRR e snapshot do mês → blocos → alertas. Cada etapa
// e cada bloco falham sozinhos: um bloco quebrado não apaga os outros, e o
// erro volta na resposta (e fica em painel_runs.erro) em vez de sumir.
// ============================================================
'use strict';

const pool = require('../config/database');
const { BLOCOS, POR_ID } = require('./painelBlocos');
const { carregarEmpresas, somaDias, num } = require('./painelBlocos/_base');
const { usoPorModulo } = require('./painelBlocos/_uso');
const { recalculateAll } = require('./healthScore');
const { calcularMrr, gravarSnapshot } = require('./receita');
const { calcularAlertas, gravarAlertas } = require('./painelAlertas');

// Blocos calculados ao mesmo tempo. O pool tem 15 conexões e a loja está
// usando: o painel não pode ocupar todas.
const EM_PARALELO = 3;

// Dia de hoje em Brasília, 'YYYY-MM-DD'.
function hojeBRT(agora = Date.now()) {
  return new Date(agora - 3 * 3600000).toISOString().slice(0, 10);
}

// Calcula todos os blocos (ou só os pedidos). Não grava nada.
async function calcularBlocos({ hoje, db = pool, ids = null, mrr = null } = {}) {
  const alvo = ids ? ids.map((id) => POR_ID.get(id)).filter(Boolean) : BLOCOS;
  const empresas = await carregarEmpresas(db);
  // uso_funcionalidade e adocao leem as mesmas tabelas (_uso.MODULOS): uma leitura só.
  const precisaUso = alvo.filter((b) => b.id === 'uso_funcionalidade' || b.id === 'adocao');
  const uso = precisaUso.length === 2 ? await usoPorModulo({ db, hoje, periodo: 30 }) : undefined;

  const resultados = {};
  const erros = [];
  for (let i = 0; i < alvo.length; i += EM_PARALELO) {
    await Promise.all(alvo.slice(i, i + EM_PARALELO).map(async (bloco) => {
      try {
        resultados[bloco.id] = await bloco.calcular({
          hoje, periodo: bloco.periodoPadrao, db, empresas, uso, mrr: mrr || undefined,
        });
      } catch (err) {
        erros.push({ etapa: `bloco:${bloco.id}`, erro: err.message });
        console.error(`[painel] bloco ${bloco.id} falhou:`, err.message);
      }
    }));
  }
  return { resultados, erros, empresas };
}

// Variação = valor de hoje menos o valor gravado 7 e 30 dias atrás. Sem a
// linha do dia correspondente (ou com valor não numérico), fica null.
async function aplicarVariacao({ hoje, db = pool, resultados }) {
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT to_char(dia, 'YYYY-MM-DD') AS dia, bloco, dados->'valor' AS valor
         FROM painel_blocos_diarios
        WHERE dia IN ($1::date - 7, $1::date - 30)`,
      [hoje]
    ));
  } catch (err) {
    if (!err || err.code !== '42P01') throw err;
  }
  const antes = new Map((rows || []).map((r) => [`${r.dia}|${r.bloco}`, r.valor]));
  const delta = (id, dias, atual) => {
    const v = antes.get(`${somaDias(hoje, -dias)}|${id}`);
    if (typeof atual !== 'number' || v === null || v === undefined || Number.isNaN(Number(v))) return null;
    return Math.round((atual - num(v)) * 100) / 100;
  };
  for (const [id, dados] of Object.entries(resultados)) {
    dados.variacao = { d7: delta(id, 7, dados.valor), d30: delta(id, 30, dados.valor) };
  }
  return resultados;
}

async function gravarBlocos({ hoje, db = pool, resultados }) {
  const linhas = Object.entries(resultados).map(([bloco, dados]) => ({ bloco, dados }));
  if (!linhas.length) return;
  await db.query(
    `INSERT INTO painel_blocos_diarios (dia, bloco, dados, calculado_em)
     SELECT $1::date, x.bloco, x.dados, NOW()
       FROM jsonb_to_recordset($2::jsonb) AS x(bloco text, dados jsonb)
     ON CONFLICT (dia, bloco) DO UPDATE SET
       dados = EXCLUDED.dados,
       calculado_em = NOW()`,
    [hoje, JSON.stringify(linhas)]
  );
}

async function rodarPainelDiario({ hoje = hojeBRT(), db = pool } = {}) {
  const inicio = Date.now();
  const erros = [];
  const etapa = async (nome, fn) => {
    try {
      return await fn();
    } catch (err) {
      erros.push({ etapa: nome, erro: err.message });
      console.error(`[painel] etapa ${nome} falhou:`, err.message);
      return null;
    }
  };

  const health = await etapa('health', () => recalculateAll({ db }));

  const mrr = await etapa('receita', async () => {
    const m = await calcularMrr({ db });
    await gravarSnapshot({ db, hoje, mrr: m });
    return m;
  });

  let empresas;
  const blocos = await etapa('blocos', async () => {
    const r = await calcularBlocos({ hoje, db, mrr });
    erros.push(...r.erros);
    empresas = r.empresas;
    await aplicarVariacao({ hoje, db, resultados: r.resultados });
    await gravarBlocos({ hoje, db, resultados: r.resultados });
    return Object.keys(r.resultados);
  });

  const alertas = await etapa('alertas', async () => {
    const lista = await calcularAlertas({ hoje, db, empresas });
    await gravarAlertas({ hoje, db, alertas: lista });
    return lista;
  });

  return {
    dia: hoje,
    ok: erros.length === 0,
    duracao_ms: Date.now() - inicio,
    health_atualizados: health ? health.updated : 0,
    mrr_total: mrr ? mrr.mrr_total : null,
    blocos: blocos || [],
    alertas: alertas ? alertas.length : 0,
    erros,
  };
}

module.exports = {
  hojeBRT,
  calcularBlocos,
  aplicarVariacao,
  gravarBlocos,
  rodarPainelDiario,
};
