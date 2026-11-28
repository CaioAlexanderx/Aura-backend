// ============================================================
// AURA — Trava da Aurinha no WhatsApp (28/11/2026)
//
// Decisao do Caio: a primeira versao do WhatsApp sai SEM a Aurinha (a IA que
// responde as clientes); ainda ha teste a fazer. O codigo fica, desligado.
//
// Env AURINHA_WA_LIBERADA, desligada por padrao ('1' / 'true' / 'sim' / 'on'
// liga). Desligada, a Aurinha nao responde loja nenhuma, mesmo que a loja
// tenha ligado o interruptor antes, e o saldo "aurinha" nao e consumido.
//
// Passam, para teste: a propria Aura (AURA_COMPANY_ID) e empresa com
// companies.is_sandbox = true. A trava vale tambem com WA_HUB_LOJAS_LIGADO=1.
//
// Mesmo desenho do app (utils/aurinhaLiberada.ts).
// ============================================================
'use strict';

const db = require('../config/database');

const MOTIVO = 'AURINHA_NAO_LIBERADA';

function ligada() {
  return ['1', 'true', 'sim', 'on'].includes(String(process.env.AURINHA_WA_LIBERADA || '').trim().toLowerCase());
}

function ehAura(companyId) {
  const v = String(process.env.AURA_COMPANY_ID || '').trim();
  return !!v && !!companyId && String(companyId) === v;
}

// Empresa sandbox? Falha de leitura = nao (na duvida, a Aurinha fica calada).
async function ehSandbox(companyId) {
  if (!companyId) return false;
  try {
    const { rows } = await db.query('SELECT is_sandbox FROM companies WHERE id = $1 LIMIT 1', [companyId]);
    return !!rows[0] && rows[0].is_sandbox === true;
  } catch (e) {
    if (e && e.code !== '42703' && e.code !== '42P01') console.error('[aurinhaLiberada] is_sandbox:', e.code || '', e.message);
    return false;
  }
}

// A Aurinha pode atender esta empresa agora? Nunca lanca.
async function permitida(companyId) {
  if (ligada()) return true;
  if (ehAura(companyId)) return true;
  return ehSandbox(companyId);
}

// Pode LIGAR a Aurinha (PUT /hub/settings)? `user` e o req.user: equipe Aura
// (is_staff) tambem passa.
async function podeLigar(companyId, user) {
  if (user && user.is_staff === true) return true;
  return permitida(companyId);
}

module.exports = { MOTIVO, ligada, permitida, podeLigar };
