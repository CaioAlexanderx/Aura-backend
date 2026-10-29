// ============================================================
// AURA. — Job: checagem diária das conexões do Mercado Pago (tq-94)
//
// Criado: 29/10/2026
//
// Para cada loja conectada por OAuth (connection_status = 'ok'):
//   1. faltando menos de 30 dias para o token vencer (180 dias no Mercado
//      Pago) → renova. Recusa da renovação (invalid_grant) = conexão caiu.
//   2. senão → GET /users/me com o token da loja. 401/403 = autorização
//      retirada dentro do Mercado Pago → conexão caiu. Atualiza o nome da
//      conta de "Conectado como" se mudou.
// Erro de rede ou 5xx do Mercado Pago não derruba ninguém: tenta amanhã.
//
// Conexão caída sai do checkout na hora (services/mpGateway.temGatewayAtivo
// filtra connection_status = 'ok'): a loja para de oferecer cartão e Pix do
// Mercado Pago antes da primeira venda perdida. Pix pela chave e pagamento
// na entrega seguem se estiverem ligados.
//
// `aoCair` recebe cada queda nova (uma vez por queda — marcarCaiu só devolve
// true na transição ok → caiu). O e-mail "a conexão caiu" (tq-109) entra aí.
//
// Diário a partir das 06h20 BRT, trava por data. Kill switch
// MP_CONEXAO_DIARIA_ENABLED=false. Dormente sem o OAuth configurado.
// ============================================================
'use strict';

const db        = require('../config/database');
const mpOAuth   = require('../services/mpOAuth');
const mpGateway = require('../services/mpGateway');

const RENOVAR_ANTES_MS = 30 * 24 * 3600 * 1000;
const LOTE = 200;

function habilitado() {
  return String(process.env.MP_CONEXAO_DIARIA_ENABLED || 'true').toLowerCase() !== 'false';
}

const _aoCair = [];
/** Registra quem quer saber de cada queda nova: fn({ gateway_id, company_id, motivo }). */
function aoCair(fn) { if (typeof fn === 'function') _aoCair.push(fn); }

async function avisarQueda(evento) {
  for (const fn of _aoCair) {
    try { await fn(evento); } catch (e) { console.error('[mpConexaoDiaria] aviso de queda falhou:', e.message); }
  }
}

/**
 * Uma rodada. Deps injetáveis para teste.
 * @returns {Promise<{checadas:number, renovadas:number, caidas:number, erros:number}|null>}
 */
async function checarConexoes({ db: banco = db, agora = Date.now() } = {}) {
  if (!mpOAuth.oauthDisponivel()) return null;
  const resumo = { checadas: 0, renovadas: 0, caidas: 0, erros: 0 };

  let rows;
  try {
    ({ rows } = await banco.query(
      `SELECT id, company_id, access_token, refresh_token, token_expires_at,
              auth_method, connection_status, mp_nickname
         FROM companies_payment_gateways
        WHERE gateway = 'mercadopago' AND auth_method = 'oauth' AND connection_status = 'ok'
        ORDER BY last_checked_at NULLS FIRST
        LIMIT $1`,
      [LOTE]
    ));
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return null; // migration 419 pendente
    throw e;
  }

  for (const row of rows) {
    resumo.checadas++;
    try {
      const expira = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
      if (expira - agora < RENOVAR_ANTES_MS) {
        const token = await mpGateway.renovar(banco, row);
        if (token) resumo.renovadas++;
        else {
          resumo.caidas++;
          await avisarQueda({ gateway_id: row.id, company_id: row.company_id, motivo: 'renovacao' });
        }
      } else {
        const me = await mpOAuth.getUserMe({ accessToken: mpGateway.abrir(row.access_token) });
        if (!me.ok && (me.status === 401 || me.status === 403)) {
          if (await mpGateway.marcarCaiu(banco, row.id, 'users_me:' + me.status)) {
            resumo.caidas++;
            await avisarQueda({ gateway_id: row.id, company_id: row.company_id, motivo: 'autorizacao' });
          }
          continue;
        }
        if (me.ok && me.nickname && me.nickname !== row.mp_nickname) {
          await banco.query(`UPDATE companies_payment_gateways SET mp_nickname = $2 WHERE id = $1`, [row.id, me.nickname]);
        }
      }
      await banco.query(`UPDATE companies_payment_gateways SET last_checked_at = NOW() WHERE id = $1`, [row.id]);
    } catch (e) {
      resumo.erros++;
      console.error(`[mpConexaoDiaria] gateway=${row.id}:`, e.message);
    }
  }

  if (resumo.checadas) console.log('[mpConexaoDiaria]', JSON.stringify(resumo));
  return resumo;
}

function nowBRT() { return new Date(Date.now() - 3 * 3600000); }

let _lastDate = null;
function tick() {
  if (!habilitado()) return;
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 6 && now.getUTCMinutes() >= 20 && now.getUTCMinutes() < 25 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    checarConexoes().catch((e) => console.error('[mpConexaoDiaria] crash:', e.message));
  }
}

let _interval = null;
function initMpConexaoDiariaJob() {
  if (_interval) return;
  if (!habilitado()) {
    console.log('[mpConexaoDiaria] desligado por MP_CONEXAO_DIARIA_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, 60 * 1000);
  if (_interval.unref) _interval.unref();
  console.log('[mpConexaoDiaria] scheduler iniciado — diario 06h20 BRT (renova token e confere a conexão do Mercado Pago)');
}

function stopMpConexaoDiariaJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initMpConexaoDiariaJob, stopMpConexaoDiariaJob, checarConexoes, aoCair,
  RENOVAR_ANTES_MS, _tick: tick,
};
