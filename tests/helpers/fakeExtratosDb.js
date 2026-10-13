// ============================================================
// Banco de mentira do extrato OFX da Aura (migration 373).
//
// Guarda aura_extratos e aura_extrato_lancamentos em memória e responde às
// consultas de src/routes/adminPainelOfx.js e src/services/conciliacaoOfx.js
// pelo começo do SQL. Consulta desconhecida LANÇA: SQL novo sem teste
// aparece em vez de voltar vazio.
//
// Reproduz o índice único de conciliado_com (um pagamento, um crédito): o
// UPDATE que o violaria lança { code: '23505' }, como o Postgres.
// ============================================================
'use strict';

const HOJE = '2026-10-13';
const AGORA = new Date('2026-10-13T12:00:00.000Z');
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';

// Um pagamento da Asaas já agrupado por cobrança (a linha que o GROUP BY devolve).
function pagamento(chave, dia, valor, extra = {}) {
  return {
    chave,
    log_id: `log_${chave}`,
    company_id: null,
    processed_at: `${dia}T15:00:00.000Z`,
    dia,
    mes_conf: dia.slice(0, 7),
    valor: String(valor),
    liquido: null,
    credito_em: null,
    pago_em: dia,
    ...extra,
  };
}

function criar({ pagamentos = [], extratos = [], lancamentos = [] } = {}) {
  const estado = {
    pagamentos,
    extratos: extratos.map((e) => ({ ...e })),
    lancamentos: lancamentos.map((l) => ({ ...l })),
    seq: 100,
    log: [],
  };

  const violaUnico = (chave, ignorarId) => estado.lancamentos.some((l) => l.conciliado_com === chave && String(l.id) !== String(ignorarId));
  const unico = () => { const e = new Error('duplicate key value violates unique constraint "uq_aura_extrato_lancamentos_conciliado"'); e.code = '23505'; return e; };
  const recorte = (l) => ({ ...l });
  const extratoDe = (id) => estado.extratos.find((e) => String(e.id) === String(id));

  function responder(sqlBruto, params = []) {
    const s = sqlBruto.replace(/\s+/g, ' ').trim();
    estado.log.push(s);

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return [];
    if (s.startsWith('SELECT pg_advisory_xact_lock')) return [];

    // importação
    if (s.includes('FROM aura_extrato_lancamentos l JOIN aura_extratos e ON e.id = l.extrato_id')) {
      const mes = String(params[0]).slice(0, 7);
      return estado.lancamentos
        .filter((l) => (extratoDe(l.extrato_id) || {}).mes === mes)
        .map((l) => ({ fitid: l.fitid, data: l.data, valor: l.valor, extrato_id: l.extrato_id }));
    }
    if (s.startsWith('INSERT INTO aura_extratos')) {
      const [mes, nome, por, total, linhas] = params;
      const e = {
        id: String(++estado.seq), mes: String(mes).slice(0, 7), nome_arquivo: nome, importado_em: AGORA.toISOString(),
        importado_por: por, total_creditos: String(total), linhas,
      };
      estado.extratos.push(e);
      return [recorte(e)];
    }
    if (s.startsWith('INSERT INTO aura_extrato_lancamentos')) {
      const [extratoId, datas, valores, descricoes, fitids, tipos] = params;
      const inseridos = [];
      datas.forEach((data, i) => {
        if (estado.lancamentos.some((l) => String(l.extrato_id) === String(extratoId) && l.fitid === fitids[i])) return;
        const l = {
          id: String(++estado.seq), extrato_id: String(extratoId), data, valor: String(valores[i]), descricao: descricoes[i],
          fitid: fitids[i], tipo: tipos[i], conciliado_com: null, com_taxa: false,
          status: tipos[i] === 'credito' ? 'pendente' : 'ignorado',
        };
        estado.lancamentos.push(l);
        inseridos.push({ id: l.id, data: l.data, valor: l.valor, tipo: l.tipo });
      });
      return inseridos;
    }

    // Asaas
    if (s.includes('FROM webhook_logs') && s.includes('GROUP BY 1')) {
      if (s.includes("id::text = $1")) {
        return estado.pagamentos.filter((p) => p.chave === params[0] || p.log_id === params[0]);
      }
      const [de, ate] = params;
      return estado.pagamentos.filter((p) => p.dia >= de && p.dia <= ate);
    }
    if (s.startsWith('SELECT conciliado_com FROM aura_extrato_lancamentos')) {
      return estado.lancamentos.filter((l) => l.conciliado_com).map((l) => ({ conciliado_com: l.conciliado_com }));
    }
    if (s.startsWith('UPDATE aura_extrato_lancamentos l SET conciliado_com = m.chave')) {
      const [ids, chaves, taxas] = params;
      ids.forEach((id, i) => {
        const l = estado.lancamentos.find((x) => String(x.id) === String(id));
        if (!l || l.status !== 'pendente') return;
        if (violaUnico(chaves[i], id)) throw unico();
        Object.assign(l, { conciliado_com: chaves[i], com_taxa: taxas[i], status: 'conciliado' });
      });
      return [];
    }
    if (s.startsWith("SELECT id, to_char(data, 'YYYY-MM-DD') AS data, valor FROM aura_extrato_lancamentos WHERE extrato_id = $1 AND tipo = 'credito' AND status = 'pendente'")) {
      return estado.lancamentos
        .filter((l) => String(l.extrato_id) === String(params[0]) && l.tipo === 'credito' && l.status === 'pendente')
        .map((l) => ({ id: l.id, data: l.data, valor: l.valor }));
    }

    // leitura
    if (s.includes('FROM aura_extratos e LEFT JOIN aura_extrato_lancamentos l')) {
      const inicio = String(params[0]).slice(0, 7);
      return estado.extratos
        .filter((e) => e.mes >= inicio)
        .map((e) => {
          const meus = estado.lancamentos.filter((l) => String(l.extrato_id) === String(e.id) && l.tipo === 'credito');
          const por = (st) => meus.filter((l) => l.status === st);
          const soma = (arr) => arr.reduce((t, l) => t + Number(l.valor), 0).toFixed(2);
          return {
            id: e.id, mes: e.mes, nome_arquivo: e.nome_arquivo, importado_em: e.importado_em,
            total_creditos: e.total_creditos, linhas: e.linhas,
            conciliados_n: String(por('conciliado').length), conciliados_valor: soma(por('conciliado')),
            pendentes_n: String(por('pendente').length), pendentes_valor: soma(por('pendente')),
            ignorados_n: String(por('ignorado').length),
          };
        });
    }
    if (s.includes('FROM aura_extratos WHERE id = $1') && s.startsWith('SELECT')) {
      const e = extratoDe(params[0]);
      return e ? [recorte(e)] : [];
    }
    if (s.includes('FROM aura_extrato_lancamentos WHERE extrato_id = $1 ORDER BY data, id')) {
      return estado.lancamentos
        .filter((l) => String(l.extrato_id) === String(params[0]))
        .sort((x, y) => (x.data < y.data ? -1 : x.data > y.data ? 1 : Number(x.id) - Number(y.id)))
        .map(recorte);
    }
    if (s.startsWith('SELECT') && s.includes('FROM aura_extrato_lancamentos WHERE id = $1 AND extrato_id = $2')) {
      const l = estado.lancamentos.find((x) => String(x.id) === String(params[0]) && String(x.extrato_id) === String(params[1]));
      return l ? [recorte(l)] : [];
    }

    // escrita manual
    if (s.startsWith('UPDATE aura_extrato_lancamentos SET') && s.includes('WHERE id = $1 AND extrato_id = $2')) {
      const l = estado.lancamentos.find((x) => String(x.id) === String(params[0]) && String(x.extrato_id) === String(params[1]));
      if (!l) return [];
      if (s.includes("status = 'conciliado'")) {
        if (violaUnico(params[2], l.id)) throw unico();
        Object.assign(l, { conciliado_com: params[2], com_taxa: params[3], status: 'conciliado' });
      } else if (s.includes("status = 'ignorado'")) {
        Object.assign(l, { conciliado_com: null, com_taxa: false, status: 'ignorado' });
      } else if (s.includes("status = 'pendente'")) {
        Object.assign(l, { conciliado_com: null, com_taxa: false, status: 'pendente' });
      } else {
        throw new Error('UPDATE desconhecido no banco de mentira do extrato: ' + s.slice(0, 160));
      }
      return [recorte(l)];
    }
    if (s.startsWith('DELETE FROM aura_extratos WHERE id = $1')) {
      const e = extratoDe(params[0]);
      if (!e) return [];
      estado.extratos = estado.extratos.filter((x) => x !== e);
      estado.lancamentos = estado.lancamentos.filter((l) => String(l.extrato_id) !== String(e.id));
      return [{ id: e.id, nome_arquivo: e.nome_arquivo, linhas: e.linhas }];
    }

    throw new Error('SQL inesperado no banco de mentira do extrato: ' + s.slice(0, 200));
  }

  const query = async (sql, params) => {
    const rows = responder(sql, params);
    return { rows, rowCount: rows.length };
  };
  return { estado, query, responder };
}

module.exports = { HOJE, AGORA, USER, pagamento, criar };
