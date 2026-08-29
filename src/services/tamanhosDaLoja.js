// ============================================================
// AURA — normalizar e ordenar tamanho.
//
// A Finesse grava dezessete valores de tamanho:
//
//   34 36 38 40 42 g G gg GG m M p P PP u U Único
//
// São dez. O resto é o mesmo tamanho escrito de jeitos diferentes, porque
// quem cadastra digita à mão e ninguém padroniza caixa. Um filtro sem
// normalizar mostraria "G" e "g" como dois botões, e clicar num traria
// metade das peças.
//
// ORDENAR TAMBÉM IMPORTA, e é onde o alfabético falha feio: em ordem
// alfabética a régua sai `G, GG, M, P, PP` — que não é ordem de tamanho
// nenhuma. A pessoa procura o dela numa escala, não num dicionário.
// ============================================================
'use strict';

/**
 * A escala de letras, do menor para o maior.
 *
 * "Único" fica por último de propósito: não é um ponto da escala, é a
 * ausência dela, e no meio da régua confundiria.
 */
const ESCALA = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'ÚNICO'];

/** Sinônimos que a lojista escreve e significam "serve em qualquer uma". */
const UNICO = ['U', 'UN', 'UNI', 'ÚNICO', 'UNICO', 'TAMANHO ÚNICO', 'TAMANHO UNICO'];

function semAcento(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .split('')
    .filter((c) => {
      const k = c.charCodeAt(0);
      return k < 0x300 || k > 0x36f;
    })
    .join('');
}

/**
 * O rótulo canônico de um tamanho.
 *
 * Devolve null para vazio — quem chama decide se ignora ou agrupa como
 * "sem tamanho"; aqui não inventamos um valor que a lojista não escreveu.
 */
function normalizarTamanho(bruto) {
  const s = String(bruto == null ? '' : bruto).trim();
  if (!s) return null;

  const alto = semAcento(s).toUpperCase();
  if (UNICO.includes(alto)) return 'Único';

  // Numérico (34, 36, 38…): devolve o número limpo, sem zero à esquerda.
  const num = alto.replace(/[^0-9]/g, '');
  if (num && num === alto.replace(/\s/g, '')) return String(parseInt(num, 10));

  // Letra: PP, P, M, G, GG, XG…
  const semEspaco = alto.replace(/\s/g, '');
  if (ESCALA.includes(semEspaco)) {
    return semEspaco === 'ÚNICO' ? 'Único' : semEspaco;
  }

  // Não reconhecido: devolve como a lojista escreveu, só com a caixa
  // arrumada. Melhor um rótulo estranho que ela reconhece do que sumir
  // com o tamanho dela.
  return s;
}

/**
 * Peso de ordenação. Número vem antes de letra, letra segue a escala, e
 * o que não é nenhum dos dois vai para o fim.
 */
function pesoDoTamanho(rotulo) {
  const s = String(rotulo == null ? '' : rotulo).trim();
  if (/^\d+$/.test(s)) return { grupo: 0, ordem: parseInt(s, 10) };
  const i = ESCALA.indexOf(semAcento(s).toUpperCase());
  if (i >= 0) return { grupo: 1, ordem: i };
  return { grupo: 2, ordem: 0, texto: s };
}

/** Ordena rótulos já normalizados na ordem em que a régua se lê. */
function ordenarTamanhos(rotulos) {
  return [...(rotulos || [])].sort((a, b) => {
    const pa = pesoDoTamanho(a);
    const pb = pesoDoTamanho(b);
    if (pa.grupo !== pb.grupo) return pa.grupo - pb.grupo;
    if (pa.grupo === 2) return String(a).localeCompare(String(b));
    return pa.ordem - pb.ordem;
  });
}

/**
 * Agrupa linhas do banco por tamanho canônico.
 *
 * @param linhas [{ value, total }]
 * @returns [{ rotulo, total, valores }] na ordem da régua — `valores` é o
 *          que efetivamente está gravado, porque é por ele que o filtro
 *          precisa buscar.
 */
function agruparTamanhos(linhas) {
  const mapa = new Map();
  for (const l of linhas || []) {
    const rotulo = normalizarTamanho(l.value);
    if (!rotulo) continue;
    const total = Number(l.total) || 0;
    const atual = mapa.get(rotulo);
    if (atual) {
      atual.total += total;
      if (!atual.valores.includes(l.value)) atual.valores.push(l.value);
    } else {
      mapa.set(rotulo, { rotulo, total, valores: [l.value] });
    }
  }
  const ordem = ordenarTamanhos([...mapa.keys()]);
  return ordem.map((r) => mapa.get(r));
}

module.exports = {
  ESCALA,
  normalizarTamanho,
  ordenarTamanhos,
  agruparTamanhos,
};
