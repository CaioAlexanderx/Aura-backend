// ============================================================
// AURA. — Falhas de conexão relatadas pelo app (14/11/2026)
//
// POST /usage/connection-failures — quando o app fica sem resposta do
// servidor ("Não conseguimos falar com a Aura agora"), o pedido nem chega
// aqui e não deixa rastro nos logs. O app anota cada falha e manda o lote
// assim que a conexão volta. Com isso o suporte sabe se foi a internet da
// loja (falhas com online=false, várias telas ao mesmo tempo, nenhum erro
// do nosso lado) ou algo nosso.
//
// Body: { failures: [{ id, at, method, path, code, screen, online, attempts }] }
//   id        gerado pelo app, único por falha — reenvio não duplica
//   at        quando aconteceu (ISO), até 7 dias atrás
//   method    GET/POST/...; path sem query string, até 200 caracteres
//   code      'network' (sem resposta) | 'timeout'
//   screen    rota do app no momento (até 64), online (bool|null), attempts
//   No máximo 50 itens por chamada.
//
// Empresa e usuário vêm do token. É telemetria: nunca derruba o app —
// payload estranho responde 400; staff em modo admin, token sem empresa e
// tabela ainda não criada (42P01) respondem 200 com gravadas: 0.
// ============================================================
'use strict';

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const MAX_ITENS = 50;
const JANELA_PASSADO_MS = 7 * 86400000;
const TOLERANCIA_FUTURO_MS = 10 * 60 * 1000;
const CODIGOS = new Set(['network', 'timeout']);
const METODOS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const texto = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function normalizarFalhas(body, agora = Date.now()) {
  const lista = body && body.failures;
  if (!Array.isArray(lista)) return { erro: 'failures deve ser uma lista' };
  if (lista.length > MAX_ITENS) return { erro: `failures aceita no máximo ${MAX_ITENS} itens por chamada` };
  const itens = [];
  const vistos = new Set();
  for (const f of lista) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { erro: 'item inválido em failures' };
    const id = texto(f.id, 64);
    if (!id) return { erro: 'id é obrigatório' };
    if (!CODIGOS.has(f.code)) return { erro: 'code deve ser network ou timeout' };
    const ms = typeof f.at === 'string' || typeof f.at === 'number' ? new Date(f.at).getTime() : NaN;
    if (Number.isNaN(ms)) return { erro: 'at inválido' };
    if (ms < agora - JANELA_PASSADO_MS) continue; // antiga demais: descarta sem erro
    if (vistos.has(id)) continue;
    vistos.add(id);
    const method = typeof f.method === 'string' && METODOS.has(f.method.toUpperCase()) ? f.method.toUpperCase() : null;
    const path = texto(f.path, 400);
    itens.push({
      client_id: id,
      ocorreu_em: new Date(ms > agora + TOLERANCIA_FUTURO_MS ? agora : ms).toISOString(),
      method,
      path: path ? path.split('?')[0].slice(0, 200) : null,
      code: f.code,
      screen: texto(f.screen, 64),
      online: f.online === true ? true : (f.online === false ? false : null),
      attempts: Number.isInteger(f.attempts) && f.attempts >= 0 && f.attempts <= 20 ? f.attempts : null,
    });
  }
  return { itens };
}

const SQL = `INSERT INTO connection_failures
       (company_id, user_id, client_id, ocorreu_em, method, path, code, screen, online, attempts, user_agent)
     SELECT $1::uuid, $2::uuid, x.client_id, x.ocorreu_em, x.method, x.path, x.code, x.screen, x.online, x.attempts, $4
       FROM jsonb_to_recordset($3::jsonb) AS x(client_id text, ocorreu_em timestamptz, method text, path text,
                                               code text, screen text, online boolean, attempts int)
     ON CONFLICT (company_id, client_id) DO NOTHING`;

router.post('/connection-failures', requireAuth, asyncHandler(async (req, res) => {
  const { erro, itens } = normalizarFalhas(req.body);
  if (erro) return res.status(400).json({ error: erro });
  const companyId = req.user.company || null;
  if (!companyId || req.user.role === 'admin') {
    return res.json({ ok: true, gravadas: 0, motivo: companyId ? 'staff' : 'sem_empresa' });
  }
  if (!itens.length) return res.json({ ok: true, gravadas: 0 });
  try {
    const ua = texto(req.headers['user-agent'], 300);
    const { rowCount } = await pool.query(SQL, [companyId, req.user.id, JSON.stringify(itens), ua]);
    res.json({ ok: true, gravadas: rowCount || 0 });
  } catch (err) {
    // 42P01: migration 451 ainda não aplicada. 23503/22P02: empresa/usuário
    // do token inválido. Telemetria nunca vira erro para o app.
    if (err && ['42P01', '23503', '22P02'].includes(err.code)) {
      return res.json({ ok: true, gravadas: 0, motivo: 'indisponivel' });
    }
    throw err;
  }
}));

module.exports = router;
module.exports.normalizarFalhas = normalizarFalhas;
module.exports.MAX_ITENS = MAX_ITENS;
