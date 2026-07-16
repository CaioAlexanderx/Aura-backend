// ============================================================
// AURA. — sefazSp/shadowDiff: diff estrutural entre o XML da emissão
// própria e o XML autorizado pelo gateway (S2.6 shadow-mode).
//
// Compara o que importa fiscalmente (não bytes): itens (NCM/CFOP/qCom/
// vUnCom/vProd/CSOSN-CST), totais (vProd/vDesc/vNF), pagamentos
// (tPag/vPag/indPag/vTroco), dest (CPF/CNPJ) e ide (mod/serie).
// Ignora o que DEVE divergir: chave, cNF, dhEmi, número, emitente
// (shadow roda com CNPJ/cert da empresa de teste), QR, assinatura.
// ============================================================
'use strict';

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_',
  removeNSPrefix: true, parseTagValue: false,
});

function toArray(x) { return x === undefined ? [] : (Array.isArray(x) ? x : [x]); }

function num(v) {
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Extrai a estrutura comparável de um XML de NFC-e (proc ou NFe puro). */
function buildComparable(xml) {
  const doc = parser.parse(xml);
  const infNFe = doc.nfeProc?.NFe?.infNFe || doc.NFe?.infNFe || doc.infNFe;
  if (!infNFe) throw new Error('shadowDiff: infNFe não encontrado no XML');

  const dets = toArray(infNFe.det).map((d) => {
    const icms = d.imposto?.ICMS || {};
    const icmsGroup = Object.values(icms)[0] || {};
    return {
      ncm: String(d.prod?.NCM ?? ''),
      cfop: String(d.prod?.CFOP ?? ''),
      qCom: num(d.prod?.qCom),
      vUnCom: num(d.prod?.vUnCom),
      vProd: num(d.prod?.vProd),
      vDesc: num(d.prod?.vDesc ?? 0),
      csosn: icmsGroup.CSOSN !== undefined ? String(icmsGroup.CSOSN) : null,
      cst: icmsGroup.CST !== undefined ? String(icmsGroup.CST) : null,
      orig: icmsGroup.orig !== undefined ? String(icmsGroup.orig) : null,
    };
  });

  const tot = infNFe.total?.ICMSTot || {};
  const pag = infNFe.pag || {};
  const detPag = toArray(pag.detPag).map((p) => ({
    tPag: String(p.tPag ?? ''),
    vPag: num(p.vPag),
    indPag: p.indPag !== undefined ? String(p.indPag) : '0',
  })).sort((a, b) => (a.tPag + a.vPag).localeCompare(b.tPag + b.vPag));

  return {
    mod: String(infNFe.ide?.mod ?? ''),
    serie: String(infNFe.ide?.serie ?? ''),
    tpAmb: String(infNFe.ide?.tpAmb ?? ''),
    crt: String(infNFe.emit?.CRT ?? ''),
    destDoc: infNFe.dest ? String(infNFe.dest.CPF || infNFe.dest.CNPJ || '') : null,
    itens: dets,
    totais: {
      vProd: num(tot.vProd), vDesc: num(tot.vDesc), vNF: num(tot.vNF),
      vICMS: num(tot.vICMS), vPIS: num(tot.vPIS), vCOFINS: num(tot.vCOFINS),
    },
    pagamentos: detPag,
    vTroco: num(pag.vTroco ?? 0),
  };
}

/**
 * Diff entre a nota própria e a do gateway.
 * @returns {{ igual: boolean, diffs: string[] }}
 */
function diffNotas(ownXml, gatewayXml, { ignoreSerie = false, ignoreTpAmb = true } = {}) {
  const a = buildComparable(ownXml);      // própria
  const b = buildComparable(gatewayXml);  // gateway (referência)
  const diffs = [];
  const cmp = (campo, va, vb) => {
    if (String(va) !== String(vb)) diffs.push(`${campo}: própria=${va} gateway=${vb}`);
  };

  cmp('ide.mod', a.mod, b.mod);
  if (!ignoreSerie) cmp('ide.serie', a.serie, b.serie);
  if (!ignoreTpAmb) cmp('ide.tpAmb', a.tpAmb, b.tpAmb);
  cmp('emit.CRT', a.crt, b.crt);
  cmp('dest.doc', a.destDoc, b.destDoc);

  if (a.itens.length !== b.itens.length) {
    diffs.push(`itens: própria=${a.itens.length} gateway=${b.itens.length}`);
  } else {
    a.itens.forEach((ia, i) => {
      const ib = b.itens[i];
      for (const k of ['ncm', 'cfop', 'qCom', 'vProd', 'vDesc', 'csosn', 'cst', 'orig']) {
        if (String(ia[k]) !== String(ib[k])) diffs.push(`det[${i + 1}].${k}: própria=${ia[k]} gateway=${ib[k]}`);
      }
    });
  }

  for (const k of Object.keys(a.totais)) {
    if (String(a.totais[k]) !== String(b.totais[k])) {
      diffs.push(`ICMSTot.${k}: própria=${a.totais[k]} gateway=${b.totais[k]}`);
    }
  }

  if (a.pagamentos.length !== b.pagamentos.length) {
    diffs.push(`pag: própria=${a.pagamentos.length} gateway=${b.pagamentos.length} formas`);
  } else {
    a.pagamentos.forEach((pa, i) => {
      const pb = b.pagamentos[i];
      for (const k of ['tPag', 'vPag', 'indPag']) {
        if (String(pa[k]) !== String(pb[k])) diffs.push(`pag[${i}].${k}: própria=${pa[k]} gateway=${pb[k]}`);
      }
    });
  }
  cmp('pag.vTroco', a.vTroco, b.vTroco);

  return { igual: diffs.length === 0, diffs };
}

module.exports = { buildComparable, diffNotas };
