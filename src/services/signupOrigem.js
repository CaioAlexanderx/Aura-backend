// ============================================================
// AURA. — Origem do cadastro (card t2-09, 15/10/2026)
//
// O site (aura-site, js/origem.js) guarda o primeiro toque do visitante e o
// manda em POST /auth/register como `origem`. Aqui:
//   - sanitizarOrigem: entrada pública, então tudo é whitelist + tamanho.
//     Chave desconhecida some, string acima do limite é cortada, valor que
//     não é texto some, landing_page perde query e #, referrer vira só o
//     host, first_seen_at tem de ser uma data válida. Sem nenhuma chave
//     válida devolve null (nada é gravado e o cadastro segue como sempre);
//   - gravarOrigem: UPDATE na empresa NOVA, na transação do cadastro, atrás
//     de SAVEPOINT (coluna ausente = deploy antes da migration 387; o
//     cadastro nunca cai por causa da origem);
//   - completarCidadePeloCnpj: o register não consulta a Receita, então a
//     cidade só entrava quando a loja passava pelo onboarding. Depois do
//     COMMIT, em segundo plano, usa o lookup do CNPJ (cache de 24h que o
//     próprio cadastro do site já aqueceu) e grava address_city/state se
//     estiverem vazios. Falhou, não grava: nunca atrapalha o cadastro.
//
// Não guarda IP, user agent, e-mail nem telefone: só o que o Marketing
// precisa para saber de onde veio o cadastro.
// ============================================================
'use strict';

const LIMITES = {
  utm_source: 100,
  utm_medium: 100,
  utm_campaign: 100,
  utm_content: 100,
  utm_term: 100,
  landing_page: 300,
  referrer: 200,
};
const CHAVES_UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
// utm_source e utm_medium agrupam melhor em minúsculas ("Google" = "google").
const EM_MINUSCULAS = new Set(['utm_source', 'utm_medium']);

// Texto limpo: só string, sem caractere de controle, aparado e cortado.
function texto(valor, max) {
  if (typeof valor !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const limpo = valor.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  return limpo.slice(0, max);
}

// "/planos?x=1#topo" -> "/planos"; URL inteira -> só o caminho. Query e hash
// podem carregar dado pessoal, então nunca entram.
function caminho(valor) {
  const t = texto(valor, 2000);
  if (!t) return null;
  let p = t;
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(p);
  if (url) p = p.slice(url[0].length);
  p = p.split('#')[0].split('?')[0];
  if (!p) p = '/';
  if (p[0] !== '/') p = `/${p}`;
  return p.slice(0, LIMITES.landing_page);
}

// "https://www.google.com/search?q=x" -> "www.google.com"; "www.google.com" fica.
function host(valor) {
  const t = texto(valor, 2000);
  if (!t) return null;
  let h = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  h = h.split(/[/?#]/)[0];
  h = h.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
  if (!h || !/^[a-z0-9.-]+$/.test(h)) return null;
  return h.slice(0, LIMITES.referrer);
}

function dataIso(valor) {
  if (typeof valor !== 'string' || valor.length > 40) return null;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  // Data absurda (relógio do aparelho errado) não serve para análise.
  const ano = d.getUTCFullYear();
  if (ano < 2024 || ano > 2100) return null;
  return d.toISOString();
}

// Devolve o objeto limpo, ou null quando não sobra nada.
function sanitizarOrigem(bruto) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const out = {};
  for (const chave of CHAVES_UTM) {
    const v = texto(bruto[chave], LIMITES[chave]);
    if (v) out[chave] = EM_MINUSCULAS.has(chave) ? v.toLowerCase() : v;
  }
  const landing = caminho(bruto.landing_page);
  if (landing) out.landing_page = landing;
  const ref = host(bruto.referrer);
  if (ref) out.referrer = ref;
  const visto = dataIso(bruto.first_seen_at);
  if (visto) out.first_seen_at = visto;
  return Object.keys(out).length ? out : null;
}

// Dentro da transação do cadastro. Devolve true se gravou.
async function gravarOrigem(client, companyId, origem) {
  if (!origem || !companyId) return false;
  try {
    await client.query('SAVEPOINT signup_origem');
    await client.query('UPDATE companies SET signup_origin = $2::jsonb WHERE id = $1', [companyId, JSON.stringify(origem)]);
    await client.query('RELEASE SAVEPOINT signup_origem');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK TO SAVEPOINT signup_origem'); } catch (_) { /* transação segue com o chamador */ }
    if (!(err && err.code === '42703')) {
      console.warn('[register] origem do cadastro não gravada:', err && err.message);
    }
    return false;
  }
}

// Depois do COMMIT. `lookup` = services/cnpj.lookupCNPJ; `redis` = cache.
async function completarCidadePeloCnpj({ db, companyId, cnpj, lookup, redis }) {
  const limpo = String(cnpj || '').replace(/\D/g, '');
  if (!companyId || limpo.length !== 14 || typeof lookup !== 'function') return false;
  try {
    const rf = await lookup(limpo, redis);
    const cidade = texto(rf && rf.address_city, 100);
    const uf = texto(rf && rf.address_state, 2);
    if (!cidade) return false;
    await db.query(
      `UPDATE companies
          SET address_city  = COALESCE(NULLIF(address_city, ''), $2),
              address_state = COALESCE(NULLIF(address_state, ''), $3)
        WHERE id = $1`,
      [companyId, cidade, uf]
    );
    return true;
  } catch (err) {
    console.warn('[register] cidade pelo CNPJ não gravada:', err && err.message);
    return false;
  }
}

module.exports = { sanitizarOrigem, gravarOrigem, completarCidadePeloCnpj, LIMITES };
