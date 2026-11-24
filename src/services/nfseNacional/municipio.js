// ============================================================
// AURA. — nfseNacional/municipio: código IBGE do município emissor da
// NFS-e (cLocEmi) e a Situação perante o Simples Nacional pela Receita,
// para a tela "Pronto para emitir NFS-e?" já trazer preenchido. 23/11/2026.
//
// Por que existe: a DPS exige o código IBGE (7 dígitos) do município
// emissor. A sugestão vinha só de companies.ibge_code, que o cadastro não
// grava (o cnpj.ws devolve cidade.ibge_id, mas o mapeamento do lookup
// guarda só o nome da cidade): em 23/11/2026, 219 de 228 empresas estavam
// sem ibge_code, entre elas TODAS as lojas da Bahia. A tela então pedia
// para a lojista digitar o código.
//
// Ordem (a primeira que responder vence; nunca inventamos código):
//   1. companies.ibge_code (cadastro);
//   2. CEP da empresa → ViaCEP (services/ibgePeloCep);
//   3. cidade + UF da empresa → lista oficial de municípios do IBGE
//      (servicodados.ibge.gov.br/api/v1/localidades/estados/{UF}/municipios);
//   4. sem cidade/UF no cadastro: a consulta do CNPJ na Receita
//      (services/cnpj.lookupCNPJ, a mesma do cadastro) dá cidade, UF e CEP,
//      e o passo 2/3 resolve o código.
// A consulta à Receita também devolve a situação no Simples (MEI, ME/EPP
// ou fora). O Sistema Nacional confere a opSimpNac da DPS com o cadastro
// do Simples na data de competência (E0160), então a sugestão da tela
// segue a Receita quando ela é confirmada (regime_fonte 'receita') — e
// avisa quando o cadastro da Aura diz outra coisa.
//
// Tudo aqui é "melhor esforço": erro de rede, timeout ou resposta estranha
// viram null, e a tela continua pedindo o dado como antes.
// ============================================================
'use strict';

const { ibgePeloCep } = require('../ibgePeloCep');
const { opSimpNacDoRegime } = require('./config');

const IBGE_BASE = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados';
const TIMEOUT_MS = 4000;
const TTL_UF_MS = 7 * 24 * 60 * 60 * 1000; // a lista de municípios quase nunca muda
const TTL_RECEITA_OK_MS = 6 * 60 * 60 * 1000;
const TTL_RECEITA_FALHA_MS = 10 * 60 * 1000;

const UFS = new Set(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB',
  'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);

const _porUf = new Map();     // UF → { mapa: Map(nomeNormalizado → id), ate }
const _receita = new Map();   // cnpj → { valor, ate }

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/**
 * Nome comparável: sem acento, maiúsculo, apóstrofo/hífen/ponto viram
 * espaço ("Dias d'Ávila" = "DIAS D AVILA"; "Xique-Xique" = "XIQUE XIQUE").
 */
function normalizarNomeMunicipio(nome) {
  return String(nome == null ? '' : nome)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[’'`´\-.]/g, ' ')
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarUf(uf) {
  const u = String(uf == null ? '' : uf).trim().toUpperCase();
  return UFS.has(u) ? u : null;
}

async function _getJson(url, fetchImpl, timeoutMs) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const resp = await f(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Aura-Backend/1.0', Accept: 'application/json' },
    });
    if (!resp || !resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Código IBGE pelo nome da cidade e a UF, na lista oficial do IBGE.
 * @returns {Promise<string|null>} 7 dígitos ou null
 */
async function ibgePeloNome(municipio, uf, opts = {}) {
  const u = normalizarUf(uf);
  const nome = normalizarNomeMunicipio(municipio);
  if (!u || !nome) return null;
  let hit = _porUf.get(u);
  if (!hit || hit.ate <= Date.now()) {
    const lista = await _getJson(`${IBGE_BASE}/${u}/municipios`, opts.fetchImpl, opts.timeoutMs);
    if (!Array.isArray(lista) || !lista.length) return null; // falha não é cacheada
    const mapa = new Map();
    for (const m of lista) {
      const id = String(m && m.id != null ? m.id : '');
      if (/^\d{7}$/.test(id) && m.nome) mapa.set(normalizarNomeMunicipio(m.nome), id);
    }
    if (!mapa.size) return null;
    hit = { mapa, ate: Date.now() + TTL_UF_MS };
    _porUf.set(u, hit);
  }
  return hit.mapa.get(nome) || null;
}

/**
 * Consulta da Receita (lookupCNPJ), com cache em memória por CNPJ. O
 * lookup já tem três fontes e cache no Redis; aqui só evitamos repetir a
 * consulta a cada abertura da tela. @returns {Promise<object|null>}
 */
async function receitaDoCnpj(cnpj, lookup) {
  const c = onlyDigits(cnpj);
  if (c.length !== 14 || typeof lookup !== 'function') return null;
  const hit = _receita.get(c);
  if (hit && hit.ate > Date.now()) return hit.valor;
  let valor = null;
  try {
    valor = (await lookup(c)) || null;
  } catch (_) {
    valor = null;
  }
  if (_receita.size >= 2000) _receita.clear();
  _receita.set(c, { valor, ate: Date.now() + (valor ? TTL_RECEITA_OK_MS : TTL_RECEITA_FALHA_MS) });
  return valor;
}

/**
 * Município (IBGE) e situação no Simples sugeridos para a NFS-e.
 * @param {object} company — linha de companies
 * @param {{ fetchImpl?, buscarCep?, lookupReceita?, consultarReceita? }} [deps]
 *   consultarReceita=false pula a Receita (passo 4 e o regime)
 * @returns {Promise<{ municipio_ibge, municipio, uf, fonte_municipio,
 *   receita: null | { op_simp_nac, regime, fonte } }>}
 */
async function resolverMunicipioERegime(company, deps = {}) {
  const c = company || {};
  const buscarCep = deps.buscarCep || ((cep) => ibgePeloCep(cep, { fetchImpl: deps.fetchImpl }));
  const out = {
    municipio_ibge: null,
    municipio: c.address_city || null,
    uf: normalizarUf(c.address_state),
    fonte_municipio: null,
    receita: null,
  };

  const doCadastro = onlyDigits(c.ibge_code);
  if (/^\d{7}$/.test(doCadastro)) {
    Object.assign(out, { municipio_ibge: doCadastro, fonte_municipio: 'cadastro' });
  }

  const tentarEndereco = async (cep, cidade, uf, fonteCep, fonteNome) => {
    if (out.municipio_ibge) return;
    if (onlyDigits(cep).length === 8) {
      const v = await buscarCep(onlyDigits(cep)).catch(() => null);
      if (v && /^\d{7}$/.test(String(v.ibge || ''))
          && (!uf || !v.uf || String(v.uf).toUpperCase() === uf)) {
        Object.assign(out, {
          municipio_ibge: String(v.ibge), fonte_municipio: fonteCep,
          municipio: out.municipio || v.municipio || null, uf: out.uf || normalizarUf(v.uf),
        });
        return;
      }
    }
    if (cidade && uf) {
      const id = await ibgePeloNome(cidade, uf, deps).catch(() => null);
      if (id) Object.assign(out, { municipio_ibge: id, fonte_municipio: fonteNome, municipio: out.municipio || cidade, uf: out.uf || uf });
    }
  };

  await tentarEndereco(c.address_zip, c.address_city, out.uf, 'cep', 'nome_da_cidade');

  if (deps.consultarReceita !== false && typeof deps.lookupReceita === 'function') {
    const rf = await receitaDoCnpj(c.cnpj, deps.lookupReceita);
    if (rf) {
      const ufRf = normalizarUf(rf.address_state);
      // o endereço do cadastro (quando existe) vence o da Receita
      if (!out.municipio && rf.address_city) out.municipio = rf.address_city;
      if (!out.uf && ufRf) out.uf = ufRf;
      await tentarEndereco(rf.address_zip, rf.address_city, ufRf, 'receita_cep', 'receita');
      const op = opSimpNacDoRegime(rf.suggested_regime);
      if (op && rf.regime_fonte === 'receita') {
        out.receita = { op_simp_nac: op, regime: rf.suggested_regime, fonte: 'receita' };
      }
    }
  }
  return out;
}

/**
 * Junta a resolução (resolverMunicipioERegime) na sugestão da tela
 * (config.sugestaoDaEmpresa). Pura. O código do cadastro nunca é trocado;
 * a situação no Simples segue a Receita confirmada e, quando o cadastro da
 * Aura diz outra coisa, `regime_divergente` conta as duas.
 */
function completarSugestao(sugestao, resolucao, company, config = null) {
  const s = { ...(sugestao || {}) };
  const r = resolucao || {};
  if (!s.municipio_ibge && /^\d{7}$/.test(String(r.municipio_ibge || ''))) {
    s.municipio_ibge = String(r.municipio_ibge);
    s.municipio_ibge_fonte = r.fonte_municipio || null;
  } else if (s.municipio_ibge) {
    s.municipio_ibge_fonte = 'cadastro';
  }
  if (!s.municipio && r.municipio) s.municipio = r.municipio;
  if (!s.uf && r.uf) s.uf = r.uf;
  if (r.receita && r.receita.op_simp_nac) {
    const doCadastro = opSimpNacDoRegime(company && company.tax_regime);
    if (doCadastro !== r.receita.op_simp_nac) {
      s.regime_divergente = {
        cadastro_aura: (company && company.tax_regime) || null,
        receita: r.receita.regime,
      };
    }
    s.op_simp_nac = r.receita.op_simp_nac;
    s.reg_ap_trib_sn = r.receita.op_simp_nac === 3 ? 1 : null;
    s.fonte = 'receita';
    // a loja já gravou outra situação na config: a nota voltaria com E0160
    const gravada = config && config.op_simp_nac != null ? Number(config.op_simp_nac) : null;
    if (gravada && gravada !== r.receita.op_simp_nac) {
      s.aviso_regime = `A Situação perante o Simples Nacional escolhida (${ROTULO_OP[gravada] || gravada}) `
        + `não é a que a Receita Federal mostra para este CNPJ (${ROTULO_OP[r.receita.op_simp_nac]}). `
        + 'O gov.br confere essa informação e recusa a nota quando ela não bate. '
        + 'Confira com o seu contador e ajuste no passo Dados da nota.';
    }
  }
  return s;
}

const ROTULO_OP = { 1: 'não optante', 2: 'MEI', 3: 'ME/EPP do Simples Nacional' };

function _limparCaches() { _porUf.clear(); _receita.clear(); }

module.exports = {
  normalizarNomeMunicipio, normalizarUf, ibgePeloNome, receitaDoCnpj, resolverMunicipioERegime, completarSugestao,
  IBGE_BASE, _limparCaches,
};
