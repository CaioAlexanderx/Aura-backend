// ============================================================
// AURA. — Log do regime tributário no cadastro (prefixo [REGIME])
//
// 28/10/2026: desde 19/10 nenhum cadastro novo grava o regime vindo da
// Receita (MEI nasce simples_nacional). Cada camada, lida sozinha, parece
// certa. Este log mostra, cadastro a cadastro, o que a Receita respondeu
// (POST /onboarding/cnpj-lookup e a consulta pós-cadastro), o que o
// cliente mandou em `tax_regime` e o que foi ao INSERT.
//
// Só observa: nada é gravado e nenhuma regra muda. Nunca entra e-mail,
// senha, telefone, nome de pessoa nem CPF — o CNPJ só vai ao log quando
// tem 14 dígitos (o campo `cnpj` do register aceita 11 dígitos).
// Uma linha por evento: `[REGIME] {json}`.
// ============================================================
'use strict';

const PREFIXO = '[REGIME]';
const REGIME_PADRAO_DO_INSERT = 'simples_nacional';

function cnpjDoLog(cnpj) {
  const d = String(cnpj == null ? '' : cnpj).replace(/\D/g, '');
  if (!d) return 'sem CNPJ';
  if (d.length === 14) return d;
  return 'documento com ' + d.length + ' digitos';
}

// Valor de `tax_regime` como chegou no corpo, sem confiar no tipo.
function valorDoCorpo(v) {
  if (v === undefined) return '(ausente)';
  if (v === null) return '(null)';
  if (typeof v !== 'string') return '(' + typeof v + ')';
  if (!v.trim()) return '(vazio)';
  return v.slice(0, 40);
}

function emitir(dados) {
  try { console.log(PREFIXO + ' ' + JSON.stringify(dados)); } catch (_) { /* log nunca derruba o fluxo */ }
}

// Resultado de lookupCNPJ (que chama regimeDaReceita) ou o erro dele.
function dadosDaReceita({ etapa, cnpj, rf, erro }) {
  const base = { evento: 'receita', etapa, cnpj: cnpjDoLog(cnpj) };
  if (erro) {
    return {
      ...base,
      regime: null,
      provedor: null,
      erro: (erro && erro.message) || String(erro),
      erro_codigo: (erro && erro.code) || null,
      erro_status: (erro && erro.status) || null,
    };
  }
  const r = rf || {};
  return {
    ...base,
    regime: r.suggested_regime || null,
    regime_fonte: r.regime_fonte || null,
    regime_confirmar: r.regime_confirmar === undefined ? null : !!r.regime_confirmar,
    mei_optante: r.mei_optante === undefined ? null : !!r.mei_optante,
    simples_optante: r.simples_optante === undefined ? null : !!r.simples_optante,
    // rf_fonte existe desde o #877 (19/10); cache anterior não tem.
    provedor: r.rf_fonte || 'desconhecido',
    do_cache: !!r._from_cache,
    situacao_ativa: r.is_active === undefined ? null : !!r.is_active,
    erro: null,
  };
}

function logReceita(args) {
  try { emitir(dadosDaReceita(args)); } catch (_) { /* log nunca derruba o fluxo */ }
}

// Envolve lookupCNPJ sem mudar o que ele devolve ou lança.
function lookupComLog(lookup, etapa) {
  return async function (cnpj, redis) {
    let rf;
    try {
      rf = await lookup(cnpj, redis);
    } catch (e) {
      logReceita({ etapa, cnpj, erro: e });
      throw e;
    }
    logReceita({ etapa, cnpj, rf });
    return rf;
  };
}

// O que o register recebeu e o que foi ao INSERT de companies.
//   caminho: 'empresa_nova' | 'empresa_existente' | 'sem_empresa'
function dadosDoCadastro({ cnpj, temCpf, taxRegimeDoCorpo, regimeDoCadastro, caminho, regimeGravado, companyId, selfServe, temCodigo, regimesValidos }) {
  let descartado = null;
  if (taxRegimeDoCorpo !== undefined && taxRegimeDoCorpo !== null && taxRegimeDoCorpo !== '' && !regimeDoCadastro) {
    descartado = temCpf ? 'conta com CPF' : 'fora da lista ' + (regimesValidos || []).join('/');
  }
  const novo = caminho === 'empresa_nova';
  return {
    evento: 'cadastro',
    caminho,
    cnpj: cnpjDoLog(cnpj),
    regime_do_app: valorDoCorpo(taxRegimeDoCorpo),
    regime_descartado: descartado,
    // $10 do INSERT; null cai no COALESCE da coluna.
    param_insert: novo ? (regimeDoCadastro || null) : null,
    valor_no_insert: novo ? (regimeDoCadastro || REGIME_PADRAO_DO_INSERT) : null,
    via_coalesce: novo ? !regimeDoCadastro : null,
    gravado: novo ? (regimeGravado || null) : null,
    company_id: companyId || null,
    self_serve: !!selfServe,
    tem_codigo: !!temCodigo,
  };
}

function logCadastro(args) {
  try { emitir(dadosDoCadastro(args)); } catch (_) { /* log nunca derruba o fluxo */ }
}

module.exports = {
  PREFIXO,
  cnpjDoLog,
  valorDoCorpo,
  dadosDaReceita,
  dadosDoCadastro,
  logReceita,
  logCadastro,
  lookupComLog,
};
