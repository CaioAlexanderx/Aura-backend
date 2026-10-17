// ============================================================
// AURA. — Telas visitadas (13/10/2026)
//
// POST /usage/screens — o app manda, em lotes, quantas vezes cada tela foi
// aberta. Alimenta o bloco "Telas visitadas" do painel da Gestão Aura
// (services/painelBlocos/telas_visitadas.js), que cobre o que as tabelas dos
// módulos não mostram: telas só de leitura.
//
// Body: { views: [{ screen, count, first_at, last_at }] }
//   screen  nome da rota do expo-router ("pdv", "estoque", "crediario"…),
//           até 64 caracteres
//   count   visitas no lote (inteiro, 1..10000)
//   last_at quando foi a última visita do lote (ISO). Define o dia (Brasília)
//           e é o que torna o reenvio seguro — ver abaixo.
//   apos_login  (opcional, 17/10/2026) quantas das `count` visitas foram a
//           PRIMEIRA tela aberta logo depois de entrar (login/cadastro), e não
//           um retorno do usuário à tela. Inteiro 0..count; ausente = 0. O
//           `count` continua sendo o total (login + retorno): quem já lia
//           `views` não muda. Retorno = views - views_login.
//   No máximo 50 itens por chamada.
//
// Empresa e usuário vêm do token, nunca do body.
//
// IDEMPOTÊNCIA: a linha é (empresa, usuário, tela, dia). Um lote só soma se
// o last_at dele for MAIOR que o já gravado; o mesmo lote reenviado (rede
// caiu, app repetiu) tem o mesmo last_at e não soma de novo.
//
// É telemetria: nunca derruba o app. Payload estranho responde 400; token
// sem empresa, staff em modo admin e tabela ainda não criada respondem 200
// com gravadas: 0.
// ============================================================
'use strict';

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const MAX_ITENS = 50;
const MAX_SCREEN = 64;
const MAX_COUNT = 10000;
// Relógio do aparelho adiantado: até aqui aceita, além disso usa o do servidor.
const TOLERANCIA_FUTURO_MS = 10 * 60 * 1000;
const JANELA_PASSADO_MS = 35 * 86400000;

const diaBRT = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);

// Valida e junta o lote. Devolve { erro } ou { itens }.
function normalizarViews(body, agora = Date.now()) {
  const views = body && body.views;
  if (!Array.isArray(views)) return { erro: 'views deve ser uma lista' };
  if (views.length > MAX_ITENS) return { erro: `views aceita no máximo ${MAX_ITENS} itens por chamada` };

  const juntos = new Map();
  for (const v of views) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { erro: 'item inválido em views' };
    if (typeof v.screen !== 'string') return { erro: 'screen deve ser texto' };
    const screen = v.screen.trim();
    if (!screen || screen.length > MAX_SCREEN) return { erro: `screen deve ter de 1 a ${MAX_SCREEN} caracteres` };
    if (!Number.isInteger(v.count) || v.count < 1 || v.count > MAX_COUNT) {
      return { erro: `count deve ser um inteiro de 1 a ${MAX_COUNT}` };
    }

    let last = agora;
    const informado = v.last_at !== undefined && v.last_at !== null ? v.last_at : v.first_at;
    if (informado !== undefined && informado !== null) {
      const ms = typeof informado === 'string' || typeof informado === 'number' ? new Date(informado).getTime() : NaN;
      if (Number.isNaN(ms)) return { erro: 'last_at inválido' };
      if (ms < agora - JANELA_PASSADO_MS) return { erro: 'last_at antigo demais' };
      last = ms > agora + TOLERANCIA_FUTURO_MS ? agora : ms;
    }

    // apos_login: ausente/nulo = 0. Não pode passar do count do próprio item.
    let aposLogin = 0;
    if (v.apos_login !== undefined && v.apos_login !== null) {
      if (!Number.isInteger(v.apos_login) || v.apos_login < 0 || v.apos_login > v.count) {
        return { erro: 'apos_login deve ser um inteiro de 0 até count' };
      }
      aposLogin = v.apos_login;
    }

    const dia = diaBRT(last);
    const k = `${screen}|${dia}`;
    const g = juntos.get(k);
    if (g) {
      g.views = Math.min(g.views + v.count, MAX_COUNT);
      g.views_login = Math.min(g.views_login + aposLogin, g.views);
      if (last > g.ms) { g.ms = last; g.last_at = new Date(last).toISOString(); }
    } else {
      juntos.set(k, { screen, dia, views: v.count, views_login: aposLogin, ms: last, last_at: new Date(last).toISOString() });
    }
  }
  // views_login só vai no item quando > 0: lote sem origem tem exatamente o
  // formato de antes (e usa o SQL de antes, que não depende da coluna).
  return {
    itens: [...juntos.values()].map(({ ms, views_login, ...item }) => (views_login > 0 ? { ...item, views_login } : item)),
  };
}

const SQL_BASE = `INSERT INTO screen_views (company_id, user_id, screen, dia, views, last_at)
       SELECT $1::uuid, $2::uuid, x.screen, x.dia, x.views, x.last_at
         FROM jsonb_to_recordset($3::jsonb) AS x(screen text, dia date, views int, last_at timestamptz)
       ON CONFLICT (company_id, user_id, screen, dia) DO UPDATE SET
         views = screen_views.views + EXCLUDED.views,
         last_at = EXCLUDED.last_at
       WHERE EXCLUDED.last_at > screen_views.last_at`;

// Lote com visitas vindas do login (migration 389): mesma regra de
// idempotência, e views_login soma junto com views.
const SQL_COM_ORIGEM = `INSERT INTO screen_views (company_id, user_id, screen, dia, views, last_at, views_login)
       SELECT $1::uuid, $2::uuid, x.screen, x.dia, x.views, x.last_at, COALESCE(x.views_login, 0)
         FROM jsonb_to_recordset($3::jsonb) AS x(screen text, dia date, views int, last_at timestamptz, views_login int)
       ON CONFLICT (company_id, user_id, screen, dia) DO UPDATE SET
         views = screen_views.views + EXCLUDED.views,
         views_login = screen_views.views_login + EXCLUDED.views_login,
         last_at = EXCLUDED.last_at
       WHERE EXCLUDED.last_at > screen_views.last_at`;

router.post('/screens', requireAuth, asyncHandler(async (req, res) => {
  const { erro, itens } = normalizarViews(req.body);
  if (erro) return res.status(400).json({ error: erro });

  const companyId = req.user.company || null;
  // Staff em modo admin não é uso do cliente; visão consolidada não tem
  // empresa no token.
  if (!companyId || req.user.role === 'admin') {
    return res.json({ ok: true, gravadas: 0, motivo: companyId ? 'staff' : 'sem_empresa' });
  }
  if (!itens.length) return res.json({ ok: true, gravadas: 0 });

  try {
    const temOrigem = itens.some((i) => i.views_login > 0);
    let rowCount;
    try {
      ({ rowCount } = await pool.query(temOrigem ? SQL_COM_ORIGEM : SQL_BASE,
        [companyId, req.user.id, JSON.stringify(itens)]));
    } catch (err) {
      // 42703: migration 389 (views_login) ainda não aplicada. A visita conta
      // do mesmo jeito, só sem a marca de origem — telemetria não se perde
      // por causa de coluna nova.
      if (!(temOrigem && err && err.code === '42703')) throw err;
      ({ rowCount } = await pool.query(SQL_BASE, [companyId, req.user.id, JSON.stringify(itens)]));
    }
    res.json({ ok: true, gravadas: rowCount || 0 });
  } catch (err) {
    // 42P01: tabela ainda não criada. 23503: empresa/usuário do token já não
    // existe. 22P02: id do token fora do formato. Nada disso é erro do app.
    if (err && ['42P01', '23503', '22P02'].includes(err.code)) {
      return res.json({ ok: true, gravadas: 0, motivo: 'indisponivel' });
    }
    throw err;
  }
}));

module.exports = router;
module.exports.normalizarViews = normalizarViews;
module.exports.MAX_ITENS = MAX_ITENS;
