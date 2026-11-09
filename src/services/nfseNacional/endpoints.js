// ============================================================
// AURA. — nfseNacional/endpoints: endereços do Sistema Nacional NFS-e
// (Emissor Público Nacional via API — "Sefin Nacional") e chaves de liga.
//
// Fontes (gov.br/nfse, "APIs - Prod. Restrita e Produção", lidas em 09/11/2026):
//   Sefin Nacional  produção restrita: sefin.producaorestrita.nfse.gov.br  (docs em /API/SefinNacional/docs/index)
//                   produção:          sefin.nfse.gov.br                   (docs em /SefinNacional/docs/index)
//   ADN DANFSe      produção restrita: adn.producaorestrita.nfse.gov.br/danfse
//                   produção:          adn.nfse.gov.br/danfse
// O Swagger do Sefin exige o certificado (mTLS) até para abrir a página; o
// contrato (basePath /SefinNacional, POST /nfse, GET /nfse/{chave},
// GET|HEAD /dps/{id}, POST /nfse/{chave}/eventos) foi conferido no Manual
// dos Contribuintes v1.2 (out/2025) e numa cópia pública do OpenAPI da
// produção restrita. A base exata é um dos itens a confirmar na homologação.
//
// AMBIENTE (decisão conservadora):
//   - qualquer valor diferente de exatamente 'producao' → PRODUÇÃO RESTRITA
//     (tpAmb=2). Isso inclui 'homologacao' (o default antigo da tabela),
//     'producao_restrita' e nulo.
//   - 'producao' só transmite se TAMBÉM houver NFSE_NACIONAL_PRODUCAO=true.
//
// LIGA GERAL: NFSE_NACIONAL_ENABLED=true. Desligada (padrão), o provider
// nacional recusa QUALQUER chamada ao Sefin/ADN com erro claro — depois do
// deploy nada sai até alguém ligar a env para a homologação.
// ============================================================
'use strict';

const SEFIN = {
  producao_restrita: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
  producao: 'https://sefin.nfse.gov.br/SefinNacional',
};

const ADN_DANFSE = {
  producao_restrita: 'https://adn.producaorestrita.nfse.gov.br/danfse',
  producao: 'https://adn.nfse.gov.br/danfse',
};

function envTrue(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** Liga geral do provider nacional (lida a cada chamada: muda sem redeploy). */
function nacionalHabilitado() {
  return envTrue('NFSE_NACIONAL_ENABLED');
}

/** Segunda trava, só para o ambiente de produção. */
function producaoHabilitada() {
  return envTrue('NFSE_NACIONAL_PRODUCAO');
}

/** 'producao' | 'producao_restrita' a partir do valor salvo em nfse_config.ambiente. */
function normalizarAmbiente(valor) {
  return String(valor || '').trim().toLowerCase() === 'producao' ? 'producao' : 'producao_restrita';
}

function tpAmbDe(ambiente) {
  return normalizarAmbiente(ambiente) === 'producao' ? 1 : 2;
}

function getEndpoints(ambiente) {
  const amb = normalizarAmbiente(ambiente);
  return { ambiente: amb, tpAmb: tpAmbDe(amb), sefin: SEFIN[amb], danfse: ADN_DANFSE[amb] };
}

module.exports = {
  SEFIN, ADN_DANFSE,
  nacionalHabilitado, producaoHabilitada,
  normalizarAmbiente, tpAmbDe, getEndpoints,
};
