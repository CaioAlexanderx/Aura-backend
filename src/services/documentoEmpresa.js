// ============================================================
// AURA. — Documento da empresa: CNPJ ou, na conta sem CNPJ, CPF
//
// 20/10/2026 — decisao do Caio: "vamos liberar para os clientes que
// sinalizarem que nao tem CNPJ". O cadastro aceita CPF + nome da loja
// (migration 400, companies.cpf). Este modulo concentra o que e comum:
//   - validacao do CPF (digitos verificadores), usada no cadastro e na
//     cobranca do Asaas;
//   - a mensagem unica das funcoes que a lei amarra ao CNPJ (NFC-e, NF-e):
//     quem tem so CPF ve uma explicacao curta e nada quebra.
// Modulo puro: sem banco, sem rede.
// ============================================================

function onlyDigits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

function validateCPF(cpf) {
  const c = onlyDigits(cpf);
  if (c.length !== 11) return false;
  if (/^(\d)\1+$/.test(c)) return false;
  const calc = (len) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += parseInt(c[i], 10) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return parseInt(c[9], 10) === calc(9) && parseInt(c[10], 10) === calc(10);
}

// Nota fiscal sem CNPJ: o mesmo texto e o mesmo code em todas as rotas, para
// a tela tratar uma vez so.
const CNPJ_REQUIRED_CODE = 'CNPJ_REQUIRED';
const CNPJ_REQUIRED_MSG =
  'A emissão de nota fiscal precisa de CNPJ. Quando você abrir o seu, informe em Configurações > Empresa.';

function cnpjRequiredBody(extra) {
  return { error: CNPJ_REQUIRED_MSG, code: CNPJ_REQUIRED_CODE, ...(extra || {}) };
}

module.exports = {
  onlyDigits,
  validateCPF,
  CNPJ_REQUIRED_CODE,
  CNPJ_REQUIRED_MSG,
  cnpjRequiredBody,
};
