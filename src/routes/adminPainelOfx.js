// ============================================================
// AURA. — Gestão Aura: extrato bancário (OFX) × repasses da Asaas (13/10/2026)
//
// Montado em /admin/painel/ofx (staff). Migration 373.
//
// POST   /admin/painel/ofx/extratos                         — importa o OFX do mês e já concilia
//        corpo JSON { ofx_content, mes?: 'YYYY-MM', nome_arquivo? }  ou o OFX cru
//        (Content-Type application/x-ofx | application/octet-stream | text/plain)
//        com ?mes= e ?nome_arquivo= na query.
// GET    /admin/painel/ofx/extratos?meses=6                 — Asaas × banco × diferença por mês
// GET    /admin/painel/ofx/extratos/:id                     — lançamentos com status
// POST   /admin/painel/ofx/extratos/:id/lancamentos/:lid/conciliar  — { pagamento_id }
// POST   /admin/painel/ofx/extratos/:id/lancamentos/:lid/ignorar
// POST   /admin/painel/ofx/extratos/:id/lancamentos/:lid/reabrir    — volta para pendente
// DELETE /admin/painel/ofx/extratos/:id
//
// Reimportar o mesmo arquivo não duplica: o FITID (com data e valor) que já
// existe em outro extrato do mesmo mês é pulado.
// ============================================================
'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const b = require('../services/painelBlocos/_base');
const painel = require('../services/painelDiario');
const { lancamentosDoOfx, mesDominante, decodificarOfx } = require('../services/ofxParser');
const {
  pagamentosAsaas, conciliarExtrato, conferenciaPorMes, somaMes,
} = require('../services/conciliacaoOfx');

const adminOnly = [requireAuth, requireRole('admin')];

// O OFX cru chega como bytes (o banco exporta em windows-1252, e decodificar
// aqui é o que mantém os acentos); o JSON já vem como texto.
const corpoCru = express.raw({
  type: ['application/x-ofx', 'application/ofx', 'application/octet-stream', 'text/plain'],
  limit: '5mb',
});

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const ID = /^\d{1,18}$/;
const centavos = (v) => Math.round((Number(v) || 0) * 100);

const COLUNAS_EXTRATO = `id, to_char(mes, 'YYYY-MM') AS mes, nome_arquivo, importado_em, importado_por, total_creditos, linhas`;
const COLUNAS_LANCAMENTO = `id, to_char(data, 'YYYY-MM-DD') AS data, valor, descricao, fitid, tipo, conciliado_com, com_taxa, status`;

const formatarExtrato = (e) => ({
  id: e.id,
  mes: e.mes,
  nome_arquivo: e.nome_arquivo || null,
  importado_em: e.importado_em,
  importado_por: e.importado_por || null,
  total_creditos: b.round2(e.total_creditos),
  linhas: b.num(e.linhas),
});

const formatarLancamento = (l) => ({
  id: l.id,
  data: l.data,
  valor: b.round2(l.valor),
  descricao: l.descricao || null,
  fitid: l.fitid,
  tipo: l.tipo,
  status: l.status,
  conciliado_com: l.conciliado_com || null,
  com_taxa: !!l.com_taxa,
});

// Deploy antes da migration: avisa em vez de 500 mudo.
function traduzirSchema(err) {
  if (err && (err.code === '42P01' || err.code === '42703')) {
    return new AppError('Tabelas do extrato ainda não existem (aplicar a migration 373)', 503);
  }
  return err;
}
const protegido = (fn) => asyncHandler(async (req, res, next) => {
  try { return await fn(req, res, next); } catch (err) { throw traduzirSchema(err); }
});

function idDe(valor, nome) {
  if (!ID.test(String(valor))) throw new AppError(`${nome} inválido`, 400);
  return String(valor);
}

// Texto do OFX, mês e nome do arquivo — do JSON ou do corpo cru.
function lerEntrada(req) {
  const corpo = req.body;
  const query = req.query || {};
  let conteudo = null;
  let mes = query.mes;
  let nome = query.nome_arquivo;
  if (Buffer.isBuffer(corpo)) {
    conteudo = decodificarOfx(corpo);
  } else if (typeof corpo === 'string') {
    conteudo = corpo;
  } else if (corpo && typeof corpo === 'object') {
    conteudo = corpo.ofx_content !== undefined ? corpo.ofx_content : corpo.ofx;
    if (corpo.mes !== undefined) mes = corpo.mes;
    if (corpo.nome_arquivo !== undefined) nome = corpo.nome_arquivo;
  }
  if (typeof conteudo !== 'string' || !conteudo.trim()) {
    throw new AppError('Envie o OFX em ofx_content (JSON) ou como corpo do pedido', 400);
  }
  if (mes !== undefined && mes !== null && mes !== '') {
    mes = String(mes).slice(0, 7);
    if (!MES.test(mes)) throw new AppError("mes deve ser 'YYYY-MM'", 400);
  } else {
    mes = null;
  }
  nome = typeof nome === 'string' && nome.trim() ? nome.trim().slice(0, 200) : null;
  return { conteudo, mes, nome };
}

// ── POST /extratos ──────────────────────────────────────────────
router.post('/extratos', ...adminOnly, corpoCru, protegido(async (req, res) => {
  const { conteudo, mes: mesInformado, nome } = lerEntrada(req);

  let lancamentos;
  try {
    lancamentos = lancamentosDoOfx(conteudo);
  } catch (err) {
    throw new AppError('Arquivo OFX inválido', 422, err.message);
  }
  if (!lancamentos.length) throw new AppError('Nenhuma transação encontrada no OFX', 422);

  const mes = mesInformado || mesDominante(lancamentos);
  const chaveDe = (l) => `${l.fitid}|${l.data}|${centavos(l.valor)}`;

  const client = await pool.connect();
  let resposta;
  try {
    await client.query('BEGIN');
    // Duas importações simultâneas do mesmo arquivo passariam as duas pela
    // conferência de duplicados; a trava serializa.
    await client.query('SELECT pg_advisory_xact_lock(373)');
    const { rows: existentes } = await client.query(
      `SELECT l.fitid, to_char(l.data, 'YYYY-MM-DD') AS data, l.valor, l.extrato_id
         FROM aura_extrato_lancamentos l
         JOIN aura_extratos e ON e.id = l.extrato_id
        WHERE e.mes = $1::date`,
      [`${mes}-01`]
    );
    const jaTem = new Map(existentes.map((r) => [chaveDe({ fitid: r.fitid, data: r.data, valor: r.valor }), r.extrato_id]));
    const novos = lancamentos.filter((l) => !jaTem.has(chaveDe(l)));
    const duplicados = lancamentos.length - novos.length;

    if (!novos.length) {
      await client.query('ROLLBACK');
      resposta = {
        status: 200,
        corpo: {
          ok: true, duplicado: true, extrato_id: jaTem.get(chaveDe(lancamentos[0])), mes,
          importados: 0, duplicados, conciliados: 0, pendentes: 0, com_taxa: 0,
        },
      };
    } else {
      const totalCreditos = b.round2(novos.filter((l) => l.tipo === 'credito').reduce((t, l) => t + l.valor, 0));
      const { rows: [extrato] } = await client.query(
        `INSERT INTO aura_extratos (mes, nome_arquivo, importado_por, total_creditos, linhas)
         VALUES ($1::date, $2, $3, $4, $5)
         RETURNING ${COLUNAS_EXTRATO}`,
        [`${mes}-01`, nome, req.user.id || null, totalCreditos, novos.length]
      );
      const { rows: inseridos } = await client.query(
        `INSERT INTO aura_extrato_lancamentos (extrato_id, data, valor, descricao, fitid, tipo, status)
         SELECT $1::bigint, x.d, x.v, x.t, x.f, x.k,
                CASE WHEN x.k = 'credito' THEN 'pendente' ELSE 'ignorado' END
           FROM unnest($2::date[], $3::numeric[], $4::text[], $5::text[], $6::text[]) AS x(d, v, t, f, k)
         ON CONFLICT (extrato_id, fitid) DO NOTHING
         RETURNING id, to_char(data, 'YYYY-MM-DD') AS data, valor, tipo`,
        [
          extrato.id,
          novos.map((l) => l.data),
          novos.map((l) => l.valor),
          novos.map((l) => l.descricao),
          novos.map((l) => l.fitid),
          novos.map((l) => l.tipo),
        ]
      );
      const conc = await conciliarExtrato({
        db: client,
        extratoId: extrato.id,
        creditos: inseridos.filter((r) => r.tipo === 'credito'),
      });
      await client.query('COMMIT');
      resposta = {
        status: 201,
        corpo: {
          ok: true,
          duplicado: false,
          extrato: formatarExtrato(extrato),
          importados: inseridos.length,
          duplicados,
          creditos: conc.creditos,
          conciliados: conc.conciliados,
          com_taxa: conc.com_taxa,
          pendentes: conc.pendentes,
        },
      };
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* sem transação aberta */ }
    throw err;
  } finally {
    client.release();
  }
  res.status(resposta.status).json(resposta.corpo);
}));

// ── GET /extratos ───────────────────────────────────────────────
router.get('/extratos', ...adminOnly, protegido(async (req, res) => {
  let meses = 6;
  if (req.query.meses !== undefined) {
    meses = parseInt(req.query.meses, 10);
    if (!Number.isInteger(meses) || meses < 1 || meses > 24) throw new AppError('meses deve ir de 1 a 24', 400);
  }
  const hoje = painel.hojeBRT();
  const linhas = await conferenciaPorMes({ db: pool, hoje, meses });
  res.json({ dia: hoje, meses: linhas.reverse() });
}));

// ── GET /extratos/:id ───────────────────────────────────────────
router.get('/extratos/:id', ...adminOnly, protegido(async (req, res) => {
  const id = idDe(req.params.id, 'id');
  const { rows: [extrato] } = await pool.query(
    `SELECT ${COLUNAS_EXTRATO} FROM aura_extratos WHERE id = $1`, [id]
  );
  if (!extrato) throw new AppError('Extrato não encontrado', 404);
  const { rows } = await pool.query(
    `SELECT ${COLUNAS_LANCAMENTO} FROM aura_extrato_lancamentos WHERE extrato_id = $1 ORDER BY data, id`, [id]
  );
  const lancamentos = rows.map(formatarLancamento);

  const creditos = lancamentos.filter((l) => l.tipo === 'credito');
  const soma = (lista) => b.round2(lista.reduce((t, l) => t + l.valor, 0));
  const porStatus = (s) => creditos.filter((l) => l.status === s);
  const resumo = {
    creditos: creditos.length,
    total_creditos: soma(creditos),
    conciliados: { n: porStatus('conciliado').length, valor: soma(porStatus('conciliado')), com_taxa: porStatus('conciliado').filter((l) => l.com_taxa).length },
    pendentes: { n: porStatus('pendente').length, valor: soma(porStatus('pendente')) },
    ignorados: { n: porStatus('ignorado').length, valor: soma(porStatus('ignorado')) },
    debitos: lancamentos.length - creditos.length,
  };

  // Pagamentos da Asaas ainda sem crédito, para a conciliação manual.
  let disponiveis = [];
  if (resumo.pendentes.n) {
    const primeiroDia = `${extrato.mes}-01`;
    const ultimoDia = b.somaDias(`${somaMes(extrato.mes, 1)}-01`, -1);
    const [pagamentos, { rows: casados }] = await Promise.all([
      pagamentosAsaas({ db: pool, de: b.somaDias(primeiroDia, -45), ate: b.somaDias(ultimoDia, 3) }),
      pool.query(`SELECT conciliado_com FROM aura_extrato_lancamentos WHERE conciliado_com IS NOT NULL`),
    ]);
    const ocupados = new Set(casados.map((r) => r.conciliado_com));
    disponiveis = pagamentos
      .filter((p) => !ocupados.has(p.chave))
      .sort((x, y) => (x.data_ref < y.data_ref ? -1 : x.data_ref > y.data_ref ? 1 : 0))
      .slice(0, 200)
      .map((p) => ({
        pagamento_id: p.chave, log_id: p.log_id, company_id: p.company_id,
        valor: p.valor, liquido: p.liquido, data: p.data_ref,
      }));
  }

  res.json({ extrato: formatarExtrato(extrato), resumo, lancamentos, pagamentos_disponiveis: disponiveis });
}));

// Atualiza um lançamento do extrato (404 se não for dele).
async function atualizarLancamento(extratoId, lancamentoId, sets, params) {
  const { rows: [l] } = await pool.query(
    `UPDATE aura_extrato_lancamentos SET ${sets}
      WHERE id = $1 AND extrato_id = $2
      RETURNING ${COLUNAS_LANCAMENTO}`,
    [lancamentoId, extratoId, ...params]
  );
  if (!l) throw new AppError('Lançamento não encontrado', 404);
  return formatarLancamento(l);
}

// ── POST …/lancamentos/:lid/conciliar ───────────────────────────
router.post('/extratos/:id/lancamentos/:lid/conciliar', ...adminOnly, protegido(async (req, res) => {
  const extratoId = idDe(req.params.id, 'id');
  const lancamentoId = idDe(req.params.lid, 'lid');
  const pagamentoId = String((req.body && req.body.pagamento_id) || '').trim();
  if (!pagamentoId || pagamentoId.length > 120) throw new AppError('pagamento_id obrigatório', 400);

  const { rows: [lanc] } = await pool.query(
    `SELECT ${COLUNAS_LANCAMENTO} FROM aura_extrato_lancamentos WHERE id = $1 AND extrato_id = $2`,
    [lancamentoId, extratoId]
  );
  if (!lanc) throw new AppError('Lançamento não encontrado', 404);
  if (lanc.tipo !== 'credito') throw new AppError('Só crédito se concilia com pagamento', 400);

  const [pagamento] = await pagamentosAsaas({ db: pool, chave: pagamentoId });
  if (!pagamento) throw new AppError('Pagamento não encontrado na Asaas', 404);

  const comTaxa = centavos(lanc.valor) < centavos(pagamento.valor);
  let lancamento;
  try {
    lancamento = await atualizarLancamento(
      extratoId, lancamentoId,
      `conciliado_com = $3, com_taxa = $4, status = 'conciliado'`,
      [pagamento.chave, comTaxa]
    );
  } catch (err) {
    if (err && err.code === '23505') throw new AppError('Esse pagamento já está conciliado com outro crédito', 409);
    throw err;
  }
  res.json({ ok: true, lancamento, pagamento: { pagamento_id: pagamento.chave, valor: pagamento.valor, data: pagamento.data_ref } });
}));

// ── POST …/lancamentos/:lid/ignorar ─────────────────────────────
router.post('/extratos/:id/lancamentos/:lid/ignorar', ...adminOnly, protegido(async (req, res) => {
  const lancamento = await atualizarLancamento(
    idDe(req.params.id, 'id'), idDe(req.params.lid, 'lid'),
    `conciliado_com = NULL, com_taxa = false, status = 'ignorado'`, []
  );
  res.json({ ok: true, lancamento });
}));

// ── POST …/lancamentos/:lid/reabrir ─────────────────────────────
router.post('/extratos/:id/lancamentos/:lid/reabrir', ...adminOnly, protegido(async (req, res) => {
  const lancamento = await atualizarLancamento(
    idDe(req.params.id, 'id'), idDe(req.params.lid, 'lid'),
    `conciliado_com = NULL, com_taxa = false, status = 'pendente'`, []
  );
  res.json({ ok: true, lancamento });
}));

// ── DELETE /extratos/:id ────────────────────────────────────────
router.delete('/extratos/:id', ...adminOnly, protegido(async (req, res) => {
  const id = idDe(req.params.id, 'id');
  const { rows: [removido] } = await pool.query(
    `DELETE FROM aura_extratos WHERE id = $1 RETURNING id, nome_arquivo, linhas`, [id]
  );
  if (!removido) throw new AppError('Extrato não encontrado', 404);
  res.json({ ok: true, id: removido.id, nome_arquivo: removido.nome_arquivo || null, lancamentos_removidos: b.num(removido.linhas) });
}));

module.exports = router;
