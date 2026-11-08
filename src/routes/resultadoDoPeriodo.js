// ============================================================
// AURA. — Resultado do período: Faturamento, Custos, Lucro bruto e Despesas
// (card p-81, 08/11/2026). Regras em services/resultadoDoPeriodo.js.
//
//   GET /companies/:id/financeiro/resultado?de=AAAA-MM-DD&ate=AAAA-MM-DD
//       [&anterior_de=...&anterior_ate=...]
//   GET /me/financeiro/resultado?de=...&ate=...   (consolidado multi-CNPJ)
//
// `start`/`end` também valem (os nomes que /transactions usa). Com
// anterior_de/anterior_ate, a resposta traz `anterior` com os mesmos
// números, para a tela mostrar a variação.
//
// Custo: quem não vê custo (estoque_consulta ou funcionário sem retaguarda,
// regra podeVerCusto do middleware estoqueSoConsulta) leva 403 — os quatro
// cartões são feitos de custo e margem. No consolidado vale a loja mais
// restrita: se em alguma loja do grupo a pessoa não vê custo, 403.
// ============================================================
'use strict';

const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { negarSemCusto, podeVerCusto } = require('../middleware/estoqueSoConsulta');
const R = require('../services/resultadoDoPeriodo');

function lerPeriodo(q) {
  const de = q.de || q.start;
  const ate = q.ate || q.end;
  const antDe = q.anterior_de || q.prevStart;
  const antAte = q.anterior_ate || q.prevEnd;
  const anterior = antDe && antAte ? { de: antDe, ate: antAte } : null;
  return { de, ate, anterior };
}

async function responder(res, empresas, periodo) {
  const [atual, anterior] = await Promise.all([
    R.resultadoDoPeriodo({ empresas, de: periodo.de, ate: periodo.ate }),
    periodo.anterior
      ? R.resultadoDoPeriodo({ empresas, de: periodo.anterior.de, ate: periodo.anterior.ate, comProdutos: false })
      : Promise.resolve(null),
  ]);
  atual.anterior = R.resumoParaComparar(anterior);
  res.set('Cache-Control', 'no-store');
  return res.json(atual);
}

function falhou(res, err, onde) {
  const status = err.statusCode || 500;
  if (status >= 500) console.error(`[resultadoDoPeriodo/${onde}] error:`, err.message);
  return res.status(status).json({
    error: status === 400 ? err.message : 'Não conseguimos calcular o resultado agora. Tente de novo em instantes.',
  });
}

// ── Por empresa (montado em /companies/:id/financeiro) ──────────
const companyRouter = express.Router({ mergeParams: true });

companyRouter.get('/resultado', negarSemCusto, async (req, res) => {
  try {
    return await responder(res, [{ id: req.params.id }], lerPeriodo(req.query));
  } catch (err) {
    return falhou(res, err, 'company');
  }
});

// ── Consolidado (montado em /me/financeiro) ─────────────────────
const meRouter = express.Router();
meRouter.use(requireAuth);

// Mesma regra de getUserCompanyIds / meAggregates.getUserCompanies (dono OU
// membro ativo, empresa ativa), com o papel e as permissões para o custo.
async function empresasDoUsuario(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id)
            c.id, COALESCE(c.trade_name, c.legal_name) AS nome, c.is_primary, c.created_at,
            (c.owner_id = $1) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true
      ORDER BY c.id, (c.owner_id = $1) DESC`,
    [userId]
  );
  rows.sort((a, b) => {
    if (a.is_primary && !b.is_primary) return -1;
    if (!a.is_primary && b.is_primary) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return rows;
}

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

meRouter.get('/resultado', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Não autenticado' });
    const empresas = await empresasDoUsuario(userId);
    const staff = req.user.role === 'admin';
    const semCusto = !staff && empresas.some((e) => !podeVerCusto({
      isOwner: e.is_owner, roleLabel: e.role_label, permissions: lerPermissoes(e.permissions),
    }));
    if (semCusto) {
      return res.status(403).json({ error: 'Este acesso não mostra custos.', code: 'ESTOQUE_SO_CONSULTA' });
    }
    return await responder(res, empresas.map((e) => ({ id: e.id, nome: e.nome })), lerPeriodo(req.query));
  } catch (err) {
    return falhou(res, err, 'me');
  }
});

module.exports = { companyRouter, meRouter, _empresasDoUsuario: empresasDoUsuario };
