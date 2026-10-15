// ============================================================
// AURA. — Filtro anti-robô do formulário do site (card t2-12, 15/10/2026)
//
// POST /api/v1/public/leads recebia ~40 robôs a cada 46 contatos. Regras, da
// mais barata para a mais cara. Tudo aqui é puro (sem banco) menos
// validarTurnstile, que faz uma chamada de rede e falha ABERTA.
//
//   1. honeypot (hp, e os nomes antigos _empresa / honeypot) preenchido:
//      decidido na rota; grava em site_lead_spam (motivo 'honeypot') e responde 200.
//   2. elapsed_ms < 3000: robô (humano não preenche em 3 s). O Worker do site
//      já descarta antes de chamar o backend; aqui é defesa em profundidade.
//   3. nome de robô conhecido (Harryseeno, Roberthaupt, Robinscawl e
//      variações: maiúsculas, espaço, ponto, acento, número, 1 letra a mais
//      ou a menos).
//   4. mensagem-modelo: "... Por favor, contacte-me por e-mail" (português de
//      Portugal traduzido por máquina; nenhum lojista brasileiro escreve).
//   5. mensagem majoritariamente em inglês E (com link OU palavra de golpe/
//      SEO): "Win a Rolls-Royce https://...", "Best seo services ...".
//   6. mensagem com link e nenhuma palavra em português (texto aleatório).
//   7. Turnstile (só se TURNSTILE_SECRET estiver definido E vier token; nunca
//      exigido. O token é de uso único: se o Worker do site tem o secret, ele
//      valida e NÃO repassa o token, então aqui nem chega):
//      token inválido = robô. Cloudflare fora do ar NÃO marca ninguém.
//
// Quem cai numa regra NÃO vira lead: vai para site_lead_spam (migration 388)
// com o motivo, e a rota responde igual a um sucesso, para o robô não
// aprender. Os leads reais conhecidos (nomes brasileiros, mensagem em
// português, pedido de ligação no WhatsApp) não batem em nenhuma regra —
// ver tests/unit/leadSpam.test.js.
// ============================================================
'use strict';

const TEMPO_MINIMO_MS = 3000;
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Letras minúsculas, sem acento, sem nada que não seja a-z.
const soLetras = (v) => String(v == null ? '' : v)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z]/g, '');
const semAcento = (v) => String(v == null ? '' : v)
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Para estender: acrescente o nome já normalizado (só letras minúsculas).
const NOMES_DE_ROBO = ['harryseeno', 'roberthaupt', 'robinscawl'];

function distanciaAte1(a, b) {
  if (a === b) return true;
  const la = a.length; const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0; let j = 0; let difs = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    difs += 1;
    if (difs > 1) return false;
    if (la > lb) i += 1;
    else if (lb > la) j += 1;
    else { i += 1; j += 1; }
  }
  return difs + (la - i) + (lb - j) <= 1;
}

function nomeDeRobo(nome) {
  const n = soLetras(nome);
  if (n.length < 8) return false;
  return NOMES_DE_ROBO.some((r) => n.includes(r) || (n.length >= 9 && distanciaAte1(n, r)));
}

const RE_LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|link|io|ru|xyz|top|info|ly|yt|ph|site|online|shop|gl|biz)\b(?:\/|\b))/i;
const temLink = (v) => RE_LINK.test(String(v || ''));

const RE_GOLPE = /\b(seo|backlinks?|jackpot|promo ?code|winner|casino|crypto|bitcoin|viagra|lamborghini|rolls-?royce|playstation|forex|guest post|organic traffic|website|domain authority|google rankings?)\b/i;

const PALAVRAS_EN = new Set(('the and of in for your you is with our we on that this are can will at be by from it have has my get now win free today its was were not if but about all new best want need please us here there just like how what when who why would could should to into than also been their they them these those which where while over look looking found several hello hi dear welcome team business products offer offers services service professional daily boost recently').split(' '));
const PALAVRAS_PT = new Set(('de que e o os as do da dos das no na nos nas um uma uns umas para pra com nao sim em por se mais eu meu minha meus quero preciso gostaria voces vocês ola oi bom boa dia tarde noite obrigado obrigada loja sistema valor preco tem como sao mim nosso nossa gostaria informacoes informacao empresa mercado negocio').split(' '));

function palavras(msg) {
  return semAcento(msg).match(/[a-z]{2,}/g) || [];
}

function majoritariamenteIngles(msg) {
  const ps = palavras(msg);
  if (ps.length < 4) return false;
  let en = 0; let pt = 0;
  for (const p of ps) {
    if (PALAVRAS_EN.has(p)) en += 1;
    if (PALAVRAS_PT.has(p)) pt += 1;
  }
  // Inglês "de verdade": 2+ palavras de inglês e nenhuma de português, ou
  // bem mais inglês que português. Português que cita uma palavra em inglês
  // ("boost", "hello") tem várias palavras de português e não passa.
  return (en >= 2 && pt === 0) || (en >= 3 && en >= pt * 3);
}

function semPortugues(msg) {
  const ps = palavras(msg);
  if (ps.length < 3) return false;
  return !ps.some((p) => PALAVRAS_PT.has(p));
}

const RE_MODELO = /contacte[\s-]*me\s+por\s+e-?mail/;

// elapsed_ms ausente (site antigo) não diz nada; número (inclusive 0) vale.
function elapsedDe(b) {
  const v = b.elapsed_ms;
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Regras locais (valem para lead completo e parcial).
// Devolve { spam: false } ou { spam: true, motivo }.
function avaliarLead(b) {
  const nome = b.nome || b.name;
  const msg = String(b.mensagem || b.message || '');
  const msgSemAcento = semAcento(msg);

  const ms = elapsedDe(b);
  if (ms !== null && ms < TEMPO_MINIMO_MS) return { spam: true, motivo: 'rapido_demais' };

  if (nomeDeRobo(nome)) return { spam: true, motivo: 'nome_conhecido' };
  if (/https?:|www\./i.test(String(nome || ''))) return { spam: true, motivo: 'nome_com_link' };

  if (RE_MODELO.test(msgSemAcento)) return { spam: true, motivo: 'mensagem_modelo' };
  if (majoritariamenteIngles(msg) && (temLink(msg) || RE_GOLPE.test(msg))) {
    return { spam: true, motivo: 'mensagem_em_ingles' };
  }
  if (temLink(msg) && semPortugues(msg)) return { spam: true, motivo: 'link_em_outra_lingua' };

  return { spam: false };
}

function tokenDoTurnstile(b) {
  const t = b.turnstile_token || b['cf-turnstile-response'] || b.cf_turnstile_response;
  return (typeof t === 'string' && t.length > 0 && t.length <= 4096) ? t : null;
}

// 'ok' | 'invalido' | 'indisponivel'. Falha aberta: erro de rede, timeout ou
// resposta que não é JSON = 'indisponivel' (não marca ninguém como robô).
async function validarTurnstile(token, { secret, fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  if (!secret || !token || typeof fetchImpl !== 'function') return 'indisponivel';
  try {
    const body = new URLSearchParams({ secret, response: token });
    const resp = await fetchImpl(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp || resp.status >= 500) return 'indisponivel';
    const json = await resp.json();
    if (json && json.success === true) return 'ok';
    // Erros do nosso lado (segredo errado, requisição malformada) não são culpa do visitante.
    const codigos = (json && json['error-codes']) || [];
    if (codigos.includes('invalid-input-secret') || codigos.includes('missing-input-secret') || codigos.includes('internal-error')) {
      return 'indisponivel';
    }
    return 'invalido';
  } catch (_) {
    return 'indisponivel';
  }
}

module.exports = {
  avaliarLead,
  validarTurnstile,
  tokenDoTurnstile,
  nomeDeRobo,
  majoritariamenteIngles,
  TEMPO_MINIMO_MS,
  NOMES_DE_ROBO,
};
