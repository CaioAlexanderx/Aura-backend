// ============================================================
// AURA. — Limites de tentativa da porta de entrada (b-tq-71, 17/11/2026)
//
// Login, 2FA, cadastro, "esqueci a senha", troca de senha, codigos de
// verificacao e reenvios. Montados em src/app.js ANTES do apiRouter (o
// Express roda as camadas na ordem do registro; depois da rota, nunca
// rodam — foi o defeito do tq-71 de 26/10).
//
// IP REAL (ipDoCliente):
//   - base: req.ip do `trust proxy 1` = o ultimo item do X-Forwarded-For,
//     posto pela borda da Railway. Forjar o comeco do header nao muda nada.
//   - atras do Cloudflare (api.getaura.com.br, loja.getaura.com.br e os
//     dominios proprios das lojas), o req.ip e a borda do Cloudflare e
//     milhares de clientes dividiriam o mesmo balde. So quando o req.ip
//     ESTA nas faixas publicadas do Cloudflare usamos o CF-Connecting-IP;
//     de qualquer outro lugar o cabecalho e ignorado (seria forjavel).
//   - IPv6 vira o bloco /64: um cliente IPv6 costuma ter o /64 inteiro e
//     trocaria de endereco a cada tentativa.
//
// ARMAZENAMENTO: memoria do processo (MemoryStore do express-rate-limit).
// Em 17/11 a producao roda 1 replica e sem Redis (/health/full:
// redis=not_configured), entao a memoria vale para todo o trafego. Limites
// conhecidos: (1) cada deploy/reinicio zera os baldes; (2) com N replicas o
// teto efetivo vira N vezes o configurado. Se um dia subir replica ou
// Redis, trocar o `store` aqui por um compartilhado.
//
// Faixas do Cloudflare: https://www.cloudflare.com/ips/ (conferidas em
// 17/11/2026; mudam raramente).
// ============================================================
'use strict';

const net = require('node:net');
const rateLimit = require('express-rate-limit');

const FAIXAS_CLOUDFLARE = {
  ipv4: [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  ],
  ipv6: [
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
  ],
};

const cloudflare = new net.BlockList();
for (const tipo of ['ipv4', 'ipv6']) {
  for (const faixa of FAIXAS_CLOUDFLARE[tipo]) {
    const [rede, prefixo] = faixa.split('/');
    cloudflare.addSubnet(rede, Number(prefixo), tipo);
  }
}

/** Tira o "::ffff:" do IPv4 embrulhado em IPv6 e o sufixo de zona. */
function normalizarIp(valor) {
  let ip = String(valor || '').trim();
  const zona = ip.indexOf('%');
  if (zona >= 0) ip = ip.slice(0, zona);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return net.isIP(ip) ? ip : '';
}

function ehCloudflare(ip) {
  const tipo = net.isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  try { return cloudflare.check(ip, tipo); } catch (_) { return false; }
}

/** O IP de quem esta do outro lado (ver cabecalho do arquivo). */
function ipDoCliente(req) {
  const ip = normalizarIp(req.ip);
  if (ip && ehCloudflare(ip)) {
    const doCloudflare = normalizarIp(req.headers && req.headers['cf-connecting-ip']);
    if (doCloudflare) return doCloudflare;
  }
  return ip || 'desconhecido';
}

/** 8 grupos de 4 digitos hex de um IPv6 valido (aceita "::" e IPv4 no fim). */
function expandirIpv6(ip) {
  let texto = ip.toLowerCase();
  const v4 = texto.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    texto = texto.slice(0, v4.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [cabeca, cauda] = texto.split('::');
  const ini = cabeca ? cabeca.split(':') : [];
  const fim = cauda !== undefined ? (cauda ? cauda.split(':') : []) : [];
  const meio = cauda !== undefined ? Array(8 - ini.length - fim.length).fill('0') : [];
  return [...ini, ...meio, ...fim].map((g) => g.padStart(4, '0'));
}

/** Chave do cliente: o IPv4 inteiro, ou o bloco /64 do IPv6. */
function chaveDoCliente(req) {
  const ip = ipDoCliente(req);
  if (net.isIP(ip) !== 6) return ip;
  return expandirIpv6(ip).slice(0, 4).join(':') + '::/64';
}

function emailDoCorpo(req) {
  return String((req.body && req.body.email) || '').toLowerCase().trim().slice(0, 254);
}

function minutosPorExtenso(segundos) {
  const minutos = Math.max(1, Math.ceil(segundos / 60));
  return minutos + (minutos === 1 ? ' minuto' : ' minutos');
}

/**
 * Um limitador. `mensagem(espera)` recebe "15 minutos" e devolve o texto
 * da tela. Conta so POST (preflight e GET nao gastam tentativa).
 */
function limitador({ nome, janelaMin, max, chave = chaveDoCliente, soFalhas = false, mensagem }) {
  const windowMs = janelaMin * 60 * 1000;
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: soFalhas,
    skip: (req) => process.env.NODE_ENV === 'test' || req.method !== 'POST',
    keyGenerator: (req) => nome + '|' + chave(req),
    handler: (req, res, _next, options) => {
      const reset = req.rateLimit && req.rateLimit.resetTime;
      const segundos = reset instanceof Date
        ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000))
        : Math.ceil(windowMs / 1000);
      res.set('Retry-After', String(segundos));
      res.status(options.statusCode).json({
        error: mensagem(minutosPorExtenso(segundos)),
        code: 'muitas_tentativas',
        retry_after: segundos,
      });
    },
  });
}

// ── Textos (gentis, sem culpar a pessoa) ───────────────────
const MSG = {
  login: (espera) => 'Muitas tentativas seguidas de entrar. Por segurança, espere ' + espera
    + ' e tente de novo. Se não lembra a senha, use "Esqueci minha senha".',
  codigo: (espera) => 'Muitas tentativas seguidas com o código. Por segurança, espere ' + espera
    + ' e tente de novo.',
  reenvio: (espera) => 'Já enviamos alguns códigos agora há pouco. Confira sua caixa de entrada e o spam, ou espere '
    + espera + ' para pedir de novo.',
  esqueci: (espera) => 'Já enviamos o link algumas vezes agora há pouco. Confira sua caixa de entrada e o spam, ou espere '
    + espera + ' para pedir de novo.',
  cadastro: (espera) => 'Muitas tentativas seguidas de cadastro. Por segurança, espere ' + espera
    + ' e tente de novo.',
  senhaNova: (espera) => 'Muitas tentativas seguidas de trocar a senha. Por segurança, espere ' + espera
    + ' e tente de novo.',
  cupom: (espera) => 'Muitas tentativas seguidas com códigos. Por segurança, espere ' + espera
    + ' e tente de novo.',
};

// ── Limites (ver relatorio do b-tq-71) ─────────────────────
// Login e 2FA contam so o que falha: a loja com varios funcionarios no
// mesmo IP que entra certo nunca bate no teto.
const LIMITES = {
  // 20 erradas por IP em 15 min (o de sempre, tq-71/26-10)
  loginPorIp: limitador({ nome: 'login-ip', janelaMin: 15, max: 20, soFalhas: true, mensagem: MSG.login }),
  // 10 erradas por IP + e-mail em 15 min
  loginPorEmail: limitador({
    nome: 'login-email', janelaMin: 15, max: 10, soFalhas: true, mensagem: MSG.login,
    chave: (req) => chaveDoCliente(req) + '|' + emailDoCorpo(req),
  }),
  // 2FA do login e publico (user_id + codigo de 6 digitos)
  doisFatoresPorIp: limitador({ nome: '2fa-ip', janelaMin: 15, max: 20, soFalhas: true, mensagem: MSG.codigo }),
  doisFatoresPorUsuario: limitador({
    nome: '2fa-usuario', janelaMin: 15, max: 10, soFalhas: true, mensagem: MSG.codigo,
    chave: (req) => chaveDoCliente(req) + '|' + String((req.body && req.body.user_id) || '').slice(0, 64),
  }),
  // codigo do e-mail (6 digitos) e do telefone (4 digitos): 10 erradas em 15 min
  codigoPorIp: limitador({ nome: 'codigo-ip', janelaMin: 15, max: 10, soFalhas: true, mensagem: MSG.codigo }),
  // reenvio de codigo: 10 pedidos em 15 min (a rota ja tem o teto por usuario)
  reenvioPorIp: limitador({ nome: 'reenvio-ip', janelaMin: 15, max: 10, mensagem: MSG.reenvio }),
  // cadastro: 20 por IP em 15 min (o de sempre)
  cadastroPorIp: limitador({ nome: 'cadastro-ip', janelaMin: 15, max: 20, mensagem: MSG.cadastro }),
  // esqueci a senha: 20 por IP em 15 min (o de sempre) + 5 por IP + e-mail em 1 hora
  esqueciPorIp: limitador({ nome: 'esqueci-ip', janelaMin: 15, max: 20, mensagem: MSG.esqueci }),
  esqueciPorEmail: limitador({
    nome: 'esqueci-email', janelaMin: 60, max: 5, mensagem: MSG.esqueci,
    chave: (req) => chaveDoCliente(req) + '|' + emailDoCorpo(req),
  }),
  // troca de senha pelo link: 20 por IP em 15 min
  senhaNovaPorIp: limitador({ nome: 'senha-nova-ip', janelaMin: 15, max: 20, mensagem: MSG.senhaNova }),
  // codigo de convite/cupom no cadastro: 30 errados por IP em 15 min
  cupomPorIp: limitador({ nome: 'cupom-ip', janelaMin: 15, max: 30, soFalhas: true, mensagem: MSG.cupom }),
};

/** Monta tudo no app, ANTES do apiRouter. */
function montarLimitesDeAcesso(app, base = '/api/v1/auth') {
  const L = LIMITES;
  app.use(base + '/login',                   L.loginPorIp, L.loginPorEmail);
  app.use(base + '/2fa/validate',            L.doisFatoresPorIp, L.doisFatoresPorUsuario);
  app.use(base + '/verify-email',            L.codigoPorIp);
  app.use(base + '/verify-phone',            L.codigoPorIp);
  app.use(base + '/send-verification',       L.reenvioPorIp);
  app.use(base + '/send-phone-verification', L.reenvioPorIp);
  app.use(base + '/register',                L.cadastroPorIp);
  app.use(base + '/forgot-password',         L.esqueciPorIp, L.esqueciPorEmail);
  app.use(base + '/reset-password',          L.senhaNovaPorIp);
  app.use(base + '/validate-code',           L.cupomPorIp);
}

module.exports = {
  montarLimitesDeAcesso,
  ipDoCliente,
  chaveDoCliente,
  FAIXAS_CLOUDFLARE,
  _internos: { normalizarIp, expandirIpv6, ehCloudflare },
};
