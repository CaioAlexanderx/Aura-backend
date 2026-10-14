// ============================================================
// AURA. — Indicação: regras da concessão do mês do indicador (14/10/2026)
//
// Usado por scripts/indicacao-concessao.js (dry-run / --apply / --estornar /
// --combinada) e scripts/indicacao-relatorio.js (somente leitura). Cartão
// t2-19, fallback manual do t2-17. Regras da Célia (13/10) e decisão do Caio
// (opção C: excluir a cobrança do mês do indicador):
//
//   - elegível só depois da PRIMEIRA cobrança do indicado com
//     PAYMENT_RECEIVED em webhook_logs (CONFIRMED não conta; estornada ou
//     contestada não conta);
//   - indicador em dia: nenhum PAYMENT_OVERDUE sem RECEIVED/CONFIRMED/DELETED
//     posterior há mais de 3 dias (webhook_logs) e, na hora de conceder,
//     nenhuma cobrança OVERDUE na Asaas vencida há mais de 3 dias;
//   - só cobrança FUTURA e PENDENTE da assinatura do indicador, nunca a
//     primeira dele (indicador em trial: o mês grátis sai na segunda);
//   - valor registrado = a cobrança inteira (com acesso extra);
//   - teto de R$ 230 por mês (soma das concessões 'padrao' do mês) e 3 por
//     indicador por ano; fila pela data do pagamento do indicado: quem não
//     cabe no mês espera o próximo sem perder a vez (quem vem atrás também
//     espera);
//   - antifraude: indicador e indicado com CNPJ, e-mail e telefone distintos
//     e donos diferentes;
//   - indicador em trial: a indicação vence se ele não assinar em 60 dias
//     contados do primeiro pagamento do indicado;
//   - a concessão é GRAVADA antes de qualquer chamada que muda algo na Asaas;
//   - estorno = cobrança avulsa de mesmo valor e vencimento ligada à linha.
//
// Nada aqui roda sozinho: as funções recebem `db` e `asaas` por parâmetro e
// só escrevem quando o script é chamado com --apply e a pessoa confirma.
// ============================================================
'use strict';

const PARAMETROS_PADRAO = Object.freeze({
  tetoMensal: 230,       // R$ por mês, soma das concessões 'padrao' (R$ 400 quando o caixa passar de R$ 1.500)
  maxPorAno: 3,          // concessões 'padrao' por indicador por ano
  diasAtraso: 3,         // atraso tolerado do indicador
  janelaTrialDias: 60,   // indicador em trial: prazo para assinar
});

// Concessão "viva": ocupa o teto e trava a cobrança/indicação.
const STATUS_VIVOS = ['registrada', 'aplicada', 'estornando'];
const TZ = 'America/Sao_Paulo';

class Recusa extends Error {
  constructor(msg) { super(msg); this.name = 'Recusa'; this.recusa = true; }
}

// ── datas (sempre 'AAAA-MM-DD' em texto, fuso de São Paulo) ─────────────
const DATA_RE = /^\d{4}-\d{2}-\d{2}/;
function hojeSP(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}
function dia(v) {
  if (!v) return null;
  if (typeof v === 'string') return DATA_RE.test(v) ? v.slice(0, 10) : null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return hojeSP(v);
  return null;
}
function somarDias(d, n) {
  const t = new Date(d + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function diasEntre(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}
const instante = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

function reais(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '-';
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
const centavos = (v) => Math.round(Number(v) * 100);

// ── antifraude ──────────────────────────────────────────────────────────
const digitos = (s) => String(s || '').replace(/\D/g, '');
function telefone(s) {
  let d = digitos(s);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length >= 8 ? d : '';
}
const email = (s) => String(s || '').trim().toLowerCase();

function motivosAntifraude(c) {
  const motivos = [];
  if (c.referrer_id && c.referred_user_id && c.referrer_id === c.referred_user_id) motivos.push('mesmo dono');
  if (c.indicador_id && c.indicado_id && c.indicador_id === c.indicado_id) motivos.push('mesma empresa');
  const cnpjA = digitos(c.indicador_cnpj);
  const cnpjB = digitos(c.indicado_cnpj);
  if (cnpjA && cnpjB && cnpjA === cnpjB) motivos.push('mesmo CNPJ');
  const emailsA = new Set([email(c.indicador_email), email(c.indicador_user_email)].filter(Boolean));
  const emailsB = [email(c.indicado_email), email(c.indicado_user_email)].filter(Boolean);
  if (emailsB.some((e) => emailsA.has(e))) motivos.push('mesmo e-mail');
  const telsA = new Set([telefone(c.indicador_phone), telefone(c.indicador_user_phone)].filter(Boolean));
  const telsB = [telefone(c.indicado_phone), telefone(c.indicado_user_phone)].filter(Boolean);
  if (telsB.some((t) => telsA.has(t))) motivos.push('mesmo telefone');
  return motivos;
}

// ── eventos da Asaas (webhook_logs) ─────────────────────────────────────
const EVENTOS_LIDOS = [
  'PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED',
  'PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED',
];
const DESFEITOS = new Set(['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED']);
const RESOLVEM_ATRASO = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_DELETED']);

// Cobrança do plano: a da assinatura e a avulsa da 1ª mensalidade (que vai
// sem `subscription` e com externalReference = id da empresa). Pedido do
// Canal Digital e pacote de mensagens não contam.
const NAO_E_PLANO = /^(digital-order-|wa-pack-)/;
const ehDoPlano = (e) => !NAO_E_PLANO.test(String(e.referencia || ''));

// Pagamentos recebidos do plano, sem estorno/contestação depois. Ordem: data
// do pagamento.
function recebimentosDoPlano(eventos) {
  const desfeitos = new Set(eventos.filter((e) => DESFEITOS.has(e.event)).map((e) => e.pagamento_id));
  const vistos = new Set();
  const lista = [];
  for (const e of eventos) {
    if (e.event !== 'PAYMENT_RECEIVED' || !ehDoPlano(e) || !e.pagamento_id) continue;
    if (desfeitos.has(e.pagamento_id) || vistos.has(e.pagamento_id)) continue;
    vistos.add(e.pagamento_id);
    lista.push({ pagamento_id: e.pagamento_id, data: dia(e.pago_em) || e.dia, valor: e.valor == null ? null : Number(e.valor) });
  }
  return lista.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}
const primeiroRecebimento = (eventos) => recebimentosDoPlano(eventos)[0] || null;
function ultimoRecebimento(eventos) {
  const l = recebimentosDoPlano(eventos);
  return l[l.length - 1] || null;
}

// PAYMENT_OVERDUE sem RECEIVED/CONFIRMED/DELETED do mesmo pagamento depois
// dele, registrado há mais de `diasAtraso` dias.
function atrasosAbertos(eventos, hoje, diasAtraso) {
  const abertos = [];
  for (const e of eventos) {
    if (e.event !== 'PAYMENT_OVERDUE' || !ehDoPlano(e) || !e.pagamento_id) continue;
    const resolvido = eventos.some((o) => o.pagamento_id === e.pagamento_id
      && RESOLVEM_ATRASO.has(o.event) && instante(o.processed_at) >= instante(e.processed_at));
    if (resolvido) continue;
    if (diasEntre(e.dia, hoje) > diasAtraso) abertos.push({ pagamento_id: e.pagamento_id, desde: e.dia, valor: e.valor });
  }
  return abertos;
}

// ── leituras no banco ───────────────────────────────────────────────────
// Cada SQL leva uma etiqueta (-- indicacao:...) para o teste reconhecer.
const SQL_CANDIDATOS = `-- indicacao:candidatos
SELECT r.id AS referral_id, r.code, r.status AS referral_status,
       (r.created_at AT TIME ZONE '${TZ}')::date::text AS indicado_em,
       r.referrer_id, r.referred_user_id,
       ui.email AS indicador_user_email, ui.phone AS indicador_user_phone,
       ud.email AS indicado_user_email, ud.phone AS indicado_user_phone,
       ci.id AS indicador_id, COALESCE(ci.trade_name, ci.legal_name) AS indicador_nome,
       ci.cnpj AS indicador_cnpj, ci.email AS indicador_email, ci.phone AS indicador_phone,
       ci.asaas_customer_id AS indicador_cliente, ci.asaas_subscription_id AS indicador_assinatura,
       cd.id AS indicado_id, COALESCE(cd.trade_name, cd.legal_name) AS indicado_nome,
       cd.cnpj AS indicado_cnpj, cd.email AS indicado_email, cd.phone AS indicado_phone
  FROM referrals r
  LEFT JOIN users ui ON ui.id = r.referrer_id
  LEFT JOIN users ud ON ud.id = r.referred_user_id
  LEFT JOIN LATERAL (
    SELECT c.* FROM companies c
     WHERE c.owner_id = r.referrer_id
     ORDER BY (c.asaas_subscription_id IS NOT NULL) DESC, c.is_primary DESC NULLS LAST, c.created_at
     LIMIT 1
  ) ci ON true
  LEFT JOIN LATERAL (
    SELECT c.* FROM companies c
     WHERE c.owner_id = r.referred_user_id
     ORDER BY (c.asaas_customer_id IS NOT NULL) DESC, c.is_primary DESC NULLS LAST, c.created_at
     LIMIT 1
  ) cd ON true
 ORDER BY r.created_at`;

const P = `COALESCE(w.payload->'payment', w.payload)`;
const SQL_EVENTOS = `-- indicacao:eventos
SELECT w.company_id, w.event, w.processed_at,
       (w.processed_at AT TIME ZONE '${TZ}')::date::text AS dia,
       ${P}->>'id' AS pagamento_id,
       ${P}->>'subscription' AS assinatura,
       ${P}->>'externalReference' AS referencia,
       ${P}->>'paymentDate' AS pago_em,
       ${P}->>'dueDate' AS vencimento,
       NULLIF(${P}->>'value', '')::numeric AS valor
  FROM webhook_logs w
 WHERE w.provider = 'asaas'
   AND w.company_id = ANY($1::uuid[])
   AND w.event IN (${EVENTOS_LIDOS.map((e) => `'${e}'`).join(', ')})
   AND COALESCE(${P}->>'externalReference', '') NOT LIKE 'digital-order-%'
 ORDER BY w.processed_at`;

const SQL_CONCESSOES = `-- indicacao:concessoes
SELECT id, tipo, status, referral_id, indicador_company_id, indicado_company_id,
       data_concessao::text AS data_concessao, valor, asaas_payment_id,
       cobranca_vencimento::text AS cobranca_vencimento, estorno_pay_id
  FROM indicacao_concessoes
 ORDER BY criado_em`;

function erroDeSchema(err) {
  if (err && err.code === '42P01') {
    return new Error('Tabela indicacao_concessoes não existe: a migration 385 ainda não foi aplicada.');
  }
  return err;
}

async function lerConcessoes(q) {
  try {
    const { rows } = await q.query(SQL_CONCESSOES);
    return rows.map((r) => ({ ...r, valor: Number(r.valor) }));
  } catch (err) { throw erroDeSchema(err); }
}

async function carregarDados(db) {
  const { rows: candidatos } = await db.query(SQL_CANDIDATOS);
  const ids = [...new Set(candidatos.flatMap((c) => [c.indicador_id, c.indicado_id]).filter(Boolean))];
  const { rows: eventos } = ids.length ? await db.query(SQL_EVENTOS, [ids]) : { rows: [] };
  const eventosPorEmpresa = new Map();
  for (const e of eventos) {
    if (!eventosPorEmpresa.has(e.company_id)) eventosPorEmpresa.set(e.company_id, []);
    eventosPorEmpresa.get(e.company_id).push(e);
  }
  const concessoes = await lerConcessoes(db);
  return { candidatos, eventosPorEmpresa, concessoes };
}

// ── avaliação (pura) ────────────────────────────────────────────────────
const ROTULOS = {
  sem_empresa: 'indicação sem empresa do indicador ou do indicado',
  barrada_antifraude: 'barrada no antifraude',
  concedida: 'já concedida',
  em_conferencia: 'concessão gravada sem confirmação da Asaas: conferir no painel',
  aguardando_pagamento_indicado: 'aguardando a primeira cobrança paga do indicado',
  aguardando_assinatura_indicador: 'indicador em trial: aguardando a assinatura',
  aguardando_primeiro_pagamento_indicador: 'indicador ainda não pagou a primeira cobrança (o mês grátis é a segunda)',
  vencida: 'vencida: o indicador não assinou em 60 dias',
  indicador_em_atraso: 'indicador com cobrança atrasada há mais de 3 dias',
  elegivel: 'elegível',
  sem_cobranca_futura: 'indicador sem cobrança futura pendente na Asaas',
  erro_asaas: 'a Asaas não respondeu',
  acima_do_teto: 'valor da cobrança maior que o teto mensal: decidir à mão',
  teto_anual: 'indicador já recebeu o máximo do ano',
  aguardando_teto_mensal: 'na fila: o teto do mês acabou',
  uma_por_execucao: 'mesmo indicador já tem uma concessão nesta execução',
  pronta: 'pronta para conceder',
};

function avaliarCandidato(c, { eventosPorEmpresa, concessoes, hoje, params = PARAMETROS_PADRAO }) {
  const base = {
    referral_id: c.referral_id, code: c.code, indicado_em: c.indicado_em,
    indicador_id: c.indicador_id || null, indicador_nome: c.indicador_nome || null,
    indicador_cliente: c.indicador_cliente || null, indicador_assinatura: c.indicador_assinatura || null,
    indicado_id: c.indicado_id || null, indicado_nome: c.indicado_nome || null,
    indicado_pagamento_id: null, indicado_pago_em: null, valor: null, cobranca: null, motivo: null,
  };
  const sai = (situacao, extra = {}) => ({ ...base, ...extra, situacao });

  if (!c.indicador_id || !c.indicado_id) return sai('sem_empresa');

  const fraude = motivosAntifraude(c);
  if (fraude.length) return sai('barrada_antifraude', { motivo: fraude.join(', ') });

  const viva = concessoes.find((k) => STATUS_VIVOS.includes(k.status)
    && (k.referral_id === c.referral_id || k.indicado_company_id === c.indicado_id));
  if (viva) {
    return sai(viva.status === 'aplicada' ? 'concedida' : 'em_conferencia', {
      valor: viva.valor, motivo: `concessão ${viva.id} (${viva.status})`,
    });
  }

  const evIndicado = eventosPorEmpresa.get(c.indicado_id) || [];
  const evIndicador = eventosPorEmpresa.get(c.indicador_id) || [];
  const pago = primeiroRecebimento(evIndicado);
  if (!pago) return sai('aguardando_pagamento_indicado');
  const comPagamento = { indicado_pagamento_id: pago.pagamento_id, indicado_pago_em: pago.data };

  const prazo = somarDias(pago.data, params.janelaTrialDias);
  if (!c.indicador_assinatura) {
    return sai(hoje > prazo ? 'vencida' : 'aguardando_assinatura_indicador',
      { ...comPagamento, motivo: `prazo até ${prazo}` });
  }
  if (!primeiroRecebimento(evIndicador)) return sai('aguardando_primeiro_pagamento_indicador', comPagamento);

  const atrasos = atrasosAbertos(evIndicador, hoje, params.diasAtraso);
  if (atrasos.length) {
    return sai('indicador_em_atraso', {
      ...comPagamento, motivo: atrasos.map((a) => `${a.pagamento_id} desde ${a.desde}`).join(', '),
    });
  }
  return sai('elegivel', comPagamento);
}

function ordenarFila(itens) {
  return [...itens].sort((a, b) => {
    const pa = a.indicado_pago_em || '9999-12-31';
    const pb = b.indicado_pago_em || '9999-12-31';
    if (pa !== pb) return pa < pb ? -1 : 1;
    return String(a.indicado_em || '') < String(b.indicado_em || '') ? -1 : 1;
  });
}

const mesDe = (d) => String(d || '').slice(0, 7);
const anoDe = (d) => String(d || '').slice(0, 4);

// Uso do teto a partir do livro: soma do mês e contagem do ano por indicador.
function usoDoTeto(concessoes, hoje) {
  const vivas = concessoes.filter((k) => k.tipo === 'padrao' && STATUS_VIVOS.includes(k.status));
  const usadoMes = vivas.filter((k) => mesDe(k.data_concessao) === mesDe(hoje))
    .reduce((s, k) => s + centavos(k.valor), 0) / 100;
  const porIndicadorNoAno = {};
  for (const k of vivas.filter((x) => anoDe(x.data_concessao) === anoDe(hoje))) {
    porIndicadorNoAno[k.indicador_company_id] = (porIndicadorNoAno[k.indicador_company_id] || 0) + 1;
  }
  return { usadoMes, porIndicadorNoAno };
}

// Aplica teto mensal e anual na fila (itens 'elegivel' já com valor).
// Fila estrita: quando um não cabe no mês, os de trás esperam também.
function aplicarTetos(itens, concessoes, hoje, params = PARAMETROS_PADRAO) {
  const { usadoMes, porIndicadorNoAno } = usoDoTeto(concessoes, hoje);
  let usado = centavos(usadoMes);
  const teto = centavos(params.tetoMensal);
  const doAno = { ...porIndicadorNoAno };
  const nestaExecucao = new Set();
  let filaParada = false;
  const saida = ordenarFila(itens).map((it) => {
    if (it.situacao !== 'elegivel' || it.valor == null) return it;
    const v = centavos(it.valor);
    if (v > teto) return { ...it, situacao: 'acima_do_teto' };
    if ((doAno[it.indicador_id] || 0) >= params.maxPorAno) return { ...it, situacao: 'teto_anual' };
    if (nestaExecucao.has(it.indicador_id)) return { ...it, situacao: 'uma_por_execucao' };
    if (filaParada || usado + v > teto) {
      filaParada = true;
      return { ...it, situacao: 'aguardando_teto_mensal' };
    }
    usado += v;
    doAno[it.indicador_id] = (doAno[it.indicador_id] || 0) + 1;
    nestaExecucao.add(it.indicador_id);
    return { ...it, situacao: 'pronta' };
  });
  return { itens: saida, usadoMes, projetadoMes: usado / 100, tetoMensal: params.tetoMensal };
}

// ── Asaas (leitura) ─────────────────────────────────────────────────────
function cobrancaUsada(concessoes, pagamentoId) {
  return concessoes.some((k) => k.asaas_payment_id === pagamentoId && k.status !== 'falhou');
}

async function atrasosNaAsaas(asaas, cliente, hoje, diasAtraso) {
  const r = await asaas('GET', '/payments?customer=' + encodeURIComponent(cliente) + '&status=OVERDUE&limit=100');
  return ((r && Array.isArray(r.data)) ? r.data : [])
    .filter((p) => p && !p.deleted && p.status === 'OVERDUE' && dia(p.dueDate)
      && diasEntre(dia(p.dueDate), hoje) > diasAtraso);
}

async function proximaCobrancaFutura(asaas, assinatura, hoje, concessoes) {
  const r = await asaas('GET', '/subscriptions/' + encodeURIComponent(assinatura) + '/payments?status=PENDING&limit=100');
  const lista = ((r && Array.isArray(r.data)) ? r.data : [])
    .filter((p) => p && p.id && !p.deleted && p.status === 'PENDING' && dia(p.dueDate) && dia(p.dueDate) > hoje)
    .filter((p) => !cobrancaUsada(concessoes, p.id))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  return lista[0] || null;
}

// Completa os elegíveis com a cobrança da Asaas (só leitura).
async function completarComAsaas(itens, { asaas, hoje, concessoes, params = PARAMETROS_PADRAO }) {
  const saida = [];
  for (const it of itens) {
    if (it.situacao !== 'elegivel') { saida.push(it); continue; }
    try {
      const atrasos = await atrasosNaAsaas(asaas, it.indicador_cliente, hoje, params.diasAtraso);
      if (atrasos.length) {
        saida.push({ ...it, situacao: 'indicador_em_atraso', motivo: atrasos.map((p) => `${p.id} venceu ${p.dueDate}`).join(', ') });
        continue;
      }
      const cob = await proximaCobrancaFutura(asaas, it.indicador_assinatura, hoje, concessoes);
      if (!cob) { saida.push({ ...it, situacao: 'sem_cobranca_futura' }); continue; }
      saida.push({
        ...it,
        valor: Number(cob.value),
        cobranca: { id: cob.id, vencimento: dia(cob.dueDate), forma: cob.billingType || null, valor: Number(cob.value) },
      });
    } catch (err) {
      saida.push({ ...it, situacao: 'erro_asaas', motivo: err.message });
    }
  }
  return saida;
}

// Lista completa: avalia, consulta a Asaas (se houver cliente) e aplica tetos.
async function montarFila({ db, asaas = null, hoje, params = PARAMETROS_PADRAO }) {
  const dados = await carregarDados(db);
  let itens = dados.candidatos.map((c) => avaliarCandidato(c, { ...dados, hoje, params }));
  if (asaas) itens = await completarComAsaas(itens, { asaas, hoje, concessoes: dados.concessoes, params });
  const tetos = aplicarTetos(itens, dados.concessoes, hoje, params);
  return { ...tetos, itens: tetos.itens, dados };
}

// ── escrita: concessão e estorno ────────────────────────────────────────
// Confere a cobrança direto na Asaas logo antes de gravar: ainda pendente,
// futura, do indicador e com o valor mostrado na confirmação.
function conferirCobranca(p, item, hoje) {
  if (!p || !p.id) throw new Recusa('cobrança não encontrada na Asaas');
  if (p.deleted) throw new Recusa(`cobrança ${p.id} já foi excluída na Asaas`);
  if (p.status !== 'PENDING') throw new Recusa(`cobrança ${p.id} não está pendente (status ${p.status})`);
  if (!dia(p.dueDate) || dia(p.dueDate) <= hoje) throw new Recusa(`cobrança ${p.id} não é futura (vence ${p.dueDate})`);
  if (item.indicador_cliente && p.customer !== item.indicador_cliente) {
    throw new Recusa(`cobrança ${p.id} não é do indicador (cliente ${p.customer})`);
  }
  if (item.tipo !== 'combinada' && item.indicador_assinatura && p.subscription !== item.indicador_assinatura) {
    throw new Recusa(`cobrança ${p.id} não é da assinatura do indicador`);
  }
  if (centavos(p.value) !== centavos(item.valor)) {
    throw new Recusa(`valor da cobrança mudou: ${reais(p.value)} na Asaas, ${reais(item.valor)} na confirmação`);
  }
}

const SQL_TRAVA = `-- indicacao:trava
SELECT pg_advisory_xact_lock(hashtext('indicacao_concessoes'))`;

const SQL_INSERIR = `-- indicacao:inserir
INSERT INTO indicacao_concessoes
  (tipo, status, referral_id, indicador_company_id, indicado_company_id, data_concessao, valor,
   asaas_payment_id, cobranca_vencimento, cobranca_forma, asaas_customer_id,
   indicado_payment_id, indicado_pago_em, observacao, criado_por)
VALUES ($1, 'registrada', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
RETURNING id`;

const SQL_APLICADA = `-- indicacao:aplicada
UPDATE indicacao_concessoes
   SET status = 'aplicada', aplicada_em = NOW(), erro = NULL, atualizado_em = NOW()
 WHERE id = $1 AND status = 'registrada'`;

const SQL_FALHOU = `-- indicacao:falhou
UPDATE indicacao_concessoes
   SET status = 'falhou', erro = $2, atualizado_em = NOW()
 WHERE id = $1 AND status = 'registrada'`;

// Revalida teto/unicidade DENTRO da transação, com a trava, e grava.
async function gravarConcessao(db, item, { hoje, params = PARAMETROS_PADRAO, operador = null }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(SQL_TRAVA);
    const concessoes = await lerConcessoes(client);
    if (cobrancaUsada(concessoes, item.cobranca.id)) throw new Recusa(`cobrança ${item.cobranca.id} já tem concessão`);
    const viva = concessoes.find((k) => STATUS_VIVOS.includes(k.status)
      && ((item.referral_id && k.referral_id === item.referral_id)
        || (item.indicado_id && k.indicado_company_id === item.indicado_id)));
    if (viva) throw new Recusa(`indicação já tem concessão (${viva.id}, ${viva.status})`);
    if (item.tipo !== 'combinada') {
      const { usadoMes, porIndicadorNoAno } = usoDoTeto(concessoes, hoje);
      if (centavos(usadoMes) + centavos(item.valor) > centavos(params.tetoMensal)) {
        throw new Recusa(`teto do mês: ${reais(usadoMes)} usados de ${reais(params.tetoMensal)}`);
      }
      if ((porIndicadorNoAno[item.indicador_id] || 0) >= params.maxPorAno) {
        throw new Recusa(`indicador já recebeu ${params.maxPorAno} concessões este ano`);
      }
    }
    const { rows } = await client.query(SQL_INSERIR, [
      item.tipo || 'padrao', item.referral_id || null, item.indicador_id, item.indicado_id || null,
      hoje, item.valor, item.cobranca.id, item.cobranca.vencimento, item.cobranca.forma || null,
      item.indicador_cliente || null, item.indicado_pagamento_id || null, item.indicado_pago_em || null,
      item.observacao || null, operador,
    ]);
    await client.query('COMMIT');
    return rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw erroDeSchema(err);
  } finally {
    if (client.release) client.release();
  }
}

// Concede UMA: confere na Asaas, grava a linha, só então exclui a cobrança.
async function concederUma({ db, asaas, item, hoje, params = PARAMETROS_PADRAO, operador = null }) {
  if (!item || !item.cobranca || !item.cobranca.id) throw new Recusa('item sem cobrança');
  const atual = await asaas('GET', '/payments/' + encodeURIComponent(item.cobranca.id));
  conferirCobranca(atual, item, hoje);

  const concessaoId = await gravarConcessao(db, item, { hoje, params, operador });

  let resposta;
  try {
    resposta = await asaas('DELETE', '/payments/' + encodeURIComponent(item.cobranca.id));
  } catch (err) {
    await db.query(SQL_FALHOU, [concessaoId, err.message]);
    return { ok: false, concessaoId, erro: err.message };
  }
  if (resposta && resposta.deleted === false) {
    await db.query(SQL_FALHOU, [concessaoId, 'Asaas respondeu deleted=false']);
    return { ok: false, concessaoId, erro: 'Asaas respondeu deleted=false' };
  }
  try {
    await db.query(SQL_APLICADA, [concessaoId]);
  } catch (err) {
    // A cobrança JÁ foi excluída: a linha fica 'registrada' e o relatório a
    // mostra em conferência. Não tentar de novo.
    return { ok: true, concessaoId, aviso: `exclusão feita, mas a linha ficou 'registrada': ${err.message}` };
  }
  return { ok: true, concessaoId };
}

const SQL_CONCESSAO_POR_ID = `-- indicacao:concessao-por-id
SELECT id, tipo, status, indicador_company_id, valor, asaas_payment_id,
       cobranca_vencimento::text AS cobranca_vencimento, cobranca_forma, asaas_customer_id, estorno_pay_id
  FROM indicacao_concessoes WHERE id = $1`;

const SQL_ESTORNANDO = `-- indicacao:estornando
UPDATE indicacao_concessoes SET status = 'estornando', atualizado_em = NOW()
 WHERE id = $1 AND status = 'aplicada'`;

const SQL_ESTORNADA = `-- indicacao:estornada
UPDATE indicacao_concessoes
   SET status = 'estornada', estorno_pay_id = $2, estornado_em = NOW(), erro = NULL, atualizado_em = NOW()
 WHERE id = $1 AND status = 'estornando'`;

const SQL_ESTORNO_FALHOU = `-- indicacao:estorno-falhou
UPDATE indicacao_concessoes SET status = 'aplicada', erro = $2, atualizado_em = NOW()
 WHERE id = $1 AND status = 'estornando'`;

async function lerConcessao(db, id) {
  try {
    const { rows } = await db.query(SQL_CONCESSAO_POR_ID, [id]);
    return rows[0] ? { ...rows[0], valor: Number(rows[0].valor) } : null;
  } catch (err) { throw erroDeSchema(err); }
}

function planoDeEstorno(c, { hoje, vencimento = null }) {
  if (!c) throw new Recusa('concessão não encontrada');
  if (c.status !== 'aplicada') throw new Recusa(`concessão está '${c.status}', só 'aplicada' pode ser estornada`);
  if (!c.asaas_customer_id) throw new Recusa('concessão sem cliente da Asaas');
  const venc = vencimento || c.cobranca_vencimento;
  if (!dia(venc)) throw new Recusa('concessão sem vencimento: informe --vencimento AAAA-MM-DD');
  if (dia(venc) < hoje) {
    throw new Recusa(`o vencimento ${venc} já passou: informe --vencimento AAAA-MM-DD (hoje ou depois)`);
  }
  return {
    customer: c.asaas_customer_id,
    billingType: c.cobranca_forma || 'UNDEFINED',
    value: Number(c.valor),
    dueDate: dia(venc),
    description: `Aura: cobrança refeita (estorno da concessão de indicação ${c.id}, cobrança ${c.asaas_payment_id})`,
    externalReference: c.indicador_company_id,
  };
}

// Estorno: grava 'estornando' antes, cria a cobrança avulsa, liga o pay_ novo.
async function estornar({ db, asaas, concessao, hoje, vencimento = null }) {
  const corpo = planoDeEstorno(concessao, { hoje, vencimento });
  const r = await db.query(SQL_ESTORNANDO, [concessao.id]);
  if (!r || r.rowCount !== 1) throw new Recusa('concessão mudou de estado; nada foi feito');
  let nova;
  try {
    nova = await asaas('POST', '/payments', corpo);
  } catch (err) {
    await db.query(SQL_ESTORNO_FALHOU, [concessao.id, 'estorno: ' + err.message]);
    return { ok: false, erro: err.message };
  }
  if (!nova || !nova.id) {
    await db.query(SQL_ESTORNO_FALHOU, [concessao.id, 'estorno: Asaas não devolveu id']);
    return { ok: false, erro: 'Asaas não devolveu o id da cobrança nova' };
  }
  await db.query(SQL_ESTORNADA, [concessao.id, nova.id]);
  return { ok: true, estornoPayId: nova.id, corpo };
}

// Concessão combinada (antes de 15/10): indicador, indicado e cobrança vêm
// da linha de comando; mesmo caminho de gravação e exclusão, fora do teto.
const SQL_EMPRESA = `-- indicacao:empresa
SELECT id, COALESCE(trade_name, legal_name) AS nome, asaas_customer_id, asaas_subscription_id
  FROM companies WHERE id = $1`;

async function montarCombinada({ db, asaas, indicadorId, indicadoId, cobrancaId, observacao = null, hoje }) {
  const { rows: a } = await db.query(SQL_EMPRESA, [indicadorId]);
  const { rows: b } = await db.query(SQL_EMPRESA, [indicadoId]);
  if (!a[0]) throw new Recusa('indicador não encontrado');
  if (!b[0]) throw new Recusa('indicado não encontrado');
  if (a[0].id === b[0].id) throw new Recusa('indicador e indicado são a mesma empresa');
  if (!a[0].asaas_customer_id) throw new Recusa('indicador sem cliente na Asaas');
  const p = await asaas('GET', '/payments/' + encodeURIComponent(cobrancaId));
  const item = {
    tipo: 'combinada', referral_id: null,
    indicador_id: a[0].id, indicador_nome: a[0].nome, indicador_cliente: a[0].asaas_customer_id,
    indicador_assinatura: a[0].asaas_subscription_id,
    indicado_id: b[0].id, indicado_nome: b[0].nome,
    valor: p ? Number(p.value) : null,
    cobranca: p ? { id: p.id, vencimento: dia(p.dueDate), forma: p.billingType || null, valor: Number(p.value) } : null,
    observacao,
    situacao: 'pronta',
  };
  conferirCobranca(p, item, hoje);
  return item;
}

module.exports = {
  PARAMETROS_PADRAO, STATUS_VIVOS, ROTULOS, Recusa,
  hojeSP, dia, somarDias, diasEntre, reais,
  motivosAntifraude, recebimentosDoPlano, primeiroRecebimento, ultimoRecebimento, atrasosAbertos,
  carregarDados, lerConcessoes, lerConcessao, avaliarCandidato, ordenarFila, usoDoTeto, aplicarTetos,
  completarComAsaas, montarFila, conferirCobranca, gravarConcessao, concederUma,
  planoDeEstorno, estornar, montarCombinada,
};
