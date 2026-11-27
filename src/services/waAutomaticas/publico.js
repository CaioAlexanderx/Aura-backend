// ============================================================
// AURA — WhatsApp: PÚBLICO e CORTE das automáticas (tela nova, 26/11/2026)
//
// Quem pode receber, em que ordem, e quantos cabem. A lista é cortada
// ANTES do clique (e antes do job): nenhum botão manda para mais gente
// do que cabe. Regras do Caio:
//   - uma novidade a cada 7 dias por cliente (todas as automáticas somadas);
//   - quem pediu para sair nunca recebe;
//   - sem telefone fica de fora;
//   - no máximo 50 por envio;
//   - ordem do corte: quem mais compra primeiro; no Crediário (vender),
//     quem tem mais limite livre.
//
// As funções puras (ordenar, classificar, cortar) são o que os testes
// provam; as consultas só trazem os candidatos e os dois conjuntos
// (recebeu há <7 dias, pediu para sair).
// ============================================================
'use strict';

const db = require('../../config/database');
const waOutbox = require('../waOutbox');
const quota = require('../marketing/marketingQuota');
const overdueRule = require('../credit/overdue');

const MAX_POR_ENVIO = 50;
const JANELA_DIAS = 7;
const LIMITE_CANDIDATOS = 500;

const MOTIVO = Object.freeze({
  SEM_TELEFONE: 'SEM_TELEFONE',
  OPT_OUT: 'OPT_OUT',
  RECENTE: 'RECEBEU_HA_MENOS_DE_7_DIAS',
  SEM_PECA: 'SEM_PECA_ULTIMA_COMPRA',
});

// Frase para a lojista de cada motivo de ficar de fora.
const MOTIVO_TEXTO = Object.freeze({
  SEM_TELEFONE: 'sem telefone',
  OPT_OUT: 'pediu para não receber',
  RECEBEU_HA_MENOS_DE_7_DIAS: 'recebeu novidade há menos de 7 dias',
  SEM_PECA_ULTIMA_COMPRA: 'sem a peça da última compra',
});

// Faixas do Venda+ (dias desde a última compra). "Sumiu" vai até 180:
// depois disso a pessoa mal lembra da loja (denúncia de spam).
const SEGMENTOS_VENDA_MAIS = Object.freeze({ sumindo: [31, 60], sumiu: [61, 180] });

function schemaMissing(e) { return !!e && (e.code === '42P01' || e.code === '42703'); }

// ── datas ────────────────────────────────────────────────────
function hojeBRT(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}
function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mesDe(iso) { return iso.slice(0, 7); }

/**
 * Nome da peça como a mensagem fala dela: minúsculas, sem código nem SKU
 * ("Vestido Verde - AB1234 (M)" -> "vestido verde"). null quando não sobra nome.
 */
function nomeDaPeca(nome) {
  let t = String(nome || '').toLowerCase();
  t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');                       // (M), [AB123]
  t = t.replace(/\b(?:sku|cod|cód|c[óo]digo|ref)\.?\s*[:#-]?\s*\S+/g, ' '); // "sku 123", "ref: ab1"
  t = t.replace(/\s[-–|\/]\s*\S*\d\S*\s*$/g, ' ');                      // " - AB123" no fim
  t = t.split(/\s+/).filter((w) => !(/\d/.test(w) && /[a-z]/.test(w) && w.length >= 4) && !(/^\d{5,}$/.test(w))).join(' ');
  t = t.replace(/[\s\-–|\/,;:.]+$/g, '').replace(/^[\s\-–|\/,;:.]+/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!t || t.length < 2) return null;
  return t.slice(0, 60);
}

/** Venda+: quem não tem a peça da última compra fica de fora (o modelo aprovado tem a variável fixa). */
function separarSemPeca(elegiveis) {
  const comPeca = []; const semPeca = [];
  for (const c of elegiveis) {
    if (c.ultima_peca) comPeca.push(c); else semPeca.push({ ...c, motivo: MOTIVO.SEM_PECA });
  }
  return { comPeca, semPeca };
}

const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Data (Date ou texto) -> 'YYYY-MM-DD' no dia de Brasília; null se não for data.
function isoBRT(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

/** "2026-08-14" -> "agosto". */
function mesPorExtenso(iso) {
  const m = Number(String(iso || '').slice(5, 7));
  return m >= 1 && m <= 12 ? MESES_PT[m - 1] : null;
}

// Campos que a prévia mostra por cliente além do detalhe (mockup): o limite
// livre do Crediário e a última compra do Venda+. Só aparecem quando a
// automática tem o dado.
function camposExtras(c) {
  const extra = {};
  if (c.limite_livre !== undefined && c.limite_livre !== null) {
    const n = Number(c.limite_livre);
    if (Number.isFinite(n)) extra.limite_livre = Math.round(n * 100) / 100;
  }
  const ultima = isoBRT(c.ultima_compra);
  if (ultima) { extra.ultima_compra = ultima; extra.mes_ultima_compra = mesPorExtenso(ultima); }
  // A PEÇA da última compra ({Última compra} no modelo): nunca a data.
  if (c.ultima_peca) extra.ultima_peca = c.ultima_peca;
  // O telefone da própria cliente (da lojista), só dígitos, para o botão
  // "Chamar pelo meu WhatsApp". Só quando existe e é válido.
  const telefone = waOutbox.normalizePhone(c.phone);
  if (telefone) extra.telefone = telefone;
  return extra;
}

// ── funções puras ────────────────────────────────────────────
// Do que mais pesa para o que menos pesa; empate pelo nome (estável).
function ordenar(cands, campo = 'total_spent') {
  return cands.slice().sort((a, b) => {
    const d = Number(b[campo] || 0) - Number(a[campo] || 0);
    if (d !== 0) return d;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });
}

/**
 * Separa quem pode receber de quem fica de fora, com o motivo.
 * `recentes` e `optouts` são Sets de telefone normalizado.
 */
function classificar(cands, { recentes = new Set(), optouts = new Set() } = {}) {
  const elegiveis = []; const fora = [];
  for (const c of cands) {
    const fone = waOutbox.normalizePhone(c.phone);
    if (!fone) { fora.push({ ...c, motivo: MOTIVO.SEM_TELEFONE }); continue; }
    if (c.marketing_opt_out === true || optouts.has(fone)) { fora.push({ ...c, motivo: MOTIVO.OPT_OUT }); continue; }
    if (recentes.has(fone)) { fora.push({ ...c, motivo: MOTIVO.RECENTE }); continue; }
    elegiveis.push({ ...c, fone });
  }
  return { elegiveis, fora };
}

/** Corte: os `livres` primeiros (já ordenados), nunca mais que `max`. */
function cortar(elegiveis, livres, max = MAX_POR_ENVIO) {
  const n = Math.max(0, Math.min(Math.floor(Number(livres) || 0), max, elegiveis.length));
  return { vao: elegiveis.slice(0, n), guardados: elegiveis.slice(n) };
}

function contarForas(fora) {
  const c = (m) => fora.filter((x) => x.motivo === m).length;
  return {
    recebeu_ha_menos_de_7_dias: c(MOTIVO.RECENTE),
    pediu_para_nao_receber: c(MOTIVO.OPT_OUT),
    sem_telefone: c(MOTIVO.SEM_TELEFONE),
    sem_a_peca_da_ultima_compra: c(MOTIVO.SEM_PECA),
  };
}

function iniciais(nome) {
  const p = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

function reais(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'R$ 0,00';
  const [i, d] = Math.abs(n).toFixed(2).split('.');
  return `R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`;
}

/** Corpo do GET .../publico para as automáticas de novidade. */
function montarPrevia({ key, periodo, elegiveis, fora, livres, ordem, detalhe }) {
  const { vao, guardados } = cortar(elegiveis, livres);
  const item = (c) => ({ customer_id: c.id, nome: c.name || 'Cliente', iniciais: iniciais(c.name), detalhe: detalhe(c), ...camposExtras(c) });
  return {
    key, periodo,
    elegiveis: elegiveis.length,
    cabem: vao.length,
    livres: Math.max(0, Number(livres) || 0),
    ordem,
    vao: vao.map((c) => ({ ...item(c), telefone_final: String(c.fone || '').slice(-4) })),
    ficam_guardados: guardados.length,
    guardados: guardados.slice(0, 20).map(item),
    fora: contarForas(fora),
    fora_lista: fora.slice(0, 50).map((c) => ({ customer_id: c.id, nome: c.name || 'Cliente', motivo: c.motivo, motivo_texto: MOTIVO_TEXTO[c.motivo] || null, ...camposExtras(c) })),
    falta_para_todos: Math.max(0, elegiveis.length - Math.max(0, Number(livres) || 0)),
  };
}

// ── consultas ────────────────────────────────────────────────
// Dois conjuntos de uma vez, para a lista inteira (nada de uma ida ao
// banco por cliente).
async function conjuntosDeBloqueio(companyId, cands) {
  const fones = [...new Set(cands.map((c) => waOutbox.normalizePhone(c.phone)).filter(Boolean))];
  const out = { recentes: new Set(), optouts: new Set() };
  if (!fones.length) return out;
  try {
    const rec = await db.query(
      `-- wa:publico-recentes
       SELECT DISTINCT to_phone FROM wa_outbox
        WHERE company_id = $1 AND to_phone = ANY($2::text[])
          AND source_type = ANY($3::text[])
          AND status NOT IN ('skipped','failed')
          AND created_at > NOW() - ($4::int || ' days')::interval`,
      [companyId, fones, quota.MARKETING_SOURCE_TYPES, JANELA_DIAS]
    );
    rec.rows.forEach((r) => out.recentes.add(r.to_phone));
    const opt = await db.query(
      `-- wa:publico-optouts
       SELECT phone FROM wa_contacts
        WHERE company_id = $1 AND phone = ANY($2::text[]) AND opted_out_at IS NOT NULL`,
      [companyId, fones]
    );
    opt.rows.forEach((r) => out.optouts.add(r.phone));
  } catch (e) {
    // Na dúvida, bloqueia: sem poder ler, ninguém entra na lista.
    if (schemaMissing(e)) { fones.forEach((f) => { out.recentes.add(f); }); return out; }
    throw e;
  }
  return out;
}

async function classificarDoBanco(companyId, cands) {
  return classificar(cands, await conjuntosDeBloqueio(companyId, cands));
}

async function candidatosAniversario(companyId, mes) {
  try {
    const { rows } = await db.query(
      `-- wa:publico-aniversario
       SELECT c.id, c.name, c.phone, c.total_spent, c.marketing_opt_out,
              EXTRACT(DAY FROM c.birth_date)::int AS dia
         FROM customers c
        WHERE c.company_id = $1 AND c.is_active = true AND c.birth_date IS NOT NULL
          AND EXTRACT(MONTH FROM c.birth_date)::int = $2::int
        ORDER BY c.total_spent DESC NULLS LAST, c.name ASC
        LIMIT ${LIMITE_CANDIDATOS}`,
      [companyId, Number(mes)]
    );
    return rows;
  } catch (e) { if (schemaMissing(e)) return []; throw e; }
}

async function candidatosVendaMais(companyId, segmento, hoje) {
  const faixa = SEGMENTOS_VENDA_MAIS[segmento];
  if (!faixa) return [];
  try {
    const { rows } = await db.query(
      `-- wa:publico-venda-mais
       SELECT c.id, c.name, c.phone, c.total_spent, c.marketing_opt_out, c.last_purchase_at,
              COALESCE((SELECT MAX(s.created_at) FROM sales s
                         WHERE s.company_id = c.company_id AND s.customer_id = c.id AND s.status <> 'cancelled'),
                       c.last_purchase_at) AS ultima_compra,
              -- A peça da última venda não cancelada; havendo mais de um item, o de MAIOR VALOR
              -- (empate: o primeiro item gravado). Nome do produto cadastrado.
              (SELECT p.name FROM sales s
                 JOIN sale_items si ON si.sale_id = s.id
                 JOIN products p ON p.id = si.product_id
                WHERE s.company_id = c.company_id AND s.customer_id = c.id AND s.status <> 'cancelled'
                ORDER BY s.created_at DESC, si.total_price DESC NULLS LAST, si.id ASC LIMIT 1) AS ultima_peca_nome,
              ($2::date - c.last_purchase_at::date) AS dias_sem_comprar
         FROM customers c
        WHERE c.company_id = $1 AND c.is_active = true AND c.last_purchase_at IS NOT NULL
          AND ($2::date - c.last_purchase_at::date) BETWEEN $3 AND $4
        ORDER BY c.total_spent DESC NULLS LAST, c.name ASC
        LIMIT ${LIMITE_CANDIDATOS}`,
      [companyId, hoje, faixa[0], faixa[1]]
    );
    return rows.map((r) => ({ ...r, ultima_peca: nomeDaPeca(r.ultima_peca_nome) }));
  } catch (e) { if (schemaMissing(e)) return []; throw e; }
}

// Paga em dia (já pagou parcela e nenhuma está vencida) e tem limite livre.
async function candidatosCrediarioVender(companyId, hoje) {
  try {
    const { rows } = await db.query(
      `-- wa:publico-crediario-vender
       SELECT c.id, c.name, c.phone, c.total_spent, c.marketing_opt_out,
              (p.credit_limit - p.credit_used) AS limite_livre,
              p.total_paid_on_time, p.relationship_months
         FROM customer_credit_profiles p
         JOIN customers c ON c.id = p.customer_id AND c.company_id = p.company_id
        WHERE p.company_id = $1 AND p.status = 'active' AND c.is_active = true
          AND (p.credit_limit - p.credit_used) > 0 AND p.total_paid_on_time > 0
          AND NOT EXISTS (
            SELECT 1 FROM credit_installments ci
             WHERE ci.company_id = p.company_id AND ci.customer_id = p.customer_id
               AND ci.status IN ('pending','overdue')
               AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005
               AND ci.due_date < $2::date)
        ORDER BY (p.credit_limit - p.credit_used) DESC, c.name ASC
        LIMIT ${LIMITE_CANDIDATOS}`,
      [companyId, hoje]
    );
    return rows;
  } catch (e) { if (schemaMissing(e)) return []; throw e; }
}

// Parcelas que vencem em hoje + deslocamento (negativo = atraso).
async function parcelasParaCobrar(companyId, hoje, deslocamentos) {
  const alvos = deslocamentos.map((d) => somarDias(hoje, d));
  try {
    const { rows } = await db.query(
      `-- wa:publico-crediario-cobrar
       SELECT ci.id, ci.customer_id, ci.installment_number, ci.total_installments,
              (ci.amount_due - COALESCE(ci.covered_amount, 0)) AS valor, ci.due_date::text AS due_iso,
              COALESCE(cu.name, cu.phone) AS name, cu.phone, cu.id AS id_cliente
         FROM credit_installments ci
         JOIN customers cu ON cu.id = ci.customer_id
        WHERE ci.company_id = $1 AND ci.status IN ('pending','overdue')
          AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005
          AND ci.due_date = ANY($2::date[])
          AND ${overdueRule.ledgerDebtSql({ alias: 'ci', companyParam: '$1' })}
        ORDER BY (ci.amount_due - COALESCE(ci.covered_amount, 0)) DESC, ci.id ASC`,
      [companyId, alvos]
    );
    return rows.map((r) => ({ ...r, deslocamento: deslocamentos[alvos.indexOf(r.due_iso)] }));
  } catch (e) { if (schemaMissing(e)) return []; throw e; }
}

module.exports = {
  MAX_POR_ENVIO, JANELA_DIAS, MOTIVO, MOTIVO_TEXTO, nomeDaPeca, separarSemPeca, SEGMENTOS_VENDA_MAIS,
  hojeBRT, somarDias, mesDe, isoBRT, mesPorExtenso, camposExtras, MESES_PT, ordenar, classificar, cortar, contarForas, iniciais, reais, montarPrevia,
  conjuntosDeBloqueio, classificarDoBanco,
  candidatosAniversario, candidatosVendaMais, candidatosCrediarioVender, parcelasParaCobrar,
};
