// ============================================================
// AURA. — hubWhatsappMidia.js
// Foto e áudio na conversa do WhatsApp, nos dois sentidos.
//
// ENVIAR (conversa aberta, grátis): sobe o arquivo para a Meta
// (POST /{phone-number-id}/media), manda a mensagem pelo id da mídia e
// guarda uma cópia no bucket PRIVADO do R2 para a thread mostrar depois.
//   - foto: JPEG ou PNG, até 5 MB.
//   - áudio: o Chrome grava WebM/Opus, que a Meta NÃO aceita. A conversão
//     para OGG/Opus é feita AQUI, no servidor, por troca de container (sem
//     recodificar; ver utils/webmParaOgg.js). Quem já manda OGG/Opus, MP4,
//     AAC ou MP3 (Safari, Firefox) passa direto.
//
// RECEBER: o webhook só traz o id da mídia ("[audio]", "[image]"). A Meta
// guarda a mídia por ~30 dias e o link dura minutos, então baixamos na hora
// (Graph: GET /{media-id} → url → GET url com o token) e guardamos no R2
// privado. A thread recebe uma URL assinada de vida curta (1 h).
//
// Sem R2_PRIVATE_BUCKET_NAME a cópia não é guardada (nunca vai para o bucket
// público: conversa de cliente é dado pessoal). O envio continua funcionando;
// a thread mostra o texto no lugar do player.
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');
const wa = require('./whatsapp');
const r2 = require('../utils/r2Privado');
const { webmParaOgg, ehOgg, ehWebm } = require('../utils/webmParaOgg');
const envio = require('./hubWhatsappEnvio');

const GRAPH = 'https://graph.facebook.com/v21.0';
const MAX_FOTO = 5 * 1024 * 1024;
const MAX_AUDIO = 16 * 1024 * 1024;
const MAX_RECEBIDA = 16 * 1024 * 1024;
const URL_VALIDADE_S = 3600;
const TIMEOUT_MS = 15000;
// A URL assinada só muda de meia em meia hora: a thread relê a cada 10 s e o
// player/foto não pode recarregar a cada leitura. Vale 1 h a partir do começo
// da meia hora, então sobram pelo menos 30 min.
const JANELA_ASSINATURA_MS = 30 * 60 * 1000;

// O que a Cloud API aceita como áudio (docs de mídia suportada).
const AUDIO_PASSA_DIRETO = new Set(['audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/amr']);
const EXTENSAO = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/amr': 'amr',
};

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

function mimeBase(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function ehJpeg(b) { return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; }
function ehPng(b) { return b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG'; }

// ── Preparo do que vai sair ──────────────────────────────────
/** Valida a foto. Devolve { buffer, mime } ou joga erro de regra. */
function prepararFoto(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw envio.erro('MIDIA_VAZIA', 'Foto vazia', 400);
  if (buffer.length > MAX_FOTO) throw envio.erro('MIDIA_GRANDE', 'A foto passa de 5 MB. Escolha uma menor.', 413);
  if (ehJpeg(buffer)) return { buffer, mime: 'image/jpeg' };
  if (ehPng(buffer)) return { buffer, mime: 'image/png' };
  throw envio.erro('FOTO_FORMATO', 'Só foto JPEG ou PNG.', 415);
}

/** Áudio pronto para a Meta: WebM/Opus vira OGG/Opus; formatos aceitos passam. */
function prepararAudio(buffer, mimeInformado) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw envio.erro('MIDIA_VAZIA', 'Áudio vazio', 400);
  if (buffer.length > MAX_AUDIO) throw envio.erro('MIDIA_GRANDE', 'O áudio é grande demais.', 413);
  if (ehWebm(buffer)) {
    try {
      return { buffer: webmParaOgg(buffer), mime: 'audio/ogg; codecs=opus', convertido: true };
    } catch (e) {
      if (e.code === 'AUDIO_INVALIDO') throw envio.erro('AUDIO_FORMATO', 'Não consegui preparar este áudio. Grave de novo.', 415);
      throw e;
    }
  }
  if (ehOgg(buffer)) return { buffer, mime: 'audio/ogg; codecs=opus', convertido: false };
  const base = mimeBase(mimeInformado);
  if (AUDIO_PASSA_DIRETO.has(base) && base !== 'audio/ogg') return { buffer, mime: base, convertido: false };
  throw envio.erro('AUDIO_FORMATO', 'Este formato de áudio não é aceito pelo WhatsApp.', 415);
}

// ── Meta: subir e baixar mídia ───────────────────────────────
async function subirParaMeta(creds, buffer, mime) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeBase(mime));
  form.append('file', new Blob([buffer], { type: mime }), `arquivo.${EXTENSAO[mimeBase(mime)] || 'bin'}`);
  const resp = await fetch(`${GRAPH}/${creds.phoneNumberId}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${creds.accessToken}` }, body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await resp.json();
  if (data.error || !data.id) throw wa.graphError(data, resp.status);
  return data.id;
}

async function baixarDaMeta(creds, mediaId) {
  const h = { Authorization: `Bearer ${creds.accessToken}` };
  const meta = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const info = await meta.json();
  if (info.error || !info.url) throw wa.graphError(info, meta.status);
  if (Number(info.file_size) > MAX_RECEBIDA) throw new Error('Mídia recebida grande demais');
  const arq = await fetch(info.url, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!arq.ok) throw new Error(`Download da mídia falhou (${arq.status})`);
  const buffer = Buffer.from(await arq.arrayBuffer());
  if (buffer.length > MAX_RECEBIDA) throw new Error('Mídia recebida grande demais');
  return { buffer, mime: info.mime_type || arq.headers.get('content-type') || 'application/octet-stream' };
}

// ── R2 privado ───────────────────────────────────────────────
/** Guarda a cópia. Devolve a chave ou null (sem bucket, ou falha). */
async function guardar({ companyId, conversationId, buffer, mime }) {
  if (!r2.disponivel()) return null;
  const ext = EXTENSAO[mimeBase(mime)] || 'bin';
  const key = `wa/${companyId}/${conversationId}/${crypto.randomUUID()}.${ext}`;
  const r = await r2.enviar(key, buffer, mime);
  return r.ok ? key : null;
}

/** URL assinada de leitura (1 h) ou null. */
function urlDaMidia(key) {
  if (!key || !r2.disponivel()) return Promise.resolve(null);
  const inicio = new Date(Math.floor(Date.now() / JANELA_ASSINATURA_MS) * JANELA_ASSINATURA_MS);
  return r2.urlAssinada(key, URL_VALIDADE_S, inicio);
}

// ── Enviar ───────────────────────────────────────────────────
/**
 * Foto ou áudio na conversa aberta. kind: 'foto' | 'audio'.
 * Devolve { ok, wamid, convertido }.
 */
async function enviarMidia({ companyId, conversationId, userId, kind, buffer, mime, caption = null }) {
  if (kind !== 'foto' && kind !== 'audio') throw envio.erro('TIPO_INVALIDO', 'kind inválido (foto, audio)', 400);
  // Valida e converte ANTES de tocar na Meta: arquivo ruim nunca gasta chamada.
  const pronto = kind === 'foto' ? prepararFoto(buffer) : prepararAudio(buffer, mime);
  const { creds, phone } = await envio.prepararEnvio(companyId, conversationId);

  const legenda = kind === 'foto' && caption ? String(caption).trim().slice(0, 1000) : '';
  const mediaId = await subirParaMeta(creds, pronto.buffer, pronto.mime);
  const corpo = kind === 'foto'
    ? { type: 'image', image: { id: mediaId, ...(legenda ? { caption: legenda } : {}) } }
    : { type: 'audio', audio: { id: mediaId } };
  const resp = await wa.graphPost(`/${creds.phoneNumberId}/messages`, creds.accessToken, {
    messaging_product: 'whatsapp', to: phone, ...corpo,
  });
  const wamid = envio.wamidDe(resp);

  const key = await guardar({ companyId, conversationId, buffer: pronto.buffer, mime: pronto.mime }).catch(() => null);
  await envio.gravarNaThread({
    companyId, conversationId, userId, wamid,
    content: legenda || (kind === 'foto' ? '[foto]' : '[audio]'),
    metadata: {
      tipo: kind,
      media: { kind: kind === 'foto' ? 'image' : 'audio', mime: pronto.mime, key, bytes: pronto.buffer.length, media_id: mediaId },
    },
  });
  return { ok: true, wamid, convertido: !!pronto.convertido };
}

// ── Receber ──────────────────────────────────────────────────
const TIPOS_RECEBIDOS = { image: 'image', audio: 'audio', sticker: 'image' };

/** { kind, id, mime } da mensagem do webhook, ou null se não for foto/áudio. */
function midiaDaMensagem(msg) {
  const kind = msg && TIPOS_RECEBIDOS[msg.type];
  const corpo = kind && msg[msg.type];
  if (!corpo || !corpo.id) return null;
  return { kind, id: String(corpo.id), mime: corpo.mime_type || null };
}

/**
 * Baixa a mídia de uma mensagem recebida e guarda em hub_messages.metadata.media.
 * Nunca joga: o webhook já respondeu 200 e a mensagem de texto já está gravada.
 */
async function guardarRecebida({ companyId, conversationId, msg }) {
  const m = midiaDaMensagem(msg);
  if (!m) return { ok: false, reason: 'SEM_MIDIA' };
  try {
    if (!r2.disponivel()) return { ok: false, reason: 'SEM_BUCKET' };
    const creds = await envio.carregarCredenciais(companyId);
    if (!creds) return { ok: false, reason: 'SEM_CREDENCIAIS' };
    const baixada = await baixarDaMeta(creds, m.id);
    const key = await guardar({ companyId, conversationId, buffer: baixada.buffer, mime: baixada.mime });
    if (!key) return { ok: false, reason: 'NAO_GUARDOU' };
    await db.query(
      `-- hubmidia:recebida
       UPDATE hub_messages
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
        WHERE company_id = $1 AND channel = 'whatsapp' AND external_message_id = $2`,
      [companyId, msg.id, JSON.stringify({
        media: { kind: m.kind, mime: mimeBase(baixada.mime), key, bytes: baixada.buffer.length, media_id: m.id },
      })]
    );
    return { ok: true, key };
  } catch (e) {
    if (!isMissingSchema(e)) console.error('[HUB-MIDIA] mídia recebida não guardada: %s', e.message);
    return { ok: false, reason: 'ERRO' };
  }
}

module.exports = {
  enviarMidia, guardarRecebida, midiaDaMensagem, urlDaMidia, prepararAudio, prepararFoto,
  subirParaMeta, baixarDaMeta, guardar, MAX_FOTO, MAX_AUDIO,
};
