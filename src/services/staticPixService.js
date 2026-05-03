// ============================================================
// AURA. — Static Pix BR Code generator
// Gera payload EMV (BR Code estatico) sem depender de Asaas.
// Spec: Manual de Padroes para Iniciacao do Pix - Bacen
// ============================================================
'use strict';

/** Encode TLV (Tag-Length-Value) com length de 2 chars. */
function toEmv(id, value) {
  const v = String(value);
  const len = String(v.length).padStart(2, '0');
  return id + len + v;
}

/** CRC16/CCITT-FALSE — polinomial 0x1021, init 0xFFFF. */
function crc16ccitt(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Remove acentos, caracteres especiais e limita tamanho. Pix exige ASCII. */
function sanitize(str, maxLen) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9\s\-\.]/g, '')
    .trim()
    .substring(0, maxLen)
    .toUpperCase();
}

/** Sanitiza valor monetario pra duas casas. Retorna null se invalido. */
function formatAmount(amount) {
  const n = Number(amount);
  if (!isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

/** Sanitiza txid: max 25 chars, alfanumerico apenas. */
function sanitizeTxid(txid) {
  const t = String(txid || '').replace(/[^A-Za-z0-9]/g, '');
  if (!t) return '***';
  return t.substring(0, 25);
}

/** Valida formato basico da chave Pix por tipo. */
function validatePixKey(key, type) {
  const k = String(key || '').trim();
  if (!k) return { valid: false, error: 'Chave Pix vazia' };
  switch ((type || '').toUpperCase()) {
    case 'CPF': {
      const d = k.replace(/\D/g, '');
      if (d.length !== 11) return { valid: false, error: 'CPF deve ter 11 digitos' };
      return { valid: true, normalized: d };
    }
    case 'CNPJ': {
      const d = k.replace(/\D/g, '');
      if (d.length !== 14) return { valid: false, error: 'CNPJ deve ter 14 digitos' };
      return { valid: true, normalized: d };
    }
    case 'PHONE': {
      const d = k.replace(/\D/g, '');
      if (d.length < 10 || d.length > 13) return { valid: false, error: 'Telefone invalido' };
      // Pix exige formato +5511999990000
      const withCountry = d.startsWith('55') ? d : '55' + d;
      return { valid: true, normalized: '+' + withCountry };
    }
    case 'EMAIL': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)) return { valid: false, error: 'E-mail invalido' };
      if (k.length > 77) return { valid: false, error: 'E-mail muito longo (max 77)' };
      return { valid: true, normalized: k.toLowerCase() };
    }
    case 'RANDOM':
    case 'EVP': {
      // UUID v4: 32 hex chars com 4 traços
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(k)) {
        return { valid: false, error: 'Chave aleatoria deve ser um UUID' };
      }
      return { valid: true, normalized: k.toLowerCase() };
    }
    default:
      // Sem tipo: aceita como veio, sem normalizar
      return { valid: true, normalized: k };
  }
}

/**
 * Constroi o payload BR Code estatico (Pix copiavel).
 * @param {Object} opts
 * @param {string} opts.pixKey - chave normalizada (CPF apenas digitos, etc)
 * @param {number|string} opts.amount - valor em reais (ex: 89.90)
 * @param {string} opts.beneficiaryName - nome recebedor (max 25 chars apos sanitize)
 * @param {string} opts.beneficiaryCity - cidade recebedor (max 15 chars apos sanitize)
 * @param {string} [opts.txid] - identificador transacao (max 25 alfanum); '***' se vazio
 * @returns {string} payload EMV completo (com CRC) — pode ser convertido em QR Code
 */
function buildStaticBrCode({ pixKey, amount, beneficiaryName, beneficiaryCity, txid }) {
  if (!pixKey) throw new Error('pixKey obrigatorio');

  const merchantAccountInfo =
    toEmv('00', 'br.gov.bcb.pix') +
    toEmv('01', String(pixKey).trim());

  const additionalData = toEmv('05', sanitizeTxid(txid));

  const parts = [
    toEmv('00', '01'),                       // Payload Format Indicator
    toEmv('26', merchantAccountInfo),        // Merchant Account Information (Pix)
    toEmv('52', '0000'),                     // Merchant Category Code (geral)
    toEmv('53', '986'),                      // Currency (BRL)
  ];

  const formattedAmount = formatAmount(amount);
  if (formattedAmount) {
    parts.push(toEmv('54', formattedAmount));  // Transaction Amount
  }

  parts.push(toEmv('58', 'BR'));                                                 // Country
  parts.push(toEmv('59', sanitize(beneficiaryName, 25) || 'AURA NEGOCIO'));      // Merchant Name
  parts.push(toEmv('60', sanitize(beneficiaryCity, 15) || 'BRASIL'));            // Merchant City
  parts.push(toEmv('62', additionalData));                                        // Additional Data

  // CRC16 calculado sobre tudo + '6304' (campo 63 com length 04)
  const payloadWithCrcId = parts.join('') + '6304';
  const crc = crc16ccitt(payloadWithCrcId);

  return payloadWithCrcId + crc;
}

module.exports = { buildStaticBrCode, validatePixKey, sanitize, sanitizeTxid, crc16ccitt };
