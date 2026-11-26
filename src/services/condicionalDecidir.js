// ============================================================
// AURA. — Venda condicional: decidir as pecas (C9, 26/11/2026)
//
// O que a lojista faz com a condicional aberta, peca por peca:
//   marcar     PATCH …/:cid/itens        voltou | voltou_defeito | ficou | com_cliente
//   nova data  PATCH …/:cid/prazo        hoje (SP) a hoje + 30; qualquer vendedora (decisao 3)
//   acrescentar POST …/:cid/itens        preco do dia, mesmo prazo, so peca livre
//   tudo devolvido POST …/:cid/tudo-devolvido   as com_cliente viram voltou (R10)
//   cancelar   POST …/:cid/cancelar      so aberta por engano (nada decidido)
//
// Regras (notas de 25-26/11 e mockup aprovado):
//   R1  nada aqui cria venda, lancamento, movimento de caixa ou de estoque.
//       A venda e do Caixa (C11, sales.condicional_id).
//   R6  'voltou' tira a peca de "com clientes" na hora (o numero e calculado,
//       services/comClientes.js: a peca deixa de ser com_cliente).
//       'voltou_defeito' tambem sai de "com clientes", mas NAO volta a livre:
//       fica "para resolver" (resolved_at NULL, migration 468) ate o C16.
//       'ficou' continua fora da loja (conta em out_qty) ate virar venda.
//   Peca com sale_id (ja cobrada) nao muda: 409. Peca resolvida (C16) nao
//   muda: 409. Peca que tinha voltado ('voltou') e sai de novo
//   (com_cliente/ficou) passa pela conta do livre, como ao guardar.
//   Encerramento: a condicional aberta encerra quando nenhuma peca esta
//   com_cliente e nenhuma 'ficou' sem venda (com venda ou nao). Com 'ficou'
//   sem venda e nada com ela, segue aberta: situacao derivada a_cobrar
//   ("Falta cobrar"). Nada com ela (a_cobrar): sem nova data e sem
//   acrescentar (mockup de 26/11).
//
// Concorrencia: cada escrita e uma transacao com SELECT … FOR UPDATE na
// condicional e depois nos itens (sempre nesta ordem). Duas marcacoes ao
// mesmo tempo na mesma condicional rodam uma depois da outra; a segunda le o
// que a primeira gravou. A conta do livre (acrescentar, voltou -> fora) usa
// as mesmas travas por produto do guardar (pg_advisory_xact_lock em ordem),
// tomadas DEPOIS da trava da condicional.
//
// Idempotencia: Idempotency-Key (cabecalho ou corpo) gravada nos eventos da
// operacao (dados.idempotency_key, dados.op, dados.assinatura). A repeticao
// com a mesma chave, depois da trava da condicional, acha o evento e devolve
// a condicional como esta (200, idempotent_replay); a mesma chave com outra
// operacao ou outro corpo: 409 IDEMPOTENCY_KEY_REUSED. Operacao que nao
// mudou nada nao grava evento (repetir tambem nao muda nada).
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');
const { lerVendaSemEstoque } = require('../utils/vendaSemEstoque');
const c = require('./condicional');

const { erro } = c;
const SITUACOES = ['com_cliente', 'ficou', 'voltou', 'voltou_defeito'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTA_MAX = 500;
const MOTIVO_MAX = 300;
// Marcacoes num pedido so: o detalhe salva todas as pecas de uma vez.
const MAX_MARCACOES = 200;

const FORA = (sit, saleId) => sit === 'com_cliente' || (sit === 'ficou' && !saleId);

function nomeDaPeca(i) {
  return `"${i.product_name}${i.variant_label ? ` (${i.variant_label})` : ''}"`;
}

function assinar(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// ─── Leitura dos corpos (sem banco) ───────────────────────────

/**
 * PATCH …/itens: [{item_id, situacao, defect_note?}] (em `items` ou o
 * proprio corpo). Devolve { marcacoes } ou { erro }.
 */
function lerMarcacoes(body) {
  const brutos = Array.isArray(body) ? body : (body && body.items);
  if (!Array.isArray(brutos) || brutos.length === 0) {
    return { erro: { status: 422, code: 'COND_SEM_PECAS', message: 'Marque pelo menos uma peça.' } };
  }
  if (brutos.length > MAX_MARCACOES) {
    return { erro: { status: 422, code: 'COND_PECAS_DEMAIS', message: `Dá para marcar até ${MAX_MARCACOES} peças de uma vez.` } };
  }
  const vistos = new Set();
  const marcacoes = [];
  for (let i = 0; i < brutos.length; i++) {
    const m = brutos[i] || {};
    const id = m.item_id ? String(m.item_id).trim().toLowerCase() : '';
    if (!UUID_RE.test(id)) {
      return { erro: { status: 422, code: 'COND_ITEM_INVALIDO', message: `A marcação ${i + 1} não diz qual é a peça.` } };
    }
    if (vistos.has(id)) {
      return { erro: { status: 422, code: 'COND_ITEM_REPETIDO', message: 'A mesma peça veio duas vezes. Marque cada peça uma vez só.' } };
    }
    vistos.add(id);
    const situacao = typeof m.situacao === 'string' ? m.situacao.trim() : '';
    if (!SITUACOES.includes(situacao)) {
      return { erro: { status: 422, code: 'COND_SITUACAO', message: 'Marque a peça como Ficou, Voltou, Voltou com defeito ou Ainda com ela.' } };
    }
    const nota = situacao === 'voltou_defeito' ? c.textoLimpo(m.defect_note, NOTA_MAX) : null;
    marcacoes.push({ item_id: id, situacao, defect_note: nota });
  }
  return { marcacoes };
}

/** PATCH …/prazo: { due_date } de hoje (SP) a hoje + 30. Devolve { dueDate } ou { erro }. */
function lerPrazo(body, { hoje = c.hojeSP() } = {}) {
  const raw = body && body.due_date;
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return { erro: { status: 422, code: 'COND_DATA', message: 'Escolha a nova data de devolução.' } };
  if (!c.dataValida(s)) return { erro: { status: 422, code: 'COND_DATA', message: 'A data de devolução está inválida.' } };
  if (s < hoje) {
    return { erro: { status: 422, code: 'COND_DATA', message: 'A data de devolução já passou. Escolha hoje ou um dia depois.' } };
  }
  if (s > c.somarDias(hoje, c.PRAZO_MAX_DIAS)) {
    return { erro: { status: 422, code: 'COND_DATA', message: `A devolução pode ser em até ${c.PRAZO_MAX_DIAS} dias.` } };
  }
  return { dueDate: s };
}

/**
 * Cancelar: so condicional aberta em que nenhuma peca foi decidida (todas
 * com_cliente, sem venda). Devolve null (pode) ou o erro.
 */
function motivoParaNaoCancelar(itens) {
  const decidida = (itens || []).find((i) => i.situacao !== 'com_cliente' || i.sale_id);
  if (!decidida) return null;
  return {
    status: 409,
    code: 'COND_CANCELAR_DECIDIDA',
    message: 'Já tem peça decidida nesta condicional, então ela não pode ser cancelada. '
      + 'Cancelar é só para condicional aberta por engano: se as peças voltaram, marque cada uma como Voltou.',
  };
}

/** A condicional aberta ja pode encerrar? (nada com ela e nada para cobrar) */
function podeEncerrar(itens) {
  return !(itens || []).some((i) => FORA(i.situacao, i.sale_id));
}

function erroFechada(cond) {
  if (cond.status === 'cancelada') {
    return erro(409, 'Esta condicional foi cancelada e não muda mais.', 'COND_FECHADA');
  }
  return erro(409, 'Esta condicional já foi concluída e não muda mais.', 'COND_FECHADA');
}

// ─── Transacao comum ──────────────────────────────────────────

const REPETIDA = Symbol('condicional-operacao-repetida');

/**
 * Roda `fazer` numa transacao com a condicional e os itens travados.
 *   fazer(ctx) -> { motivoEncerrar?, extra? }
 *   ctx: { client, cond, itens, evento(tipo, itemId, dados), userId, agora }
 * Depois de `fazer`, encerra a condicional aberta que ficou sem peca fora.
 * Devolve { condicional, repetido, ...extra }.
 */
async function naCondicional({ companyId, condId, chave, op, assinatura, userId, hoje = c.hojeSP(), agora = new Date() }, fazer) {
  if (!UUID_RE.test(String(condId || ''))) throw erro(404, 'Condicional não encontrada.', 'COND_NAO_ENCONTRADA');
  const client = await db.connect();
  let extra = {};
  let repetido = false;
  try {
    await client.query('BEGIN');
    const { rows: [cond] } = await client.query(
      `SELECT id, company_id, numero, status, due_date::text AS due_date
         FROM condicionais WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [condId, companyId]
    );
    if (!cond) throw erro(404, 'Condicional não encontrada.', 'COND_NAO_ENCONTRADA');

    if (chave) {
      const { rows: [ja] } = await client.query(
        `SELECT dados->>'op' AS op, dados->>'assinatura' AS assinatura
           FROM condicional_eventos
          WHERE condicional_id = $1 AND dados->>'idempotency_key' = $2
          LIMIT 1`,
        [condId, chave]
      );
      if (ja) {
        if (ja.op !== op || (assinatura && ja.assinatura !== assinatura)) {
          throw erro(409, 'Esta tentativa já foi usada para outra alteração nesta condicional. Abra a condicional de novo e repita.', 'IDEMPOTENCY_KEY_REUSED', { condicional_id: condId });
        }
        throw Object.assign(new Error('repetida'), { [REPETIDA]: true });
      }
    }

    const { rows: itens } = await client.query(
      `SELECT id, product_id, variant_id, product_name, variant_label, unit_price,
              situacao, defect_note, decided_at, sale_id, resolved_at
         FROM condicional_itens WHERE condicional_id = $1
        ORDER BY id FOR UPDATE`,
      [condId]
    );

    let houveEvento = false;
    const evento = async (tipo, itemId, dados) => {
      houveEvento = true;
      await client.query(
        // clock_timestamp (e nao NOW, que e o mesmo em toda a transacao): o
        // historico sai na ordem em que aconteceu (voltou antes de encerrada).
        `INSERT INTO condicional_eventos (condicional_id, company_id, tipo, item_id, dados, user_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, clock_timestamp())`,
        [condId, companyId, tipo, itemId || null, JSON.stringify({
          ...(dados || {}),
          op,
          ...(chave ? { idempotency_key: chave, ...(assinatura ? { assinatura } : {}) } : {}),
        }), userId || null]
      );
    };

    const r = (await fazer({ client, cond, itens, evento, userId, hoje, agora })) || {};
    extra = r.extra || {};

    // Encerramento (R6/R10): nada com ela e nada "ficou" sem venda.
    let encerrou = false;
    if (cond.status === 'aberta' && r.motivoEncerrar !== false && podeEncerrar(itens)) {
      await client.query(
        `UPDATE condicionais SET status = 'encerrada', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [condId]
      );
      const vendidas = itens.filter((i) => i.sale_id).length;
      await evento('encerrada', null, { motivo: r.motivoEncerrar || 'pecas_decididas', com_venda: vendidas > 0 });
      encerrou = true;
    }
    if (houveEvento && !encerrou) {
      await client.query(`UPDATE condicionais SET updated_at = NOW() WHERE id = $1`, [condId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e && e[REPETIDA]) repetido = true;
    else throw e;
  } finally {
    client.release();
  }
  const condicional = await c.lerCondicionalCompleta(db, companyId, condId, { hoje, agora });
  return { condicional, repetido, ...(repetido ? {} : extra) };
}

/** Travas por produto (as mesmas do guardar), em ordem fixa. */
async function travarProdutos(client, productIds) {
  const pids = [...new Set(productIds.map(String))].sort();
  if (!pids.length) return;
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('condicional-peca:' || s.pid))
       FROM (SELECT t.pid FROM unnest($1::text[]) WITH ORDINALITY AS t(pid, n) ORDER BY t.n) s`,
    [pids]
  );
}

async function vendeSemEstoque(client, companyId) {
  const { rows: [loja] } = await client.query(`SELECT pdv_settings FROM companies WHERE id = $1`, [companyId]);
  return lerVendaSemEstoque((loja && loja.pdv_settings) || {});
}

/**
 * Confere o livre das pecas que vao sair da loja; 409 COND_SEM_SALDO ou os
 * avisos (loja que vende sem estoque). `pecas`: [{product_id, variant_id, nome, variant_label}].
 */
async function conferirSaida(client, companyId, pecas) {
  if (!pecas.length) return [];
  await travarProdutos(client, pecas.map((p) => p.product_id));
  const faltas = await c.conferirLivres(client, companyId, pecas);
  if (!faltas.length) return [];
  if (!(await vendeSemEstoque(client, companyId))) {
    throw erro(409, `Não dá para levar: ${faltas.map(c.fraseDaFalta).join(' ')}`, 'COND_SEM_SALDO', { faltas });
  }
  return faltas.map((f) => ({ ...f, mensagem: c.AVISO_SEM_ESTOQUE }));
}

// ─── Operacoes ────────────────────────────────────────────────

/** Marcar pecas. Devolve { condicional, repetido, avisos }. */
async function marcarPecas({ companyId, condId, userId, body, chave, hoje, agora }) {
  const lido = lerMarcacoes(body);
  if (lido.erro) throw erro(lido.erro.status, lido.erro.message, lido.erro.code);
  const { marcacoes } = lido;
  const assinatura = assinar(marcacoes.map((m) => [m.item_id, m.situacao, m.defect_note]).sort());
  return naCondicional({ companyId, condId, chave, op: 'marcar', assinatura, userId, hoje, agora }, async ({ client, cond, itens, evento }) => {
    if (cond.status !== 'aberta') throw erroFechada(cond);
    const porId = new Map(itens.map((i) => [String(i.id), i]));
    const mudancas = [];
    for (const m of marcacoes) {
      const it = porId.get(m.item_id);
      if (!it) throw erro(404, 'Essa peça não é desta condicional.', 'COND_PECA_NAO_ENCONTRADA', { item_id: m.item_id });
      if (it.sale_id) {
        throw erro(409, `${nomeDaPeca(it)} já foi cobrada numa venda e não muda mais.`, 'COND_PECA_COBRADA', { item_id: it.id, sale_id: it.sale_id });
      }
      if (it.resolved_at) {
        throw erro(409, `${nomeDaPeca(it)} já foi resolvida em Peças para resolver e não muda mais.`, 'COND_PECA_RESOLVIDA', { item_id: it.id });
      }
      const mesmaNota = (it.defect_note || null) === (m.defect_note || null);
      if (it.situacao === m.situacao && (m.situacao !== 'voltou_defeito' || mesmaNota)) continue;
      mudancas.push({ it, m });
    }
    // Peca que tinha voltado e sai de novo: precisa de unidade livre.
    const saindo = mudancas
      .filter(({ it, m }) => it.situacao === 'voltou' && FORA(m.situacao, null))
      .map(({ it }) => ({ product_id: String(it.product_id), variant_id: it.variant_id ? String(it.variant_id) : null, nome: it.product_name, variant_label: it.variant_label }));
    const avisos = await conferirSaida(client, companyId, saindo);

    for (const { it, m } of mudancas) {
      const decidida = m.situacao !== 'com_cliente';
      await client.query(
        `UPDATE condicional_itens
            SET situacao = $2, defect_note = $3,
                decided_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END,
                decided_by = CASE WHEN $4::boolean THEN $5::uuid ELSE NULL END
          WHERE id = $1`,
        [it.id, m.situacao, m.defect_note, decidida, userId || null]
      );
      await evento(m.situacao === 'com_cliente' ? 'ainda_com_ela' : m.situacao, it.id, {
        de: it.situacao,
        para: m.situacao,
        ...(m.defect_note ? { defect_note: m.defect_note } : {}),
      });
      it.situacao = m.situacao;
      it.defect_note = m.defect_note;
    }
    return { motivoEncerrar: 'pecas_decididas', extra: { avisos } };
  });
}

/** Nova data de devolucao. Devolve { condicional, repetido }. */
async function mudarPrazo({ companyId, condId, userId, body, chave, hoje = c.hojeSP(), agora }) {
  const lido = lerPrazo(body, { hoje });
  if (lido.erro) throw erro(lido.erro.status, lido.erro.message, lido.erro.code);
  const { dueDate } = lido;
  return naCondicional({ companyId, condId, chave, op: 'prazo', assinatura: assinar([dueDate]), userId, hoje, agora }, async ({ client, cond, itens, evento }) => {
    if (cond.status !== 'aberta') throw erroFechada(cond);
    if (!itens.some((i) => i.situacao === 'com_cliente')) {
      throw erro(409, 'Nada mais está com a cliente, então não há prazo para mudar. Falta só cobrar no Caixa.', 'COND_NADA_COM_ELA');
    }
    if (cond.due_date === dueDate) return { motivoEncerrar: false };
    await client.query(`UPDATE condicionais SET due_date = $2::date WHERE id = $1`, [cond.id, dueDate]);
    await evento('nova_data', null, { de: cond.due_date, para: dueDate });
    return { motivoEncerrar: false };
  });
}

/** Acrescentar pecas. Devolve { condicional, repetido, avisos, itens_acrescentados }. */
async function acrescentarPecas({ companyId, condId, userId, body, chave, hoje, agora = new Date() }) {
  const lido = c.lerItens(body && body.items);
  if (lido.erro) throw erro(lido.erro.status, lido.erro.message, lido.erro.code);
  const novas = lido.itens;
  const assinatura = assinar(novas.map((i) => `${i.product_id}|${i.variant_id || ''}`).sort());
  // Fora da transacao: a leitura de promo_* tem fallback (42703) que nao pode
  // abortar a transacao (o mesmo do guardar).
  if (UUID_RE.test(String(condId || ''))) await c.conferirPecas(db, companyId, novas, agora);
  return naCondicional({ companyId, condId, chave, op: 'acrescentar', assinatura, userId, hoje, agora }, async ({ client, cond, itens, evento }) => {
    if (cond.status !== 'aberta') throw erroFechada(cond);
    if (!itens.some((i) => i.situacao === 'com_cliente')) {
      throw erro(409, 'Nada mais está com a cliente nesta condicional. Para levar outra peça, comece uma condicional nova.', 'COND_NADA_COM_ELA');
    }
    if (itens.length + novas.length > c.MAX_PECAS) {
      throw erro(422, `Uma condicional leva até ${c.MAX_PECAS} peças. Esta já tem ${itens.length}.`, 'COND_PECAS_DEMAIS');
    }
    const avisos = await conferirSaida(client, companyId, novas);
    const { rows: criados } = await client.query(
      `INSERT INTO condicional_itens
         (condicional_id, product_id, variant_id, product_name, variant_label, color_name, size_label, unit_price, situacao, added_at)
       SELECT $1, t.product_id, t.variant_id, t.product_name, t.variant_label, t.color_name, t.size_label, t.unit_price, 'com_cliente',
              NOW() + (t.n * interval '1 microsecond')
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[])
              WITH ORDINALITY AS t(product_id, variant_id, product_name, variant_label, color_name, size_label, unit_price, n)
        ORDER BY t.n
       RETURNING id, product_id, variant_id, product_name, variant_label, unit_price`,
      [
        cond.id,
        novas.map((x) => x.product_id), novas.map((x) => x.variant_id), novas.map((x) => x.nome),
        novas.map((x) => x.variant_label), novas.map((x) => x.color_name), novas.map((x) => x.size_label),
        novas.map((x) => x.unit_price),
      ]
    );
    const semSaldo = new Set(avisos.map((a) => `${a.product_id}|${a.variant_id || ''}`));
    for (const r of criados) {
      await evento('peca_acrescentada', r.id, {
        product_name: r.product_name,
        variant_label: r.variant_label || null,
        unit_price: Number(r.unit_price),
        due_date: cond.due_date,
        ...(semSaldo.has(`${r.product_id}|${r.variant_id || ''}`) ? { sem_saldo: true } : {}),
      });
    }
    return { motivoEncerrar: false, extra: { avisos, itens_acrescentados: criados.map((r) => r.id) } };
  });
}

/** Tudo devolvido (R10). Devolve { condicional, repetido }. */
async function tudoDevolvido({ companyId, condId, userId, chave, hoje, agora }) {
  return naCondicional({ companyId, condId, chave, op: 'tudo_devolvido', userId, hoje, agora }, async ({ client, cond, itens, evento }) => {
    if (cond.status !== 'aberta') throw erroFechada(cond);
    const aCobrar = itens.filter((i) => i.situacao === 'ficou' && !i.sale_id);
    if (aCobrar.length) {
      throw erro(409,
        `${aCobrar.map(nomeDaPeca).join(', ')} ficou com a cliente e ainda não foi cobrada. Cobre no Caixa ou marque como Voltou antes.`,
        'COND_TEM_FICOU');
    }
    const comEla = itens.filter((i) => i.situacao === 'com_cliente');
    if (comEla.length) {
      await client.query(
        `UPDATE condicional_itens SET situacao = 'voltou', defect_note = NULL, decided_at = NOW(), decided_by = $2
          WHERE id = ANY($1::uuid[])`,
        [comEla.map((i) => i.id), userId || null]
      );
    }
    for (const it of comEla) {
      await evento('voltou', it.id, { de: 'com_cliente', para: 'voltou', tudo_devolvido: true });
      it.situacao = 'voltou';
    }
    return { motivoEncerrar: 'tudo_devolvido' };
  });
}

/** Cancelar a condicional aberta por engano. Devolve { condicional, repetido }. */
async function cancelarCondicional({ companyId, condId, userId, body, chave, hoje, agora }) {
  const motivo = c.textoLimpo(body && (body.reason || body.motivo || body.cancel_reason), MOTIVO_MAX);
  return naCondicional({ companyId, condId, chave, op: 'cancelar', userId, hoje, agora }, async ({ client, cond, itens, evento }) => {
    if (cond.status !== 'aberta') throw erroFechada(cond);
    const nao = motivoParaNaoCancelar(itens);
    if (nao) throw erro(nao.status, nao.message, nao.code);
    await client.query(
      `UPDATE condicionais SET status = 'cancelada', cancelled_at = NOW(), cancel_reason = $2 WHERE id = $1`,
      [cond.id, motivo]
    );
    cond.status = 'cancelada';
    await evento('cancelada', null, { motivo, pecas: itens.length });
    return { motivoEncerrar: false };
  });
}

module.exports = {
  SITUACOES,
  MAX_MARCACOES,
  lerMarcacoes,
  lerPrazo,
  motivoParaNaoCancelar,
  podeEncerrar,
  marcarPecas,
  mudarPrazo,
  acrescentarPecas,
  tudoDevolvido,
  cancelarCondicional,
};
