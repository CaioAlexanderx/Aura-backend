// ============================================================
// AURA. — Bipe sintético (13/10/2026)
//
// Simula o que a lojista faz no Caixa, pelo caminho HTTP real — a URL
// pública da API, não um atalho dentro do processo. Quem testa por dentro
// testa o que a gente imagina; quem testa por fora testa o que o lojista
// enfrenta (DNS, borda, pooler, middleware, rota montada na ordem certa).
//
//   token     assina um token de acesso para o usuário de serviço da
//             empresa de teste (mesmo segredo do JWT, sem senha)
//   bipe      GET  /companies/:id/pdv/scan/:code
//   venda     POST /companies/:id/pdv/sale        1 un., em dinheiro
//   consulta  GET  /companies/:id/sales/:saleId
//   cancela   POST /companies/:id/sales/:saleId/cancel  (repõe o estoque e
//             tira a receita — a venda sintética não acumula)
//
// A sequência para no primeiro erro, MAS o cancelamento roda sempre que a
// venda chegou a existir. Sem ele o produto canário esgotaria o estoque e a
// receita da empresa de teste só cresceria.
//
// Config (env; sem as três primeiras o canário fica dormente):
//   CANARY_COMPANY_ID  empresa de teste
//   CANARY_USER_ID     usuário de serviço (dono ou membro dela)
//   CANARY_BARCODE     código de barras fixo do produto canário
//   CANARY_BASE_URL    opcional; padrão = endereço público da API
//   CANARY_ENABLED     'false' desliga sem deploy
//   CANARY_TIMEOUT_MS  opcional; por requisição (padrão 15000)
//
// Nada aqui toca o banco: o job grava o resultado. Isso mantém o teste
// independente do que está sendo testado.
// ============================================================
'use strict';

const jwt = require('jsonwebtoken');
const { enderecoDaApi } = require('../config/enderecoDaApi');

const PASSOS = ['token', 'bipe', 'venda', 'consulta', 'cancela'];
const TIMEOUT_PADRAO_MS = 15000;
const MARCA_VENDA = '[CANARY] bipe sintético';
const NOME_VENDEDOR = 'Aura Canary';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Config ou null (dormente). Dormente = sem alguma das três envs, id inválido
// ou kill switch ligado.
function configuracao(env = process.env) {
  if (String(env.CANARY_ENABLED || 'true').trim().toLowerCase() === 'false') return null;
  const companyId = String(env.CANARY_COMPANY_ID || '').trim();
  const userId = String(env.CANARY_USER_ID || '').trim();
  const barcode = String(env.CANARY_BARCODE || '').trim();
  if (!UUID.test(companyId) || !UUID.test(userId) || !barcode) return null;
  const base = String(env.CANARY_BASE_URL || '').trim().replace(/\/+$/, '') || enderecoDaApi();
  const timeout = parseInt(env.CANARY_TIMEOUT_MS, 10);
  return {
    companyId,
    userId,
    barcode,
    baseUrl: base,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : TIMEOUT_PADRAO_MS,
  };
}

// Token de acesso de curta duração, no formato do login (routes/auth.js):
// mesmo segredo, `type: 'access'`. Vale 5 minutos — uma execução dura
// segundos, e token solto por aí não serve para nada depois.
function gerarToken(cfg, { secret } = {}) {
  const JWT_SECRET = secret || require('../config/env').validateRuntimeEnv().JWT_SECRET;
  return jwt.sign(
    {
      id: cfg.userId,
      role: 'user',
      plan: 'expansao',
      company: cfg.companyId,
      is_staff: false,
      consolidated_view: false,
      canary: true,
      type: 'access',
    },
    JWT_SECRET,
    { expiresIn: '5m' }
  );
}

// Uma requisição com tempo-limite. Nunca lança: devolve { status, body, ms, erro }.
async function chamar(cfg, token, metodo, caminho, corpo, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const inicio = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  try {
    const resp = await fetchImpl(cfg.baseUrl + '/api/v1' + caminho, {
      method: metodo,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'User-Agent': 'aura-canary/1',
        'X-Aura-Canary': '1',
        ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: ctl.signal,
    });
    let body = null;
    const texto = await resp.text();
    try { body = texto ? JSON.parse(texto) : null; } catch (_) { body = { _texto: String(texto).slice(0, 200) }; }
    return { status: resp.status, body, ms: Date.now() - inicio, erro: null };
  } catch (e) {
    const abortou = e && (e.name === 'AbortError' || ctl.signal.aborted);
    return {
      status: 0,
      body: null,
      ms: Date.now() - inicio,
      erro: abortou ? `sem resposta em ${cfg.timeoutMs} ms` : `falha de rede: ${(e && e.message) || e}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Mensagem curta do que a API respondeu de errado.
function motivo(r, esperado) {
  if (r.erro) return r.erro;
  const detalhe = r.body && (r.body.error || r.body.message || r.body._texto);
  return `HTTP ${r.status}${esperado ? ` (esperado ${esperado})` : ''}${detalhe ? ` — ${String(detalhe).slice(0, 160)}` : ''}`;
}

function passo(nome, r, ok, erro, detalhe) {
  return {
    passo: nome,
    ok: !!ok,
    ms: r ? r.ms : 0,
    status: r ? r.status : null,
    erro: ok ? null : erro,
    ...(detalhe ? { detalhe } : {}),
  };
}

// Estorna a venda sintética. Usado ao fim de toda execução e pelo job, para
// recolher venda que ficou aberta numa execução anterior.
async function cancelarVenda(cfg, token, vendaId, deps = {}) {
  const r = await chamar(cfg, token, 'POST',
    `/companies/${cfg.companyId}/sales/${vendaId}/cancel`, { reason: 'bipe sintético' }, deps);
  // 400 "ja esta cancelada": o estado desejado já existe.
  const jaCancelada = r.status === 400 && /cancelad/i.test(String((r.body && r.body.error) || ''));
  const ok = (r.status === 200 && !!(r.body && r.body.ok)) || jaCancelada;
  return { r, ok };
}

// O bipe: GET /companies/:id/pdv/scan/:code, o mesmo do leitor no Caixa.
function bipar(cfg, token, deps = {}) {
  return chamar(cfg, token, 'GET',
    `/companies/${cfg.companyId}/pdv/scan/${encodeURIComponent(cfg.barcode)}`, null, deps);
}

// O bipe deu certo? Achou o produto canário (match exato) com preço válido.
// → { ok: true, produto, varianteId, preco } | { ok: false, erro }
function conferirBipe(r) {
  const p = r.body && r.body.product;
  if (r.status === 200 && r.body && r.body.match === 'exact' && p && p.id) {
    const preco = Number(r.body.effective_price != null ? r.body.effective_price : p.price);
    if (!Number.isFinite(preco) || preco < 0) {
      return { ok: false, erro: `produto canário sem preço válido (price=${p.price})` };
    }
    return { ok: true, produto: p, varianteId: r.body.variant_id || null, preco };
  }
  const achou = r.body && r.body.match ? `match=${r.body.match}` : null;
  return { ok: false, erro: motivo(r, 200) + (achou ? ` · ${achou}` : '') };
}

// Só o bipe (t1-08: laço rápido de 30 s). Mesmo formato de executar(), com
// os passos token e bipe. Não vende, não consulta, não cancela: só leitura.
async function executarSoBipe(cfg, deps = {}) {
  const inicio = Date.now();
  const passos = [];
  let token = null;
  const t0 = Date.now();
  try {
    token = (deps.gerarToken || gerarToken)(cfg);
    passos.push({ passo: 'token', ok: true, ms: Date.now() - t0, status: null, erro: null });
  } catch (e) {
    passos.push({ passo: 'token', ok: false, ms: Date.now() - t0, status: null, erro: `não assinou o token: ${e.message}` });
  }
  if (token) {
    const r = await bipar(cfg, token, deps);
    const b = conferirBipe(r);
    passos.push(passo('bipe', r, b.ok, b.erro, b.ok ? { produto_id: b.produto.id } : null));
  }
  const falho = passos.find((p) => !p.ok) || null;
  return {
    ok: !falho,
    passos,
    duracao_ms: Date.now() - inicio,
    erro: falho ? `${falho.passo}: ${falho.erro}` : null,
    passo_falho: falho ? falho.passo : null,
  };
}

// A sequência inteira. Devolve:
//   { ok, passos[], duracao_ms, erro, passo_falho, venda_id, venda_pendente }
async function executar(cfg, deps = {}) {
  const inicio = Date.now();
  const passos = [];
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  let vendaId = null;
  let vendaCancelada = false;
  let seguir = true;

  // 1. token
  let token = null;
  {
    const t0 = Date.now();
    try {
      token = (deps.gerarToken || gerarToken)(cfg);
      passos.push({ passo: 'token', ok: true, ms: Date.now() - t0, status: null, erro: null });
    } catch (e) {
      passos.push({ passo: 'token', ok: false, ms: Date.now() - t0, status: null, erro: `não assinou o token: ${e.message}` });
      seguir = false;
    }
  }

  // 2. bipe
  let produto = null;
  let varianteId = null;
  let preco = 0;
  if (seguir) {
    const r = await bipar(cfg, token, deps);
    const b = conferirBipe(r);
    if (b.ok) {
      ({ produto, varianteId, preco } = b);
      passos.push(passo('bipe', r, true, null, { produto_id: produto.id, estoque: produto.stock_qty }));
    } else {
      passos.push(passo('bipe', r, false, b.erro));
      seguir = false;
    }
  }

  // 3. venda — 1 unidade em dinheiro
  if (seguir) {
    const corpo = {
      items: [{
        product_id: produto.id,
        ...(varianteId ? { variant_id: varianteId } : {}),
        quantity: 1,
        unit_price: preco,
      }],
      payment_method: 'dinheiro',
      payments: [{ method: 'dinheiro', value: preco }],
      notes: MARCA_VENDA,
      seller_name: NOME_VENDEDOR,
    };
    const caminho = `/companies/${cfg.companyId}/pdv/sale`;
    let r = await chamar(cfg, token, 'POST', caminho, corpo, deps);
    let caixaAberto = false;

    // A empresa de teste exige caixa aberto (pdv_settings.caixa_enabled). Ninguém
    // fecha o caixa dela de propósito, mas se estiver fechado a venda não é
    // sinal de queda: abre pelo caminho real e tenta de novo, uma vez.
    if (r.status === 409 && r.body && r.body.code === 'CAIXA_REQUIRED') {
      const ab = await chamar(cfg, token, 'POST', `/companies/${cfg.companyId}/caixa/abrir`, { troco_inicial: 0 }, deps);
      if (ab.status === 201 || ab.status === 200) {
        caixaAberto = true;
        r = await chamar(cfg, token, 'POST', caminho, corpo, deps);
      } else {
        passos.push(passo('venda', ab, false, `caixa fechado e não abriu: ${motivo(ab)}`));
        seguir = false;
      }
    }

    if (seguir) {
      const sale = r.body && r.body.sale;
      if (r.status === 201 && sale && sale.id) {
        vendaId = sale.id;
        passos.push(passo('venda', r, true, null, caixaAberto ? { venda_id: vendaId, caixa_aberto: true } : { venda_id: vendaId }));
      } else {
        passos.push(passo('venda', r, false, motivo(r, 201)));
        seguir = false;
      }
    }
  }

  // 4. consulta
  if (seguir) {
    const r = await chamar(cfg, token, 'GET', `/companies/${cfg.companyId}/sales/${vendaId}`, null, deps);
    const s = r.body && r.body.sale;
    const totalOk = s && Math.abs(Number(s.total_amount) - preco) < 0.01;
    if (r.status === 200 && s && s.id === vendaId && s.status === 'completed' && totalOk) {
      passos.push(passo('consulta', r, true));
    } else if (r.status === 200) {
      passos.push(passo('consulta', r, false,
        `venda consultada não confere (id=${s && s.id}, status=${s && s.status}, total=${s && s.total_amount}, esperado ${preco})`));
    } else {
      passos.push(passo('consulta', r, false, motivo(r, 200)));
    }
  }

  // 5. cancela — sempre que a venda existe, mesmo com a consulta falhando
  if (vendaId) {
    let { r, ok } = await cancelarVenda(cfg, token, vendaId, deps);
    if (!ok) {
      await sleep(500);
      ({ r, ok } = await cancelarVenda(cfg, token, vendaId, deps));
    }
    vendaCancelada = ok;
    passos.push(passo('cancela', r, ok, motivo(r, 200)));
  }

  const falho = passos.find((p) => !p.ok) || null;
  return {
    ok: !falho,
    passos,
    duracao_ms: Date.now() - inicio,
    erro: falho ? `${falho.passo}: ${falho.erro}` : null,
    passo_falho: falho ? falho.passo : null,
    venda_id: vendaId,
    venda_pendente: !!vendaId && !vendaCancelada,
  };
}

module.exports = {
  PASSOS, MARCA_VENDA, NOME_VENDEDOR,
  configuracao, gerarToken, chamar, cancelarVenda, executar,
  bipar, conferirBipe, executarSoBipe,
};
