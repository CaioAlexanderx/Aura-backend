// ============================================================
// AURA. -- Endereco do cliente para entrega (09/11/2026, parte 1)
//
// O cadastro do varejo nao tinha endereco em lugar nenhum: o app nao
// mandava e /customers ignorava. As colunas ja existiam em `customers`
// desde a 001 (street, number, complement, city, state, zip_code) e a 073
// (neighborhood). Ha duas colunas paralelas -- address_number e
// postal_code (073) -- vazias em 100% dos clientes do varejo. As
// CANONICAS sao `number` e `zip_code`; esta rota nunca escreve nas outras.
//
// Ponto de referencia ("portao azul, ao lado da padaria") e coluna nova:
// address_reference (migration 433).
//
// Validacao leve, tudo opcional no cadastro comum:
//   - CEP: so digitos; vazio apaga; se vier, 8 digitos.
//   - UF: duas letras; vazio apaga.
//   - texto: trim; vazio vira NULL (apaga); teto de tamanho.
// A trava "venda com frete precisa de endereco" e do Caixa (parte 2),
// nao do cadastro.
// ============================================================
'use strict';

// chave no body -> coluna em customers. Mesmo nome dos dois lados.
const ADDRESS_FIELDS = [
  'zip_code', 'street', 'number', 'complement', 'neighborhood', 'city', 'state', 'address_reference',
];

const MAX_LEN = {
  street: 200, number: 20, complement: 120, neighborhood: 120, city: 120, address_reference: 300,
};

const LABEL = {
  street: 'Rua', number: 'Numero', complement: 'Complemento', neighborhood: 'Bairro',
  city: 'Cidade', address_reference: 'Ponto de referencia',
};

function texto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

/**
 * Le os campos de endereco presentes no body. Campo ausente (undefined)
 * nao entra -- o PATCH nao mexe nele. null ou '' apagam.
 *
 * @returns {{ ok: true, values: Object<string, string|null> }
 *         | { ok: false, error: string, field: string }}
 */
function parseCustomerAddress(body) {
  const values = {};
  const src = body || {};
  for (const field of ADDRESS_FIELDS) {
    if (src[field] === undefined) continue;
    const raw = src[field];

    if (field === 'zip_code') {
      const str = raw === null ? '' : String(raw).trim();
      if (str === '') { values.zip_code = null; continue; }
      const digits = str.replace(/\D/g, '');
      if (digits.length !== 8) return { ok: false, error: 'O CEP precisa ter 8 numeros', field };
      values.zip_code = digits;
      continue;
    }

    if (field === 'state') {
      const uf = texto(raw);
      if (uf === null) { values.state = null; continue; }
      const up = uf.toUpperCase();
      if (!/^[A-Z]{2}$/.test(up)) return { ok: false, error: 'A UF precisa ter 2 letras (ex.: SP)', field };
      values.state = up;
      continue;
    }

    const v = texto(raw);
    if (v !== null && v.length > MAX_LEN[field]) {
      return { ok: false, error: `${LABEL[field]} passou de ${MAX_LEN[field]} letras`, field };
    }
    values[field] = v;
  }
  return { ok: true, values };
}

/**
 * Tem o minimo para levar uma entrega: rua (ou CEP), numero e cidade.
 * O mesmo criterio que o app usa no selo "sem endereco" e que a trava do
 * frete (parte 2) vai exigir.
 */
function hasDeliveryAddress(row) {
  if (!row) return false;
  const t = (v) => (v === null || v === undefined ? '' : String(v).trim());
  return !!((t(row.street) || t(row.zip_code)) && t(row.number) && t(row.city));
}

/** Os campos de endereco de uma linha de customers, prontos para o JSON. */
function addressFromRow(r) {
  const t = (v) => (v === null || v === undefined ? '' : String(v).trim());
  return {
    zip_code: t(r.zip_code),
    street: t(r.street),
    number: t(r.number),
    complement: t(r.complement),
    neighborhood: t(r.neighborhood),
    city: t(r.city),
    state: t(r.state),
    address_reference: t(r.address_reference),
    has_address: hasDeliveryAddress(r),
  };
}

/** 42703 que fala da coluna da 433 (banco ainda sem a migration). */
function isMissingReferenceColumn(err) {
  return !!err && err.code === '42703' && /address_reference/.test(String(err.message || ''));
}

module.exports = {
  ADDRESS_FIELDS,
  parseCustomerAddress,
  hasDeliveryAddress,
  addressFromRow,
  isMissingReferenceColumn,
};
