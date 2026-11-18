// ============================================================
// AURA. — Regime tributário da empresa nova no cadastro
//
// 17/11/2026 (b-tq-regime-cadastro): desde 19/10 o cadastro não gravava o
// regime da Receita. O POST /auth/register usava só o `tax_regime` do
// corpo, e o cadastro do site (/comecar) nunca mandou o campo: todo
// cadastro pelo site caía no COALESCE do INSERT e nascia simples_nacional,
// MEI inclusive (log [REGIME] de 10/11 mostrou: Receita "mei", corpo
// ausente, gravado simples_nacional).
//
// Agora o register consulta a Receita (o mesmo lookupCNPJ do
// /onboarding/cnpj-lookup) e decide aqui:
//   - conta com CPF: nada muda (sem regime, a coluna fica no default);
//   - Receita confiável (regime_fonte 'receita'): vale a Receita, mesmo que
//     o corpo diga outra coisa. Única exceção: a Receita não distingue
//     Presumido de Real; se ela diz "fora do Simples" e o corpo traz
//     lucro_presumido ou lucro_real, vale o corpo;
//   - Receita estimada (sem o dado do Simples/MEI), fora do ar, lenta ou
//     CNPJ não encontrado: o comportamento de antes (o corpo, se válido;
//     senão o default da coluna) e o log [REGIME] registra o motivo.
//
// Nunca bloqueia o cadastro: a consulta tem prazo e nunca lança.
// "Estimado" não tem coluna em companies (não existe tax_regime_fonte);
// a origem da decisão vai só ao log [REGIME].
// ============================================================
'use strict';

const REGIMES = ['mei', 'simples_nacional', 'lucro_presumido', 'lucro_real'];

// O register soma bcrypt e várias idas ao banco; o app aborta em 10 s e
// tenta de novo (retry: 1). A consulta não pode passar disso.
const PRAZO_CONSULTA_MS = 3500;

function cnpjConsultavel(cnpj) {
  const d = String(cnpj == null ? '' : cnpj).replace(/\D/g, '');
  return d.length === 14 ? d : null;
}

// Dispara a consulta à Receita e devolve:
//   bruta:    a promessa do lookup, sem prazo (serve à cidade em segundo plano,
//             para não consultar a Receita duas vezes); nunca fica sem catch;
//   resultado: Promise<{ rf } | { erro }> com prazo, que nunca rejeita.
function consultarReceita(lookup, cnpj, redis, { prazoMs = PRAZO_CONSULTA_MS } = {}) {
  let bruta;
  try {
    bruta = Promise.resolve(lookup(cnpj, redis));
  } catch (e) {
    bruta = Promise.reject(e);
  }
  bruta.catch(() => {});
  let timer = null;
  const prazo = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ erro: 'prazo de ' + prazoMs + ' ms esgotado' }), prazoMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  const resultado = Promise.race([
    bruta.then((rf) => ({ rf }), (e) => ({ erro: (e && e.message) || String(e) })),
    prazo,
  ]).then((r) => { clearTimeout(timer); return r; });
  return { bruta, resultado };
}

// Decide o regime que vai ao INSERT ($10; null = default da coluna).
//   origem: 'cpf' | 'receita' | 'corpo' | 'padrao'
function decidirRegime({ temCpf, regimeDoCorpo, receita }) {
  const corpo = REGIMES.includes(regimeDoCorpo) ? regimeDoCorpo : null;
  if (temCpf) return { regime: null, origem: 'cpf', motivo: 'conta com CPF' };

  const rf = receita && receita.rf;
  const regimeRf = rf && REGIMES.includes(rf.suggested_regime) ? rf.suggested_regime : null;
  const confiavel = !!(regimeRf && rf.regime_fonte === 'receita');

  if (confiavel) {
    const foraDoSimples = rf.regime_confirmar === true && regimeRf === 'lucro_presumido';
    if (foraDoSimples && (corpo === 'lucro_presumido' || corpo === 'lucro_real')) {
      return { regime: corpo, origem: 'corpo', motivo: 'Receita fora do Simples; Presumido/Real do corpo' };
    }
    return {
      regime: regimeRf,
      origem: 'receita',
      motivo: corpo && corpo !== regimeRf ? 'corpo divergia da Receita (' + corpo + ')' : (corpo ? 'corpo igual a Receita' : 'corpo sem regime'),
    };
  }

  let motivo;
  if (!receita) motivo = 'sem consulta';
  else if (receita.erro) motivo = 'consulta falhou: ' + String(receita.erro).slice(0, 120);
  else motivo = 'Receita sem dado confiavel (' + ((rf && rf.regime_fonte) || 'sem regime') + ')';

  if (corpo) return { regime: corpo, origem: 'corpo', motivo };
  return { regime: null, origem: 'padrao', motivo };
}

module.exports = {
  REGIMES,
  PRAZO_CONSULTA_MS,
  cnpjConsultavel,
  consultarReceita,
  decidirRegime,
};
