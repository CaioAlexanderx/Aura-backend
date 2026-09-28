// ============================================================
// AURA Studio — ajuste da arte na peca (chaves laterais do customization)
//
// A vitrine passa a deixar a cliente posicionar, escalar e girar a arte
// na peca, e escolher fonte e tamanho do texto. Isso chega no pedido como
// CHAVES LATERAIS no objeto `customization` (plano, { [field.id]: valor }),
// no mesmo padrao da `<campo>_cor` que ja existe:
//
//   <F>_ajuste    (F text | image | template)
//       { v: 1, cx, cy, larg?, alt?, rot?, encaixe?, cm?, arquivo?, dpi? }
//       cx, cy   centro da arte na area de impressao, em fracao (0..1),
//                limitado a [-0.5, 1.5] (a arte pode sair um pouco da area)
//       larg     largura em fracao da area (so image/template), [0.02, 3]
//       alt      altura da linha em fracao da area (so text), [0.02, 2]
//       rot      0 | 90 | 180 | 270 (outro valor vira 0)
//       encaixe  'ajustar' | 'preencher' | 'livre'
//       cm       { x, y, w, h } em cm, cada um em [-500, 500], 2 casas
//       arquivo  { w, h } em pixels, inteiros 1..100000
//       dpi      0..20000, inteiro
//   <F>_fonte     (F text) nome da fonte, ate 60 caracteres; se o campo
//                 tiver `config.fonts`, precisa estar na lista
//   <F>_tam       (F text) 'P' | 'M' | 'G'
//   <F>_contorno  (F text) booleano
//
// O QUE ISTO NAO FAZ: nunca recusa o pedido. Um ajuste malformado nao
// pode travar uma venda — a chave (ou a propriedade) invalida sai, e a
// producao cai no layout padrao, que e o que acontecia antes de existir
// o ajuste. Qualquer outra chave do customization passa intacta.
//
// Pura de proposito: sem banco, sem req. Quem chama passa o
// customization_config do produto (o de HOJE).
// ============================================================
'use strict';

const SUFIXOS = ['_ajuste', '_fonte', '_tam', '_contorno'];

const TIPOS_COM_AJUSTE = new Set(['text', 'image', 'template']);
const TIPOS_DE_ARTE = new Set(['image', 'template']);

const ROTACOES = new Set([0, 90, 180, 270]);
const ENCAIXES = new Set(['ajustar', 'preencher', 'livre']);
const TAMANHOS = new Set(['P', 'M', 'G']);

const MAX_FONTE = 60;

const numero = (v) => typeof v === 'number' && Number.isFinite(v);
const limitar = (v, min, max) => Math.min(max, Math.max(min, v));
const objeto = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const duasCasas = (v) => Math.round(v * 100) / 100;

function cmDoAjuste(cm) {
  if (!objeto(cm)) return undefined;
  const out = {};
  for (const k of ['x', 'y', 'w', 'h']) {
    if (!numero(cm[k])) return undefined;
    // `+ 0` tira o -0 que o arredondamento de -0.001 deixaria.
    out[k] = duasCasas(limitar(cm[k], -500, 500)) + 0;
  }
  return out;
}

function arquivoDoAjuste(a) {
  if (!objeto(a)) return undefined;
  const ok = (v) => Number.isInteger(v) && v >= 1 && v <= 100000;
  if (!ok(a.w) || !ok(a.h)) return undefined;
  return { w: a.w, h: a.h };
}

/**
 * O `<F>_ajuste` limpo, ou `undefined` se nao da para aproveitar.
 * @param {*} bruto  o que veio do cliente
 * @param {string} tipo  tipo do campo F (text | image | template)
 */
function ajusteLimpo(bruto, tipo) {
  if (!objeto(bruto) || bruto.v !== 1) return undefined;
  if (!numero(bruto.cx) || !numero(bruto.cy)) return undefined;

  const out = {
    v: 1,
    cx: limitar(bruto.cx, -0.5, 1.5),
    cy: limitar(bruto.cy, -0.5, 1.5),
  };

  if (TIPOS_DE_ARTE.has(tipo) && numero(bruto.larg)) {
    out.larg = limitar(bruto.larg, 0.02, 3);
  }
  if (tipo === 'text' && numero(bruto.alt)) {
    out.alt = limitar(bruto.alt, 0.02, 2);
  }
  if (bruto.rot !== undefined) {
    out.rot = ROTACOES.has(bruto.rot) ? bruto.rot : 0;
  }
  if (typeof bruto.encaixe === 'string' && ENCAIXES.has(bruto.encaixe)) {
    out.encaixe = bruto.encaixe;
  }
  const cm = cmDoAjuste(bruto.cm);
  if (cm) out.cm = cm;
  const arquivo = arquivoDoAjuste(bruto.arquivo);
  if (arquivo) out.arquivo = arquivo;
  if (numero(bruto.dpi) && bruto.dpi >= 0 && bruto.dpi <= 20000) {
    out.dpi = Math.round(bruto.dpi);
  }
  return out;
}

/** Nome de uma fonte cadastrada no campo (texto ou { family | value | name }). */
function nomeDaFonteCadastrada(f) {
  if (typeof f === 'string') return f;
  if (objeto(f)) {
    for (const k of ['family', 'value', 'name']) {
      if (typeof f[k] === 'string') return f[k];
    }
  }
  return null;
}

function fonteLimpa(bruto, campo) {
  if (typeof bruto !== 'string') return undefined;
  const nome = bruto.trim();
  if (!nome || nome.length > MAX_FONTE) return undefined;
  const lista = campo.config && Array.isArray(campo.config.fonts) ? campo.config.fonts : [];
  if (lista.length > 0 && !lista.some((f) => nomeDaFonteCadastrada(f) === nome)) return undefined;
  return nome;
}

/**
 * Se `chave` e uma chave lateral de ajuste, devolve { base, sufixo };
 * senao null. Uma chave que e o id de um campo do produto nunca e
 * lateral (um campo pode se chamar "cor_fonte").
 */
function chaveLateral(chave, campos) {
  if (campos.has(chave)) return null;
  for (const sufixo of SUFIXOS) {
    if (chave.endsWith(sufixo)) {
      return { base: chave.slice(0, -sufixo.length), sufixo };
    }
  }
  return null;
}

/**
 * Devolve um NOVO customization com as chaves de ajuste da arte limpas.
 * Nao muta a entrada e nunca lanca.
 *
 * @param {object} customization  { [field.id]: valor, ... } vindo do cliente
 * @param {object} config         customization_config do produto
 * @returns {object} o customization limpo (ou a propria entrada, se nao for objeto)
 */
function sanitizarAjustesDaArte(customization, config) {
  if (!objeto(customization)) return customization;

  const campos = new Map();
  const fields = config && Array.isArray(config.fields) ? config.fields : [];
  for (const f of fields) {
    if (f && typeof f.id === 'string' && f.id) campos.set(f.id, f);
  }

  const out = {};
  for (const chave of Object.keys(customization)) {
    const valor = customization[chave];
    const lateral = chaveLateral(chave, campos);
    if (!lateral) {
      out[chave] = valor;
      continue;
    }
    const campo = campos.get(lateral.base);
    if (!campo) continue; // prefixo nao e campo do produto
    let limpo;
    try {
      switch (lateral.sufixo) {
        case '_ajuste':
          limpo = TIPOS_COM_AJUSTE.has(campo.type) ? ajusteLimpo(valor, campo.type) : undefined;
          break;
        case '_fonte':
          limpo = campo.type === 'text' ? fonteLimpa(valor, campo) : undefined;
          break;
        case '_tam':
          limpo = campo.type === 'text' && TAMANHOS.has(valor) ? valor : undefined;
          break;
        case '_contorno':
          limpo = campo.type === 'text' && typeof valor === 'boolean' ? valor : undefined;
          break;
        default:
          limpo = undefined;
      }
    } catch (_) {
      // Getter esquisito, objeto com proxy... nada disso trava a venda.
      limpo = undefined;
    }
    if (limpo !== undefined) out[chave] = limpo;
  }
  return out;
}

module.exports = { sanitizarAjustesDaArte, SUFIXOS_DE_AJUSTE: SUFIXOS };
