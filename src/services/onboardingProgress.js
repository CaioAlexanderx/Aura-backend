// ============================================================
// AURA. — Passo do cadastro que avança sozinho (17/10/2026, card t2-04)
//
// Por quê: 30 de 30 cadastros dos últimos 30 dias estavam em
// companies.onboarding_step = 'cnpj'. O passo nasce 'cnpj' no POST
// /auth/register e quem o avançava era o wizard de onboarding
// (POST /companies/:id/onboarding/step/{cnpj,regime,perfil}) — que o app
// aposentou em 08/04/2026 e nenhuma tela chama mais. O passo ficou parado
// para sempre e deixou de dizer em que ponto cada conta está.
//
// Agora o passo anda pelos marcos reais que o painel já lê (degraus de
// services/painelBlocos/trials_degrau.js: só cadastro → com produtos → vendeu):
//
//   cnpj     cadastro criado (valor de nascimento)
//   regime   (wizard antigo — mantido na escada para nunca regredir)
//   perfil   cadastro concluído: check-in respondido ou pulado
//   produto  primeiro produto (cadastro, lote, importação ou NF-e)
//   venda    primeira venda no Caixa
//   done     legado: wizard concluído (também 'complete' e 'completed')
//
// Regras: só avança (UPDATE condicionado ao posto atual — idempotente e
// seguro com requests simultâneos), nunca regride, nunca lança e nunca
// atrasa quem chama (os ganchos são fire-and-forget). Depois de alcançar um
// posto a empresa é lembrada em memória (por processo) e o gancho deixa de
// ir ao banco: a venda do Caixa não paga query extra depois da primeira.
// Nos testes o módulo vira no-op em tests/jest.setup.js — sem isso a query
// extra consumiria os mockResolvedValueOnce dos testes de rota.
// ============================================================
'use strict';

const db = require('../config/database');

// Posto de cada valor. Os apelidos do legado ('complete', 'completed') valem
// o mesmo que 'done'. Valor desconhecido ou NULL vale 0 (o mesmo que 'cnpj').
const POSTO = Object.freeze({
  cnpj: 0,
  regime: 1,
  perfil: 2,
  produto: 3,
  venda: 4,
  done: 5,
  complete: 5,
  completed: 5,
});

// Passos que os ganchos podem gravar (os apelidos do legado nunca são gravados).
const PASSOS = Object.freeze(['cnpj', 'regime', 'perfil', 'produto', 'venda', 'done']);

// CASE gerado da tabela acima (constantes do código, nunca entrada de usuário).
const CASE_POSTO = 'CASE onboarding_step '
  + Object.keys(POSTO).map((k) => `WHEN '${k}' THEN ${POSTO[k]}`).join(' ')
  + ' ELSE 0 END';

const SQL_AVANCAR = `
  UPDATE companies
     SET onboarding_step = $2
   WHERE id = $1
     AND ${CASE_POSTO} < $3::int`;

const LIMITE_MEMORIA = 5000;
const alcancado = new Map(); // companyId → maior posto já visto neste processo
let avisado = false;

function lembrar(companyId, posto) {
  if (alcancado.size >= LIMITE_MEMORIA) alcancado.clear();
  const prev = alcancado.get(companyId);
  if (prev === undefined || posto > prev) alcancado.set(companyId, posto);
}

// Avança o passo da empresa para `passo` se ele ainda não o alcançou.
// Retorna true quando gravou. Nunca lança.
async function avancarPasso(companyId, passo, { conn = db } = {}) {
  if (!companyId || !PASSOS.includes(passo)) return false;
  const posto = POSTO[passo];
  const visto = alcancado.get(companyId);
  if (visto !== undefined && visto >= posto) return false;
  try {
    const r = await conn.query(SQL_AVANCAR, [companyId, passo, posto]);
    // Gravou ou já estava no posto (ou além): em ambos os casos não precisa
    // voltar ao banco por este passo neste processo.
    lembrar(companyId, posto);
    return !!(r && r.rowCount > 0);
  } catch (err) {
    // Não marca como alcançado: o próximo marco tenta de novo.
    if (!avisado) {
      avisado = true;
      console.warn('[onboardingProgress] passo não avançado:', err && err.message);
    }
    return false;
  }
}

// Atalho dos ganchos: dispara sem aguardar e sem nunca lançar.
function avancarSemEsperar(companyId, passo) {
  Promise.resolve().then(() => avancarPasso(companyId, passo)).catch(() => {});
}

// Só para testes.
function _resetForTests() {
  alcancado.clear();
  avisado = false;
}

module.exports = { POSTO, PASSOS, SQL_AVANCAR, avancarPasso, avancarSemEsperar, _resetForTests };
