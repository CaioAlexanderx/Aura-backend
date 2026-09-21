// Casos de telefone da Fase 1 (perfil do cliente). Usados pelo teste puro
// (src/utils/phone.js) e pelo de paridade com public.aura_phone_e164_br
// (migration 341) — as duas implementações precisam concordar em todos.
'use strict';

module.exports = [
  // celulares com o 9
  ['(11) 98765-4321', '5511987654321'],
  ['11987654321', '5511987654321'],
  ['+55 (21) 99876-5432', '5521998765432'],
  ['5511987654321', '5511987654321'],
  ['0055 11 98765 4321', '5511987654321'],
  // celulares sem o 9 (formato antigo) ganham o nono dígito
  ['(11) 8765-4321', '5511987654321'],
  ['1187654321', '5511987654321'],
  ['55 11 7654-3210', '5511976543210'],
  ['+55 31 6123-4567', '5531961234567'],
  // fixos ficam como estão
  ['(11) 3456-7890', '551134567890'],
  ['+55 51 2345-6789', '555123456789'],
  ['4834567890', '554834567890'],
  // prefixo de tronco e de operadora
  ['0 11 98765-4321', '5511987654321'],
  ['011 3456-7890', '551134567890'],
  ['0 15 11 98765-4321', '5511987654321'],
  ['0 21 21 8765-4321', '5521987654321'],
  // lixo e casos inválidos
  [null, null],
  ['', null],
  ['   ', null],
  ['abc', null],
  ['123', null],
  ['(01) 3456-7890', null],     // DDD com zero
  ['(10) 98765-4321', null],    // DDD com zero
  ['11 1234-5678', null],       // 8 dígitos começando com 1
  ['11 0234-5678', null],       // 8 dígitos começando com 0
  ['11 88765-4321', null],      // 9 dígitos sem o 9 na frente
  ['+1 555 630 9005', null],    // estrangeiro
  ['0015 11 3456 7890', null],  // internacional que não é Brasil
  ['551198765432100', null],    // longo demais
  ['98765-4321', null],         // sem DDD
];
