// ============================================================
// AURA Studio — As etapas que o cliente ve no pedido
//
// Moravam em routes/studioTrackPublic.js (acompanhamento, K3). A Fase 2
// da vitrine Studio ganhou a confirmacao persistente
// (GET /storefront/:slug/studio/pedido/:token), que mostra a MESMA linha
// do tempo — e duas tabelas de etapas seriam o cliente vendo "Criando a
// arte" numa tela e outra coisa na seguinte. Uma tabela, dois leitores.
// ============================================================
'use strict';

// As etapas que o CLIENTE entende. O board tem 6 colunas operacionais;
// aqui viram 4 marcos, porque "aprovado" e "em producao" sao a mesma
// promessa pra quem espera: esta sendo feito.
const ETAPAS = [
  { key: 'recebido',  label: 'Pedido recebido' },
  { key: 'arte',      label: 'Criando a arte' },
  { key: 'producao',  label: 'Em produção' },
  { key: 'pronto',    label: 'Pronto' },
];

// status de producao -> indice da etapa em que o pedido esta
function etapaDoStatus(status) {
  switch (status) {
    case 'awaiting_customization': return 0;
    case 'pending_art':            return 1;
    case 'approved':
    case 'in_production':          return 2;
    case 'ready':
    case 'delivered':              return 3;
    default:                       return 0; // venda sem producao: so "recebido"
  }
}

/**
 * A linha do tempo com o estado de cada etapa, na mesma leitura da
 * pagina de acompanhamento (app/acompanhar/[token].tsx): antes da atual
 * esta feito, a atual e "e onde estamos agora", depois e futuro.
 */
function etapasComEstado(atual) {
  return ETAPAS.map((e, i) => ({
    chave: e.key,
    rotulo: e.label,
    estado: i < atual ? 'feito' : i === atual ? 'atual' : 'futuro',
  }));
}

module.exports = { ETAPAS, etapaDoStatus, etapasComEstado };
