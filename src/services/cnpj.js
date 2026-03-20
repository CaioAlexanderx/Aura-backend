// ============================================================
// AURA. — Serviço de Validação de CNPJ
// ============================================================

/**
 * Remove caracteres não numéricos do CNPJ
 */
function sanitizeCNPJ(cnpj) {
  return String(cnpj).replace(/\D/g, '');
}

/**
 * Valida CNPJ usando algoritmo oficial da Receita Federal
 * @param {string} cnpj - CNPJ com ou sem formatação
 * @returns {boolean}
 */
function validateCNPJ(cnpj) {
  const cleaned = sanitizeCNPJ(cnpj);

  if (cleaned.length !== 14) return false;

  // Rejeita sequências inválidas (ex: 00000000000000)
  if (/^(\d)\1+$/.test(cleaned)) return false;

  // Validação do primeiro dígito verificador
  const calcDigit = (cnpj, length) => {
    const weights = length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

    const sum = cnpj
      .slice(0, length)
      .split('')
      .reduce((acc, digit, i) => acc + parseInt(digit) * weights[i], 0);

    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const digit1 = calcDigit(cleaned, 12);
  const digit2 = calcDigit(cleaned, 13);

  return (
    parseInt(cleaned[12]) === digit1 &&
    parseInt(cleaned[13]) === digit2
  );
}

/**
 * Formata CNPJ para exibição: XX.XXX.XXX/XXXX-XX
 */
function formatCNPJ(cnpj) {
  const cleaned = sanitizeCNPJ(cnpj);
  if (cleaned.length !== 14) return cnpj;
  return cleaned.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    '$1.$2.$3/$4-$5'
  );
}

/**
 * Detecta o tipo de empresa pelo CNPJ
 * @returns {'MEI'|'EMPRESA'|'INVALIDO'}
 */
function detectCompanyType(cnpj) {
  if (!validateCNPJ(cnpj)) return 'INVALIDO';
  // MEI tem filial 0001 e natureza jurídica específica
  // Por ora retorna EMPRESA como padrão (lookup real via API RF)
  return 'EMPRESA';
}

module.exports = {
  sanitizeCNPJ,
  validateCNPJ,
  formatCNPJ,
  detectCompanyType,
};
