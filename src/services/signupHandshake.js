// ============================================================
// AURA. — Handshake pelo WhatsApp no cadastro (porta de entrada 1/5, tq-66)
//
// A conta nova de varejo ganha um código AURA-XXXX (signup_handshakes,
// migration 402). O app mostra o código e o botão "mandar no WhatsApp"
// (link wa.me pronto, services/whatsappCadastro). Quando a mensagem chega, a
// equipe confirma.
//
// HOJE NÃO HÁ CONFIRMAÇÃO AUTOMÁTICA: o número da Aura (5511956305269) não
// está na API do WhatsApp, então não existe webhook de mensagem recebida para
// ele. A confirmação é manual, pela equipe (POST /admin/painel/handshakes/
// :codigo/confirmar, ou o "Registrar contato" com confirma_whatsapp). O app
// não tem como "esperar a mensagem chegar": o estado nasce 'aguardando' e
// só muda pela mão da equipe. confirmarHandshake já aceita via='whatsapp'
// para o webhook chamar quando o número entrar na API.
//
// A CONTA NUNCA É BLOQUEADA PELO HANDSHAKE: criarHandshake roda atrás de
// SAVEPOINT e qualquer erro (tabela ausente, colisão repetida) devolve null
// e o cadastro segue.
// ============================================================
'use strict';

const crypto = require('crypto');
const whatsapp = require('./whatsappCadastro');

// Sem 0/O, 1/I/L: o código é lido e digitado por gente.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODIGO_RE = /^AURA-[A-Z0-9]{4}$/;
const TENTATIVAS = 5;

function gerarCodigo(sortear = crypto.randomInt) {
  let s = '';
  for (let i = 0; i < 4; i += 1) s += ALFABETO[sortear(ALFABETO.length)];
  return `AURA-${s}`;
}

function normalizarCodigo(v) {
  if (typeof v !== 'string') return null;
  const c = v.trim().toUpperCase();
  return CODIGO_RE.test(c) ? c : null;
}

// O que vai para o app e para o painel. confirmacao_automatica é sempre
// false enquanto o número da Aura não estiver na API (ver cabeçalho).
function moldar(row, env = process.env) {
  if (!row) return null;
  return {
    codigo: row.codigo,
    estado: row.estado,
    whatsapp: row.whatsapp,
    whatsapp_aura: whatsapp.numeroDaAura(env),
    link: whatsapp.linkDoHandshake(row.codigo, env),
    confirmacao_automatica: false,
    confirmado_em: row.confirmado_em || null,
    confirmado_via: row.confirmado_via || null,
    criado_em: row.criado_em || null,
  };
}

/**
 * Dentro da transação do cadastro. Devolve a linha criada ou null. Nunca lança.
 */
async function criarHandshake(client, { companyId, userId, whatsapp: numero }, sortear) {
  if (!client || !companyId || !numero) return null;
  for (let i = 0; i < TENTATIVAS; i += 1) {
    const codigo = gerarCodigo(sortear);
    try {
      await client.query('SAVEPOINT signup_handshake');
      const { rows } = await client.query(
        `INSERT INTO signup_handshakes (company_id, user_id, codigo, whatsapp)
         VALUES ($1, $2, $3, $4)
         RETURNING id, codigo, whatsapp, estado, confirmado_em, confirmado_via, criado_em`,
        [companyId, userId || null, codigo, numero]
      );
      await client.query('RELEASE SAVEPOINT signup_handshake');
      return rows[0] || null;
    } catch (err) {
      try { await client.query('ROLLBACK TO SAVEPOINT signup_handshake'); } catch (_) { /* segue com o chamador */ }
      // Código repetido: sorteia outro.
      if (err && err.code === '23505') continue;
      // 42P01 = migration 402 ainda não rodou: cadastro sem handshake.
      if (!(err && err.code === '42P01')) {
        console.warn('[register] handshake do WhatsApp não criado:', err && err.message);
      }
      return null;
    }
  }
  console.warn('[register] handshake do WhatsApp não criado: código repetido em todas as tentativas');
  return null;
}

/**
 * Confirma o handshake. Chamada pela equipe (via='staff', confirmadoPor = id
 * do usuário) e, quando o número entrar na API, pelo webhook (via='whatsapp').
 * Alvo: { codigo } ou { companyId } (o mais recente aguardando da empresa).
 * Devolve { handshake, ja_confirmado } ou null (não encontrado).
 */
async function confirmarHandshake(db, { codigo, companyId, confirmadoPor = null, via = 'staff' }) {
  const viaOk = via === 'whatsapp' ? 'whatsapp' : 'staff';
  const cod = codigo ? normalizarCodigo(codigo) : null;
  if (!cod && !companyId) return null;
  const alvo = cod ? 'codigo = $1' : `id = (SELECT id FROM signup_handshakes
                                           WHERE company_id = $1 AND estado = 'aguardando'
                                           ORDER BY criado_em DESC LIMIT 1)`;
  const { rows } = await db.query(
    `-- handshake:confirmar
     UPDATE signup_handshakes
        SET estado = 'confirmado', confirmado_em = NOW(), confirmado_por = $2, confirmado_via = $3
      WHERE ${alvo} AND estado = 'aguardando'
      RETURNING id, company_id, codigo, whatsapp, estado, confirmado_em, confirmado_via, criado_em`,
    [cod || companyId, confirmadoPor, viaOk]
  );
  if (rows.length) return { handshake: rows[0], ja_confirmado: false };

  const { rows: atual } = await db.query(
    `-- handshake:atual
     SELECT id, company_id, codigo, whatsapp, estado, confirmado_em, confirmado_via, criado_em
       FROM signup_handshakes
      WHERE ${cod ? 'codigo = $1' : 'company_id = $1'}
      ORDER BY criado_em DESC LIMIT 1`,
    [cod || companyId]
  );
  if (!atual.length) return null;
  return { handshake: atual[0], ja_confirmado: atual[0].estado === 'confirmado' };
}

// O mais recente da empresa (ficha da Gestão Aura). Sem a tabela: null.
async function doCliente(db, companyId) {
  try {
    const { rows } = await db.query(
      `-- handshake:ficha
       SELECT id, codigo, whatsapp, estado, confirmado_em, confirmado_via, criado_em
         FROM signup_handshakes WHERE company_id = $1
        ORDER BY criado_em DESC LIMIT 1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) return null;
    throw err;
  }
}

module.exports = {
  gerarCodigo, normalizarCodigo, moldar, criarHandshake, confirmarHandshake, doCliente,
  ALFABETO, CODIGO_RE,
};
