// ============================================================
// AURA. — Nome da loja: UMA regra para a Aura inteira (21/11/2026)
//
// Pedido do Caio (21/11): "a mudança de nome nas configurações afetar
// todas as documentações e comunicações da Aura". Duas lojas trocaram o
// nome (Layali, Looks Da Jenny) e o nome velho, ou o da dona, continuou
// aparecendo — o login mandava `company.name` com a RAZÃO SOCIAL primeiro
// (em conta com CPF ou MEI, a razão social é o nome da pessoa).
//
// REGRA: nome da loja = nome fantasia (`trade_name`) quando preenchido;
// senão, a razão social (`legal_name`). "Preenchido" = tem algum caractere
// que não é espaço. O valor sai como está gravado (sem trim), para o papel
// de quem não mudou nada sair idêntico, byte a byte.
//
// EXCEÇÕES (não usam esta função):
//   - Documento fiscal segue a lei: xNome do emitente (NFC-e, NF-e) é a
//     razão social; o nome fantasia vai só no xFant. NFS-e Nacional não
//     manda o nome do prestador (a Receita usa o do CNPJ). Arquivos:
//     services/sefazSp/*, services/nuvemfiscal.js, services/focusnfe.js,
//     services/nfseNacional/*, routes/foodNfce.js (razaoSocial),
//     services/tissXml.js (TISS/ANS) e os relatórios de obrigação fiscal
//     (obligationReport*, "Razao Social:").
//   - Contrato e cobrança da própria Aura ao lojista (Asaas:
//     services/asaasCustomer.js) ficam com a razão social.
//
// SQL: `COALESCE(trade_name, legal_name)` é a mesma regra desde que o
// nome fantasia nunca seja gravado em branco — por isso quem grava
// trade_name passa por `nomeFantasiaParaGravar` (branco vira NULL). Para
// consulta nova, use `sqlNomeDaLoja('c')`, que também pula o branco que já
// estiver no banco. Sem aspas no texto: cabe em string com ' ou com `.
// ============================================================
'use strict';

const preenchido = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Nome da loja para mostrar ao lojista ou à cliente final.
 * @param {{trade_name?: string|null, legal_name?: string|null}|null|undefined} company
 * @param {string} [fallback] o que sai quando a loja não tem nome nenhum
 */
function nomeDaLoja(company, fallback) {
  if (company) {
    if (preenchido(company.trade_name)) return company.trade_name;
    if (preenchido(company.legal_name)) return company.legal_name;
  }
  return fallback === undefined ? '' : fallback;
}

/** Razão social, para o que a lei ou o contrato pedem razão social. */
function razaoSocialDaLoja(company, fallback) {
  if (company) {
    if (preenchido(company.legal_name)) return company.legal_name;
    if (preenchido(company.trade_name)) return company.trade_name;
  }
  return fallback === undefined ? '' : fallback;
}

/** Expressão SQL da mesma regra. `alias` = alias da tabela companies ('' sem alias). */
function sqlNomeDaLoja(alias) {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(CASE WHEN LENGTH(BTRIM(${a}trade_name)) > 0 THEN ${a}trade_name END, ${a}legal_name)`;
}

/** O que gravar em companies.trade_name: texto aparado ou NULL (nunca branco). */
function nomeFantasiaParaGravar(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

module.exports = { nomeDaLoja, razaoSocialDaLoja, sqlNomeDaLoja, nomeFantasiaParaGravar };
