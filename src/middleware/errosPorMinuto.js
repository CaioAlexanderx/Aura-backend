// ============================================================
// AURA. — Contador de erro por minuto (card t1-02)
//
// Conta, em memória, cada resposta enviada e cada 5xx; o resto (EMAXCONNSESSION
// do pooler, flush por minuto, leitura do painel) está em
// services/errosPorMinuto.js. O trabalho por requisição é um `res.once('finish')`
// e três inteiros: nenhuma consulta, nenhum await, nada no caminho da resposta
// (o contador roda DEPOIS que a resposta já foi enviada).
//
// Fica de fora: OPTIONS (preflight) e /health (UptimeRobot), que diluiriam a
// taxa de erro da lojista.
// ============================================================
'use strict';

const contador = require('../services/errosPorMinuto');

function errosPorMinuto() {
  // Liga o flush por minuto e o observador do pool (dormente em teste e com
  // ERROS_POR_MINUTO=off).
  contador.iniciar();

  return function contarErrosPorMinuto(req, res, next) {
    if (req.method !== 'OPTIONS' && !req.path.startsWith('/health')) {
      res.once('finish', () => contador.registrarResposta(res.statusCode));
    }
    next();
  };
}

module.exports = { errosPorMinuto };
