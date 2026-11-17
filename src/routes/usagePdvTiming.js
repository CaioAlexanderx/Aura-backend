// ============================================================
// AURA. — Tempos da venda no Caixa, medidos no app (p-151, 17/11/2026)
//
// POST /usage/pdv-timing — o app manda, quando a próxima venda começa, os
// tempos da venda anterior (migration 455):
//
// Body: { timings: [{ id, at, sale_id, atendimento_ms, espera_ms, ocioso_ms,
//                     itens, entrada, ok }] }
//   id        gerado pelo app, único por venda — reenvio não duplica
//   at        quando a venda foi finalizada (ISO), até 7 dias atrás
//   *_ms      inteiros de 0 a 6 h (fora disso vira null)
//   entrada   'leitor' | 'grade' | 'busca' | 'misto' (outra coisa vira null)
//   No máximo 50 itens por chamada.
//
// Sem dado de cliente final. Empresa e usuário vêm do token. É telemetria:
// nunca derruba o app — payload estranho responde 400; staff em modo
// admin, token sem empresa e tabela ainda não criada (42P01) respondem 200
// com gravadas: 0.
// ============================================================
'use strict';

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const MAX_ITENS = 50;
const JANELA_PASSADO_MS = 7 * 86400000;
const TOLERANCIA_FUTURO_MS = 10 * 60 * 1000;
const TETO_MS = 6 * 3600 * 1000;
const ENTRADAS = new Set(['leitor', 'grade', 'busca', 'misto']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const texto = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const duracao = (v) => (Number.isFinite(v) && v >= 0 && v <= TETO_MS ? Math.round(v) : null);

function normalizarTempos(body, agora = Date.now()) {
  const lista = body && body.timings;
  if (!Array.isArray(lista)) return { erro: 'timings deve ser uma lista' };
  if (lista.length > MAX_ITENS) return { erro: `timings aceita no máximo ${MAX_ITENS} itens por chamada` };
  const itens = [];
  const vistos = new Set();
  for (const t of lista) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return { erro: 'item inválido em timings' };
    const id = texto(t.id, 64);
    if (!id) return { erro: 'id é obrigatório' };
    const ms = typeof t.at === 'string' || typeof t.at === 'number' ? new Date(t.at).getTime() : NaN;
    if (Number.isNaN(ms)) return { erro: 'at inválido' };
    if (ms < agora - JANELA_PASSADO_MS) continue; // antiga demais: descarta sem erro
    if (vistos.has(id)) continue;
    vistos.add(id);
    itens.push({
      client_id: id,
      sale_id: typeof t.sale_id === 'string' && UUID.test(t.sale_id) ? t.sale_id : null,
      ocorreu_em: new Date(ms > agora + TOLERANCIA_FUTURO_MS ? agora : ms).toISOString(),
      atendimento_ms: duracao(t.atendimento_ms),
      espera_ms: duracao(t.espera_ms),
      ocioso_ms: duracao(t.ocioso_ms),
      itens: Number.isInteger(t.itens) && t.itens >= 0 && t.itens <= 10000 ? t.itens : null,
      entrada: ENTRADAS.has(t.entrada) ? t.entrada : null,
      ok: t.ok === true ? true : (t.ok === false ? false : null),
    });
  }
  return { itens };
}

const SQL = `INSERT INTO pdv_sale_timings
       (company_id, user_id, client_id, sale_id, ocorreu_em, atendimento_ms, espera_ms, ocioso_ms, itens, entrada, ok, user_agent)
     SELECT $1::uuid, $2::uuid, x.client_id, x.sale_id, x.ocorreu_em, x.atendimento_ms, x.espera_ms, x.ocioso_ms,
            x.itens, x.entrada, x.ok, $4
       FROM jsonb_to_recordset($3::jsonb) AS x(client_id text, sale_id uuid, ocorreu_em timestamptz,
                                               atendimento_ms int, espera_ms int, ocioso_ms int,
                                               itens int, entrada text, ok boolean)
     ON CONFLICT (company_id, client_id) DO NOTHING`;

router.post('/pdv-timing', requireAuth, asyncHandler(async (req, res) => {
  const { erro, itens } = normalizarTempos(req.body);
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
    // 42P01: migration 455 ainda não aplicada. 23503/22P02: empresa/usuário
    // do token inválido. Telemetria nunca vira erro para o app.
    if (err && ['42P01', '23503', '22P02'].includes(err.code)) {
      return res.json({ ok: true, gravadas: 0, motivo: 'indisponivel' });
    }
    throw err;
  }
}));

module.exports = router;
module.exports.normalizarTempos = normalizarTempos;
module.exports.MAX_ITENS = MAX_ITENS;
