// ============================================================
// AURA. — Campos de NFS-e no cadastro do servico (migration 437)
//
// Uma regra so para o POST e o PATCH de produto (src/routes/products.js)
// e para a leitura das colunas: quais campos existem, os nomes aceitos no
// corpo (snake_case da coluna e camelCase), como validar e como devolver.
//
// Regras de entrada:
//   - so olha o que VEIO no corpo (undefined = nao mexe);
//   - null ou '' = limpa (volta a seguir o padrao da empresa);
//   - codigos: tira pontuacao (ponto, hifen, barra, espaco) e exige so
//     digitos no tamanho certo. Letra ou tamanho errado e ERRO 400, nunca
//     null em silencio — um codigo que some sem aviso vira nota rejeitada
//     la na frente;
//   - aliquota do ISS: % entre 0 e 5, aceita "2,5" e "2.5", 2 casas;
//   - descricao: ate 2000 caracteres (limite de xDescServ na DPS).
//
// Os campos valem para qualquer unidade (nao so 'srv'): a decisao e
// gravar, nao ignorar. Ver o comentario em products.js.
// ============================================================
'use strict';

const CAMPOS = [
  {
    col: 'nfse_ctribnac', aliases: ['nfseCtribnac', 'nfseCTribNac'], digitos: 6,
    msg: 'O código de tributação nacional precisa ter 6 dígitos (ex.: 01.07.01). Confira e tente de novo.',
  },
  {
    col: 'nfse_cnbs', aliases: ['nfseCnbs', 'nfseCNBS'], digitos: 9,
    msg: 'O código NBS precisa ter 9 dígitos (ex.: 1.1503.10.00). Confira e tente de novo.',
  },
  {
    col: 'nfse_ctribmun', aliases: ['nfseCtribmun', 'nfseCTribMun'], digitos: 3,
    msg: 'O código de tributação municipal precisa ter 3 dígitos. Confira e tente de novo.',
  },
  { col: 'nfse_aliquota_iss', aliases: ['nfseAliquotaIss'], tipo: 'aliquota' },
  { col: 'nfse_descricao', aliases: ['nfseDescricao'], tipo: 'texto', max: 2000 },
  {
    col: 'ibscbs_cst', aliases: ['ibscbsCst', 'ibscbsCST'], digitos: 3,
    msg: 'O CST do IBS/CBS precisa ter 3 dígitos (ex.: 000). Confira e tente de novo.',
  },
  {
    col: 'ibscbs_cclasstrib', aliases: ['ibscbsCclasstrib', 'ibscbsCClassTrib'], digitos: 6,
    msg: 'A classificação tributária do IBS/CBS (cClassTrib) precisa ter 6 dígitos (ex.: 000001). Confira e tente de novo.',
  },
  {
    col: 'ibscbs_cindop', aliases: ['ibscbsCindop', 'ibscbsCIndOp'], digitos: 6,
    msg: 'O indicador da operação do IBS/CBS (cIndOp) precisa ter 6 dígitos. Confira e tente de novo.',
  },
];

const COLUNAS = CAMPOS.map((c) => c.col);

/** Para o SELECT da listagem: 'nfse_ctribnac, ..., ibscbs_cindop,' (virgula no fim, como os outros degraus). */
const COLUNAS_SELECT = COLUNAS.join(', ') + ',';

const MSG_ALIQUOTA = 'A alíquota do ISS precisa ser um número entre 0 e 5 (ex.: 2 ou 2,5). Confira e tente de novo.';

const vazio = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function normalizarCodigo(def, raw) {
  if (vazio(raw)) return { value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: def.msg };
  const limpo = String(raw).replace(/[\s.\-/]/g, '');
  if (!new RegExp(`^\\d{${def.digitos}}$`).test(limpo)) return { error: def.msg };
  return { value: limpo };
}

function normalizarAliquota(raw) {
  if (vazio(raw)) return { value: null };
  let bruto = raw;
  if (typeof bruto === 'string') {
    bruto = bruto.replace(/%/g, '').trim();
    if (bruto.includes(',')) bruto = bruto.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(bruto)) return { error: MSG_ALIQUOTA };
  } else if (typeof bruto !== 'number') {
    return { error: MSG_ALIQUOTA };
  }
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < 0 || n > 5) return { error: MSG_ALIQUOTA };
  return { value: Math.round(n * 100) / 100 };
}

function normalizarTexto(def, raw) {
  if (vazio(raw)) return { value: null };
  if (typeof raw !== 'string') return { error: 'A descrição do serviço para a nota precisa ser um texto.' };
  const t = raw.trim();
  if (t.length > def.max) {
    return { error: `A descrição do serviço para a nota pode ter até 2.000 caracteres — esta tem ${t.length}. Que tal resumir um pouco?` };
  }
  return { value: t };
}

function normalizar(def, raw) {
  if (def.tipo === 'aliquota') return normalizarAliquota(raw);
  if (def.tipo === 'texto') return normalizarTexto(def, raw);
  return normalizarCodigo(def, raw);
}

/**
 * Le e valida os campos de NFS-e que vieram no corpo.
 * snake_case vence camelCase quando os dois vierem.
 * @returns {{ campos: Object<string, any>, presentes: boolean, erros: string[] }}
 *   campos = { coluna: valor normalizado } so com o que veio.
 */
function lerCamposNfse(body) {
  const b = body || {};
  const campos = {};
  const erros = [];
  for (const def of CAMPOS) {
    let raw;
    if (b[def.col] !== undefined) raw = b[def.col];
    else {
      const alias = def.aliases.find((a) => b[a] !== undefined);
      if (alias === undefined) continue;
      raw = b[alias];
    }
    const r = normalizar(def, raw);
    if (r.error) erros.push(r.error);
    else campos[def.col] = r.value;
  }
  return { campos, presentes: Object.keys(campos).length > 0, erros };
}

/** Campos de NFS-e da linha, prontos para a resposta (null quando nao ha valor ou a base nao tem a 437). */
function camposNfseDaLinha(row) {
  const r = row || {};
  const out = {};
  for (const col of COLUNAS) {
    const v = r[col];
    if (v === null || v === undefined || v === '') out[col] = null;
    else if (col === 'nfse_aliquota_iss') {
      const n = parseFloat(v);
      out[col] = Number.isFinite(n) ? n : null;
    } else out[col] = String(v);
  }
  return out;
}

module.exports = {
  CAMPOS, COLUNAS, COLUNAS_SELECT, lerCamposNfse, camposNfseDaLinha,
  normalizarAliquotaIss: normalizarAliquota,
};
