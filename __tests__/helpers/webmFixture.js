// ============================================================
// Fixture: WebM/Opus no formato do MediaRecorder do Chrome (Segment e
// Cluster de tamanho desconhecido, SimpleBlock, trilha A_OPUS com OpusHead
// no CodecPrivate). Montado à mão: não depende de gravar nada.
// ============================================================
'use strict';

function vintTamanho(n) {
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  if (n < 0x3fff) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  return Buffer.from([0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff]);
}
const DESCONHECIDO = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
function idBuf(id) {
  const bytes = [];
  let v = id;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  return Buffer.from(bytes);
}
const el = (id, corpo) => Buffer.concat([idBuf(id), vintTamanho(corpo.length), corpo]);
const elDesconhecido = (id, corpo) => Buffer.concat([idBuf(id), DESCONHECIDO, corpo]);
const uint = (n) => Buffer.from([n]);

function opusHead(canais = 1, preSkip = 312) {
  const h = Buffer.alloc(19);
  h.write('OpusHead', 0, 'ascii');
  h[8] = 1; h[9] = canais;
  h.writeUInt16LE(preSkip, 10);
  h.writeUInt32LE(48000, 12);
  return h;
}

function simpleBlock(pacote, tempo = 0) {
  // trilha 1 (vint 0x81), timecode int16, flags 0x80 (keyframe), sem lacing
  return el(0xa3, Buffer.concat([Buffer.from([0x81, (tempo >> 8) & 0xff, tempo & 0xff, 0x80]), pacote]));
}

function criarWebm(pacotes, { canais = 1, codec = 'A_OPUS', head = opusHead(1), canaisVazio = false, trilhaIntrusa = null } = {}) {
  const ebml = el(0x1a45dfa3, el(0x4282, Buffer.from('webm')));
  const info = el(0x1549a966, el(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40])));
  const entrada = el(0xae, Buffer.concat([
    el(0xd7, uint(1)), el(0x83, uint(2)), el(0x86, Buffer.from(codec)),
    ...(head ? [el(0x63a2, head)] : []),
    el(0xe1, Buffer.concat([el(0xb5, Buffer.alloc(4)), el(0x9f, canaisVazio ? Buffer.alloc(0) : uint(canais))])),
  ]));
  const outra = el(0xae, Buffer.concat([el(0xd7, uint(2)), el(0x83, uint(1)), el(0x86, Buffer.from('V_VP8'))]));
  const trilhas = el(0x1654ae6b, trilhaIntrusa ? Buffer.concat([entrada, outra]) : entrada);
  const intruso = trilhaIntrusa ? [el(0xa3, Buffer.concat([Buffer.from([0x82, 0, 0, 0x80]), trilhaIntrusa]))] : [];
  const cluster1 = elDesconhecido(0x1f43b675, Buffer.concat([
    el(0xe7, uint(0)), ...intruso, ...pacotes.slice(0, Math.ceil(pacotes.length / 2)).map((p, i) => simpleBlock(p, i * 20)),
  ]));
  const cluster2 = elDesconhecido(0x1f43b675, Buffer.concat([
    el(0xe7, uint(0)), ...pacotes.slice(Math.ceil(pacotes.length / 2)).map((p, i) => simpleBlock(p, i * 20)),
  ]));
  return Buffer.concat([ebml, elDesconhecido(0x18538067, Buffer.concat([info, trilhas, cluster1, cluster2]))]);
}


// Pacote Opus de teste: TOC 0xFC = CELT 20 ms, 1 quadro (960 amostras).
const pacote = (n, tam) => Buffer.concat([Buffer.from([0xfc]), Buffer.alloc(tam - 1, n & 0xff)]);

module.exports = { criarWebm, pacote, opusHead };
