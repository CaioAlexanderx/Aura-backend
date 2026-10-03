// ============================================================
// AURA Studio — Preço certo: o custo fixo dentro do preço (03/10/2026)
// Montado em private.js, mesmo gate de plano das vizinhas do Studio.
//
// GET  /studio/preco-certo/custos       → lista de custos fixos, sugestões
//                                         do financeiro, taxa real × em uso
// PUT  /studio/preco-certo/custos       → grava a lista; aceitar a taxa é
//                                         mandar taxa_em_uso_pct no corpo
// GET  /studio/preco-certo/diagnostico  → peça a peça: custo, margem que
//                                         sobra, situação e preço sugerido
// POST /studio/preco-certo/aplicar      → grava os preços que ELA aceitou
//
// A conta toda mora em services/precoCerto.js (pura, testada sem banco).
//
// REGRA DE OURO: nada aqui muda preço ou taxa por conta própria. O PUT só
// troca a taxa em uso quando o corpo traz o campo; o POST só grava o preço
// que veio da tela — o servidor valida, não recalcula.
//
// SEM MIGRATION: tudo em companies.studio_settings (JSONB) —
//   custos_fixos           [{ id, nome, valor, origem, chave_financeiro?, ativo }]
//   taxa_custo_fixo_pct    a taxa EM USO (ausente = recurso não configurado)
//   taxa_custo_fixo_aceita_em  quando ela aceitou a taxa (ISO)
//   faturamento_esperado   para estúdio sem histórico
//   margem_minima_pct      o piso de margem (já lido por margemEmRisco)
//
// MULTI-CNPJ: tudo escopado no company_id da URL. Cada CNPJ tem seus
// custos, sua taxa e seus preços; produto compartilhado pelo grupo
// (is_group_shared) de OUTRA empresa não é reprecificado por aqui.
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true }); // company_id = req.params.id
const db      = require('../config/database');
const pc      = require('../services/precoCerto');
const { margemMinima } = require('../services/margemEmRisco');
const { esquecerPagina } = require('../services/cacheDaPaginaDaLoja');
const { DEFAULT_LINE_MAP } = require('./dre');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAXIMO_DE_PRECOS = 200;
const PRECO_MAXIMO = 9999999.99;

/** A categoria é "Despesas Fixas" (ou Pessoal) no DRE? Só dica para a tela. */
function eDespesaFixa(categoria) {
  const linha = DEFAULT_LINE_MAP[String(categoria || '').toLowerCase().trim()];
  return Boolean(linha && (linha.line === 'despesa_fixa' || linha.line === 'despesa_pessoal'));
}

async function lerSettings(cid) {
  const { rows } = await db.query(
    `SELECT COALESCE(studio_settings, '{}'::jsonb) AS s FROM companies WHERE id = $1`,
    [cid]
  );
  return rows.length ? (rows[0].s || {}) : null;
}

/**
 * As despesas recorrentes do financeiro, uma linha por série.
 *
 * O financeiro grava recorrência em `transactions`: cada série tem um
 * `recurrence_group_id` e um `recurrence_type` (weekly | monthly | yearly),
 * com uma linha por vencimento. Só entra série VIVA (com vencimento neste
 * mês ou adiante): aluguel de um ponto que ela já entregou não é custo de
 * hoje. Qualquer falha aqui vira lista vazia — sugestão é conforto, não
 * pode derrubar a tela.
 */
async function lerRecorrentes(cid) {
  const consulta = (valor) => db.query(
    `SELECT recurrence_group_id::text AS grupo,
            MAX(recurrence_type)      AS tipo,
            MIN(description)          AS descricao,
            MAX(category)             AS categoria,
            AVG(${valor})::float      AS valor
       FROM transactions
      WHERE company_id = $1
        AND type = 'expense'
        AND recurrence_group_id IS NOT NULL
        AND status::text NOT IN ('cancelled', 'canceled')
      GROUP BY recurrence_group_id
     HAVING MAX(due_date) >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))::date
      LIMIT 200`,
    [cid]
  );
  try {
    // original_amount (migration 362) guarda o valor combinado quando a
    // baixa foi por outro valor — e é o combinado que é o custo fixo.
    let r;
    try {
      r = await consulta('COALESCE(original_amount, amount)');
    } catch (e) {
      if (e.code !== '42703') throw e;
      r = await consulta('amount');
    }
    return (r && r.rows) || [];
  } catch (e) {
    console.warn('[studio/preco-certo] recorrentes indisponiveis:', e.message);
    return [];
  }
}

/**
 * Receita por mês dos últimos 6 meses FECHADOS.
 *
 * É a mesma fonte do DRE (routes/dre.js): `transactions` com type='income'
 * e status='confirmed', no mês de `paid_at`. Venda do PDV e pedido da
 * vitrine confirmado já caem lá — não há um faturamento "do Studio" à parte.
 */
async function lerReceitaMensal(cid) {
  try {
    const { rows } = await db.query(
      `SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS mes,
              COALESCE(SUM(amount), 0)::float                  AS receita
         FROM transactions
        WHERE company_id = $1
          AND type = 'income'
          AND status = 'confirmed'
          AND paid_at >= date_trunc('month', NOW()) - INTERVAL '6 months'
          AND paid_at <  date_trunc('month', NOW())
        GROUP BY 1
        ORDER BY 1`,
      [cid]
    );
    return rows || [];
  } catch (e) {
    console.warn('[studio/preco-certo] receita indisponivel:', e.message);
    return [];
  }
}

/** O mês corrente no relógio do banco (UTC), para deixar de fora da média. */
function mesAtual() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * As peças com ficha técnica e a mão de obra de cada uma.
 *
 * Produto desativado fica de fora (mesmo critério da vitrine,
 * `is_active IS NOT FALSE`): ninguém reprecifica o que não vende. Base sem
 * a view (42P01/42703) devolve vazio — sem ficha não há o que diagnosticar.
 */
async function lerPecas(cid) {
  let linhas = [];
  try {
    const r = await db.query(
      `SELECT s.product_id, s.product_name, s.product_price, s.total_cost,
              s.item_count, p.image_url
         FROM studio_compositions_summary s
         JOIN products p ON p.id = s.product_id
        WHERE s.company_id = $1 AND s.is_active = true
          AND p.is_active IS NOT FALSE
        ORDER BY s.product_name`,
      [cid]
    );
    linhas = r.rows || [];
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }

  // labor_cost da regra ativa: a do produto, senão a global, senão 0.
  const porProduto = new Map();
  let global = 0;
  try {
    const r = await db.query(
      `SELECT product_id, labor_cost FROM studio_pricing_rules
        WHERE company_id = $1 AND is_active = true`,
      [cid]
    );
    for (const regra of r.rows || []) {
      const v = parseFloat(regra.labor_cost) || 0;
      if (regra.product_id == null) global = v;
      else porProduto.set(String(regra.product_id), v);
    }
  } catch (e) {
    console.warn('[studio/preco-certo] regras indisponiveis:', e.message);
  }
  const maoDeObraDe = (pid) => (porProduto.has(String(pid)) ? porProduto.get(String(pid)) : global);
  return { linhas, maoDeObraDe };
}

/** O corpo do GET /custos — o PUT devolve o mesmo, já com o que gravou. */
async function montarCustos(cid, settings) {
  const itens = pc.custosSalvos(settings);
  const total = pc.totalDosCustos(itens);
  const esperado = pc.faturamentoEsperado(settings);

  const [recorrentes, receita, pecas] = await Promise.all([
    lerRecorrentes(cid),
    lerReceitaMensal(cid),
    lerPecas(cid).catch((e) => {
      console.warn('[studio/preco-certo] pecas indisponiveis:', e.message);
      return { linhas: [], maoDeObraDe: () => 0 };
    }),
  ]);

  const faturamento = pc.faturamentoMedio(receita, mesAtual(), esperado);
  const fracao = pc.fracaoVariavelMedia(pecas.linhas.map((l) => ({
    custo: (parseFloat(l.total_cost) || 0) + pecas.maoDeObraDe(l.product_id),
    preco: l.product_price,
  })));

  return {
    itens,
    sugestoes_do_financeiro: pc.sugestoesDoFinanceiro(recorrentes, itens, eDespesaFixa),
    total_mensal: total,
    faturamento,
    faturamento_esperado: esperado,
    taxa_real_pct: pc.taxaReal(total, faturamento.medio),
    // null = ela nunca aceitou uma taxa (recurso não configurado; as contas usam 0).
    taxa_em_uso_pct: pc.taxaConfigurada(settings) ? pc.taxaEmUso(settings) : null,
    taxa_aceita_em: settings.taxa_custo_fixo_aceita_em || null,
    margem_minima_pct: margemMinima(settings),
    ponto_de_equilibrio: pc.pontoDeEquilibrio(total, fracao),
    custo_variavel_medio_pct: fracao == null ? null : Math.round(fracao * 10000) / 100,
  };
}

// ─────────────────────────────────────────────────────────────
// GET /studio/preco-certo/custos
// ─────────────────────────────────────────────────────────────
router.get('/preco-certo/custos', async (req, res) => {
  const cid = req.params.id;
  try {
    const settings = await lerSettings(cid);
    if (!settings) return res.status(404).json({ error: 'Empresa não encontrada' });
    return res.json(await montarCustos(cid, settings));
  } catch (e) {
    console.error('[studio/preco-certo] GET /custos', e.message);
    return res.status(500).json({ error: 'Erro ao carregar os custos fixos' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /studio/preco-certo/custos
// Body: { itens?, faturamento_esperado?, margem_minima_pct?, taxa_em_uso_pct? }
//
// Só mexe no que veio no corpo. `taxa_em_uso_pct` presente É o "aceitar a
// nova taxa" — ausente, a taxa em uso fica como está, mesmo que a lista
// de custos mude a taxa real. null em qualquer dos três opcionais limpa.
// ─────────────────────────────────────────────────────────────
router.put('/preco-certo/custos', async (req, res) => {
  const cid = req.params.id;
  const body = req.body || {};
  const patch = {};

  if (body.itens !== undefined) {
    const v = pc.normalizarCustos(body.itens);
    if (!v.ok) return res.status(400).json({ error: v.error });
    patch.custos_fixos = v.value;
  }

  if (body.faturamento_esperado !== undefined) {
    const f = body.faturamento_esperado;
    if (f !== null && (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f > 999999999)) {
      return res.status(400).json({ error: 'faturamento_esperado deve ser um número maior ou igual a zero' });
    }
    patch.faturamento_esperado = f === null ? null : Math.round(f * 100) / 100;
  }

  if (body.margem_minima_pct !== undefined) {
    const m = body.margem_minima_pct;
    if (m !== null && (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > 95)) {
      return res.status(400).json({ error: 'margem_minima_pct deve ser um número de 0 a 95' });
    }
    patch.margem_minima_pct = m;
  }

  if (body.taxa_em_uso_pct !== undefined) {
    const t = body.taxa_em_uso_pct;
    if (t !== null && (typeof t !== 'number' || pc.taxaValida(t) == null)) {
      return res.status(400).json({ error: `taxa_em_uso_pct deve ser um número de 0 a ${pc.TAXA_MAXIMA}` });
    }
    patch.taxa_custo_fixo_pct = t === null ? null : Math.round(t * 100) / 100;
    patch.taxa_custo_fixo_aceita_em = t === null ? null : new Date().toISOString();
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      error: 'nada pra gravar (envie itens, faturamento_esperado, margem_minima_pct ou taxa_em_uso_pct)',
    });
  }

  try {
    const atual = await lerSettings(cid);
    if (!atual) return res.status(404).json({ error: 'Empresa não encontrada' });

    // Taxa e piso juntos não podem comer o preço inteiro: a partir de 95%
    // não há preço sugerido para peça nenhuma, e a tela ficaria muda.
    const depois = { ...atual, ...patch };
    if (patch.taxa_custo_fixo_pct !== undefined || patch.margem_minima_pct !== undefined) {
      const soma = pc.taxaEmUso(depois) + margemMinima(depois);
      // Sem taxa a conta é a de antes do recurso, e o piso segue livre até 95.
      if (pc.taxaEmUso(depois) > 0 && soma >= pc.TETO_TAXA_MAIS_MARGEM) {
        return res.status(400).json({
          error: `A taxa de custo fixo (${pc.taxaEmUso(depois)}%) somada à margem mínima (${margemMinima(depois)}%) `
            + `precisa ficar abaixo de ${pc.TETO_TAXA_MAIS_MARGEM}%`,
        });
      }
    }

    // Mesmo merge do PATCH /studio/settings: só as chaves do patch mudam.
    const r = await db.query(
      `UPDATE companies
          SET studio_settings = COALESCE(studio_settings, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2
        RETURNING COALESCE(studio_settings, '{}'::jsonb) AS s`,
      [JSON.stringify(patch), cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    return res.json(await montarCustos(cid, r.rows[0].s || depois));
  } catch (e) {
    console.error('[studio/preco-certo] PUT /custos', e.message);
    return res.status(500).json({ error: 'Erro ao salvar os custos fixos' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /studio/preco-certo/diagnostico
// ─────────────────────────────────────────────────────────────
router.get('/preco-certo/diagnostico', async (req, res) => {
  const cid = req.params.id;
  try {
    const settings = await lerSettings(cid);
    if (!settings) return res.status(404).json({ error: 'Empresa não encontrada' });
    const taxa = pc.taxaEmUso(settings);
    const piso = margemMinima(settings);

    const { linhas, maoDeObraDe } = await lerPecas(cid);
    const d = pc.diagnostico(linhas, { taxaPct: taxa, piso, maoDeObraDe });

    // Produto sem ficha só conta: ele não "está ruim", nunca foi medido.
    let semFicha = 0;
    try {
      const r = await db.query(
        `SELECT COUNT(*)::int AS n
           FROM products p
          WHERE p.company_id = $1
            AND p.is_active IS NOT FALSE
            AND NOT EXISTS (
              SELECT 1 FROM studio_compositions c
               WHERE c.company_id = $1 AND c.product_id = p.id AND c.is_active = true
            )`,
        [cid]
      );
      semFicha = parseInt(r.rows[0] && r.rows[0].n, 10) || 0;
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    return res.json({
      pecas: d.pecas,
      resumo: { ...d.resumo, sem_ficha: semFicha },
      taxa_em_uso_pct: taxa,
      taxa_configurada: pc.taxaConfigurada(settings),
      margem_minima_pct: piso,
    });
  } catch (e) {
    console.error('[studio/preco-certo] GET /diagnostico', e.message);
    return res.status(500).json({ error: 'Erro ao calcular o diagnóstico' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /studio/preco-certo/aplicar
// Body: { itens: [{ product_id, price }] }  (máx. 200)
//
// O preço vem da TELA: é o número que ela viu e aceitou. O servidor não
// recalcula — recalcular trocaria o preço entre o clique e a gravação se
// um insumo mudasse no meio. Só valida e grava.
//
// Tudo ou nada: um produto que não é desta empresa derruba o lote inteiro
// antes de qualquer UPDATE. Gravar "os que deu" deixaria a lojista sem
// saber quais preços mudaram.
//
// Mesmo caminho do PATCH /products/:pid — UPDATE em products.price, sem
// efeito colateral. card_price não é tocado: null segue o percentual da
// loja sobre o preço novo; valor próprio é escolha dela e fica.
// ─────────────────────────────────────────────────────────────
router.post('/preco-certo/aplicar', async (req, res) => {
  const cid = req.params.id;
  const itens = (req.body || {}).itens;

  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ error: 'Escolha ao menos um produto' });
  }
  if (itens.length > MAXIMO_DE_PRECOS) {
    return res.status(400).json({ error: `No máximo ${MAXIMO_DE_PRECOS} produtos por vez` });
  }
  const limpos = [];
  const vistos = new Set();
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i] || {};
    const pid = String(it.product_id || '').toLowerCase();
    if (!UUID_RE.test(pid)) return res.status(400).json({ error: `product_id inválido no item ${i + 1}` });
    if (vistos.has(pid)) return res.status(400).json({ error: `Produto repetido no item ${i + 1}` });
    vistos.add(pid);
    if (typeof it.price !== 'number' || !Number.isFinite(it.price)) {
      return res.status(400).json({ error: `price deve ser um número (item ${i + 1})` });
    }
    const price = Math.round(it.price * 100) / 100;
    if (!(price > 0) || price > PRECO_MAXIMO) {
      return res.status(400).json({ error: `price deve ser maior que zero (item ${i + 1})` });
    }
    limpos.push({ product_id: pid, price });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const donos = await client.query(
      `SELECT id FROM products WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [cid, limpos.map((l) => l.product_id)]
    );
    const meus = new Set((donos.rows || []).map((r) => String(r.id).toLowerCase()));
    const deFora = limpos.filter((l) => !meus.has(l.product_id)).map((l) => l.product_id);
    if (deFora.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Produto não encontrado nesta empresa — nenhum preço foi alterado',
        product_ids: deFora,
      });
    }

    const atualizados = [];
    for (const l of limpos) {
      const r = await client.query(
        `UPDATE products SET price = $1, updated_at = NOW()
          WHERE id = $2 AND company_id = $3
          RETURNING id, name, price`,
        [l.price, l.product_id, cid]
      );
      if (!r.rows.length) throw new Error('produto sumiu no meio da gravacao: ' + l.product_id);
      atualizados.push({
        product_id: r.rows[0].id,
        nome: r.rows[0].name,
        price: parseFloat(r.rows[0].price),
      });
    }

    await client.query('COMMIT');

    // A home da vitrine fica guardada por 60 s (cacheDaPaginaDaLoja) com o
    // preço antigo. Quem salva aqui não sabe o slug: esquece todas, como
    // faz o upload de imagem em digitalChannel.js.
    esquecerPagina();

    return res.json({ atualizados, count: atualizados.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[studio/preco-certo] POST /aplicar', e.message);
    return res.status(500).json({ error: 'Erro ao aplicar os preços — nenhum preço foi alterado' });
  } finally {
    client.release();
  }
});

module.exports = router;
