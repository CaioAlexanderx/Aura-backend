// ============================================================
// AURA KARATÊ — Validação da ficha de "solicitar praticante novo"
// (item 6 da revisão de Atualização Cadastral, 15/07/2026)
//
// Antes desta revisão só full_name + (phone OU email) eram obrigatórios
// no backend — o front tinha os outros campos na tela, mas nada impedia
// enviar a ficha praticamente vazia direto pela API (curl/Postman) mesmo
// com o front validando. O Caio pediu que TODOS os campos da ficha sejam
// obrigatórios, e que a validação exista no BACKEND também, não só no
// front.
//
// "Todos os campos", como decidido para esta ficha (é uma matrícula
// nova — mais rígido que a completude de quem já está cadastrado, ver
// classifyPraticante em karateRosterPortalPublic.js):
//   full_name, birth_date, sex, cpf, rg, phone E email (os dois, não
//   "um dos dois"), claimed_belt (faixa alegada), e endereço completo
//   (zip_code, street, number, neighborhood, city, state).
//   complement fica de fora (é modificador opcional do endereço — nem
//   toda casa tem apartamento/fundos).
//   guardian_name/guardian_phone/guardian_relationship só entram quando
//   o praticante é menor de 18 (guardian_cpf continua opcional).
//   fpkt_number_claimed continua OPCIONAL de propósito — é uma alegação,
//   não um campo da ficha; "não tenho o número" é um fluxo válido (a
//   federação atribui na aprovação).
//
// Usado pelos DOIS canais que criam solicitação (mesmo contrato de
// campos, ver comentário de topo de karateDojoPractitionerRequests.js):
//   - POST /federation/:id/dojo/practitioner-requests      (JWT/OTP)
//   - POST /public/roster-update/:token/practitioner        (token público)
// ============================================================
'use strict';

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function ageFromISO(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime())) return null;
  const t = new Date();
  let a = t.getFullYear() - d.getFullYear();
  const mm = t.getMonth() - d.getMonth();
  if (mm < 0 || (mm === 0 && t.getDate() < d.getDate())) a--;
  return a;
}

// `parsed` é o objeto já normalizado pelo caller (mesmas chaves de
// `payload` em karateDojoPractitionerRequests.js / karateRosterPortalPublic.js):
// full_name, birth_date, sex, cpf, rg, phone, email, claimed_belt,
// street, number, complement, neighborhood, city, state, zip_code,
// guardian_name, guardian_cpf, guardian_phone, guardian_relationship.
//
// Retorna array de mensagens (vazio = válido). Nunca lança — o caller
// decide o formato da resposta 422.
function validatePractitionerRequestPayload(parsed) {
  const errors = [];

  if (isBlank(parsed.full_name)) errors.push('Nome completo é obrigatório');
  if (isBlank(parsed.birth_date)) errors.push('Data de nascimento é obrigatória');
  if (isBlank(parsed.sex)) errors.push('Sexo é obrigatório');
  if (isBlank(parsed.cpf)) errors.push('CPF é obrigatório');
  if (isBlank(parsed.rg)) errors.push('RG é obrigatório');
  if (isBlank(parsed.phone)) errors.push('Telefone é obrigatório');
  if (isBlank(parsed.email)) errors.push('E-mail é obrigatório');
  if (isBlank(parsed.claimed_belt)) errors.push('Faixa alegada é obrigatória');

  if (isBlank(parsed.zip_code)) errors.push('CEP é obrigatório');
  if (isBlank(parsed.street)) errors.push('Rua é obrigatória');
  if (isBlank(parsed.number)) errors.push('Número é obrigatório');
  if (isBlank(parsed.neighborhood)) errors.push('Bairro é obrigatório');
  if (isBlank(parsed.city)) errors.push('Cidade é obrigatória');
  if (isBlank(parsed.state)) errors.push('UF é obrigatória');

  const age = ageFromISO(parsed.birth_date);
  const isMinor = age !== null && age < 18;
  if (isMinor) {
    if (isBlank(parsed.guardian_name)) errors.push('Nome do responsável é obrigatório para menores de 18 anos');
    if (isBlank(parsed.guardian_phone)) errors.push('Telefone do responsável é obrigatório para menores de 18 anos');
    if (isBlank(parsed.guardian_relationship)) errors.push('Parentesco do responsável é obrigatório para menores de 18 anos');
  }

  return errors;
}

module.exports = { validatePractitionerRequestPayload, isBlank, ageFromISO };
