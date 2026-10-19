// ============================================================
// AURA. — Painel da Gestão Aura: base comum dos blocos
//
// Todo bloco exporta `async calcular({ hoje, periodo, db, empresas })` e
// devolve o formato de montarBloco() abaixo. `hoje` é o dia em Brasília
// ('YYYY-MM-DD') e entra nas consultas como $1 — nada usa NOW(), para o
// resultado de um dia ser o mesmo se o bloco for recalculado.
//
// Desenho das consultas: cada bloco agrega a tabela-fonte por company_id e
// junta com o universo de empresas em JS (carregarEmpresas). Assim o filtro
// de quem conta fica num lugar só:
//   - fora as contas internas (e-mail da empresa @getaura.com.br);
//   - só billing_status 'trial' ou 'active';
//   - fora os dojôs (vertical 'karate_dojo'), decisão do Caio de 19/10/2026.
// Uma loja fora do universo some de todos os blocos de uma vez.
// Dentro do universo, `emp.pagantes` é só quem conta como pagante da Aura:
// filial paga pela matriz e dojô sem assinatura própria ficam em `emp.lista`
// (existem, usam o produto) e em `emp.foraDaContagem`, nunca em `pagantes`.
// ============================================================
'use strict';

const pool = require('../../config/database');
const { semDojo } = require('../../utils/empresasDaGestao');

const TZ = 'America/Sao_Paulo';

const NOME = `COALESCE(c.name, c.trade_name, c.legal_name)`;
const TELEFONE = `COALESCE(NULLIF(u.phone, ''), c.phone)`;
// 13/10/2026: a empresa de teste do bipe sintético (CANARY_COMPANY_ID) também
// sai. A conta Aura de teste tem e-mail @gmail.com e estava dentro do
// universo como "pagante"; sem esta linha a venda sintética contaria como
// venda da plataforma se um estorno falhasse. O id só entra na consulta se
// for um UUID — a constante vira SQL.
const ID_CANARY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  .test(String(process.env.CANARY_COMPANY_ID || '').trim())
  ? String(process.env.CANARY_COMPANY_ID).trim().toLowerCase()
  : null;
// 13/10/2026: conta de teste (companies.is_sandbox) também sai de todos os
// blocos. JKA Teste, os 10 dojôs de teste da JKA e a empresa Aura de teste
// eram contados como pagantes porque a regra só olhava e-mail e o id do
// canário (pedido de Produto e Financeiro; card P1).
// 19/10/2026 (decisão do Caio): dojô (vertical 'karate_dojo') sai do universo
// inteiro: é dado da federação, não cliente da Aura (utils/empresasDaGestao).
const SEM_INTERNAS = `COALESCE(c.email, '') NOT ILIKE '%@getaura.com.br'`
  + ` AND c.is_sandbox IS NOT TRUE`
  + ` AND ${semDojo('c')}`
  + (ID_CANARY ? ` AND c.id <> '${ID_CANARY}'::uuid` : '');

// 14/10/2026 (card t1-11, estende o #820): quem NÃO conta como pagante da Aura.
// A empresa continua no universo (usa o produto, aparece em acesso, uso,
// fiscal...), mas sai da contagem de pagantes e da adoção. Duas razões, e a
// regra mora aqui — services/receita.js (MRR) e carregarEmpresas (blocos e
// alertas) usam o MESMO fragmento, para a conta nunca divergir:
//   - filial cujo plano é pago por OUTRA empresa (billing_owner_company_id
//     diferente do próprio id): Villa Branca, cobrada na Matriz;
//   - dojô de federação SEM assinatura própria (asaas_subscription_id nulo e
//     federation_id diferente do id): BASSAI DAI, KANO DOJO e SHOBUKAN SÃO
//     PAULO. Dojô COM assinatura própria continua contando.
// Conta de teste (is_sandbox) já sai do universo inteiro em SEM_INTERNAS.
// Alias `c` = companies, como em SEM_INTERNAS.
const PAGA_POR_OUTRA = `(c.billing_owner_company_id IS NOT NULL AND c.billing_owner_company_id <> c.id)`;
const DOJO_SEM_ASSINATURA = `(c.asaas_subscription_id IS NULL AND c.federation_id IS NOT NULL AND c.federation_id <> c.id)`;

// Acesso da loja: login direto ou troca de loja (grupo multi-CNPJ entra numa
// e troca para a outra — o login em si fica gravado sem empresa).
const ACOES_ACESSO = `('login', 'switch_company')`;

// Venda que conta: tudo menos a cancelada.
const VENDA_VALIDA = `COALESCE(status, 'completed') <> 'cancelled'`;

// A cobrança dentro de webhook_logs.payload. O webhook da Asaas grava o
// pagamento na raiz do payload (routes/webhookAsaas.js → logWebhookEvent);
// registro que tenha vindo com o corpo inteiro traz em payload.payment. Lendo
// pelos dois caminhos o valor não vira NULL conforme quem gravou.
const PAGAMENTO_ASAAS = `COALESCE(payload->'payment', payload)`;
// Dinheiro que entrou. No cartão a Asaas manda CONFIRMED e, dias depois,
// RECEIVED para a MESMA cobrança: quem soma precisa contar cada id uma vez.
const EVENTOS_PAGOS = `('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')`;

// Início do dia (hoje - n) em Brasília, como timestamptz. $1 = hoje.
const desde = (n) => `(($1::date - ${parseInt(n, 10)})::timestamp AT TIME ZONE '${TZ}')`;
// Dia em Brasília de uma coluna timestamptz, como texto.
const diaBRT = (col) => `to_char((${col} AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD')`;

const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const round2 = (v) => Math.round(num(v) * 100) / 100;

// ── datas (sempre 'YYYY-MM-DD', sem fuso) ───────────────────────
function paraUTC(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function somaDias(ymd, n) {
  return new Date(paraUTC(ymd) + n * 86400000).toISOString().slice(0, 10);
}
function diasEntre(de, ate) {
  return Math.round((paraUTC(ate) - paraUTC(de)) / 86400000);
}
function rotuloDia(ymd) {
  const s = String(ymd).slice(0, 10);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
}
// Segunda-feira da semana do dia.
function inicioDaSemana(ymd) {
  const dow = new Date(paraUTC(ymd)).getUTCDay(); // 0 = domingo
  return somaDias(ymd, -((dow + 6) % 7));
}
// As últimas n semanas (segundas), da mais antiga para a atual.
function ultimasSemanas(hoje, n) {
  const atual = inicioDaSemana(hoje);
  return Array.from({ length: n }, (_, i) => somaDias(atual, -7 * (n - 1 - i)));
}
// Timestamp (Date ou string) → dia em Brasília.
function diaDe(ts) {
  if (!ts) return null;
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

// ── banco ───────────────────────────────────────────────────────
async function consultar(db, sql, params) {
  const { rows } = await db.query(sql, params);
  return rows || [];
}

const _avisados = new Set();
// Tabela ou coluna ausente (deploy antes da migration) zera a fonte em vez de
// derrubar o bloco — e avisa no log, uma vez por mensagem, para um nome
// errado na consulta não passar por "tabela ainda não existe".
async function opcional(db, sql, params) {
  try {
    return await consultar(db, sql, params);
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) {
      if (!_avisados.has(err.message)) {
        _avisados.add(err.message);
        console.warn('[painel] fonte ausente, bloco segue sem ela:', err.message);
      }
      return [];
    }
    throw err;
  }
}

// ── universo de empresas ────────────────────────────────────────
async function carregarEmpresas(db = pool) {
  const rows = await consultar(
    db,
    `SELECT c.id AS company_id,
            ${NOME} AS nome,
            ${TELEFONE} AS telefone,
            c.plan::text AS plan,
            COALESCE(c.billing_cycle, 'monthly') AS ciclo,
            c.billing_status AS status,
            ${diaBRT('c.created_at')} AS criado_em,
            ${diaBRT('c.trial_ends_at')} AS trial_ate,
            to_char(c.next_billing_date, 'YYYY-MM-DD') AS vence_em,
            c.segment,
            c.vertical_active,
            (c.access_code_used IS NOT NULL AND c.access_code_used <> '') AS por_codigo,
            UPPER(NULLIF(TRIM(c.access_code_used), '')) AS codigo_acesso,
            (c.asaas_subscription_id IS NOT NULL) AS tem_cobranca,
            (c.federation_id IS NOT NULL AND c.federation_id <> c.id) AS eh_dojo,
            ${PAGA_POR_OUTRA} AS paga_por_outra,
            ${DOJO_SEM_ASSINATURA} AS dojo_sem_assinatura
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE ${SEM_INTERNAS}
        AND c.billing_status IN ('trial', 'active')
      ORDER BY 2`
  );
  const lista = rows.map((r) => {
    const pagaPorOutra = !!r.paga_por_outra;
    const dojoSemAssinatura = !!r.dojo_sem_assinatura;
    const foraDaContagem = pagaPorOutra || dojoSemAssinatura;
    const ativa = r.status === 'active';
    return {
      ...r,
      telefone: r.telefone || null,
      por_codigo: !!r.por_codigo,
      tem_cobranca: !!r.tem_cobranca,
      eh_dojo: !!r.eh_dojo,
      paga_por_outra: pagaPorOutra,
      dojo_sem_assinatura: dojoSemAssinatura,
      fora_da_contagem: foraDaContagem,
      // `pagante`: a conta está ativa (billing_status). `conta_pagante`: ativa
      // E conta como pagante da Aura. Só a segunda entra em contagens.
      pagante: ativa,
      conta_pagante: ativa && !foraDaContagem,
    };
  });
  const porId = new Map(lista.map((e) => [e.company_id, e]));
  return {
    lista,
    porId,
    pagantes: lista.filter((e) => e.conta_pagante),
    // Ativas que existem mas não contam (filial paga pela matriz, dojô sem
    // assinatura): o painel mostra à parte, para ninguém filtrar à mão.
    foraDaContagem: lista.filter((e) => e.pagante && e.fora_da_contagem),
  };
}

function motivoForaDaContagem(e) {
  if (e.paga_por_outra) return 'Filial paga pela matriz';
  if (e.dojo_sem_assinatura) return 'Dojô sem assinatura própria';
  return null;
}

// Identificação que toda linha de lista carrega.
function ref(e) {
  return { company_id: e.company_id, nome: e.nome, telefone: e.telefone || null };
}

// ── fontes compartilhadas por mais de um bloco ──────────────────
// Vendas por loja na janela (hoje - dias .. hoje).
async function vendasPorLoja(db, hoje, dias) {
  const rows = await consultar(
    db,
    `SELECT company_id, COUNT(*) AS vendas, MAX(created_at) AS ultima
       FROM sales
      WHERE created_at >= ${desde(dias)} AND ${VENDA_VALIDA}
      GROUP BY company_id`,
    [hoje]
  );
  return new Map(rows.map((r) => [r.company_id, { vendas: num(r.vendas), ultima: r.ultima }]));
}

// Última venda de cada loja, em qualquer tempo.
async function ultimaVendaPorLoja(db) {
  const rows = await consultar(
    db,
    `SELECT company_id, COUNT(*) AS vendas, MAX(created_at) AS ultima
       FROM sales
      WHERE ${VENDA_VALIDA}
      GROUP BY company_id`
  );
  return new Map(rows.map((r) => [r.company_id, { vendas: num(r.vendas), ultima: r.ultima }]));
}

// Dias com acesso e último acesso de cada loja na janela.
async function acessoPorLoja(db, hoje, dias) {
  const rows = await consultar(
    db,
    `SELECT company_id,
            COUNT(DISTINCT (created_at AT TIME ZONE '${TZ}')::date) AS dias_ativos,
            COUNT(*) AS acessos,
            MAX(created_at) AS ultimo
       FROM audit_log
      WHERE action IN ${ACOES_ACESSO} AND company_id IS NOT NULL
        AND created_at >= ${desde(dias)}
      GROUP BY company_id`,
    [hoje]
  );
  return new Map(rows.map((r) => [r.company_id, {
    dias_ativos: num(r.dias_ativos), acessos: num(r.acessos), ultimo: r.ultimo,
  }]));
}

// ── formato ─────────────────────────────────────────────────────
const col = (chave, rotulo, tipo = 'texto') => ({ chave, rotulo, tipo });
const colLoja = () => col('nome', 'Loja', 'loja');
const indicador = (rotulo, valor, nota = null) => ({ rotulo, valor, nota });
const lista = (titulo, colunas, linhas) => ({ titulo, colunas, linhas });
const serieDe = (titulo, tipo, pontos) => ({ titulo, tipo, pontos });

// O que todo bloco devolve. `variacao` é preenchida depois, pelo passo
// diário, comparando `valor` com a linha de 7 e de 30 dias atrás.
function montarBloco({
  valor, unidade = null, resumo = null, serie = [], linhas = [], fonte,
  indicadores = [], listas = [], series = [], insight = null,
}) {
  return {
    valor,
    unidade,
    variacao: null,
    serie,
    resumo,
    lista: linhas,
    fonte,
    detalhe: { indicadores, listas, series, insight },
  };
}

const PLANO_ROTULO = { essencial: 'Essencial', negocio: 'Negócio', expansao: 'Expansão', personalizado: 'Personalizado' };
const CICLO_ROTULO = { monthly: 'Mensal', annual: 'Anual' };

function mediana(valores) {
  const v = valores.slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 10) / 10;
}

// Situação de uma loja no painel: Pagante (conta), Sem cobrança própria
// (ativa, mas paga pela matriz ou dojô sem assinatura) ou Trial.
const situacaoDe = (e) => (e.conta_pagante ? 'Pagante' : e.pagante ? 'Sem cobrança própria' : 'Trial');

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

// R$ 9.690,70
function brl(v) {
  const [inteiro, centavos] = Math.abs(round2(v)).toFixed(2).split('.');
  return `${round2(v) < 0 ? '-' : ''}R$ ${inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${centavos}`;
}

module.exports = {
  pool, TZ, NOME, TELEFONE, SEM_INTERNAS, ACOES_ACESSO,
  PAGA_POR_OUTRA, DOJO_SEM_ASSINATURA, motivoForaDaContagem, situacaoDe, VENDA_VALIDA,
  PAGAMENTO_ASAAS, EVENTOS_PAGOS,
  desde, diaBRT, num, round2,
  somaDias, diasEntre, rotuloDia, inicioDaSemana, ultimasSemanas, diaDe,
  consultar, opcional, carregarEmpresas, ref,
  vendasPorLoja, ultimaVendaPorLoja, acessoPorLoja,
  col, colLoja, indicador, lista, serieDe, montarBloco,
  PLANO_ROTULO, CICLO_ROTULO, mediana, plural, brl,
};
