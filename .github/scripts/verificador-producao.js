'use strict';
// VERIFICADOR DE PRODUÇÃO (t1-04, 14/10/2026) — roda pelo workflow
// .github/workflows/verificador-producao.yml a cada 15 min.
//
// Pergunta: o que está no ar é o que está em `main`?
//   backend: `version` do /health (8 caracteres do commit) contra main do
//            Aura-backend;
//   app:     `sha` do https://app.getaura.com.br/version.json contra main do
//            aura-app.
// Se algum estiver defasado há mais de LIMITE_MIN (20 min), contando do
// commit mais antigo de main que ainda não está no ar, o job falha e abre
// (ou atualiza) uma issue. Quando tudo volta ao normal, a issue é fechada.
//
// Por que existe: 3 builds do app sem resultado em 20 dias (23/09 50 min,
// 07/10 horas, 12/10 77 min) e deploys do backend que falharam com o
// /health verde (a versão antiga continuava respondendo 200).
//
// version.json com sha "main": o build disparado pelo deploy hook (rede de
// segurança do aura-app#1032) grava o nome do branch em vez do commit. Aí
// não dá para comparar: registra como "sem sha" e NÃO falha. Para não ficar
// cego, compara o builtAt com a data do último commit de main e anota.
//
// Sem dependências: Node 20 (fetch nativo). Toda a decisão fica em funções
// puras exportadas, testadas em tests/unit/verificadorProducao.test.js.

const LIMITE_MIN_PADRAO = 20;
const TITULO_ISSUE = 'Produção defasada: main não está no ar (verificador)';
const MARCA_ISSUE = '<!-- verificador-producao -->';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function shaValido(s) {
  return typeof s === 'string' && SHA_RE.test(s.trim());
}

function minutosDesde(iso, agora) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((agora.getTime() - t) / 60000));
}

/**
 * Decide o estado de um alvo.
 * @param {object} p
 * @param {string} p.nome            'backend' | 'app'
 * @param {string|null} p.noAr       sha (curto ou longo) que está no ar
 * @param {string} p.mainSha         sha completo de main
 * @param {string} p.mainData        data (ISO) do último commit de main
 * @param {string|null} p.pendenteDesde data (ISO) do commit mais antigo de
 *                                   main que não está no ar (compare); null
 *                                   quando não deu para saber
 * @param {string|null} [p.builtAt]  só o app: quando o bundle foi gerado
 * @param {string|null} [p.erro]     falha ao ler o que está no ar
 * @returns {{ nome, estado, falha, minutos, resumo }}
 *   estado: 'em_dia' | 'atrasado' | 'defasado' | 'sem_sha' | 'indisponivel'
 *   falha:  true só em 'defasado' e 'indisponivel'
 */
function avaliarAlvo({ nome, noAr, mainSha, mainData, pendenteDesde, builtAt = null, erro = null }, agora, limiteMin = LIMITE_MIN_PADRAO) {
  const curto = (s) => String(s || '').slice(0, 8);

  if (erro) {
    return { nome, estado: 'indisponivel', falha: true, minutos: null,
      resumo: `${nome}: não consegui ler a versão no ar (${erro})` };
  }

  if (!shaValido(noAr)) {
    // Ex.: version.json com sha "main" (build pelo deploy hook) ou /health
    // com "1.0.0" (deploy sem commit). Registra, não falha.
    let nota = '';
    if (builtAt && mainData) {
      const build = Date.parse(builtAt);
      const commit = Date.parse(mainData);
      if (Number.isFinite(build) && Number.isFinite(commit)) {
        nota = build >= commit
          ? ` O build (${builtAt}) é posterior ao último commit de main (${mainData}): provavelmente em dia.`
          : ` O build (${builtAt}) é ANTERIOR ao último commit de main (${mainData}): pode estar defasado; conferir o bundle.`;
      }
    }
    return { nome, estado: 'sem_sha', falha: false, minutos: null,
      resumo: `${nome}: versão no ar sem sha ("${noAr}"), não dá para comparar com main ${curto(mainSha)}.${nota}` };
  }

  const v = noAr.trim().toLowerCase();
  if (String(mainSha).toLowerCase().startsWith(v) || v.startsWith(String(mainSha).toLowerCase())) {
    return { nome, estado: 'em_dia', falha: false, minutos: 0,
      resumo: `${nome}: em dia (${curto(v)} = main)` };
  }

  // Defasado: conta do commit mais antigo que falta; sem o compare, do
  // último commit de main (subestima, nunca superestima).
  const minutos = minutosDesde(pendenteDesde || mainData, agora);
  if (minutos !== null && minutos > limiteMin) {
    return { nome, estado: 'defasado', falha: true, minutos,
      resumo: `${nome}: DEFASADO há ${minutos} min — no ar ${curto(v)}, main ${curto(mainSha)}` };
  }
  return { nome, estado: 'atrasado', falha: false, minutos,
    resumo: `${nome}: ainda subindo (${minutos === null ? '?' : minutos} min de ${limiteMin}) — no ar ${curto(v)}, main ${curto(mainSha)}` };
}

const nomesComFalha = (resultados) => resultados.filter((r) => r.falha).map((r) => r.nome).sort().join(',');

// Quais alvos falhavam na última vez (marca escondida no corpo da issue).
function falhasRegistradas(corpo) {
  const m = /<!-- falhas:([^>]*?) -->/.exec(corpo || '');
  return m ? m[1].trim() : null;
}

// O que fazer com a issue, dado o resultado e a issue aberta (ou null).
function decidirIssue(resultados, issueAberta) {
  const falhas = resultados.filter((r) => r.falha);
  if (falhas.length) return issueAberta ? 'atualizar' : 'abrir';
  return issueAberta ? 'fechar' : 'nada';
}

function corpoIssue(resultados, agora, runUrl) {
  const linhas = resultados.map((r) => `- ${r.falha ? '**FALHA**' : 'ok'} — ${r.resumo}`);
  return [
    MARCA_ISSUE,
    `<!-- falhas:${nomesComFalha(resultados)} -->`,
    `Última verificação: ${agora.toISOString()}${runUrl ? ` ([execução](${runUrl}))` : ''}`,
    '',
    ...linhas,
    '',
    'O que fazer:',
    '- **app**: Cloudflare > Workers & Pages > aura-app > Deployments > Build history. Se o build do último commit não existe ou ficou "Skipped", "Retry build" **no commit mais recente** (nunca num anterior).',
    '- **backend**: Railway > Aura-backend > Deployments. Deploy FAILED/SKIPPED (CI vermelho, Wait for CI, preDeploy das migrations) ou nenhum deploy do commit. Ver docs/deploy.md.',
    '',
    'Esta issue é aberta e fechada sozinha pelo workflow "Verificador de produção" (.github/workflows/verificador-producao.yml).',
  ].join('\n');
}

// ── Leitura (rede) ─────────────────────────────────────────────────────────

async function lerJson(url, { tentativas = 3, esperaMs = 5000, headers = {}, fetchFn = fetch } = {}) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const res = await fetchFn(url, { headers: { 'cache-control': 'no-cache', ...headers } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      ultimoErro = e;
      if (i < tentativas - 1) await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
  throw ultimoErro;
}

function criarGithub({ token, fetchFn = fetch }) {
  const base = 'https://api.github.com';
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  async function req(metodo, caminho, corpo) {
    const res = await fetchFn(base + caminho, {
      method: metodo,
      headers: { ...headers, ...(corpo ? { 'content-type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${metodo} ${caminho}: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  return {
    async main(repo) {
      const c = await req('GET', `/repos/${repo}/commits/main`);
      return { sha: c.sha, data: c.commit && c.commit.committer && c.commit.committer.date };
    },
    // Data do commit mais antigo de main que não está no ar.
    async pendenteDesde(repo, noAr) {
      try {
        const cmp = await req('GET', `/repos/${repo}/compare/${encodeURIComponent(noAr)}...main`);
        const c = cmp && cmp.commits && cmp.commits[0];
        return (c && c.commit && c.commit.committer && c.commit.committer.date) || null;
      } catch (_) {
        return null; // sha desconhecido: avaliarAlvo usa a data de main
      }
    },
    async issueAberta(repo) {
      const lista = await req('GET', `/repos/${repo}/issues?state=open&per_page=100`);
      return (lista || []).find((i) => !i.pull_request && i.title === TITULO_ISSUE) || null;
    },
    abrir: (repo, body) => req('POST', `/repos/${repo}/issues`, { title: TITULO_ISSUE, body }),
    editar: (repo, numero, dados) => req('PATCH', `/repos/${repo}/issues/${numero}`, dados),
    comentar: (repo, numero, body) => req('POST', `/repos/${repo}/issues/${numero}/comments`, { body }),
  };
}

async function verificarAlvo({ nome, repo, url, extrair }, gh, agora, limiteMin, fetchFn) {
  const main = await gh.main(repo);
  let noAr = null; let builtAt = null; let erro = null;
  try {
    const json = await lerJson(url, { fetchFn });
    ({ noAr, builtAt } = extrair(json));
  } catch (e) {
    erro = e.message;
  }
  const pendenteDesde = !erro && shaValido(noAr) && !main.sha.startsWith(noAr)
    ? await gh.pendenteDesde(repo, noAr)
    : null;
  return avaliarAlvo({ nome, noAr, mainSha: main.sha, mainData: main.data, pendenteDesde, builtAt, erro }, agora, limiteMin);
}

async function executar({ env = process.env, fetchFn = fetch, log = console, agora = new Date() } = {}) {
  const limiteMin = Number(env.LIMITE_MIN) > 0 ? Number(env.LIMITE_MIN) : LIMITE_MIN_PADRAO;
  const gh = criarGithub({ token: env.GITHUB_TOKEN, fetchFn });
  const dono = env.REPO_DONO || 'CaioAlexanderx';
  const alvos = [
    {
      nome: 'backend',
      repo: `${dono}/Aura-backend`,
      url: env.BACKEND_HEALTH_URL || 'https://aura-backend-production-f805.up.railway.app/health',
      extrair: (j) => ({ noAr: j && j.version, builtAt: null }),
    },
    {
      nome: 'app',
      repo: `${dono}/aura-app`,
      url: env.APP_VERSION_URL || 'https://app.getaura.com.br/version.json',
      extrair: (j) => ({ noAr: j && j.sha, builtAt: j && j.builtAt }),
    },
  ];

  const resultados = [];
  for (const alvo of alvos) {
    resultados.push(await verificarAlvo(alvo, gh, agora, limiteMin, fetchFn));
  }
  for (const r of resultados) (r.falha ? log.error : log.log)(r.resumo);

  // A issue fica no repositório onde o workflow roda.
  const repoIssue = env.GITHUB_REPOSITORY || `${dono}/Aura-backend`;
  const runUrl = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repoIssue}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
  const aberta = await gh.issueAberta(repoIssue);
  const acao = decidirIssue(resultados, aberta);
  const corpo = corpoIssue(resultados, agora, runUrl);
  if (acao === 'abrir') {
    const nova = await gh.abrir(repoIssue, corpo);
    log.log(`issue aberta: #${nova.number}`);
  } else if (acao === 'atualizar') {
    // Corpo sempre com o estado atual; comentário só quando o conjunto de
    // falhas muda, para não gerar uma notificação a cada 15 min.
    const antes = falhasRegistradas(aberta.body);
    const agoraFalhas = nomesComFalha(resultados);
    await gh.editar(repoIssue, aberta.number, { body: corpo });
    if (antes !== agoraFalhas) await gh.comentar(repoIssue, aberta.number, `Mudou: agora falha em **${agoraFalhas}**.\n\n${resultados.map((r) => `- ${r.resumo}`).join('\n')}`);
    log.log(`issue #${aberta.number} atualizada`);
  } else if (acao === 'fechar') {
    await gh.comentar(repoIssue, aberta.number, `Voltou ao normal em ${agora.toISOString()}.\n\n${resultados.map((r) => `- ${r.resumo}`).join('\n')}`);
    await gh.editar(repoIssue, aberta.number, { state: 'closed', state_reason: 'completed' });
    log.log(`issue #${aberta.number} fechada`);
  }

  // Resumo na página da execução.
  if (env.GITHUB_STEP_SUMMARY) {
    require('fs').appendFileSync(env.GITHUB_STEP_SUMMARY,
      `## Verificador de produção\n\n${resultados.map((r) => `- ${r.falha ? '❌' : (r.estado === 'em_dia' ? '✅' : 'ℹ️')} ${r.resumo}`).join('\n')}\n`);
  }

  return { resultados, acao, falhou: resultados.some((r) => r.falha) };
}

if (require.main === module) {
  executar()
    .then(({ falhou }) => { process.exitCode = falhou ? 1 : 0; })
    .catch((e) => { console.error('verificador quebrou:', e.message); process.exitCode = 1; });
}

module.exports = {
  avaliarAlvo, decidirIssue, corpoIssue, falhasRegistradas, shaValido, minutosDesde, executar, criarGithub, lerJson,
  TITULO_ISSUE, MARCA_ISSUE, LIMITE_MIN_PADRAO,
};
