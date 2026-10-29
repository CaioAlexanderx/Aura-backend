// ============================================================
// AURA. — Gateway Mercado Pago da empresa (banco)
//
// Um lugar só para ler e gravar companies_payment_gateways. Antes, cada
// rota fazia o próprio SELECT access_token; com o OAuth (tq-94) o token pode
// estar cifrado, vencer e ser renovado, ou a conexão pode ter caído — e o
// checkout precisa parar de oferecer cartão e Pix do Mercado Pago na hora.
//
//   temGatewayAtivo(db, cid)   → boolean (sem decifrar; para has_card/has_pix)
//   gatewayAtivo(db, cid)      → { access_token (texto), public_key, ... } | null
//   tokenDoGateway(db, row)    → access_token em texto, renovando se preciso
//   salvarConexaoOAuth(...)    → upsert do retorno do OAuth
//   marcarCaiu(db, id, motivo) → true só na primeira vez (uma vez por queda)
//
// Registros manuais (token colado) continuam como sempre: texto puro, sem
// renovação. Antes da migration 417 as colunas novas não existem; tudo aqui
// cai no SELECT antigo (42703) e o comportamento é o de hoje.
// ============================================================
'use strict';

const { encryptString, decryptString, isEncrypted } = require('../utils/secretCrypto');
const mpOAuth = require('./mpOAuth');

// Renova na hora do uso quando faltam menos de 3 dias. O job diário renova
// com 30 dias de folga, então isto é só a rede de segurança.
const RENOVAR_NO_USO_MS = 3 * 24 * 3600 * 1000;

let _temColunas = null;
async function temColunasOAuth(db) {
  if (_temColunas !== null) return _temColunas;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'companies_payment_gateways' AND column_name = 'auth_method'`
    );
    _temColunas = rows.length > 0;
  } catch (_) { _temColunas = false; }
  return _temColunas;
}
function _resetCache() { _temColunas = null; _semColunas = false; }

function abrir(valor) {
  if (!valor) return null;
  return isEncrypted(valor) ? decryptString(valor) : valor;
}

const COLS_OAUTH = `id, company_id, gateway, access_token, public_key, sandbox, webhook_secret,
  auth_method, refresh_token, token_expires_at, mp_user_id, mp_nickname,
  connection_status, connection_lost_at, last_checked_at, created_at, updated_at`;

// Sem a migration 417 as colunas novas não existem: a primeira consulta que
// der 42703 liga este marcador e as próximas vão direto no SELECT antigo.
// (Sem consulta extra ao information_schema: o checkout faz uma consulta só,
// como antes.)
let _semColunas = false;

/** Linha crua do gateway MP da empresa (inclui a conexão caída). */
async function carregarGateway(db, companyId) {
  if (!_semColunas) {
    try {
      const { rows } = await db.query(
        `SELECT ${COLS_OAUTH} FROM companies_payment_gateways
          WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
        [companyId]
      );
      return rows[0] || null;
    } catch (e) {
      if (e.code !== '42703') throw e;
      _semColunas = true;
    }
  }
  const { rows } = await db.query(
    `SELECT id, company_id, gateway, access_token, public_key, sandbox, created_at, updated_at
       FROM companies_payment_gateways
      WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
    [companyId]
  );
  return rows[0] ? { ...rows[0], auth_method: 'manual', connection_status: 'ok' } : null;
}

/** has_card / has_pix: existe gateway e a conexão não caiu. */
async function temGatewayAtivo(db, companyId) {
  try {
    if (!_semColunas) {
      try {
        const { rows } = await db.query(
          `SELECT id FROM companies_payment_gateways
            WHERE company_id = $1 AND gateway = 'mercadopago'
              AND connection_status = 'ok' LIMIT 1`,
          [companyId]
        );
        return rows.length > 0;
      } catch (e) {
        if (e.code !== '42703') throw e;
        _semColunas = true;
      }
    }
    const { rows } = await db.query(
      `SELECT id FROM companies_payment_gateways WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
      [companyId]
    );
    return rows.length > 0;
  } catch (_) {
    return false; // tabela pode não existir em deployment antigo
  }
}

/**
 * Marca a conexão como caída. Devolve true só quando mudou de 'ok' para
 * 'caiu' — quem chama dispara o aviso uma vez por queda (tq-109).
 */
async function marcarCaiu(db, gatewayId, motivo) {
  try {
    const { rowCount } = await db.query(
      `UPDATE companies_payment_gateways
          SET connection_status = 'caiu',
              connection_lost_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND connection_status = 'ok'`,
      [gatewayId]
    );
    if (rowCount > 0) console.warn(`[mpGateway] conexão caiu (gateway=${gatewayId}, motivo=${motivo || '?'})`);
    return rowCount > 0;
  } catch (e) {
    if (e.code === '42703') return false;
    throw e;
  }
}

/**
 * Renova o token OAuth. Otimista: grava só se o refresh_token no banco ainda
 * é o que usamos (outra instância pode ter renovado antes). Se o Mercado Pago
 * recusar (invalid_grant), relê a linha: se outra instância já renovou,
 * usa o token novo; senão marca a conexão como caída.
 * @returns {Promise<string|null>} access_token em texto, ou null se caiu
 */
async function renovar(db, row) {
  const rtAtual = row.refresh_token;
  let novo;
  try {
    novo = await mpOAuth.refreshToken({ refreshToken: abrir(rtAtual) });
  } catch (e) {
    if (!e.revogado) throw e;
    const { rows } = await db.query(
      `SELECT access_token, refresh_token, token_expires_at FROM companies_payment_gateways WHERE id = $1`,
      [row.id]
    );
    const r = rows[0];
    if (r && r.refresh_token !== rtAtual && new Date(r.token_expires_at).getTime() > Date.now()) {
      return abrir(r.access_token);
    }
    await marcarCaiu(db, row.id, 'refresh:' + (e.mpError || e.status));
    return null;
  }
  const { rowCount } = await db.query(
    `UPDATE companies_payment_gateways
        SET access_token = $2,
            refresh_token = $3,
            public_key = COALESCE($4, public_key),
            token_expires_at = $5,
            connection_status = 'ok',
            connection_lost_at = NULL,
            updated_at = NOW()
      WHERE id = $1 AND refresh_token IS NOT DISTINCT FROM $6`,
    [
      row.id,
      encryptString(novo.access_token),
      novo.refresh_token ? encryptString(novo.refresh_token) : rtAtual,
      novo.public_key,
      novo.expires_at,
      rtAtual,
    ]
  );
  if (rowCount === 0) {
    // Outra instância renovou no meio do caminho; o token dela vale.
    const { rows } = await db.query(`SELECT access_token FROM companies_payment_gateways WHERE id = $1`, [row.id]);
    return rows[0] ? abrir(rows[0].access_token) : null;
  }
  return novo.access_token;
}

/**
 * access_token em texto para chamar o Mercado Pago com a conta da loja.
 * Manual: devolve como está. OAuth: decifra e renova se estiver perto de vencer.
 */
async function tokenDoGateway(db, row, { janelaMs = RENOVAR_NO_USO_MS } = {}) {
  if (!row) return null;
  if (row.auth_method !== 'oauth') return row.access_token || null;
  if (row.connection_status === 'caiu') return null;
  const expira = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  if (row.refresh_token && expira - Date.now() < janelaMs && mpOAuth.oauthDisponivel()) {
    try {
      return await renovar(db, row);
    } catch (e) {
      console.error('[mpGateway] renovação falhou:', e.message);
      // Ainda válido? usa o atual; vencido, não há o que fazer agora.
      return expira > Date.now() ? abrir(row.access_token) : null;
    }
  }
  return abrir(row.access_token);
}

/** Gateway pronto para cobrar: conexão ok e token em texto. */
async function gatewayAtivo(db, companyId) {
  let row;
  try { row = await carregarGateway(db, companyId); }
  catch (_) { return null; } // tabela pode não existir em deployment antigo
  if (!row || row.connection_status === 'caiu') return null;
  let token;
  try { token = await tokenDoGateway(db, row); }
  catch (e) {
    console.error('[mpGateway] token ilegível:', e.message);
    return null;
  }
  if (!token) return null;
  return { ...row, access_token: token, refresh_token: undefined };
}

/** Grava (ou troca) a conexão por OAuth da empresa. */
async function salvarConexaoOAuth(db, { companyId, userId, tokens, nickname, sandbox }) {
  const { rows } = await db.query(
    `INSERT INTO companies_payment_gateways
       (company_id, gateway, access_token, public_key, sandbox, webhook_secret,
        auth_method, refresh_token, token_expires_at, mp_user_id, mp_nickname,
        connection_status, connection_lost_at, last_checked_at, connected_by)
     VALUES ($1, 'mercadopago', $2, $3, $4, NULL,
        'oauth', $5, $6, $7, $8,
        'ok', NULL, NOW(), $9)
     ON CONFLICT (company_id, gateway) DO UPDATE SET
       access_token       = EXCLUDED.access_token,
       public_key         = EXCLUDED.public_key,
       sandbox            = EXCLUDED.sandbox,
       webhook_secret     = NULL,
       auth_method        = 'oauth',
       refresh_token      = EXCLUDED.refresh_token,
       token_expires_at   = EXCLUDED.token_expires_at,
       mp_user_id         = EXCLUDED.mp_user_id,
       mp_nickname        = EXCLUDED.mp_nickname,
       connection_status  = 'ok',
       connection_lost_at = NULL,
       last_checked_at    = NOW(),
       connected_by       = EXCLUDED.connected_by,
       updated_at         = NOW()
     RETURNING id`,
    [
      companyId,
      encryptString(tokens.access_token),
      tokens.public_key || '',
      !!sandbox,
      tokens.refresh_token ? encryptString(tokens.refresh_token) : null,
      tokens.expires_at,
      tokens.user_id,
      nickname || null,
      userId || null,
    ]
  );
  _resetCache();
  return rows[0];
}

module.exports = {
  RENOVAR_NO_USO_MS,
  temColunasOAuth, carregarGateway, temGatewayAtivo, gatewayAtivo,
  tokenDoGateway, renovar, marcarCaiu, salvarConexaoOAuth, abrir,
  _resetCache,
};
