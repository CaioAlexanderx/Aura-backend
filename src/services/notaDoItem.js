// ============================================================
// AURA. — Em que nota o item sai: NFC-e ou NFS-e (migration 442)
//
// Ate a 442, "vai para a NFS-e" era sinonimo de products.unit = 'srv'.
// Decisao do dono (10/11/2026): a NOTA e separada do TIPO do item. Uma
// grafica vende carimbo sob encomenda: e ISS (NFS-e), mas a mecanica do
// carimbo e peca que precisa de estoque. Coluna products.nota_fiscal:
//   'nfse' -> nota de servico; 'nfce' -> cupom fiscal;
//   NULL   -> segue o tipo, como sempre foi (srv na NFS-e, o resto na NFC-e).
//
// UM predicado so para o backend inteiro decidir a nota. Quem decide a nota
// pelo `unit === 'srv'` direto esta errado — use vaiNaNfse/vaiNaNfce.
// A baixa de estoque NAO passa por aqui: continua pelo tipo do item.
//
// Espelho no app: utils/notaDoItem.ts (mesma regra).
// ============================================================
'use strict';

const NOTAS = ['nfce', 'nfse'];

function ehUnidadeServico(unit) {
  return String(unit == null ? '' : unit).trim().toLowerCase() === 'srv';
}

/** 'nfce' | 'nfse' | null — qualquer outro valor conta como nao escolhido (null). */
function notaEscolhida(item) {
  const v = item ? item.nota_fiscal : null;
  return v === 'nfce' || v === 'nfse' ? v : null;
}

/** O item sai na NFS-e: escolheu NFS-e, ou nao escolheu e e servico (unit 'srv'). */
function vaiNaNfse(item) {
  const nota = notaEscolhida(item);
  if (nota) return nota === 'nfse';
  return ehUnidadeServico(item && item.unit);
}

/** O inverso: o item sai na NFC-e (cupom fiscal / NF-e da venda). */
function vaiNaNfce(item) {
  return !vaiNaNfse(item);
}

const MSG_NOTA = 'O campo "Sai em" aceita só Cupom fiscal (NFC-e) ou Nota de serviço (NFS-e). Confira e tente de novo.';

/**
 * Le `nota_fiscal` (ou `notaFiscal`) do corpo do POST/PATCH de produto.
 * undefined = nao veio (nao mexe); null ou '' = limpa (volta a seguir o
 * tipo). Aceita 'NFC-e'/'NFS-e' e caixa alta. Outro valor = erro 400.
 * @returns {{ presente: boolean, value?: 'nfce'|'nfse'|null, erro?: string }}
 */
function lerNotaFiscal(body) {
  const b = body || {};
  let raw;
  if (b.nota_fiscal !== undefined) raw = b.nota_fiscal;
  else if (b.notaFiscal !== undefined) raw = b.notaFiscal;
  else return { presente: false };
  if (raw === null) return { presente: true, value: null };
  if (typeof raw !== 'string') return { presente: true, erro: MSG_NOTA };
  const limpo = raw.trim().toLowerCase().replace(/[\s\-_.]/g, '');
  if (limpo === '') return { presente: true, value: null };
  if (!NOTAS.includes(limpo)) return { presente: true, erro: MSG_NOTA };
  return { presente: true, value: limpo };
}

/** Para a resposta: 'nfce' | 'nfse' | null (null tambem para base sem a 442). */
function notaFiscalOut(v) {
  return v === 'nfce' || v === 'nfse' ? v : null;
}

module.exports = {
  NOTAS, MSG_NOTA, ehUnidadeServico, notaEscolhida, vaiNaNfse, vaiNaNfce, lerNotaFiscal, notaFiscalOut,
};
