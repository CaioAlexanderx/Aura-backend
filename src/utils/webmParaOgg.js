// ============================================================
// AURA. — webm/opus  →  ogg/opus (sem recodificar)
//
// O Chrome grava áudio com MediaRecorder em WebM (Opus). A Cloud API da
// Meta só aceita Opus dentro de OGG (audio/ogg; codecs=opus), não WebM.
// Os dois guardam os MESMOS pacotes Opus: muda só a embalagem. Então a
// conversão é uma troca de container — lê os blocos do WebM e escreve
// páginas Ogg com os mesmos pacotes. Sem ffmpeg, sem binário nativo, sem
// perda de qualidade, e roda em milissegundos.
//
// WebM do MediaRecorder tem Segment e Cluster de tamanho "desconhecido"
// (gravação ao vivo). Por isso a leitura é sequencial: nos elementos que
// só agrupam (Segment, Cluster, Tracks, TrackEntry, BlockGroup) entra-se
// direto; os demais pulam pelo tamanho.
//
// Formato de saída (RFC 7845): página 1 = OpusHead (BOS), página 2 =
// OpusTags, depois os pacotes com granule position em amostras de 48 kHz
// (inclui o pre-skip) e a última página marcada EOS.
// ============================================================
'use strict';

const ID = {
  EBML: 0x1a45dfa3, SEGMENT: 0x18538067, CLUSTER: 0x1f43b675, TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae, TRACK_NUMBER: 0xd7, CODEC_ID: 0x86, CODEC_PRIVATE: 0x63a2, AUDIO: 0xe1, CHANNELS: 0x9f,
  SIMPLE_BLOCK: 0xa3, BLOCK_GROUP: 0xa0, BLOCK: 0xa1,
};
const ENTRAR = new Set([ID.SEGMENT, ID.CLUSTER, ID.TRACKS, ID.TRACK_ENTRY, ID.BLOCK_GROUP, ID.AUDIO]);
const PRE_SKIP_PADRAO = 312;

function erro(msg) {
  const e = new Error(msg);
  e.code = 'AUDIO_INVALIDO';
  return e;
}

// ── EBML ─────────────────────────────────────────────────────
function lerId(buf, pos) {
  const b = buf[pos];
  if (b === undefined || b === 0) return null;
  let len = 1;
  while (len <= 4 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 4 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

// Tamanho em vint; todos os bits de valor em 1 = desconhecido (-1).
function lerTamanho(buf, pos) {
  const b = buf[pos];
  if (b === undefined || b === 0) return null;
  let len = 1;
  while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > buf.length) return null;
  let valor = b & (0xff >> len);
  let tudoUm = valor === (0xff >> len);
  for (let i = 1; i < len; i++) {
    valor = valor * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) tudoUm = false;
  }
  return { tamanho: tudoUm ? -1 : valor, len };
}

function lerVint(buf, pos) {
  const b = buf[pos];
  if (b === undefined || b === 0) return null;
  let len = 1;
  while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
  let valor = b & (0xff >> len);
  for (let i = 1; i < len; i++) valor = valor * 256 + buf[pos + i];
  return { valor, len };
}

/** Lê o WebM e devolve { pacotes: Buffer[], head: Buffer|null, canais }. */
function lerWebm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.readUInt32BE(0) !== ID.EBML) {
    throw erro('Não é um arquivo WebM');
  }
  const out = { pacotes: [], head: null, canais: 1, codec: null };
  let pos = 0;
  let trilhaOpus = null;
  let trackAtual = null;
  while (pos < buf.length) {
    const id = lerId(buf, pos);
    if (!id) break;
    const tam = lerTamanho(buf, pos + id.len);
    if (!tam) break;
    const dados = pos + id.len + tam.len;
    if (ENTRAR.has(id.id)) {
      if (id.id === ID.TRACK_ENTRY) trackAtual = { numero: null, codec: null, canais: 1, head: null };
      pos = dados;
      continue;
    }
    if (tam.tamanho < 0) throw erro('WebM com elemento de tamanho desconhecido inesperado');
    const fim = dados + tam.tamanho;
    if (fim > buf.length) break; // arquivo cortado: usa o que veio
    if (trackAtual) {
      if (id.id === ID.CODEC_ID) {
        trackAtual.codec = buf.toString('ascii', dados, fim).replace(/\0+$/, '');
        if (trackAtual.codec === 'A_OPUS' && trilhaOpus === null) trilhaOpus = trackAtual;
      } else if (id.id === ID.CODEC_PRIVATE) {
        trackAtual.head = buf.subarray(dados, fim);
      } else if (id.id === ID.TRACK_NUMBER && tam.tamanho >= 1 && tam.tamanho <= 6) {
        trackAtual.numero = buf.readUIntBE(dados, tam.tamanho);
      } else if (id.id === ID.CHANNELS) {
        if (tam.tamanho < 1 || tam.tamanho > 6) throw erro('WebM com número de canais inválido');
        trackAtual.canais = buf.readUIntBE(dados, tam.tamanho) || 1;
      }
    }
    if (id.id === ID.SIMPLE_BLOCK || id.id === ID.BLOCK) {
      const trilha = lerVint(buf, dados);
      // Só os blocos da trilha Opus (um WebM pode ter outra trilha).
      if (trilha && (trilhaOpus === null || trilhaOpus.numero === null || trilha.valor === trilhaOpus.numero)) {
        const flags = buf[dados + trilha.len + 2];
        const lacing = (flags & 0x06) >> 1;
        if (lacing !== 0) throw erro('WebM com lacing não suportado');
        const inicio = dados + trilha.len + 3;
        if (inicio < fim) out.pacotes.push(Buffer.from(buf.subarray(inicio, fim)));
      }
    }
    pos = fim;
  }
  if (!trilhaOpus) throw erro('O áudio não está em Opus');
  out.codec = trilhaOpus.codec;
  out.canais = trilhaOpus.canais;
  out.head = trilhaOpus.head;
  if (!out.pacotes.length) throw erro('Áudio vazio');
  return out;
}

// ── Opus ─────────────────────────────────────────────────────
/** Amostras a 48 kHz de um pacote Opus (pelo byte TOC, RFC 6716 §3.1). */
function amostrasDoPacote(pacote) {
  if (!pacote.length) return 0;
  const toc = pacote[0];
  const config = toc >> 3;
  let ms;
  if (config < 12) ms = [10, 20, 40, 60][config % 4];
  else if (config < 16) ms = [10, 20][config % 2];
  else ms = [2.5, 5, 10, 20][config % 4];
  const codigo = toc & 3;
  let quadros = 1;
  if (codigo === 1 || codigo === 2) quadros = 2;
  else if (codigo === 3) quadros = pacote.length > 1 ? pacote[1] & 0x3f : 0;
  return Math.round(quadros * ms * 48);
}

function opusHead(codecPrivate, canais) {
  if (codecPrivate && codecPrivate.length >= 19 && codecPrivate.toString('ascii', 0, 8) === 'OpusHead') {
    return Buffer.from(codecPrivate.subarray(0, 19));
  }
  const h = Buffer.alloc(19);
  h.write('OpusHead', 0, 'ascii');
  h[8] = 1;
  h[9] = canais || 1;
  h.writeUInt16LE(PRE_SKIP_PADRAO, 10);
  h.writeUInt32LE(48000, 12);
  h.writeInt16LE(0, 16);
  h[18] = 0;
  return h;
}

function opusTags() {
  const vendor = Buffer.from('Aura', 'ascii');
  const b = Buffer.alloc(8 + 4 + vendor.length + 4);
  b.write('OpusTags', 0, 'ascii');
  b.writeUInt32LE(vendor.length, 8);
  vendor.copy(b, 12);
  b.writeUInt32LE(0, 12 + vendor.length);
  return b;
}

// ── Ogg ──────────────────────────────────────────────────────
// CRC-32 do Ogg: polinômio 0x04C11DB7, MSB primeiro, valor inicial 0, sem xor final.
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    t[i] = r >>> 0;
  }
  return t;
})();

function crcOgg(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ TABELA_CRC[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

function tabelaDeSegmentos(pacotes) {
  const seg = [];
  for (const p of pacotes) {
    let resto = p.length;
    while (resto >= 255) { seg.push(255); resto -= 255; }
    seg.push(resto); // 0 fecha pacote múltiplo de 255
  }
  return seg;
}

function pagina({ tipo, granule, serial, seq, pacotes }) {
  const seg = tabelaDeSegmentos(pacotes);
  const dados = Buffer.concat(pacotes);
  const cab = Buffer.alloc(27 + seg.length);
  cab.write('OggS', 0, 'ascii');
  cab[4] = 0;
  cab[5] = tipo;
  cab.writeBigInt64LE(BigInt(granule), 6);
  cab.writeUInt32LE(serial >>> 0, 14);
  cab.writeUInt32LE(seq, 18);
  cab.writeUInt32LE(0, 22);
  cab[26] = seg.length;
  seg.forEach((s, i) => { cab[27 + i] = s; });
  const total = Buffer.concat([cab, dados]);
  total.writeUInt32LE(crcOgg(total), 22);
  return total;
}

const MAX_SEGMENTOS_POR_PAGINA = 255;

/** Pacotes Opus → Buffer Ogg. */
function escreverOgg({ pacotes, head, canais }) {
  const serial = 0x41555241; // "AURA"
  const cabecalho = opusHead(head, canais);
  const preSkip = cabecalho.readUInt16LE(10);
  const paginas = [
    pagina({ tipo: 0x02, granule: 0, serial, seq: 0, pacotes: [cabecalho] }),
    pagina({ tipo: 0x00, granule: 0, serial, seq: 1, pacotes: [opusTags()] }),
  ];
  let seq = 2;
  // RFC 7845: a granule position conta amostras de 48 kHz desde o início do
  // stream (o pre-skip já está dentro dos pacotes), então começa em 0.
  let acumulado = 0;
  let grupo = [];
  let segs = 0;
  const fechar = (ultima) => {
    if (!grupo.length) return;
    paginas.push(pagina({ tipo: ultima ? 0x04 : 0x00, granule: acumulado, serial, seq: seq++, pacotes: grupo }));
    grupo = [];
    segs = 0;
  };
  pacotes.forEach((p, i) => {
    const n = tabelaDeSegmentos([p]).length;
    if (segs + n > MAX_SEGMENTOS_POR_PAGINA) fechar(false);
    grupo.push(p);
    segs += n;
    acumulado += amostrasDoPacote(p);
    // ~1 s de áudio por página: mantém o atraso de leitura baixo.
    if (grupo.length >= 50 && i < pacotes.length - 1) fechar(false);
  });
  fechar(true);
  return Buffer.concat(paginas);
}

/** WebM/Opus → OGG/Opus. Joga Error com code AUDIO_INVALIDO se não for WebM/Opus. */
function webmParaOgg(webm) {
  return escreverOgg(lerWebm(webm));
}

function ehOgg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.toString('ascii', 0, 4) === 'OggS';
}

function ehWebm(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32BE(0) === ID.EBML;
}

module.exports = { webmParaOgg, lerWebm, escreverOgg, amostrasDoPacote, crcOgg, ehOgg, ehWebm };
