// ============================================================
// AURA. — Conferencia de estoque (card p-108, 11/11/2026)
//
// Migration 446. Regras em src/services/conferenciaDeEstoque.js.
// Prefixo /companies/:id/estoque/conferencias (:id = loja).
//
//   POST   /                       { escopo, as_cegas?, motivo? } -> 201 { conferencia }
//   GET    /?limit&before          historico (array), mais recentes primeiro
//   GET    /:countId               { conferencia, itens, escopo_total, transferencias, ... }
//   PUT    /:countId/itens         { product_id, variant_id?, quantidade, modo } -> { item }
//   DELETE /:countId/itens/:itemId
//   GET    /:countId/diferencas    { resumo, itens, nao_contados }
//   POST   /:countId/aplicar       { zerar_nao_contados?, ignorar_item_ids?, motivo? }
//   POST   /:countId/desfazer
//   DELETE /:countId               descarta o rascunho (status 'descartada')
//
// ACESSO (mesmas chaves do Estoque, company_members.permissions):
//   - VER / CONTAR: quem mexe no estoque (transferenciaDeEstoque.podeMexer)
//     ou quem e "estoque so consulta" (estoque_consulta). "Funcionario
//     conta" (decisao 2 do card): a contagem nao mexe no estoque.
//   - EDITAR (aplicar, desfazer): so quem mexe no estoque (podeMexer:
//     dono, admin ou membro sem estoque desligado e sem consulta).
//   - Custo e valor saem nulos para quem nao ve custo (podeVerCusto).
// Por isso o router monta em private.js ANTES do
// negarEmConsultaSemCustoNoResto de /estoque (que daria 403 a consulta).
//
// PLANO: sem requirePlan, como as outras rotas de estoque (estoque e
// 'essencial' em services/modules.js; chave propria conferencia_estoque).
//
// Antes da migration 446: 503 MIGRATION_PENDING (utils/conferenciaSchema).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const svc = require('../services/conferenciaDeEstoque');
const { podeMexer } = require('../services/transferenciaDeEstoque');
const { ehSoConsulta, podeVerCusto } = require('../middleware/estoqueSoConsulta');
const { hasConferenciaSchema } = require('../utils/conferenciaSchema');

function falhaDeSchema(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

const TOTAL = { ver: true, editar: true, verCusto: true };

// Uma query, so para membro (dono, admin e staff nao chegam a ela).
async function lerAcesso(req) {
  if (req.acessoConferencia) return req.acessoConferencia;
  if (!req.user || req.user.role === 'admin' || req.companyRole === 'owner' || req.companyRole === 'admin') {
    req.acessoConferencia = TOTAL;
    return TOTAL;
  }
  const sql =
    `SELECT (c.owner_id = $2) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE c.id = $1
      LIMIT 1`;
  const params = [req.params.id, req.user.id];
  const { rows } = await (typeof db.queryRetry === 'function' ? db.queryRetry(sql, params) : db.query(sql, params));
  const r = rows[0];
  const quem = r ? { isOwner: r.is_owner, roleLabel: r.role_label, permissions: lerPermissoes(r.permissions) } : null;
  const editar = !!quem && podeMexer(quem);
  req.acessoConferencia = {
    ver: editar || (!!quem && ehSoConsulta(quem)),
    editar,
    verCusto: !!quem && podeVerCusto(quem),
  };
  return req.acessoConferencia;
}

const MSG_SEM_ACESSO = 'Seu acesso não inclui o estoque desta loja. Peça ao dono para liberar.';
const MSG_SEM_EDITAR = 'Só quem pode editar o estoque aplica ou desfaz o ajuste. Peça ao dono ou a quem cuida do estoque.';

// Portao do router: migration, depois quem ve o estoque.
router.use(async (req, res, next) => {
  try {
    if (!(await hasConferenciaSchema(db))) {
      return res.status(503).json({
        error: 'A conferência de estoque fica disponível em alguns minutos. Tente de novo daqui a pouco.',
        code: 'MIGRATION_PENDING',
      });
    }
    const acesso = await lerAcesso(req);
    if (!acesso.ver) return res.status(403).json({ error: MSG_SEM_ACESSO, code: 'SEM_ACESSO_AO_ESTOQUE' });
    return next();
  } catch (err) {
    console.error('[estoqueConferencias] acesso error:', err && err.message);
    return res.status(503).json({ error: 'Instabilidade momentânea de conexão. Tente novamente.', code: 'DB_CONN_TRANSIENT' });
  }
});

function exigirEditar(req, res) {
  if (req.acessoConferencia && req.acessoConferencia.editar) return true;
  res.status(403).json({ error: MSG_SEM_EDITAR, code: 'SEM_PERMISSAO_DE_EDITAR' });
  return false;
}

// Quem nao ve custo recebe custo e valor nulos (a forma da resposta fica).
const CHAVES_DE_CUSTO = new Set(['custo', 'valor', 'valor_faltam', 'valor_sobram', 'custo_no_bipe']);
function semCusto(v) {
  if (Array.isArray(v)) return v.map(semCusto);
  if (v === null || typeof v !== 'object' || v instanceof Date) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = CHAVES_DE_CUSTO.has(k) ? null : semCusto(x);
  return out;
}
function responder(req, res, status, body) {
  const ocultar = req.acessoConferencia && !req.acessoConferencia.verCusto;
  if (!ocultar) return res.status(status).json(body);
  const limpo = semCusto(body);
  if (limpo && typeof limpo === 'object' && !Array.isArray(limpo)) limpo.custos_ocultos = true;
  return res.status(status).json(limpo);
}

function tratarErro(res, err, onde) {
  if (err instanceof svc.ErroDeConferencia) return res.status(err.status).json(err.body);
  if (falhaDeSchema(err)) {
    return res.status(503).json({ error: 'A conferência de estoque fica disponível em alguns minutos. Tente de novo daqui a pouco.', code: 'MIGRATION_PENDING' });
  }
  if (err && (err.code === '40P01' || err.code === '40001' || err.code === '55P03')) {
    return res.status(409).json({ error: 'O estoque mudou enquanto a conferência era gravada. Tente de novo.', code: 'TENTE_DE_NOVO' });
  }
  if (err && err.code === '22003') {
    return res.status(400).json({ error: 'A quantidade ficou grande demais. Confira o número contado.', code: 'QUANTIDADE_INVALIDA' });
  }
  console.error(`[estoqueConferencias] ${onde} error:`, err && err.message, err && err.code);
  return res.status(500).json({ error: 'Não deu para concluir agora. Tente de novo em instantes.' });
}

// Transacao curta com o client do pool.
async function emTransacao(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const cid = (req) => String(req.params.id).toLowerCase();
const uid = (req) => (req.user && req.user.id) || null;

// ─── POST / ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  let pedido;
  try { pedido = svc.lerCriacao(req.body); } catch (e) { return tratarErro(res, e, 'POST'); }
  try {
    const conferencia = await emTransacao((c) => svc.criar(c, { companyId: cid(req), userId: uid(req), ...pedido }));
    return responder(req, res, 201, { conferencia });
  } catch (err) { return tratarErro(res, err, 'POST'); }
});

// ─── GET / ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  let before = null;
  if (req.query.before) {
    const d = new Date(String(req.query.before));
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Use uma data válida em "before".', code: 'PARAMETRO_INVALIDO' });
    before = d.toISOString();
  }
  const incluirDescartadas = req.query.incluir_descartadas === '1' || req.query.incluir_descartadas === 'true';
  try {
    const lista = await svc.listar(db, cid(req), { limit, before, incluirDescartadas });
    return responder(req, res, 200, lista);
  } catch (err) { return tratarErro(res, err, 'GET'); }
});

// ─── GET /:countId ───────────────────────────────────────────
router.get('/:countId', async (req, res) => {
  try {
    return responder(req, res, 200, await svc.obter(db, cid(req), req.params.countId));
  } catch (err) { return tratarErro(res, err, 'GET /:countId'); }
});

// ─── PUT /:countId/itens ─────────────────────────────────────
router.put('/:countId/itens', async (req, res) => {
  let pedido;
  try { pedido = svc.lerRegistro(req.body); } catch (e) { return tratarErro(res, e, 'PUT itens'); }
  try {
    const out = await emTransacao((c) => svc.registrarItem(c, { companyId: cid(req), countId: req.params.countId, ...pedido }));
    return responder(req, res, 200, out);
  } catch (err) { return tratarErro(res, err, 'PUT itens'); }
});

// ─── DELETE /:countId/itens/:itemId ──────────────────────────
router.delete('/:countId/itens/:itemId', async (req, res) => {
  try {
    const out = await emTransacao((c) => svc.removerItem(c, { companyId: cid(req), countId: req.params.countId, itemId: req.params.itemId }));
    return res.json(out);
  } catch (err) { return tratarErro(res, err, 'DELETE item'); }
});

// ─── GET /:countId/diferencas ────────────────────────────────
router.get('/:countId/diferencas', async (req, res) => {
  try {
    return responder(req, res, 200, await svc.diferencas(db, cid(req), req.params.countId));
  } catch (err) { return tratarErro(res, err, 'GET diferencas'); }
});

// ─── POST /:countId/aplicar ──────────────────────────────────
router.post('/:countId/aplicar', async (req, res) => {
  if (!exigirEditar(req, res)) return undefined;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const ignorar = Array.isArray(b.ignorar_item_ids) ? b.ignorar_item_ids.filter((x) => typeof x === 'string') : [];
  try {
    const out = await emTransacao((c) => svc.aplicar(c, {
      companyId: cid(req),
      countId: req.params.countId,
      userId: uid(req),
      zerarNaoContados: b.zerar_nao_contados === true,
      ignorarItemIds: ignorar,
      motivo: Object.prototype.hasOwnProperty.call(b, 'motivo') ? b.motivo : undefined,
    }));
    return responder(req, res, 200, out);
  } catch (err) { return tratarErro(res, err, 'aplicar'); }
});

// ─── POST /:countId/desfazer ─────────────────────────────────
router.post('/:countId/desfazer', async (req, res) => {
  if (!exigirEditar(req, res)) return undefined;
  try {
    const out = await emTransacao((c) => svc.desfazer(c, { companyId: cid(req), countId: req.params.countId, userId: uid(req) }));
    return responder(req, res, 200, out);
  } catch (err) { return tratarErro(res, err, 'desfazer'); }
});

// ─── DELETE /:countId ────────────────────────────────────────
router.delete('/:countId', async (req, res) => {
  try {
    const out = await emTransacao((c) => svc.descartar(c, {
      companyId: cid(req), countId: req.params.countId, userId: uid(req), podeEditar: !!req.acessoConferencia.editar,
    }));
    return responder(req, res, 200, out);
  } catch (err) { return tratarErro(res, err, 'DELETE'); }
});

module.exports = router;
module.exports._lerAcesso = lerAcesso;
