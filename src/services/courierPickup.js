// ============================================================
// AURA. — Retirada por app de entrega (migration 288)
//
// Terceiro delivery_type, ao lado de 'pickup' e 'delivery': o CLIENTE
// contrata o entregador (Uber, 99, motoboy particular) e informa quem
// vai buscar. A loja nao cobra frete — quem paga o app e o cliente — e
// nao precisa de endereco.
//
// Os campos sao do ENTREGADOR, nao do cliente. Sem nome e placa, a
// lojista entrega uma personalizacao para o primeiro motoboy que
// aparecer dizendo o numero do pedido.
//
// Modulo compartilhado de proposito: storefront.js (loja comum) e
// studioStorefront.js chamam a MESMA validacao. Duas copias divergindo
// dariam duas regras de retirada para a mesma lojista — foi o que
// aconteceu com a validacao de campos obrigatorios (S0).
// ============================================================
'use strict';

const COURIER = 'courier';

// Placa brasileira: antiga ABC1234 e Mercosul ABC1D23. Motos seguem o
// mesmo formato. Normaliza caixa e tira separador antes de validar, para
// aceitar "abc-1234" digitado no celular do cliente.
const PLATE_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;

function normalizePlate(raw) {
  if (raw == null) return null;
  const clean = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PLATE_RE.test(clean) ? clean : null;
}

/**
 * Valida o bloco de retirada por app de um pedido.
 *
 * @param {object} config - row de digital_channel_config
 * @param {object} body   - corpo do pedido (courier_name, courier_plate)
 * @returns {{error: string} | {courier_name: string, courier_plate: string}}
 */
function validateCourierPickup(config, body) {
  if (!config || config.courier_pickup_enabled !== true) {
    return { error: 'Retirada por app nao disponivel nesta loja' };
  }

  const name = body && body.courier_name != null ? String(body.courier_name).trim() : '';
  if (!name) {
    return { error: 'Informe o nome do entregador que vai retirar o pedido' };
  }
  if (name.length > 120) {
    return { error: 'Nome do entregador muito longo' };
  }

  const plate = normalizePlate(body && body.courier_plate);
  if (!plate) {
    return { error: 'Placa invalida. Use o formato ABC1234 ou ABC1D23' };
  }

  return { courier_name: name, courier_plate: plate };
}

module.exports = { COURIER, normalizePlate, validateCourierPickup };
