// ============================================================
// AURA. — Conciliação do extrato da Aura com os repasses da Asaas (13/10/2026)
//
// Dupla checagem da receita: o OFX mensal da conta bancária da Aura
// (migration 373: aura_extratos / aura_extrato_lancamentos) é casado, crédito
// a crédito, com os pagamentos que a Asaas disse ter recebido (webhook_logs
// PAYMENT_RECEIVED / PAYMENT_CONFIRMED, um por cobrança).
//
// Regra do casamento (casarCreditos, função pura):
//   1. valor exato e data dentro de ±3 dias da data de referência do
//      pagamento (a Asaas repassa em D+1 a D+3);
//   2. depois, "com taxa": crédito igual ao valor líquido que a Asaas informa
//      (netValue) ou menor que o cobrado em até 5%.
//   Um pagamento só casa com um crédito; o que sobra fica pendente.
//
// Data de referência do pagamento: creditDate (quando a Asaas liberou o saldo
// — no cartão são ~32 dias depois da confirmação), senão paymentDate, senão o
// dia do evento em Brasília.
//
// A função de leitura (conferenciaPorMes) alimenta a rota GET /extratos e a
// tabela "Conferência com o extrato" do bloco Receita.
// ============================================================
'use strict';

const b = require('./painelBlocos/_base');

const JANELA_DIAS = 3;
const TAXA_MAXIMA = 0.05;
// Cartão: a Asaas confirma e só libera o saldo ~30 dias depois. Para achar o
// pagamento de um crédito, olha-se tanto para trás.
const ANTECEDENCIA_DIAS = 45;

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const rotuloMes = (ym) => MESES[parseInt(String(ym).slice(5, 7), 10) - 1] || ym;
const centavos = (v) => Math.round((Number(v) || 0) * 100);
const dataValida = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

function somaMes(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

// ── pagamentos da Asaas (um por cobrança) ──────────────────────
// Mesma regra do bloco Receita: o mês é o do primeiro evento pago da
// cobrança dentro da janela (CONFIRMED seguido de RECEIVED não conta duas
// vezes). `de`/`ate` são dias de Brasília ('YYYY-MM-DD'), inclusivos; com
// `chave` (id da cobrança ou do webhook_log) busca só aquela cobrança, em
// qualquer data.
async function pagamentosAsaas({ db = b.pool, de, ate, chave = null, consulta = b.consultar }) {
  const filtro = chave === null
    ? `AND processed_at >= ($1::date::timestamp AT TIME ZONE '${b.TZ}')
        AND processed_at < (($2::date + 1)::timestamp AT TIME ZONE '${b.TZ}')`
    : `AND (${b.PAGAMENTO_ASAAS}->>'id' = $1 OR id::text = $1)`;
  const rows = await consulta(
    db,
    `SELECT COALESCE(${b.PAGAMENTO_ASAAS}->>'id', id::text) AS chave,
            (array_agg(id ORDER BY processed_at))[1] AS log_id,
            (array_agg(company_id ORDER BY processed_at))[1] AS company_id,
            MIN(processed_at) AS processed_at,
            ${b.diaBRT('MIN(processed_at)')} AS dia,
            to_char(date_trunc('month', MIN(processed_at) AT TIME ZONE '${b.TZ}'), 'YYYY-MM') AS mes_conf,
            (array_agg(NULLIF(${b.PAGAMENTO_ASAAS}->>'value', '')::numeric ORDER BY processed_at))[1] AS valor,
            MAX(NULLIF(${b.PAGAMENTO_ASAAS}->>'netValue', '')::numeric) AS liquido,
            MAX(NULLIF(${b.PAGAMENTO_ASAAS}->>'creditDate', '')) AS credito_em,
            MAX(NULLIF(${b.PAGAMENTO_ASAAS}->>'paymentDate', '')) AS pago_em
       FROM webhook_logs
      WHERE provider = 'asaas'
        AND event IN ${b.EVENTOS_PAGOS}
        ${filtro}
      GROUP BY 1`,
    chave === null ? [de, ate] : [chave]
  );
  return rows.map((r) => ({
    chave: r.chave,
    log_id: r.log_id,
    company_id: r.company_id || null,
    processed_at: r.processed_at,
    mes: r.mes_conf,
    valor: b.round2(r.valor),
    liquido: r.liquido === null || r.liquido === undefined ? null : b.round2(r.liquido),
    data_ref: dataValida(r.credito_em) || dataValida(r.pago_em) || dataValida(r.dia),
  }));
}

// ── casamento (puro) ───────────────────────────────────────────
function categoria(credito, pagamento) {
  const c = centavos(credito.valor);
  const v = centavos(pagamento.valor);
  if (c <= 0 || v <= 0) return null;
  if (c === v) return 'exato';
  if (pagamento.liquido !== null && pagamento.liquido !== undefined && c === centavos(pagamento.liquido)) return 'taxa';
  // 5% em inteiros: (v - c) / v <= 1/20 (0.05 em float erra o limite exato).
  if (c < v && (v - c) * Math.round(1 / TAXA_MAXIMA) <= v) return 'taxa';
  return null;
}

/**
 * creditos:   [{ id, data 'YYYY-MM-DD', valor }]
 * pagamentos: [{ chave, valor, liquido?, data_ref 'YYYY-MM-DD' }]
 * Devolve Map<creditoId, { chave, taxa }>. Duas passadas — primeiro todos os
 * exatos, depois os "com taxa" — para um crédito com taxa não roubar o
 * pagamento de um crédito exato. Em cada passada, o pagamento mais próximo
 * da data vence.
 */
function casarCreditos(creditos, pagamentos, { janelaDias = JANELA_DIAS } = {}) {
  const resultado = new Map();
  const usados = new Set();
  const ordenados = creditos.slice().sort((x, y) => (x.data < y.data ? -1 : x.data > y.data ? 1 : centavos(x.valor) - centavos(y.valor) || String(x.id).localeCompare(String(y.id))));

  for (const alvo of ['exato', 'taxa']) {
    for (const cr of ordenados) {
      if (resultado.has(cr.id)) continue;
      let melhor = null;
      for (const p of pagamentos) {
        if (usados.has(p.chave) || !p.data_ref) continue;
        if (categoria(cr, p) !== alvo) continue;
        const dist = Math.abs(b.diasEntre(p.data_ref, cr.data));
        if (dist > janelaDias) continue;
        const chaveOrdem = [dist, Math.abs(centavos(p.valor) - centavos(cr.valor))];
        if (!melhor || chaveOrdem[0] < melhor.ordem[0]
          || (chaveOrdem[0] === melhor.ordem[0] && (chaveOrdem[1] < melhor.ordem[1]
            || (chaveOrdem[1] === melhor.ordem[1] && String(p.chave) < String(melhor.p.chave))))) {
          melhor = { p, ordem: chaveOrdem };
        }
      }
      if (melhor) {
        usados.add(melhor.p.chave);
        resultado.set(cr.id, { chave: melhor.p.chave, taxa: alvo === 'taxa' });
      }
    }
  }
  return resultado;
}

// Concilia os créditos PENDENTES de um extrato. `creditos` pode vir pronto
// (a importação acabou de inserir) para poupar uma ida ao banco.
async function conciliarExtrato({ db, extratoId, creditos }) {
  let pendentes = creditos;
  if (!pendentes) {
    const { rows } = await db.query(
      `SELECT id, to_char(data, 'YYYY-MM-DD') AS data, valor
         FROM aura_extrato_lancamentos
        WHERE extrato_id = $1 AND tipo = 'credito' AND status = 'pendente'
        ORDER BY data, id`,
      [extratoId]
    );
    pendentes = rows;
  }
  if (!pendentes.length) return { creditos: 0, conciliados: 0, com_taxa: 0, pendentes: 0 };

  const datas = pendentes.map((c) => c.data).sort();
  const pagamentos = await pagamentosAsaas({
    db,
    de: b.somaDias(datas[0], -ANTECEDENCIA_DIAS),
    ate: b.somaDias(datas[datas.length - 1], JANELA_DIAS),
  });
  const { rows: jaCasados } = await db.query(
    `SELECT conciliado_com FROM aura_extrato_lancamentos WHERE conciliado_com IS NOT NULL`
  );
  const ocupados = new Set(jaCasados.map((r) => r.conciliado_com));
  const livres = pagamentos.filter((p) => !ocupados.has(p.chave));

  const casados = casarCreditos(pendentes, livres);
  if (casados.size) {
    const ids = [];
    const chaves = [];
    const taxas = [];
    for (const [id, c] of casados) { ids.push(id); chaves.push(c.chave); taxas.push(c.taxa); }
    await db.query(
      `UPDATE aura_extrato_lancamentos l
          SET conciliado_com = m.chave, com_taxa = m.taxa, status = 'conciliado'
         FROM unnest($1::bigint[], $2::text[], $3::boolean[]) AS m(id, chave, taxa)
        WHERE l.id = m.id AND l.status = 'pendente'`,
      [ids, chaves, taxas]
    );
  }
  const comTaxa = [...casados.values()].filter((c) => c.taxa).length;
  return {
    creditos: pendentes.length,
    conciliados: casados.size,
    com_taxa: comTaxa,
    pendentes: pendentes.length - casados.size,
  };
}

// ── leitura: Asaas × banco por mês ─────────────────────────────
/**
 * Uma linha por mês (do mais antigo ao mais novo), até o mês de `hoje`.
 * `recebidos` = { 'YYYY-MM': [{ chave, valor }] } para os meses que o chamador
 * já tem (o bloco Receita passa os dois que ele mesmo calculou, assim o
 * número da tabela é o do indicador); os demais saem de webhook_logs.
 */
async function conferenciaPorMes({ db = b.pool, hoje, meses = 6, recebidos = {} }) {
  const mesAtual = hoje.slice(0, 7);
  const lista = Array.from({ length: meses }, (_, i) => somaMes(mesAtual, -(meses - 1 - i)));
  const inicio = `${lista[0]}-01`;

  const [extratos, casados] = await Promise.all([
    b.opcional(
      db,
      `SELECT e.id, to_char(e.mes, 'YYYY-MM') AS mes, e.nome_arquivo, e.importado_em,
              e.total_creditos, e.linhas,
              COUNT(*) FILTER (WHERE l.tipo = 'credito' AND l.status = 'conciliado') AS conciliados_n,
              COALESCE(SUM(l.valor) FILTER (WHERE l.tipo = 'credito' AND l.status = 'conciliado'), 0) AS conciliados_valor,
              COUNT(*) FILTER (WHERE l.tipo = 'credito' AND l.status = 'pendente') AS pendentes_n,
              COALESCE(SUM(l.valor) FILTER (WHERE l.tipo = 'credito' AND l.status = 'pendente'), 0) AS pendentes_valor,
              COUNT(*) FILTER (WHERE l.tipo = 'credito' AND l.status = 'ignorado') AS ignorados_n
         FROM aura_extratos e
         LEFT JOIN aura_extrato_lancamentos l ON l.extrato_id = e.id
        WHERE e.mes >= $1::date
        GROUP BY e.id
        ORDER BY e.mes, e.id`,
      [inicio]
    ),
    b.opcional(db, `SELECT conciliado_com FROM aura_extrato_lancamentos WHERE conciliado_com IS NOT NULL`),
  ]);
  const ocupados = new Set(casados.map((r) => r.conciliado_com));

  const faltam = lista.filter((m) => !recebidos[m]);
  const doBanco = new Map();
  if (faltam.length) {
    const pagamentos = await pagamentosAsaas({
      db, de: `${faltam[0]}-01`, ate: hoje, consulta: b.opcional,
    });
    for (const p of pagamentos) {
      if (!faltam.includes(p.mes)) continue;
      if (!doBanco.has(p.mes)) doBanco.set(p.mes, []);
      doBanco.get(p.mes).push({ chave: p.chave, valor: p.valor });
    }
  }

  return lista.map((mes) => {
    const pagamentos = recebidos[mes] || doBanco.get(mes) || [];
    const asaas = b.round2(pagamentos.reduce((t, p) => t + b.num(p.valor), 0));
    const doMes = extratos.filter((e) => e.mes === mes);
    const base = { mes, rotulo: rotuloMes(mes), asaas, pagamentos: pagamentos.length };
    if (!doMes.length) {
      return {
        ...base, banco: null, diferenca: null, conciliado: null, pendentes: null, sem_credito: null,
        status: 'sem extrato', detalhe: null, extratos: [],
      };
    }
    const soma = (campo) => b.round2(doMes.reduce((t, e) => t + b.num(e[campo]), 0));
    const inteiro = (campo) => doMes.reduce((t, e) => t + b.num(e[campo]), 0);
    const banco = soma('total_creditos');
    const semCredito = pagamentos.filter((p) => !ocupados.has(p.chave));
    const pendentes = { n: inteiro('pendentes_n'), valor: soma('pendentes_valor') };
    const semCreditoResumo = { n: semCredito.length, valor: b.round2(semCredito.reduce((t, p) => t + b.num(p.valor), 0)) };
    const partes = [];
    if (semCreditoResumo.n) partes.push(`${b.plural(semCreditoResumo.n, 'pagamento', 'pagamentos')} da Asaas sem crédito (${b.brl(semCreditoResumo.valor)})`);
    if (pendentes.n) partes.push(`${b.plural(pendentes.n, 'crédito', 'créditos')} sem pagamento (${b.brl(pendentes.valor)})`);
    return {
      ...base,
      banco,
      diferenca: b.round2(banco - asaas),
      conciliado: { n: inteiro('conciliados_n'), valor: soma('conciliados_valor') },
      pendentes,
      sem_credito: semCreditoResumo,
      status: partes.length ? 'pendências' : 'conciliado',
      detalhe: partes.length ? partes.join(' · ') : null,
      extratos: doMes.map((e) => ({
        id: e.id, nome_arquivo: e.nome_arquivo, importado_em: e.importado_em,
        total_creditos: b.round2(e.total_creditos), linhas: b.num(e.linhas),
      })),
    };
  });
}

module.exports = {
  JANELA_DIAS, TAXA_MAXIMA,
  rotuloMes, somaMes,
  pagamentosAsaas, casarCreditos, conciliarExtrato, conferenciaPorMes,
};
