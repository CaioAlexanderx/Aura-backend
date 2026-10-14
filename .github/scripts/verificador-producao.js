'use strict';
// VERIFICADOR DE PRODUÇÃO (t1-04, 14/10/2026) — roda pelo workflow
// .github/workflows/verificador-producao.yml a cada 15 min.
//
// Pergunta: o que está no ar é o que está em `main`?
//   backend: `version` do /health (8 caracteres do commit) contra main do
//            Aura-backend;
//   app:     `sha` do https://app.getaura.com.br/version.json contra main do
//            aura-app.
// Defasado há mais de LIMITE_MIN (30 min), contando do ÚLTIMO commit de
// main: abre (ou atualiza) uma issue. Quando tudo volta ao normal, a issue é
// fechada. Conta do último commit, e não do mais antigo que falta, de
// propósito: numa rajada de merges a Railway e o Cloudflare pulam versões
// intermediárias, e contar do primeiro merge daria falso alarme.
//
// O script SEMPRE sai com código 0: o alerta é a issue. Quem lê a execução
// vê o problema no resumo e numa anotação ::error::. Ver o porquê
// (Wait for CI da Railway) no workflow.
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
// Commits só de documentação (docs/** ou *.md): o Cloudflare ou a Railway
// podem não gerar build para eles, e o que está no ar fica no commit
// anterior sem que nada esteja errado. Por isso, quando o que falta entre a
// versão no ar e main (API compare) é só docs/** e *.md, o alvo conta como em
// dia ("sem deploy esperado"). Se o compare falhar, vale a regra normal.
//
// Toda chamada externa tem tempo-limite de 10 s (AbortSignal.timeout). Versão
// no ar ilegível vira "indisponível" e abre a issue. Falha da API do GitHub
// no alvo também; falha ao mexer na issue só vai para o log.
//
// Sem dependências: Node 20 (fetch nativo). Toda a decisão fica em funções
// puras exportadas, testadas em tests/unit/verificadorProducao.test.js.

const LIMITE_MIN_PADRAO = 30;
const TIMEOUT_MS = 10000;
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

// Arquivo de documentação: não exige deploy.
function soDocumentacao(arquivo) {
  const a = String(arquivo || '');
  return a.startsWith('docs/') || /\.md$/i.test(a);
}

// Lista de arquivos pendentes (compare) só com documentação?
function pendenteSoDocs(arquivos) {
  return Array.isArray(arquivos) && arquivos.length > 0 && arquivos.every(soDocumentacao);
}

/**
 * Decide o estado de um alvo.
 * @param {object} p
 * @param {string} p.nome            'backend' | 'app'
 * @param {string|null} p.noAr       sha (curto ou longo) que está no ar
 * @param {string} p.mainSha         sha completo de main
 * @param {string} p.mainData        data (ISO) do último commit de main
 * @param {string[]|null} [p.pendentes] arquivos entre o que está no ar e
 *                                   main (compare); null = não deu para saber
 * @param {string|null} [p.builtAt]  só o app: quando o bundle foi gerado
 * @param {string|null} [p.erro]     falha ao ler o que está no ar
 * @returns {{ nome, estado, falha, minutos, resumo }}
 *   estado: 'em_dia' | 'so_docs' | 'atrasado' | 'defasado' | 'sem_sha' | 'indisponivel'
 *   falha:  true só em 'defasado' e 'indisponivel'
 */
function avaliarAlvo({ nome, noAr, mainSha, mainData, pendentes = null, builtAt = null, erro = null }, agora, limiteMin = LIMITE_MIN_PADRAO) {
  const curto = (s) => String(s || '').slice(0, 8);

  if (erro) {
    return { nome, estado: 'indisponivel', falha: true, minutos: null,
      resumo: `${nome}: inacessível — não consegui ler a versão no ar (${erro})` };
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

  if (pendenteSoDocs(pendentes)) {
    return { nome, estado: 'so_docs', falha: false, minutos: null,
      resumo: `${nome}: em dia — de ${curto(v)} até main ${curto(mainSha)} só mudou documentação (${pendentes.length} arquivo(s)), sem deploy esperado` };
  }

  // Conta do último commit de main (ver o cabeçalho).
  const minutos = minutosDesde(mainData, agora);
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
    '- **inacessível**: a URL de versão não respondeu em 10 s (3 tentativas). Pode ser queda de verdade ou rede do GitHub; a próxima execução confirma.',
    '',
    'Esta issue é aberta e fechada sozinha pelo workflow "Verificador de produção" (.github/workflows/verificador-producao.yml).',
  ].join('\n');
}

// ── Leitura (rede) ─────────────────────────────────────────────────────────

const comLimite = () => AbortSignal.timeout(TIMEOUT_MS);

async function lerJson(url, { tentativas = 3, esperaMs = 5000, headers = {}, fetchFn = fetch } = {}) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const res = await fetchFn(url, { headers: { 'cache-control': 'no-cache', ...headers }, signal: comLimite() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      ultimoErro = e && e.name === 'TimeoutError' ? new Error(`sem resposta em ${TIMEOUT_MS / 1000} s`) : e;
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
    let res;
    try {
      res = await fetchFn(base + caminho, {
        method: metodo,
        headers: { ...headers, ...(corpo ? { 'content-type': 'application/json' } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: comLimite(),
      });
    } catch (e) {
      throw new Error(`GitHub ${metodo} ${caminho}: ${e && e.name === 'TimeoutError' ? `sem resposta em ${TIMEOUT_MS / 1000} s` : e.message}`);
    }
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
    // Arquivos alterados entre o que está no ar e main; null se não der.
    async pendentes(repo, noAr) {
      try {
        const cmp = await req('GET', `/repos/${repo}/compare/${encodeURIComponent(noAr)}...main`);
        // O compare corta em 300 arquivos; aí não dá para afirmar "só docs".
        if (!cmp || !Array.isArray(cmp.files) || cmp.files.length >= 300) return null;
        return cmp.files.map((f) => f.filename);
      } catch (_) {
        return null;
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

async function verificarAlvo({ nome, repo, url, extrair }, gh, agora, limiteMin, fetchFn, esperaMs) {
  let main;
  try {
    main = await gh.main(repo);
  } catch (e) {
    return avaliarAlvo({ nome, erro: `main de ${repo}: ${e.message}` }, agora, limiteMin);
  }
  let noAr = null; let builtAt = null; let erro = null;
  try {
    const json = await lerJson(url, { fetchFn, esperaMs });
    ({ noAr, builtAt } = extrair(json));
  } catch (e) {
    erro = e.message;
  }
  const atrasado = !erro && shaValido(noAr) && !main.sha.toLowerCase().startsWith(noAr.trim().toLowerCase());
  const pendentes = atrasado ? await gh.pendentes(repo, noAr.trim()) : null;
  return avaliarAlvo({ nome, noAr, mainSha: main.sha, mainData: main.data, pendentes, builtAt, erro }, agora, limiteMin);
}

async function tratarIssue({ gh, repoIssue, resultados, agora, runUrl, log }) {
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
  return acao;
}

async function executar({ env = process.env, fetchFn = fetch, log = console, agora = new Date(), esperaMs = 5000 } = {}) {
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
    resultados.push(await verificarAlvo(alvo, gh, agora, limiteMin, fetchFn, esperaMs));
  }
  for (const r of resultados) {
    if (r.falha) log.error(`::error title=Produção defasada::${r.resumo}`);
    else log.log(r.resumo);
  }

  // A issue fica no repositório onde o workflow roda.
  const repoIssue = env.GITHUB_REPOSITORY || `${dono}/Aura-backend`;
  const runUrl = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repoIssue}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
  let acao = null;
  try {
    acao = await tratarIssue({ gh, repoIssue, resultados, agora, runUrl, log });
  } catch (e) {
    log.error(`::warning::não consegui mexer na issue: ${e.message}`);
  }

  // Resumo na página da execução.
  if (env.GITHUB_STEP_SUMMARY) {
    require('fs').appendFileSync(env.GITHUB_STEP_SUMMARY,
      `## Verificador de produção\n\n${resultados.map((r) => `- ${r.falha ? '❌' : (r.estado === 'em_dia' || r.estado === 'so_docs' ? '✅' : 'ℹ️')} ${r.resumo}`).join('\n')}\n`);
  }

  return { resultados, acao, falhou: resultados.some((r) => r.falha) };
}

if (require.main === module) {
  // Sempre 0: o alerta é a issue (ver o cabeçalho e o workflow).
  executar()
    .catch((e) => { console.error(`::error::verificador quebrou: ${e.message}`); })
    .finally(() => { process.exitCode = 0; });
}

module.exports = {
  avaliarAlvo, decidirIssue, corpoIssue, falhasRegistradas, shaValido, minutosDesde, soDocumentacao, pendenteSoDocs,
  executar, criarGithub, lerJson,
  TITULO_ISSUE, MARCA_ISSUE, LIMITE_MIN_PADRAO, TIMEOUT_MS,
};
