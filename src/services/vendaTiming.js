// ============================================================
// AURA. — Tempo da venda no Caixa, por etapa (card p-140, 17/11/2026)
//
// Uma linha por POST /pdv/sale (e /pdv/sale-com-sinal), no log do servico:
//
//   [pdv-sale-timing] {"status":201,"total_ms":2950,"pre_ms":190,
//     "etapas":{"conexao":1,"abertura":570,"itens_validacao":190,...},
//     "queries_tx":16,"queries_pos":1,"db_ms":2890,"itens":1,
//     "metodo":"pix","cliente":false,"vendedora":false,"cupom":false,
//     "caixa_sessao":false,"crediario":false,...,"company_id":"<uuid>"}
//
// Serve para medir ANTES e DEPOIS de reduzir as idas ao banco da venda
// (cards p-141 a p-144): cada `client.query` em fila custa uma ida e volta
// entre o servico e o banco (src/config/database.js).
//
// Regras:
//   - Nenhum dado de cliente final: so numeros, sim/nao, a forma de
//     pagamento e os ids internos da empresa e da venda. Nunca nome, CPF,
//     telefone, nome de produto ou texto digitado.
//   - Nada aqui pode derrubar ou atrasar a venda: toda funcao engole o
//     proprio erro, e a linha sai depois da resposta.
//   - PDV_SALE_TIMING=off desliga a linha (o padrao e ligado).
// ============================================================
'use strict';

const { performance } = require('perf_hooks');

const PREFIXO = '[pdv-sale-timing]';

// Relogio que nunca lanca: a medicao pode sair errada, a venda nao pode cair.
const agora = () => { try { return performance.now(); } catch (_) { return 0; } };
const ms = (v) => Math.round(v);

function ligado() {
  return String(process.env.PDV_SALE_TIMING || '').toLowerCase() !== 'off';
}

/**
 * Carimbo do inicio da requisicao, antes da autenticacao (routes/private.js).
 * Com ele a linha traz `pre_ms`: o tempo gasto ate entrar na rota.
 */
function carimbarInicio(req, res, next) {
  try { req._pdvInicioMs = agora(); } catch (_) { /* segue sem o carimbo */ }
  next();
}

/** Comeca a medir. Chamado na entrada do handleSale. */
function iniciar(req) {
  const t0 = agora();
  let ultimo = t0;
  let emitido = false;
  let queriesTx = 0;
  let queriesPos = 0;
  let dbMs = 0;
  const etapas = {};
  const dados = {};
  let preMs = null;
  try {
    const inicio = req && req._pdvInicioMs;
    if (typeof inicio === 'number' && Number.isFinite(inicio)) preMs = ms(t0 - inicio);
  } catch (_) { /* sem pre_ms */ }

  const somarDb = (inicio) => { try { dbMs += agora() - inicio; } catch (_) { /* so medicao */ } };

  // Acompanha a promessa da consulta sem mexer nela: quem chamou recebe a
  // MESMA promessa (mesmo resultado, mesmo erro).
  const cronometrar = (promessa, inicio) => {
    try {
      if (promessa && typeof promessa.then === 'function') {
        promessa.then(() => somarDb(inicio), () => somarDb(inicio));
      }
    } catch (_) { /* so medicao */ }
    return promessa;
  };

  return {
    /**
     * Devolve um client que conta as consultas e repassa cada uma, sem
     * tocar em nada, para o client de verdade. O client do pool nao e
     * alterado (ele volta para o pool como veio).
     */
    contar(client) {
      try {
        const contado = Object.create(client);
        contado.query = (...args) => {
          queriesTx += 1;
          const inicio = agora();
          return cronometrar(client.query(...args), inicio);
        };
        return contado;
      } catch (_) {
        return client;
      }
    },

    /** Conta uma consulta feita fora da transacao (depois do COMMIT). */
    foraDaTransacao(promessa) {
      queriesPos += 1;
      return cronometrar(promessa, agora());
    },

    /** Fecha a etapa: o tempo desde a marca anterior entra em `nome`. */
    etapa(nome) {
      try {
        const t = agora();
        etapas[nome] = (etapas[nome] || 0) + (t - ultimo);
        ultimo = t;
      } catch (_) { /* so medicao */ }
    },

    /** Junta numeros e sim/nao da venda a linha. */
    dado(campos) {
      try { Object.assign(dados, campos); } catch (_) { /* so medicao */ }
    },

    /** Escreve a linha. Uma vez por venda; nunca lanca. */
    emitir(res) {
      if (emitido) return;
      emitido = true;
      try {
        if (!ligado()) return;
        const fim = agora();
        const linha = {
          status: res && typeof res.statusCode === 'number' ? res.statusCode : null,
          total_ms: ms(fim - t0),
          pre_ms: preMs,
          etapas: Object.fromEntries(Object.entries(etapas).map(([k, v]) => [k, ms(v)])),
          queries_tx: queriesTx,
          queries_pos: queriesPos,
          db_ms: ms(dbMs),
          ...dados,
        };
        console.log(`${PREFIXO} ${JSON.stringify(linha)}`);
      } catch (e) {
        try { console.warn('[pdv-sale-timing] linha nao escrita:', e && e.message); } catch (_) { /* nada */ }
      }
    },
  };
}

/** Forma de pagamento como rotulo curto (o campo vem do app). */
function rotuloDoMetodo(v) {
  try {
    return String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || null;
  } catch (_) { return null; }
}

module.exports = { PREFIXO, iniciar, carimbarInicio, rotuloDoMetodo };
