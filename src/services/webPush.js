// ============================================================
// AURA. — Web Push do painel
// Criado: 10/09/2026 (fila de pedidos)
//
// POR QUE EXISTE: o aviso de pedido novo nunca saiu do sino. O push Expo
// depende de token de app nativo e a base tem zero tokens — o painel e web.
// Web Push entrega no navegador da lojista com a aba fechada.
//
// SEM DEPENDENCIA NOVA, DE PROPOSITO: o protocolo sao duas pecas pequenas e
// estaveis, as duas sobre o crypto do Node:
//   - RFC 8291 (aes128gcm): cifra o conteudo com a chave do navegador.
//     Travado pelo vetor de teste da propria RFC (__tests__/webPush.test.js)
//     — se a derivacao sair do lugar, o teste compara byte a byte.
//   - RFC 8292 (VAPID): JWT ES256 que diz ao servico de push quem envia.
//
// AS CHAVES VAPID: do ambiente (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) quando
// existirem; senao geradas UMA vez e guardadas em web_push_config (migration
// 324). Trocar a chave publica invalida todas as inscricoes — nao trocar.
//
// SSRF: o servidor faz POST para a URL que o navegador informou. So aceitamos
// os servicos de push dos navegadores (ehEndpointDePush); qualquer outra URL
// e recusada na inscricao.
//
// Notificar nunca derruba o fluxo: todo erro vira log.
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');

const SUBJECT_PADRAO = 'https://getaura.com.br';
// Computador desligado recebe quando ligar, dentro de 24h. Depois disso o
// aviso de "pedido novo" perdeu o sentido — o pedido ja esta no painel.
const TTL_SEGUNDOS = 24 * 3600;

// Servicos de push dos navegadores. Chrome/Edge novo/Opera/Brave/Samsung
// usam FCM; Firefox, Mozilla; Safari, Apple; Edge legado, WNS.
const HOSTS_DE_PUSH = [
  'fcm.googleapis.com',
  '.push.services.mozilla.com',
  '.push.apple.com',
  '.notify.windows.com',
];

// ── base64url ─────────────────────────────────────────────
function b64u(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64u(s) {
  return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function hmac(chave, dado) {
  return crypto.createHmac('sha256', chave).update(dado).digest();
}

// ── RFC 8291 ──────────────────────────────────────────────
/**
 * Cifra o conteudo para UM navegador.
 *
 * @param {string|Buffer} conteudo
 * @param {string} p256dhB64u  chave publica do navegador (65 bytes, nao comprimida)
 * @param {string} authB64u    segredo de autenticacao do navegador (16 bytes)
 * @param {object} [fixos]     { chavePrivadaServidor, salt } — so para o vetor da RFC
 * @returns {Buffer} corpo pronto: cabecalho (salt, rs, idlen, keyid) + texto cifrado
 */
function cifrarConteudo(conteudo, p256dhB64u, authB64u, fixos = {}) {
  const chaveNavegador = deB64u(p256dhB64u);
  const segredo = deB64u(authB64u);
  if (chaveNavegador.length !== 65 || chaveNavegador[0] !== 4) throw new Error('p256dh invalida');
  if (segredo.length !== 16) throw new Error('auth invalido');

  const ecdh = crypto.createECDH('prime256v1');
  if (fixos.chavePrivadaServidor) ecdh.setPrivateKey(deB64u(fixos.chavePrivadaServidor));
  else ecdh.generateKeys();
  const chaveServidor = ecdh.getPublicKey();
  const salt = fixos.salt ? deB64u(fixos.salt) : crypto.randomBytes(16);

  const segredoEcdh = ecdh.computeSecret(chaveNavegador);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), chaveNavegador, chaveServidor]);
  const prkKey = hmac(segredo, segredoEcdh);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0', 'latin1')).subarray(0, 12);

  // Um registro so, sem enchimento: o delimitador de ultimo registro e 0x02.
  const texto = Buffer.concat([Buffer.from(conteudo), Buffer.from([2])]);
  const cifra = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cifrado = Buffer.concat([cifra.update(texto), cifra.final(), cifra.getAuthTag()]);

  const cabecalho = Buffer.alloc(21);
  salt.copy(cabecalho, 0);
  cabecalho.writeUInt32BE(4096, 16);
  cabecalho[20] = chaveServidor.length;
  return Buffer.concat([cabecalho, chaveServidor, cifrado]);
}

// ── RFC 8292 (VAPID) ──────────────────────────────────────
function gerarChavesVapid() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const privada = ecdh.getPrivateKey();
  const privada32 = privada.length === 32 ? privada : Buffer.concat([Buffer.alloc(32 - privada.length), privada]);
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(privada32) };
}

/** Cabecalho Authorization para um endpoint. `agora` em segundos, injetavel. */
function cabecalhoVapid(endpoint, chaves, agora = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const cab = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const carga = b64u(JSON.stringify({ aud, exp: agora + 12 * 3600, sub: chaves.subject || SUBJECT_PADRAO }));
  const pub = deB64u(chaves.publicKey);
  const chave = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: chaves.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const assinatura = crypto.sign('sha256', Buffer.from(`${cab}.${carga}`), { key: chave, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${cab}.${carga}.${b64u(assinatura)}, k=${chaves.publicKey}`;
}

let _chaves = null;

/** As chaves VAPID: ambiente, senao banco, senao geradas e guardadas. */
async function getVapidKeys() {
  if (_chaves) return _chaves;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    _chaves = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT || SUBJECT_PADRAO,
    };
    return _chaves;
  }
  const ler = async () => {
    const { rows } = await db.query('SELECT public_key, private_key, subject FROM web_push_config WHERE id = 1');
    return rows[0] ? { publicKey: rows[0].public_key, privateKey: rows[0].private_key, subject: rows[0].subject } : null;
  };
  let chaves = await ler();
  if (!chaves) {
    const novas = gerarChavesVapid();
    // ON CONFLICT: dois processos subindo juntos — um ganha, o outro le o dele.
    await db.query(
      `INSERT INTO web_push_config (id, public_key, private_key, subject)
       VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [novas.publicKey, novas.privateKey, SUBJECT_PADRAO]
    );
    chaves = await ler();
  }
  if (!chaves) throw new Error('chaves VAPID indisponiveis');
  _chaves = chaves;
  return _chaves;
}

// ── Inscricao ─────────────────────────────────────────────
function ehEndpointDePush(endpoint) {
  let url;
  try { url = new URL(String(endpoint || '')); } catch (_) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return HOSTS_DE_PUSH.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
}

/** Valida o corpo de PushSubscription.toJSON(). Devolve os campos ou { erro }. */
function validarInscricao(corpo) {
  const endpoint = corpo && corpo.endpoint;
  const p256dh = corpo && corpo.keys && corpo.keys.p256dh;
  const auth = corpo && corpo.keys && corpo.keys.auth;
  if (!ehEndpointDePush(endpoint)) return { erro: 'Endereco de push invalido.' };
  const chave = deB64u(p256dh);
  if (typeof p256dh !== 'string' || chave.length !== 65 || chave[0] !== 4) return { erro: 'Chave do navegador invalida.' };
  if (typeof auth !== 'string' || deB64u(auth).length !== 16) return { erro: 'Segredo do navegador invalido.' };
  return { endpoint: String(endpoint), p256dh, auth };
}

// ── Envio ─────────────────────────────────────────────────
/** POST para um navegador. Devolve o status HTTP do servico de push. */
async function enviarUm(inscricao, conteudo, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const chaves = await getVapidKeys();
  const corpo = cifrarConteudo(JSON.stringify(conteudo), inscricao.p256dh, inscricao.auth);
  const res = await fetchFn(inscricao.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(TTL_SEGUNDOS),
      Urgency: 'high',
      Authorization: cabecalhoVapid(inscricao.endpoint, chaves),
    },
    body: corpo,
  });
  return res.status;
}

/**
 * Envia para uma lista de inscricoes e faz a faxina: 404/410 = navegador
 * desinscrito, a linha sai. @returns {{enviados, removidos, falhas}}
 */
async function enviarParaInscricoes(inscricoes, conteudo, deps = {}) {
  const resumo = { enviados: 0, removidos: 0, falhas: 0 };
  await Promise.all((inscricoes || []).map(async (sub) => {
    try {
      const status = await enviarUm(sub, conteudo, deps);
      if (status === 404 || status === 410) {
        resumo.removidos++;
        await db.query('DELETE FROM web_push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
      } else if (status >= 200 && status < 300) {
        resumo.enviados++;
        await db.query('UPDATE web_push_subscriptions SET last_success_at = NOW() WHERE id = $1', [sub.id]).catch(() => {});
      } else {
        resumo.falhas++;
        console.error('[webPush] servico de push respondeu', status);
      }
    } catch (err) {
      resumo.falhas++;
      console.error('[webPush] falha ao enviar:', err.message);
    }
  }));
  return resumo;
}

/**
 * Aviso para todos os navegadores inscritos da empresa.
 * @param {{title, body, url, tag, type}} aviso
 */
async function notifyCompany(companyId, aviso = {}) {
  const vazio = { enviados: 0, removidos: 0, falhas: 0 };
  if (!companyId) return vazio;
  try {
    let rows;
    try {
      ({ rows } = await db.query(
        'SELECT id, endpoint, p256dh, auth FROM web_push_subscriptions WHERE company_id = $1',
        [companyId]
      ));
    } catch (err) {
      if (err.code === '42P01') return vazio; // migration 324 ainda nao aplicada
      throw err;
    }
    if (!rows || !rows.length) return vazio;
    return await enviarParaInscricoes(rows, {
      title: aviso.title || 'Aura',
      body: aviso.body || '',
      url: aviso.url || '/',
      tag: aviso.tag || aviso.type || 'aura',
      type: aviso.type || null,
    });
  } catch (err) {
    console.error('[webPush] notifyCompany:', err.message);
    return vazio;
  }
}

/** So para teste. */
function _resetCache() { _chaves = null; }

module.exports = {
  cifrarConteudo,
  cabecalhoVapid,
  gerarChavesVapid,
  getVapidKeys,
  ehEndpointDePush,
  validarInscricao,
  enviarParaInscricoes,
  notifyCompany,
  TTL_SEGUNDOS,
  _resetCache,
  _b64u: b64u,
  _deB64u: deB64u,
};
