// ============================================================
// AURA. — Regra do trial (13/10/2026)
//
// Por quê: o self-service converteu 0 de 21 contas em 120 dias. O trial de
// 7 dias corridos do cadastro acabava antes de a loja sentir valor — 8 de 12
// trials ativos só tinham carregado estoque quando o muro chegou.
//
// Regra (única fonte das constantes; migration 379):
//
//   Cadastro self-service → trial_mode = 'primeira_venda' e
//     trial_ends_at = created_at + 15 dias (o TETO).
//   Primeira venda do Caixa → trial_started_by_sale_at = agora e
//     trial_ends_at = min(agora + 7 dias, created_at + 15 dias).
//
//   Ou seja: os 7 dias começam na primeira venda, mas nunca passam de 15 dias
//   corridos do cadastro. Quem nunca vende bate no teto.
//
//   Todo o resto é 'fixo' (trial_ends_at vale como está): conta por código de
//   acesso, convite, Gestão Aura, dojô, e qualquer conta em que alguém
//   escreveu trial_ends_at depois — estender trial, cupom de dias grátis
//   (inclusive quem resgatou o PRIMEIROMES, campanha removida em 19/10, cuja
//   data segue valendo). Quem escreve trial_ends_at chama marcarTrialFixo, senão a
//   primeira venda encurtaria a data que o cupom acabou de dar.
//
//   Venda depois do vencimento não reinicia nada (Caixa vivo, app#1043: trial
//   vencido continua vendendo, e só isso).
//
// O backend não tem gate de trial: quem ergue o muro é o app, lendo
// billing_status e trial_ends_at. Por isso a regra inteira se resume a
// escrever trial_ends_at certo.
//
// Nos testes, iniciarTrialPelaPrimeiraVenda e marcarTrialFixo viram no-op em
// tests/jest.setup.js (fariam uma query a mais e comeriam os
// mockResolvedValueOnce das rotas); os testes da regra usam jest.unmock.
// ============================================================
'use strict';

const db = require('../config/database');

const DIAS_APOS_PRIMEIRA_VENDA = 7;
const TETO_DIAS = 15;
// Cadastro sem as colunas da 379 (deploy antes da migration) e dojô: o trial
// de sempre.
const DIAS_FIXO_LEGADO = 7;

const MODO_FIXO = 'fixo';
const MODO_PRIMEIRA_VENDA = 'primeira_venda';

const DIA_MS = 86400000;
// Coluna ausente: não insistir a cada venda, mas voltar a tentar sozinho
// depois que a migration entrar (sem precisar reiniciar o processo).
const PAUSA_SEM_COLUNA_MS = 10 * 60 * 1000;

// Empresas cujo destino já foi decidido neste processo (começou agora, já
// tinha começado, é 'fixo' ou venceu). Evita um UPDATE a cada venda.
const resolvidas = new Set();
let semColunaAte = 0;
let avisado = false;

function tetoDe(createdAt) {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) ? new Date(t + TETO_DIAS * DIA_MS) : null;
}

// Fim do trial quando a primeira venda acontece em `agora`.
function fimPelaPrimeiraVenda(createdAt, agora = new Date()) {
  const seteDias = new Date(new Date(agora).getTime() + DIAS_APOS_PRIMEIRA_VENDA * DIA_MS);
  const teto = tetoDe(createdAt);
  return teto && teto < seteDias ? teto : seteDias;
}

// O bloco `trial` do /auth/me. Antes da primeira venda o relógio "não anda" na
// comunicação: o app mostra "seu teste começa na primeira venda; termina no
// máximo em dd/mm" (teto_em) em vez de contar dias.
function montarTrial(company, agora = new Date()) {
  if (!company) return null;
  const mode = company.trial_mode === MODO_PRIMEIRA_VENDA ? MODO_PRIMEIRA_VENDA : MODO_FIXO;
  const ends = company.trial_ends_at ? new Date(company.trial_ends_at) : null;
  const started = mode === MODO_PRIMEIRA_VENDA && company.trial_started_by_sale_at
    ? new Date(company.trial_started_by_sale_at) : null;
  const teto = mode === MODO_PRIMEIRA_VENDA ? tetoDe(company.created_at) : null;
  const restante = ends ? ends.getTime() - new Date(agora).getTime() : null;
  return {
    mode,
    ends_at: ends ? ends.toISOString() : null,
    started_by_sale_at: started ? started.toISOString() : null,
    dias_restantes: restante === null ? null : Math.max(0, Math.ceil(restante / DIA_MS)),
    teto_em: teto ? teto.toISOString() : null,
    aguardando_primeira_venda: mode === MODO_PRIMEIRA_VENDA && !started && restante !== null && restante > 0,
    dias_apos_primeira_venda: DIAS_APOS_PRIMEIRA_VENDA,
  };
}

// Um UPDATE só, atômico: duas vendas simultâneas não iniciam o trial duas
// vezes (a segunda não casa o `trial_started_by_sale_at IS NULL`).
//   - trial_ends_at > NOW(): venda depois do vencimento não reinicia nada;
//   - sem assinatura e sem billing 'active': quem já assinou não tem trial
//     para iniciar (e next_billing_date é que manda).
const SQL_INICIAR = `
  UPDATE companies
     SET trial_started_by_sale_at = NOW(),
         trial_ends_at = LEAST(NOW() + $2::int * INTERVAL '1 day',
                               created_at + $3::int * INTERVAL '1 day'),
         updated_at = NOW()
   WHERE id = $1
     AND trial_mode = '${MODO_PRIMEIRA_VENDA}'
     AND trial_started_by_sale_at IS NULL
     AND trial_ends_at IS NOT NULL
     AND trial_ends_at > NOW()
     AND asaas_subscription_id IS NULL
     AND billing_status IS DISTINCT FROM 'active'
  RETURNING trial_ends_at, trial_started_by_sale_at`;

// Gancho da venda (POST /pdv/sale, depois do COMMIT). Nunca lança: falha aqui
// não pode derrubar a venda. Retorna { iniciou, trial_ends_at? }.
async function iniciarTrialPelaPrimeiraVenda(companyId, { conn = db, agora = Date.now() } = {}) {
  if (!companyId) return { iniciou: false };
  if (resolvidas.has(companyId)) return { iniciou: false };
  if (agora < semColunaAte) return { iniciou: false };
  try {
    const { rows } = await conn.query(SQL_INICIAR, [companyId, DIAS_APOS_PRIMEIRA_VENDA, TETO_DIAS]);
    resolvidas.add(companyId);
    if (rows && rows.length) {
      console.log('[trial] primeira venda: company=' + companyId + ' trial ate ' +
                  new Date(rows[0].trial_ends_at).toISOString());
      return {
        iniciou: true,
        trial_ends_at: rows[0].trial_ends_at,
        trial_started_by_sale_at: rows[0].trial_started_by_sale_at,
      };
    }
    return { iniciou: false };
  } catch (err) {
    // Sem marcar como resolvida: a próxima venda tenta de novo.
    if (err && err.code === '42703') {
      semColunaAte = agora + PAUSA_SEM_COLUNA_MS;
    } else if (!avisado) {
      avisado = true;
      console.warn('[trial] primeira venda não registrada:', err && err.message);
    }
    return { iniciou: false, erro: true };
  }
}

// Quem escreve trial_ends_at por outro motivo (estender trial, cupom de dias
// grátis) chama isto logo depois. Query separada de propósito:
// dentro do UPDATE principal, a coluna ausente (42703) derrubaria a cobrança
// ou a extensão. Nunca lança.
async function marcarTrialFixo(companyId, { conn = db } = {}) {
  if (!companyId) return false;
  try {
    await conn.query(
      `UPDATE companies SET trial_mode = '${MODO_FIXO}' WHERE id = $1 AND trial_mode <> '${MODO_FIXO}'`,
      [companyId]
    );
    return true;
  } catch (err) {
    if (!(err && err.code === '42703')) {
      console.warn('[trial] trial_mode fixo não gravado: company=' + companyId, err && err.message);
    }
    return false;
  }
}

// Cadastro self-service: liga o modo e troca os 7 dias fixos pelo teto.
// Roda DENTRO da transação do cadastro, atrás de um SAVEPOINT — sem as
// colunas da 379 o INSERT com 7 dias fixos fica valendo e o cadastro segue.
// Retorna a linha atualizada ou null.
const SQL_LIGAR_NO_CADASTRO = `
  UPDATE companies
     SET trial_mode = '${MODO_PRIMEIRA_VENDA}',
         trial_ends_at = created_at + $2::int * INTERVAL '1 day'
   WHERE id = $1
  RETURNING trial_ends_at, trial_mode, trial_started_by_sale_at, created_at`;

async function ligarPrimeiraVendaNoCadastro(client, companyId) {
  try {
    await client.query('SAVEPOINT trial_primeira_venda');
    const { rows } = await client.query(SQL_LIGAR_NO_CADASTRO, [companyId, TETO_DIAS]);
    await client.query('RELEASE SAVEPOINT trial_primeira_venda');
    return (rows && rows[0]) || null;
  } catch (err) {
    try { await client.query('ROLLBACK TO SAVEPOINT trial_primeira_venda'); } catch (_) { /* transação segue com o chamador */ }
    if (!(err && err.code === '42703')) {
      console.warn('[trial] modo primeira_venda não ligado no cadastro:', err && err.message);
    }
    return null;
  }
}

// 17/10/2026 (t1-14): o cadastro pelo site manda access_code. COMECAR (tipo
// 'trial') e os códigos de indicação REF- (tipo 'referral') são o mesmo
// self-service com outro nome: entram em 'primeira_venda'. Convite, dojô e
// códigos de campanha (tipo promo/manual/trial de outro nome) seguem 'fixo'.
// Só vale se o código dá um trial curto (1..TETO_DIAS): um código que dá mais
// dias que o teto não pode ser encurtado por esta regra.
const CODIGO_SELF_SERVICE = 'COMECAR';
function codigoEntraNaPrimeiraVenda({ codigo, tipo, trialDays } = {}) {
  const dias = Number(trialDays) || 0;
  if (dias < 1 || dias > TETO_DIAS) return false;
  if (tipo === 'referral') return true;
  return tipo === 'trial' && typeof codigo === 'string' &&
    codigo.toUpperCase().trim() === CODIGO_SELF_SERVICE;
}

// Só para testes.
function _resetForTests() {
  resolvidas.clear();
  semColunaAte = 0;
  avisado = false;
}

module.exports = {
  DIAS_APOS_PRIMEIRA_VENDA,
  TETO_DIAS,
  DIAS_FIXO_LEGADO,
  MODO_FIXO,
  MODO_PRIMEIRA_VENDA,
  SQL_INICIAR,
  SQL_LIGAR_NO_CADASTRO,
  tetoDe,
  fimPelaPrimeiraVenda,
  montarTrial,
  iniciarTrialPelaPrimeiraVenda,
  marcarTrialFixo,
  ligarPrimeiraVendaNoCadastro,
  codigoEntraNaPrimeiraVenda,
  _resetForTests,
};
