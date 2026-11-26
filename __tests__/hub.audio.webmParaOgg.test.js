// ============================================================
// AURA — áudio da conversa: WebM/Opus (Chrome) → OGG/Opus (Meta)
//
// Fixture (helpers/webmFixture.js): WebM montado à mão no formato do
// MediaRecorder do Chrome. A saída é lida por um leitor Ogg
// escrito aqui, independente do conversor: confere os CRCs de cada página,
// a ordem e o conteúdo dos pacotes, o OpusHead/OpusTags e a granule position.
// ============================================================
'use strict';

const { criarWebm, pacote } = require('./helpers/webmFixture');
const { webmParaOgg, lerWebm, amostrasDoPacote, crcOgg, ehOgg, ehWebm } = require('../src/utils/webmParaOgg');

// ── leitor Ogg independente ──
function lerOgg(buf) {
  const paginas = [];
  let pos = 0;
  while (pos < buf.length) {
    expect(buf.toString('ascii', pos, pos + 4)).toBe('OggS');
    const nSeg = buf[pos + 26];
    const tabela = [...buf.subarray(pos + 27, pos + 27 + nSeg)];
    const tamanhoDados = tabela.reduce((a, b) => a + b, 0);
    const total = 27 + nSeg + tamanhoDados;
    const pagina = Buffer.from(buf.subarray(pos, pos + total));
    const crc = pagina.readUInt32LE(22);
    pagina.writeUInt32LE(0, 22);
    expect(crcOgg(pagina)).toBe(crc);
    // pacotes (lacing)
    const pacotes = [];
    let atual = [];
    let off = pos + 27 + nSeg;
    for (const t of tabela) {
      atual.push(buf.subarray(off, off + t));
      off += t;
      if (t < 255) { pacotes.push(Buffer.concat(atual)); atual = []; }
    }
    paginas.push({
      tipo: buf[pos + 5], granule: Number(buf.readBigInt64LE(pos + 6)), serial: buf.readUInt32LE(pos + 14),
      seq: buf.readUInt32LE(pos + 18), pacotes,
    });
    pos += total;
  }
  return paginas;
}

describe('amostrasDoPacote (TOC do Opus)', () => {
  it('CELT 20 ms, 1 quadro = 960', () => expect(amostrasDoPacote(Buffer.from([0xfc, 1]))).toBe(960));
  it('SILK 60 ms, 1 quadro = 2880', () => expect(amostrasDoPacote(Buffer.from([0x18, 1]))).toBe(2880));
  it('código 1 = 2 quadros', () => expect(amostrasDoPacote(Buffer.from([0xfd, 1]))).toBe(1920));
  it('código 3 lê a contagem de quadros', () => expect(amostrasDoPacote(Buffer.from([0xff, 0x03, 1]))).toBe(2880));
  it('CELT 2,5 ms = 120', () => expect(amostrasDoPacote(Buffer.from([0xe0, 1]))).toBe(120));
});

describe('webmParaOgg', () => {
  const pacotes = Array.from({ length: 7 }, (_, i) => pacote(i + 1, 20 + i * 7));
  const webm = criarWebm(pacotes);

  it('reconhece o formato de entrada e de saída', () => {
    expect(ehWebm(webm)).toBe(true);
    const ogg = webmParaOgg(webm);
    expect(ehOgg(ogg)).toBe(true);
    expect(ehWebm(ogg)).toBe(false);
  });

  it('lê os pacotes do WebM na ordem, mesmo com Cluster de tamanho desconhecido', () => {
    const r = lerWebm(webm);
    expect(r.pacotes).toHaveLength(7);
    r.pacotes.forEach((p, i) => expect(p.equals(pacotes[i])).toBe(true));
    expect(r.canais).toBe(1);
  });

  it('escreve OpusHead e OpusTags e depois os pacotes, todos com CRC certo', () => {
    const paginas = lerOgg(webmParaOgg(webm));
    expect(paginas[0].tipo).toBe(0x02); // BOS
    expect(paginas[0].pacotes).toHaveLength(1);
    expect(paginas[0].pacotes[0].toString('ascii', 0, 8)).toBe('OpusHead');
    expect(paginas[0].pacotes[0][9]).toBe(1); // mono
    expect(paginas[0].granule).toBe(0);
    expect(paginas[1].pacotes[0].toString('ascii', 0, 8)).toBe('OpusTags');
    const audio = paginas.slice(2).flatMap((p) => p.pacotes);
    expect(audio).toHaveLength(7);
    audio.forEach((p, i) => expect(p.equals(pacotes[i])).toBe(true));
  });

  it('numera as páginas em sequência, mesmo serial, EOS só na última', () => {
    const paginas = lerOgg(webmParaOgg(webm));
    paginas.forEach((p, i) => { expect(p.seq).toBe(i); expect(p.serial).toBe(paginas[0].serial); });
    expect(paginas[paginas.length - 1].tipo & 0x04).toBe(0x04);
    paginas.slice(0, -1).forEach((p) => expect(p.tipo & 0x04).toBe(0));
  });

  it('granule position = pre-skip + amostras de 48 kHz', () => {
    const paginas = lerOgg(webmParaOgg(webm));
    expect(paginas[paginas.length - 1].granule).toBe(312 + 7 * 960);
  });

  it('muitos pacotes viram várias páginas, cada uma com granule crescente', () => {
    const muitos = Array.from({ length: 130 }, (_, i) => pacote(i, 30));
    const paginas = lerOgg(webmParaOgg(criarWebm(muitos)));
    const audio = paginas.slice(2);
    expect(audio.length).toBeGreaterThan(1);
    expect(audio.flatMap((p) => p.pacotes)).toHaveLength(130);
    for (let i = 1; i < audio.length; i++) expect(audio[i].granule).toBeGreaterThan(audio[i - 1].granule);
    expect(audio[audio.length - 1].granule).toBe(312 + 130 * 960);
  });

  it('pacote de 255 bytes (múltiplo do lacing) volta inteiro', () => {
    const exato = pacote(9, 255);
    const grande = pacote(8, 600);
    const paginas = lerOgg(webmParaOgg(criarWebm([exato, grande])));
    const audio = paginas.slice(2).flatMap((p) => p.pacotes);
    expect(audio[0].equals(exato)).toBe(true);
    expect(audio[1].equals(grande)).toBe(true);
  });

  it('sem CodecPrivate monta um OpusHead válido (pre-skip 312, 48 kHz)', () => {
    const paginas = lerOgg(webmParaOgg(criarWebm(pacotes, { head: null })));
    const h = paginas[0].pacotes[0];
    expect(h.toString('ascii', 0, 8)).toBe('OpusHead');
    expect(h.readUInt16LE(10)).toBe(312);
    expect(h.readUInt32LE(12)).toBe(48000);
  });

  it('arquivo que não é WebM, não é Opus ou está vazio joga AUDIO_INVALIDO', () => {
    expect(() => webmParaOgg(Buffer.from('nada a ver'))).toThrow(/WebM/);
    expect(() => webmParaOgg(criarWebm(pacotes, { codec: 'A_VORBIS' }))).toThrow(/Opus/);
    expect(() => webmParaOgg(criarWebm([]))).toThrow(/vazio/);
    try { webmParaOgg(Buffer.from('xx')); } catch (e) { expect(e.code).toBe('AUDIO_INVALIDO'); }
  });

  it('arquivo cortado no fim aproveita o que chegou', () => {
    const cortado = webm.subarray(0, webm.length - 9);
    const r = lerWebm(cortado);
    expect(r.pacotes.length).toBeGreaterThan(0);
    expect(r.pacotes.length).toBeLessThan(7);
  });
});

describe('CRC do Ogg', () => {
  it('é o CRC-32 MSB-first (poly 0x04C11DB7, init 0): vetor "123456789" = 0x89A1897F', () => {
    expect(crcOgg(Buffer.from('123456789'))).toBe(0x89a1897f);
  });
});
