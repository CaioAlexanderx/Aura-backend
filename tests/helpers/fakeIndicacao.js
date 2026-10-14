// ============================================================
// Banco e Asaas de mentira para os scripts de indicação (14/10/2026).
//
// O banco responde pela etiqueta do SQL (-- indicacao:<nome>) e guarda as
// concessões em memória, então dá para rodar o script duas vezes seguidas.
// `ordem` registra, na sequência, tudo o que foi chamado no banco e na Asaas:
// é com ela que o teste prova "grava antes de excluir".
// ============================================================
'use strict';

const HOJE = '2026-10-14';

function etiqueta(sql) {
  const m = String(sql).match(/-- indicacao:([\w-]+)/);
  return m ? m[1] : String(sql).trim().split(/\s+/)[0].toUpperCase();
}

const ESCRITAS = new Set(['inserir', 'aplicada', 'falhou', 'estornando', 'estornada', 'estorno-falhou']);

function fakeDb({ candidatos = [], eventos = [], concessoes = [], empresas = [], relatorio = {}, ordem = [] } = {}) {
  const estado = { concessoes: concessoes.map((k) => ({ status: 'aplicada', tipo: 'padrao', ...k })) };
  let seq = 0;
  const atualizar = (id, de, mudancas) => {
    const k = estado.concessoes.find((x) => x.id === id && (!de || x.status === de));
    if (!k) return { rows: [], rowCount: 0 };
    Object.assign(k, mudancas);
    return { rows: [], rowCount: 1 };
  };
  const query = jest.fn(async (sql, params = []) => {
    const tag = etiqueta(sql);
    ordem.push('db:' + tag);
    switch (tag) {
      case 'candidatos': return { rows: candidatos };
      case 'eventos': return { rows: eventos.filter((e) => params[0].includes(e.company_id)) };
      case 'concessoes': return { rows: estado.concessoes.map((k) => ({ ...k })) };
      case 'concessao-por-id': return { rows: estado.concessoes.filter((k) => k.id === params[0]).map((k) => ({ ...k })) };
      case 'empresa': return { rows: empresas.filter((e) => e.id === params[0]) };
      case 'relatorio-concessoes': return { rows: relatorio.concessoes || [] };
      case 'relatorio-excluidas': return { rows: relatorio.excluidas || [] };
      case 'trava': case 'BEGIN': case 'COMMIT': case 'ROLLBACK': return { rows: [] };
      case 'inserir': {
        seq += 1;
        const id = 'conc-' + seq;
        estado.concessoes.push({
          id, tipo: params[0], status: 'registrada', referral_id: params[1], indicador_company_id: params[2],
          indicado_company_id: params[3], data_concessao: params[4], valor: params[5], asaas_payment_id: params[6],
          cobranca_vencimento: params[7], cobranca_forma: params[8], asaas_customer_id: params[9],
          indicado_payment_id: params[10], indicado_pago_em: params[11], observacao: params[12], criado_por: params[13],
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      case 'aplicada': return atualizar(params[0], 'registrada', { status: 'aplicada' });
      case 'falhou': return atualizar(params[0], 'registrada', { status: 'falhou', erro: params[1] });
      case 'estornando': return atualizar(params[0], 'aplicada', { status: 'estornando' });
      case 'estornada': return atualizar(params[0], 'estornando', { status: 'estornada', estorno_pay_id: params[1] });
      case 'estorno-falhou': return atualizar(params[0], 'estornando', { status: 'aplicada', erro: params[1] });
      default: throw new Error('SQL inesperado no teste: ' + String(sql).slice(0, 80));
    }
  });
  const escritas = () => query.mock.calls.map(([sql]) => etiqueta(sql)).filter((t) => ESCRITAS.has(t));
  return { query, connect: async () => ({ query, release: () => {} }), estado, ordem, escritas };
}

// pendentes: { sub_x: [cobranças] } · atrasadas: { cus_x: [cobranças] }
function fakeAsaas({ pendentes = {}, atrasadas = {}, falharDelete = null, falharPost = null, ordem = [] } = {}) {
  const todas = new Map();
  for (const lista of Object.values(pendentes)) for (const p of lista) todas.set(p.id, { ...p });
  const fn = jest.fn(async (metodo, caminho, corpo) => {
    ordem.push(`asaas:${metodo} ${caminho}`);
    let m;
    if (metodo === 'GET' && (m = caminho.match(/^\/subscriptions\/([^/]+)\/payments/))) {
      const sub = decodeURIComponent(m[1]);
      return { data: [...todas.values()].filter((p) => p.subscription === sub && !p.deleted) };
    }
    if (metodo === 'GET' && (m = caminho.match(/^\/payments\?customer=([^&]+)&status=OVERDUE/))) {
      return { data: atrasadas[decodeURIComponent(m[1])] || [] };
    }
    if (metodo === 'GET' && (m = caminho.match(/^\/payments\/([^/?]+)$/))) {
      const p = todas.get(decodeURIComponent(m[1]));
      if (!p) throw new Error('Asaas error 404');
      return { ...p };
    }
    if (metodo === 'DELETE' && (m = caminho.match(/^\/payments\/([^/?]+)$/))) {
      if (falharDelete) throw new Error(falharDelete);
      const p = todas.get(decodeURIComponent(m[1]));
      if (p) p.deleted = true;
      return { deleted: true, id: decodeURIComponent(m[1]) };
    }
    if (metodo === 'POST' && caminho === '/payments') {
      if (falharPost) throw new Error(falharPost);
      return { id: 'pay_estorno_1', ...corpo, status: 'PENDING' };
    }
    throw new Error(`chamada inesperada na Asaas: ${metodo} ${caminho}`);
  });
  fn.cobrancas = todas;
  return fn;
}

// ── fábrica de cenários ────────────────────────────────────────────────
let n = 0;
function par({
  indicadorValor = 93.17, indicadoPagouEm = '2026-10-05', assinatura = true, indicadorPagou = true,
  vencimento = '2026-11-15', extraIndicador = {}, extraIndicado = {}, eventosExtra = [],
} = {}) {
  n += 1;
  const a = `emp-a${n}`;
  const b = `emp-b${n}`;
  const candidato = {
    referral_id: `ref-${n}`, code: `REF-TESTE${n}`, indicado_em: '2026-10-01',
    referrer_id: `u-a${n}`, referred_user_id: `u-b${n}`,
    indicador_user_email: `dono${n}@loja-a.com`, indicador_user_phone: `1199000${String(n).padStart(4, '0')}`,
    indicado_user_email: `dono${n}@loja-b.com`, indicado_user_phone: `2198000${String(n).padStart(4, '0')}`,
    indicador_id: a, indicador_nome: `Loja A${n}`, indicador_cnpj: `11.111.111/0001-${String(n).padStart(2, '0')}`,
    indicador_email: `a${n}@a.com`, indicador_phone: null,
    indicador_cliente: `cus_a${n}`, indicador_assinatura: assinatura ? `sub_a${n}` : null,
    indicado_id: b, indicado_nome: `Loja B${n}`, indicado_cnpj: `22.222.222/0001-${String(n).padStart(2, '0')}`,
    indicado_email: `b${n}@b.com`, indicado_phone: null,
    ...extraIndicador, ...extraIndicado,
  };
  const eventos = [];
  if (indicadorPagou) {
    // 1ª mensalidade avulsa: sem subscription, externalReference = empresa
    eventos.push({ company_id: a, event: 'PAYMENT_RECEIVED', processed_at: '2026-09-15T12:00:00Z', dia: '2026-09-15',
      pagamento_id: `pay_a${n}_1`, assinatura: null, referencia: a, pago_em: '2026-09-15', valor: indicadorValor });
  }
  if (indicadoPagouEm) {
    eventos.push({ company_id: b, event: 'PAYMENT_RECEIVED', processed_at: `${indicadoPagouEm}T12:00:00Z`, dia: indicadoPagouEm,
      pagamento_id: `pay_b${n}_1`, assinatura: null, referencia: b, pago_em: indicadoPagouEm, valor: 112.66 });
  }
  eventos.push(...eventosExtra.map((e) => ({ company_id: a, ...e })));
  const pendentes = assinatura ? {
    [`sub_a${n}`]: [{
      id: `pay_a${n}_prox`, status: 'PENDING', dueDate: vencimento, value: indicadorValor, billingType: 'PIX',
      customer: `cus_a${n}`, subscription: `sub_a${n}`,
    }],
  } : {};
  return { candidato, eventos, pendentes, a, b, n };
}

function juntar(pares) {
  return {
    candidatos: pares.map((p) => p.candidato),
    eventos: pares.flatMap((p) => p.eventos),
    pendentes: Object.assign({}, ...pares.map((p) => p.pendentes)),
  };
}

module.exports = { HOJE, fakeDb, fakeAsaas, par, juntar, etiqueta, ESCRITAS };
