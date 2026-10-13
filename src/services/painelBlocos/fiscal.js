// Bloco "Fiscal": NFC-e emitidas e rejeitadas por loja.
'use strict';

const b = require('./_base');

// Tudo que não virou nota autorizada por problema da emissão.
const REJEITADA = `('rejeitada', 'erro', 'falha')`;

async function calcular({ hoje, periodo = 7, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const [rows, motivos] = await Promise.all([
    b.opcional(
      db,
      `SELECT company_id, ${b.diaBRT('created_at')} AS dia,
              COUNT(*) AS emitidas,
              COUNT(*) FILTER (WHERE status IN ${REJEITADA}) AS rejeitadas
         FROM nfce_emissions
        WHERE created_at >= ${b.desde(periodo)}
        GROUP BY 1, 2`,
      [hoje]
    ),
    b.opcional(
      db,
      `SELECT DISTINCT ON (company_id) company_id,
              COALESCE(NULLIF(last_error, ''), NULLIF(error_message, ''), rejection_code) AS motivo
         FROM nfce_emissions
        WHERE status IN ${REJEITADA} AND created_at >= ${b.desde(periodo)}
        ORDER BY company_id, created_at DESC`,
      [hoje]
    ),
  ]);
  const motivoDe = new Map(motivos.map((m) => [m.company_id, m.motivo]));
  const dados = rows.filter((r) => emp.porId.has(r.company_id));

  const dias = Array.from({ length: Math.min(periodo, 30) }, (_, i) => b.somaDias(hoje, -(Math.min(periodo, 30) - 1 - i)));
  const serie = dias.map((d) => {
    const doDia = dados.filter((r) => r.dia === d);
    return {
      rotulo: b.rotuloDia(d),
      valor: doDia.reduce((s, r) => s + b.num(r.emitidas), 0),
      rejeitadas: doDia.reduce((s, r) => s + b.num(r.rejeitadas), 0),
    };
  });

  const porLoja = new Map();
  for (const r of dados) {
    const g = porLoja.get(r.company_id) || { emitidas: 0, rejeitadas: 0 };
    g.emitidas += b.num(r.emitidas);
    g.rejeitadas += b.num(r.rejeitadas);
    porLoja.set(r.company_id, g);
  }
  const linhas = [...porLoja.entries()].map(([id, g]) => ({
    ...b.ref(emp.porId.get(id)),
    ...g,
    ultimo_motivo: g.rejeitadas ? (motivoDe.get(id) || null) : null,
  })).sort((x, y) => y.rejeitadas - x.rejeitadas || y.emitidas - x.emitidas);

  const emitidas = linhas.reduce((s, l) => s + l.emitidas, 0);
  const rejeitadas = linhas.reduce((s, l) => s + l.rejeitadas, 0);
  const aprovacao = emitidas ? Math.round(((emitidas - rejeitadas) / emitidas) * 100) : null;
  const comRejeicao = linhas.filter((l) => l.rejeitadas > 0);

  return b.montarBloco({
    valor: rejeitadas,
    unidade: `${rejeitadas === 1 ? 'rejeitada' : 'rejeitadas'} de ${emitidas} emitidas`,
    resumo: aprovacao === null ? `Nenhuma NFC-e em ${periodo} dias` : `${aprovacao}% autorizadas · ${b.plural(linhas.length, 'loja emite', 'lojas emitem')}`,
    serie,
    linhas,
    fonte: 'nfce_emissions',
    indicadores: [
      b.indicador('Emitidas', emitidas, `${periodo} dias`),
      b.indicador('Rejeitadas', rejeitadas),
      b.indicador('Autorizadas', aprovacao === null ? null : `${aprovacao}%`),
      b.indicador('Lojas emitindo', linhas.length),
    ],
    listas: [
      b.lista(`NFC-e por loja · ${periodo} dias`, [
        b.colLoja(), b.col('emitidas', 'Emitidas', 'numero'), b.col('rejeitadas', 'Rejeitadas', 'numero'),
        b.col('ultimo_motivo', 'Último motivo'),
      ], linhas),
    ],
    series: [b.serieDe('NFC-e por dia', 'barras', serie)],
    insight: comRejeicao.length
      ? `${comRejeicao.map((l) => `${l.nome} (${l.rejeitadas})`).join(', ')}: rejeição em ${periodo} dias.`
      : null,
  });
}

module.exports = { calcular, REJEITADA };
