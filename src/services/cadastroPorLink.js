// ============================================================
// AURA. — Cadastro do cliente por link (p-209, 23/11/2026)
//
// Regras puras (sem banco) do link que o lojista manda pelo WhatsApp e do
// que o cliente envia por ele. As rotas: src/routes/customerSignupLinks.js
// (lojista, autenticada) e src/routes/cadastroLinkPublic.js (cliente, sem
// auth: o token é a credencial).
//
// REGRAS (Caio, 23/11/2026):
//   - O formulário só GRAVA. Nunca devolve dado já cadastrado: o link pode
//     ser encaminhado para outra pessoa.
//   - Link de uso único, vale 7 dias.
//   - Cliente já cadastrado: campo VAZIO é preenchido sozinho; campo com
//     valor DIFERENTE vira pendência para o lojista aceitar com um toque.
//     Nada é sobrescrito sem ele.
//   - Receita e dado de saúde ficam fora (o formulário nem tem o campo).
//   - CPF não vai em log nem em listagem.
//
// O token nunca é gravado: só o sha256. Quem lê o banco não consegue
// abrir o formulário de ninguém.
// ============================================================
'use strict';

const crypto = require('crypto');
const { isValidCpf } = require('../utils/cpfCnpj');
const { normalizarTelefone, mesmoTelefone } = require('../utils/telefone');
const { parseCustomerAddress } = require('./customerAddress');

const VALIDADE_DIAS = 7;
// 32 bytes em base64url = 43 letras. Adivinhar está fora de questão; o
// limite de tentativas da rota pública é para robô, não para a sorte.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function gerarToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenComFormato(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

// ─── O que o cliente manda ───────────────────────────────────

// Chaves de topo aceitas no POST público. Qualquer outra é 422: o
// formulário não tem porta para receita, observação, tag ou crediário.
const CHAVES_DO_FORMULARIO = new Set([
  'name', 'birth_date', 'cpf', 'phone', 'email',
  'zip_code', 'street', 'number', 'complement', 'neighborhood', 'city', 'state',
  'consent',
]);

const CAMPOS_DO_ENDERECO = ['zip_code', 'street', 'number', 'complement', 'neighborhood', 'city', 'state'];

// Rótulo de cada bloco, para a pendência que o lojista vê.
const ROTULOS = {
  name: 'Nome',
  birth_date: 'Data de nascimento',
  cpf_cnpj: 'CPF',
  phone: 'Telefone',
  email: 'E-mail',
  address: 'Endereço',
};
const BLOCOS = Object.keys(ROTULOS);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function textoLimpo(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

// dd/mm/aaaa ou aaaa-mm-dd, com ANO (o formulário pede o ano; 1904 e 2000
// são os "sem ano" das importações e do cadastro antigo). Entre 1900 e hoje.
function dataDeNascimento(raw) {
  const s = textoLimpo(raw);
  if (!s) return null;
  let y, m, d;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) [d, m, y] = s.split('/').map(Number);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) [y, m, d] = s.split('-').map(Number);
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt.getTime() > Date.now()) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function erro(field, error, code) {
  return { ok: false, field, error, code: code || 'CAMPO_INVALIDO' };
}

/**
 * Valida o envio do cliente.
 * @returns {{ok: true, values: {name, birth_date, cpf_cnpj, phone?, email?, address?}, consentVersion: string}
 *         | {ok: false, field, error, code, status?}}
 */
function lerFormulario(body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const k of Object.keys(src)) {
    if (!CHAVES_DO_FORMULARIO.has(k)) return { ...erro(k, 'Campo não aceito neste formulário', 'FIELD_NOT_ALLOWED'), status: 422 };
  }

  const consent = src.consent && typeof src.consent === 'object' ? src.consent : null;
  const versao = consent && typeof consent.version === 'string' ? consent.version.trim() : '';
  if (!consent || consent.accepted !== true || !versao || versao.length > 40) {
    return erro('consent', 'Marque o aceite para enviar o cadastro.', 'ACEITE_OBRIGATORIO');
  }

  const name = textoLimpo(src.name);
  if (!name) return erro('name', 'Escreva o seu nome completo.');
  if (name.length > 200) return erro('name', 'O nome passou de 200 letras.');
  if (name.split(' ').length < 2) return erro('name', 'Escreva o nome completo, com sobrenome.');

  const birth = dataDeNascimento(src.birth_date);
  if (!birth) return erro('birth_date', 'Confira a data de nascimento (dia, mês e ano).');

  const cpf = String(src.cpf == null ? '' : src.cpf).replace(/\D/g, '');
  if (!isValidCpf(cpf)) return erro('cpf', 'Confira o CPF: os números não batem.');

  const values = { name, birth_date: birth, cpf_cnpj: cpf };

  if (src.phone !== undefined && textoLimpo(src.phone)) {
    const tel = normalizarTelefone(String(src.phone).trim());
    if (!tel.ok) return erro('phone', tel.error, tel.code);
    const digitos = String(tel.valor).replace(/\D/g, '');
    if (digitos.length < 10) return erro('phone', 'Confira o telefone, com DDD.');
    values.phone = String(tel.valor).trim();
  }

  if (src.email !== undefined && textoLimpo(src.email)) {
    const email = textoLimpo(src.email).toLowerCase();
    if (email.length > 200 || !EMAIL_RE.test(email)) return erro('email', 'Confira o e-mail.');
    values.email = email;
  }

  const temEndereco = CAMPOS_DO_ENDERECO.some((k) => textoLimpo(src[k]));
  if (temEndereco) {
    const addrBody = {};
    for (const k of CAMPOS_DO_ENDERECO) addrBody[k] = src[k] === undefined ? null : src[k];
    const addr = parseCustomerAddress(addrBody);
    if (!addr.ok) return erro(addr.field, addr.error);
    values.address = {};
    for (const k of CAMPOS_DO_ENDERECO) values.address[k] = addr.values[k] === undefined ? null : addr.values[k];
  }

  return { ok: true, values, consentVersion: versao };
}

// ─── Junção com o cadastro que já existe ─────────────────────

// Igualdade "de gente": sem diferença de maiúscula, acento ou espaço.
function chaveDeTexto(v) {
  const s = textoLimpo(v);
  if (!s) return '';
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function isoDe(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    // Coluna `date` chega do pg como meia-noite LOCAL do processo.
    const y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function vazio(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function enderecoAtual(row) {
  const out = {};
  for (const k of CAMPOS_DO_ENDERECO) out[k] = vazio(row[k]) ? null : row[k];
  return out;
}

/**
 * Decide o que grava direto e o que vira pendência.
 *
 * @param {object} atual    linha de customers (name, birth_date, cpf_cnpj, phone, email, endereço)
 * @param {object} recebido values de lerFormulario
 * @param {{placeholderName?: string|null}} [opts]
 * @returns {{set: Object<string, any>, filled: string[], pending: Object<string, any>}}
 *   set: coluna -> valor (UPDATE direto); filled: blocos preenchidos;
 *   pending: bloco -> valor recebido (address é o bloco inteiro).
 */
function planejarGravacao(atual, recebido, opts) {
  const row = atual || {};
  const placeholder = opts && opts.placeholderName ? opts.placeholderName : null;
  const set = {};
  const filled = [];
  const pending = {};

  // Nome: o provisório do cliente criado pelo link conta como vazio.
  if (recebido.name !== undefined) {
    const nomeAtual = placeholder && row.name === placeholder ? null : row.name;
    if (vazio(nomeAtual)) { set.name = recebido.name; filled.push('name'); }
    else if (chaveDeTexto(nomeAtual) !== chaveDeTexto(recebido.name)) pending.name = recebido.name;
  }

  if (recebido.birth_date !== undefined) {
    const isoAtual = isoDe(row.birth_date);
    // 1904 é o "sem ano" das importações (e da ótica desde a #1361): mesmo
    // dia e mês com o ano de verdade é completar, não divergir.
    const semAno = isoAtual && isoAtual.startsWith('1904-') && isoAtual.slice(5) === recebido.birth_date.slice(5);
    if (!isoAtual || semAno) {
      if (isoAtual !== recebido.birth_date) { set.birth_date = recebido.birth_date; filled.push('birth_date'); }
    } else if (isoAtual !== recebido.birth_date) pending.birth_date = recebido.birth_date;
  }

  if (recebido.cpf_cnpj !== undefined) {
    const docAtual = String(row.cpf_cnpj || '').replace(/\D/g, '');
    if (!docAtual) { set.cpf_cnpj = recebido.cpf_cnpj; filled.push('cpf_cnpj'); }
    else if (docAtual !== recebido.cpf_cnpj) pending.cpf_cnpj = recebido.cpf_cnpj;
  }

  if (recebido.phone !== undefined) {
    if (vazio(row.phone)) { set.phone = recebido.phone; filled.push('phone'); }
    else if (!mesmoTelefone(row.phone, recebido.phone)) pending.phone = recebido.phone;
  }

  if (recebido.email !== undefined) {
    if (vazio(row.email)) { set.email = recebido.email; filled.push('email'); }
    else if (chaveDeTexto(row.email) !== chaveDeTexto(recebido.email)) pending.email = recebido.email;
  }

  // Endereço é UM bloco: misturar a rua nova com o número antigo daria um
  // endereço que não existe.
  if (recebido.address) {
    const cur = enderecoAtual(row);
    const semEndereco = CAMPOS_DO_ENDERECO.every((k) => cur[k] === null);
    if (semEndereco) {
      for (const k of CAMPOS_DO_ENDERECO) set[k] = recebido.address[k];
      filled.push('address');
    } else {
      const igual = CAMPOS_DO_ENDERECO.every((k) => {
        if (recebido.address[k] === null) return true; // não mandou: não diverge
        if (k === 'zip_code') return String(cur[k] || '').replace(/\D/g, '') === recebido.address[k];
        return chaveDeTexto(cur[k]) === chaveDeTexto(recebido.address[k]);
      });
      if (!igual) pending.address = recebido.address;
    }
  }

  return { set, filled, pending };
}

/** Colunas que aceitar uma pendência grava. */
function colunasDaPendencia(bloco, valor) {
  if (bloco === 'address') {
    const out = {};
    for (const k of CAMPOS_DO_ENDERECO) out[k] = valor && valor[k] !== undefined ? valor[k] : null;
    return out;
  }
  return { [bloco]: valor };
}

/** Valor atual do bloco, para o lojista comparar. */
function valorAtualDoBloco(row, bloco) {
  if (!row) return null;
  if (bloco === 'address') return enderecoAtual(row);
  if (bloco === 'birth_date') return isoDe(row.birth_date);
  return vazio(row[bloco]) ? null : row[bloco];
}

/** Estado do link para a ficha e o Caixa. */
function estadoDoLink(link, agora) {
  if (!link) return null;
  const now = agora || new Date();
  if (link.used_at) return 'recebido';
  if (link.revoked_at) return 'substituido';
  if (new Date(link.expires_at).getTime() <= now.getTime()) return 'vencido';
  return 'enviado';
}

module.exports = {
  VALIDADE_DIAS,
  CAMPOS_DO_ENDERECO,
  ROTULOS,
  BLOCOS,
  gerarToken,
  hashToken,
  tokenComFormato,
  lerFormulario,
  planejarGravacao,
  colunasDaPendencia,
  valorAtualDoBloco,
  estadoDoLink,
  dataDeNascimento,
};
