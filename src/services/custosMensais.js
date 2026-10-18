// ============================================================
// AURA. — Custos mensais da Aura (18/10/2026, card f5-06, pedido da Financeiro)
//
// Os custos de cada mês moram em aura_revenue_snapshot (migration 382):
//   custos_detalhe  jsonb { categoria: { valor, origem, observacao, ... } }
//   total_costs     soma das categorias (SEM taxas da Asaas e SEM DAS)
//   gross_margin    mrr_total - total_costs no momento do lançamento
//
// Quem escreve o quê na MESMA linha (reference_month = dia 1 do mês):
//   - o job diário do painel (services/receita.gravarSnapshot) só escreve
//     clients_* e mrr_* do mês corrente. Nunca toca em custos;
//   - o lançamento manual (lancarCustos, abaixo) só escreve custos_detalhe,
//     total_costs e gross_margin. Nunca toca em clientes e MRR.
// Assim um não apaga o outro, com ou sem linha prévia do mês: os dois fazem
// INSERT ... ON CONFLICT (reference_month) DO UPDATE só das próprias colunas.
//
// A margem que o painel mostra é calculada na leitura (mrr_total do job menos
// total_costs): gross_margin do mês corrente envelhece quando o MRR muda.
// ============================================================
'use strict';

const pool = require('../config/database');

// Categorias aceitas no lançamento, na ordem da tela. `demais` é a sobra sem
// abertura que a migration 382 gravou de maio a setembro: dá para corrigir
// (redistribuir e zerar), não é oferecida para mês novo.
const CATEGORIAS = [
  { id: 'infraestrutura', rotulo: 'Infraestrutura', ajuda: 'Railway, Supabase, Cloudflare, domínio' },
  { id: 'anthropic', rotulo: 'Anthropic', ajuda: 'API e assinatura do Claude' },
  { id: 'meta', rotulo: 'Meta', ajuda: 'WhatsApp Business e anúncios' },
  { id: 'outros', rotulo: 'Outros', ajuda: 'Ferramentas e o que não cabe acima' },
  { id: 'demais', rotulo: 'Demais (sem abertura)', ajuda: 'Total antigo sem categoria', legado: true },
];
const POR_CATEGORIA = new Map(CATEGORIAS.map((c) => [c.id, c]));

// De onde saiu o dinheiro (ou o número). 'socio' é o que a migration 382 usa
// para a Anthropic paga na conta pessoal.
const ORIGENS = [
  { id: 'empresa', rotulo: 'Conta da empresa' },
  { id: 'socio', rotulo: 'Conta pessoal do sócio' },
  { id: 'estimativa', rotulo: 'Estimativa' },
];
const POR_ORIGEM = new Map(ORIGENS.map((o) => [o.id, o]));

const VALOR_MAX = 1000000;
const OBSERVACAO_MAX = 200;
const MOTIVO_MAX = 500;
const MES_MINIMO = '2025-01';
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const round2 = (v) => Math.round(num(v) * 100) / 100;

const rotuloCategoria = (id) => (POR_CATEGORIA.get(id) ? POR_CATEGORIA.get(id).rotulo : id);
const rotuloOrigem = (id) => (id ? (POR_ORIGEM.get(id) ? POR_ORIGEM.get(id).rotulo : String(id)) : null);

// 'YYYY-MM' do dia de Brasília.
function mesDe(hoje) {
  return String(hoje).slice(0, 7);
}

// Valor em reais: número (ou texto com ponto decimal), finito, >= 0, até
// 2 casas. Vírgula decimal não é aceita: o app manda número.
function lerValor(v) {
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return { erro: 'deve ser um número' };
  if (v < 0) return { erro: 'não pode ser negativo' };
  if (v > VALOR_MAX) return { erro: `passa de R$ ${VALOR_MAX.toLocaleString('pt-BR')}` };
  if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) return { erro: 'tem mais de 2 casas decimais' };
  return { valor: round2(v) };
}

// Valida o corpo do POST /admin/painel/custos. Devolve { erro } ou { valor }.
//   { mes: 'YYYY-MM',
//     categorias: { infraestrutura: { valor, origem, observacao? }, ... },
//     motivo?: texto }
function normalizarLancamento(corpo, { hoje }) {
  const c = corpo && typeof corpo === 'object' ? corpo : {};
  const mes = typeof c.mes === 'string' ? c.mes.trim() : '';
  if (!MES_RE.test(mes)) return { erro: 'mes deve ser YYYY-MM' };
  if (mes < MES_MINIMO) return { erro: `mes deve ser de ${MES_MINIMO} em diante` };
  if (mes > mesDe(hoje)) return { erro: 'mes no futuro: lance o custo quando o mês começar' };

  const cats = c.categorias;
  if (!cats || typeof cats !== 'object' || Array.isArray(cats) || !Object.keys(cats).length) {
    return { erro: 'categorias deve ter ao menos uma categoria com valor' };
  }
  const categorias = {};
  for (const [id, item] of Object.entries(cats)) {
    if (!POR_CATEGORIA.has(id)) {
      return { erro: `categoria desconhecida: ${id}. Use: ${CATEGORIAS.map((x) => x.id).join(', ')}` };
    }
    if (!item || typeof item !== 'object') return { erro: `${id}: informe { valor, origem }` };
    const v = lerValor(item.valor);
    if (v.erro) return { erro: `${id}: valor ${v.erro}` };
    const origem = typeof item.origem === 'string' ? item.origem.trim() : '';
    if (!POR_ORIGEM.has(origem)) {
      return { erro: `${id}: origem deve ser ${ORIGENS.map((o) => o.id).join(', ')}` };
    }
    let observacao = null;
    if (item.observacao !== undefined && item.observacao !== null) {
      if (typeof item.observacao !== 'string') return { erro: `${id}: observacao deve ser texto` };
      observacao = item.observacao.trim() || null;
      if (observacao && observacao.length > OBSERVACAO_MAX) {
        return { erro: `${id}: observacao passa de ${OBSERVACAO_MAX} caracteres` };
      }
    }
    categorias[id] = { valor: v.valor, origem, observacao };
  }

  let motivo = null;
  if (c.motivo !== undefined && c.motivo !== null) {
    if (typeof c.motivo !== 'string') return { erro: 'motivo deve ser texto' };
    motivo = c.motivo.trim() || null;
    if (motivo && motivo.length > MOTIVO_MAX) return { erro: `motivo passa de ${MOTIVO_MAX} caracteres` };
  }
  return { valor: { mes, categorias, motivo } };
}

// O detalhe de uma linha do snapshot como lista ordenada (categorias
// conhecidas na ordem da tela, depois as desconhecidas). Linha com total e
// sem detalhe (abril, digitado) vira uma linha "sem abertura".
function itensDoMes(linha) {
  if (!linha) return [];
  const det = linha.custos_detalhe && typeof linha.custos_detalhe === 'object' ? linha.custos_detalhe : null;
  if (!det) {
    const total = round2(linha.total_costs);
    return total > 0
      ? [{ categoria: 'sem_abertura', rotulo: 'Sem abertura', valor: total, origem: null, observacao: 'total do snapshot, sem categoria', lancado_em: null }]
      : [];
  }
  const ordem = (id) => {
    const i = CATEGORIAS.findIndex((x) => x.id === id);
    return i < 0 ? CATEGORIAS.length : i;
  };
  return Object.keys(det)
    .sort((a, b) => ordem(a) - ordem(b) || a.localeCompare(b))
    .map((id) => {
      const it = det[id] && typeof det[id] === 'object' ? det[id] : { valor: det[id] };
      return {
        categoria: id,
        rotulo: rotuloCategoria(id),
        valor: round2(it.valor),
        origem: it.origem || null,
        observacao: it.observacao || null,
        lancado_em: it.lancado_em || null,
      };
    });
}

// Mês com custo: tem detalhe, ou tem total digitado.
const temCusto = (linha) => !!linha && (!!linha.custos_detalhe || round2(linha.total_costs) > 0);

const COLUNAS = `to_char(reference_month, 'YYYY-MM') AS mes, mrr_total, total_costs, gross_margin,
            taxas_asaas, das, custos_detalhe, updated_at`;

// Os últimos `meses` meses até o mês de `hoje` (inclusive), do mais novo ao
// mais antigo. A marca `-- custos:snapshot` identifica a consulta nos testes.
async function lerMeses({ db = pool, hoje, meses = 6 }) {
  const { rows } = await db.query(
    `-- custos:snapshot
     SELECT ${COLUNAS}
       FROM aura_revenue_snapshot
      WHERE reference_month <= date_trunc('month', $1::date)::date
      ORDER BY reference_month DESC
      LIMIT $2`,
    [hoje, meses]
  );
  return rows || [];
}

async function lerMes({ db = pool, mes }) {
  const { rows } = await db.query(
    `-- custos:mes
     SELECT ${COLUNAS} FROM aura_revenue_snapshot WHERE reference_month = $1::date`,
    [`${mes}-01`]
  );
  return rows[0] || null;
}

// O que o formulário precisa para um mês: cada categoria com o valor atual.
function formularioDoMes(mes, linha) {
  const det = (linha && linha.custos_detalhe) || {};
  const itens = itensDoMes(linha);
  const categorias = CATEGORIAS
    // `demais` só aparece no mês que já tem esse valor.
    .filter((c) => !c.legado || det[c.id] !== undefined)
    .map((c) => {
      const it = itens.find((i) => i.categoria === c.id);
      return {
        id: c.id,
        rotulo: c.rotulo,
        ajuda: c.ajuda,
        valor: it ? it.valor : null,
        origem: it ? it.origem : null,
        observacao: it ? it.observacao : null,
        lancado_em: it ? it.lancado_em : null,
      };
    });
  return {
    mes,
    existe_linha: !!linha,
    mrr_total: linha ? round2(linha.mrr_total) : null,
    total_costs: linha ? round2(linha.total_costs) : 0,
    taxas_asaas: linha && linha.taxas_asaas !== null && linha.taxas_asaas !== undefined ? round2(linha.taxas_asaas) : null,
    das: linha && linha.das !== null && linha.das !== undefined ? round2(linha.das) : null,
    sem_abertura: itens.filter((i) => i.categoria === 'sem_abertura').reduce((t, i) => t + i.valor, 0) || null,
    categorias,
    origens: ORIGENS,
  };
}

// Lança (ou corrige) as categorias pedidas no mês, numa transação:
//   1. trava a linha do mês (FOR UPDATE), se existir;
//   2. junta as categorias novas ao detalhe que já existe (as que não vieram
//      ficam como estão); total sem detalhe (abril) vira `demais`, para nada
//      sumir da soma;
//   3. INSERT ... ON CONFLICT DO UPDATE só de custos_detalhe, total_costs e
//      gross_margin — clientes, MRR e notas, que são do job e da migration,
//      ficam intactos; sem linha, cria a linha só com os custos (o job
//      preenche o MRR depois, no mesmo upsert de sempre);
//   4. grava admin_audit_log (action 'set_monthly_cost') com antes e depois.
async function lancarCustos({ db = pool, staffUserId, lancamento, agora = new Date() }) {
  const { mes, categorias, motivo } = lancamento;
  const referencia = `${mes}-01`;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: atuais } = await client.query(
      `-- custos:travar
       SELECT ${COLUNAS} FROM aura_revenue_snapshot WHERE reference_month = $1::date FOR UPDATE`,
      [referencia]
    );
    const antes = atuais[0] || null;

    const detalhe = {};
    if (antes && antes.custos_detalhe && typeof antes.custos_detalhe === 'object') {
      Object.assign(detalhe, antes.custos_detalhe);
    } else if (antes && round2(antes.total_costs) > 0) {
      detalhe.demais = {
        valor: round2(antes.total_costs),
        observacao: 'total anterior sem abertura por categoria',
      };
    }
    const quando = agora.toISOString();
    for (const [id, item] of Object.entries(categorias)) {
      detalhe[id] = {
        valor: item.valor,
        origem: item.origem,
        ...(item.observacao ? { observacao: item.observacao } : {}),
        lancado_em: quando,
        lancado_por: staffUserId,
      };
    }
    const total = round2(Object.values(detalhe).reduce((t, it) => t + num(it && it.valor), 0));

    const { rows: gravadas } = await client.query(
      `-- custos:gravar
       INSERT INTO aura_revenue_snapshot (reference_month, custos_detalhe, total_costs, gross_margin)
       VALUES ($1::date, $2::jsonb, $3, -$3::numeric)
       ON CONFLICT (reference_month) DO UPDATE SET
         custos_detalhe = EXCLUDED.custos_detalhe,
         total_costs = EXCLUDED.total_costs,
         gross_margin = COALESCE(aura_revenue_snapshot.mrr_total, 0) - EXCLUDED.total_costs,
         updated_at = NOW()
       RETURNING ${COLUNAS}`,
      [referencia, JSON.stringify(detalhe), total]
    );
    const depois = gravadas[0];

    await client.query(
      `INSERT INTO admin_audit_log (staff_user_id, company_id, action, payload, reason)
       VALUES ($1, NULL, 'set_monthly_cost', $2, $3)`,
      [
        staffUserId,
        JSON.stringify({
          mes,
          criou_linha: !antes,
          categorias: Object.keys(categorias),
          antes: antes ? { total_costs: round2(antes.total_costs), custos_detalhe: antes.custos_detalhe || null } : null,
          depois: { total_costs: total, custos_detalhe: detalhe },
        }),
        motivo,
      ]
    );
    await client.query('COMMIT');
    return { antes, depois, criou_linha: !antes };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* já encerrada */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  CATEGORIAS,
  ORIGENS,
  VALOR_MAX,
  rotuloCategoria,
  rotuloOrigem,
  mesDe,
  lerValor,
  normalizarLancamento,
  itensDoMes,
  temCusto,
  lerMeses,
  lerMes,
  formularioDoMes,
  lancarCustos,
};
