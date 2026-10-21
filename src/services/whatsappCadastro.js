// ============================================================
// AURA. — WhatsApp da pessoa no cadastro (porta de entrada 1/5, tq-66, 21/10/2026)
//
// Regra do celular brasileiro: DDD válido (lista da Anatel) + 9 + 8 dígitos,
// 11 dígitos no total. Aceita +55 (ou 55) e o 0 de longa distância na frente,
// e qualquer máscara: "(11) 99999-8888", "+55 11 99999-8888", "011999998888".
// Rejeita fixo (10 dígitos, ou 11 sem o 9 depois do DDD) com mensagem
// própria, para a pessoa entender que precisa do celular com WhatsApp.
//
// Onde a regra vale (routes/auth.js): só conta NOVA de varejo, isto é, o
// cadastro que cria empresa e não é dojô. Convite (sem empresa), quem entra
// numa empresa existente pelo CNPJ e dojô seguem como sempre.
//
// O número do WhatsApp da Aura vem de AURA_WHATSAPP (padrão 5511956305269,
// confirmado pelo Caio em 21/10/2026). O link wa.me já sai pronto para o app.
//
// Obrigatoriedade DESLIGADA por padrão (decisão de 21/10): só liga com
// WHATSAPP_OBRIGATORIO_NO_CADASTRO=true, junto com a tela nova (tq-69).
// Desligada, o cadastro aceita e grava o telefone como sempre (vazio ou fixo
// não viram 400); celular válido é normalizado e ganha handshake do mesmo jeito.
// ============================================================
'use strict';

// DDDs brasileiros em uso (Anatel). 67 códigos; 20, 23, 25, 26, 29, 30, 36,
// 39, 40, 50, 52, 56–60, 70, 72, 76, 78, 80 e 90 não existem.
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
].map(String));

const AURA_WHATSAPP_PADRAO = '5511956305269';

const ERROS = Object.freeze({
  WHATSAPP_REQUIRED: 'Informe o seu WhatsApp (celular com DDD) para criar a conta.',
  WHATSAPP_INVALID: 'WhatsApp inválido. Use o celular com DDD, por exemplo (11) 99999-8888.',
  WHATSAPP_DDD_INVALID: 'O DDD do WhatsApp não existe. Confira os dois primeiros números.',
  WHATSAPP_FIXO: 'Esse número parece ser de telefone fixo. Informe o seu celular com WhatsApp.',
});

const falha = (code) => ({ ok: false, code, error: ERROS[code] });

/**
 * Valida o celular. Devolve:
 *   { ok: true, numero: '11999998888', e164: '5511999998888' }
 *   { ok: false, code, error }   (code em ERROS; error em português)
 */
function validarCelular(bruto) {
  if (bruto === undefined || bruto === null) return falha('WHATSAPP_REQUIRED');
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return falha('WHATSAPP_INVALID');
  const texto = String(bruto);
  if (texto.length > 40) return falha('WHATSAPP_INVALID');
  // Letras no meio ("ramal", "x") não são número de WhatsApp.
  if (/[a-z]/i.test(texto)) return falha('WHATSAPP_INVALID');
  let d = texto.replace(/\D/g, '');
  if (!d) return falha('WHATSAPP_REQUIRED');

  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);        // 55 + DDD + 9 dígitos
  else if (d.length === 12 && d.startsWith('55')) d = d.slice(2);   // 55 + fixo (cai no teste de fixo)
  else if (d.length === 12 && d.startsWith('0')) d = d.slice(1);    // 0 + DDD + 9 dígitos
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);    // 0 + fixo

  if (d.length !== 10 && d.length !== 11) return falha('WHATSAPP_INVALID');
  if (!DDDS_VALIDOS.has(d.slice(0, 2))) return falha('WHATSAPP_DDD_INVALID');

  const assinante = d.slice(2);
  if (d.length === 10) {
    // 8 dígitos começando em 2–5 é fixo; 6–9 é celular antigo sem o 9.
    return /^[2-5]/.test(assinante) ? falha('WHATSAPP_FIXO') : falha('WHATSAPP_INVALID');
  }
  if (assinante[0] !== '9') {
    return /^[2-5]/.test(assinante) ? falha('WHATSAPP_FIXO') : falha('WHATSAPP_INVALID');
  }
  // "99999-9999", "90000-0000": oito dígitos iguais depois do 9 é número de mentira.
  if (/^(\d)\1{7}$/.test(assinante.slice(1))) return falha('WHATSAPP_INVALID');

  return { ok: true, numero: d, e164: `55${d}` };
}

// Telefone da loja (o da Receita), opcional: só dígitos, 10 a 13. Fora disso,
// ignora (o cadastro nunca cai por causa do telefone da loja).
function telefoneDaLoja(bruto) {
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null;
  const d = String(bruto).slice(0, 40).replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13 ? d : null;
}

// Só 'true' (ou 1/sim/on) liga. Variável ausente ou qualquer outro valor: desligada.
function exigidoNoCadastro(env = process.env) {
  const v = String(env.WHATSAPP_OBRIGATORIO_NO_CADASTRO || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'sim' || v === 'on';
}

function numeroDaAura(env = process.env) {
  const d = String(env.AURA_WHATSAPP || '').replace(/\D/g, '');
  return d.length >= 12 && d.length <= 13 ? d : AURA_WHATSAPP_PADRAO;
}

// Link wa.me com a mensagem já escrita (a pessoa só aperta enviar).
function linkDoHandshake(codigo, env = process.env) {
  const texto = `Oi, Aura! Acabei de criar minha conta. Meu código é ${codigo}`;
  return `https://wa.me/${numeroDaAura(env)}?text=${encodeURIComponent(texto)}`;
}

module.exports = {
  validarCelular,
  telefoneDaLoja,
  exigidoNoCadastro,
  numeroDaAura,
  linkDoHandshake,
  DDDS_VALIDOS,
  AURA_WHATSAPP_PADRAO,
  ERROS,
};
