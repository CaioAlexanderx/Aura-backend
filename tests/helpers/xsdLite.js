// ============================================================
// AURA. — tests/helpers/xsdLite: validador XSD ENXUTO, em JS puro, para
// os esquemas OFICIAIS da NFS-e Nacional (schemas/NFSe_v1.01 e
// schemas/NFSe_v1.01_PRODREST_20261020).
//
// Por que existe: o CI não tem xmllint (as suítes xsdValidation*.test.js da
// NFC-e/NF-e são PULADAS lá). Este validador lê os .xsd oficiais e confere
// o que esses esquemas usam: xs:sequence / xs:choice com minOccurs/
// maxOccurs, elementos globais, tipos nomeados ou anônimos, atributos
// obrigatórios e as facetas de tipo simples (enumeration, pattern,
// minLength, maxLength, length) ao longo da cadeia de restrição.
// ds:Signature é só conferida como presente (o conteúdo é do xmldsig).
//
// NÃO é um validador XSD completo (sem xs:all, grupos, unions, listas,
// complexContent) — esses esquemas não usam nada disso (checado no teste).
// Padrões XSD viram RegExp ancorada ^(?:...)$, como manda a spec.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

const XS = 'http://www.w3.org/2001/XMLSchema';

const elems = (node) => {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
  return out;
};
const xsKids = (node, local) => elems(node).filter((c) => c.namespaceURI === XS && (!local || c.localName === local));
const strip = (qname) => String(qname || '').replace(/^[A-Za-z]+:/, '');
const isDs = (qname) => /^ds:/.test(String(qname || ''));

function loadSchemas(dir, files) {
  const complex = new Map();
  const simple = new Map();
  const elements = new Map();
  for (const f of files) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '');
    const doc = new DOMParser().parseFromString(txt, 'text/xml');
    const schema = doc.documentElement;
    for (const n of elems(schema)) {
      if (n.namespaceURI !== XS) continue;
      const name = n.getAttribute('name');
      if (n.localName === 'complexType') complex.set(name, n);
      else if (n.localName === 'simpleType') simple.set(name, n);
      else if (n.localName === 'element') elements.set(name, n);
    }
  }
  return { complex, simple, elements };
}

function occurs(n) {
  const min = n.hasAttribute('minOccurs') ? Number(n.getAttribute('minOccurs')) : 1;
  const maxA = n.getAttribute('maxOccurs');
  const max = !maxA ? 1 : maxA === 'unbounded' ? Infinity : Number(maxA);
  return { min, max };
}

function textOf(el) {
  let t = '';
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3 || c.nodeType === 4) t += c.nodeValue;
  }
  return t;
}

function createValidator(dir, files) {
  const S = loadSchemas(dir, files);

  function checkSimple(typeRef, value, where, errors) {
    let node = typeRef;
    if (typeof typeRef === 'string') {
      if (/^xs:/.test(typeRef)) return; // tipo nativo: xs:string etc.
      node = S.simple.get(strip(typeRef));
      if (!node) { errors.push(`${where}: tipo simples ${typeRef} não encontrado`); return; }
    }
    const r = xsKids(node, 'restriction')[0];
    if (!r) { errors.push(`${where}: tipo simples sem restriction`); return; }
    const base = r.getAttribute('base');
    if (base) checkSimple(base, value, where, errors);
    const enums = xsKids(r, 'enumeration').map((e) => e.getAttribute('value'));
    if (enums.length && !enums.includes(value)) errors.push(`${where}: "${value}" fora da enumeração [${enums.join(', ')}]`);
    const pats = xsKids(r, 'pattern').map((p) => p.getAttribute('value'));
    if (pats.length && !pats.some((p) => new RegExp(`^(?:${p})$`).test(value))) {
      errors.push(`${where}: "${value}" não casa com o padrão ${pats.join(' | ')}`);
    }
    const len = [...value].length;
    for (const f of xsKids(r)) {
      const v = Number(f.getAttribute('value'));
      if (f.localName === 'minLength' && len < v) errors.push(`${where}: tamanho ${len} < minLength ${v}`);
      if (f.localName === 'maxLength' && len > v) errors.push(`${where}: tamanho ${len} > maxLength ${v}`);
      if (f.localName === 'length' && len !== v) errors.push(`${where}: tamanho ${len} ≠ length ${v}`);
    }
  }

  function particleName(p) {
    return p.getAttribute('name') || strip(p.getAttribute('ref'));
  }

  // devolve o novo índice; erros de estrutura lançam
  function match(p, kids, i, where, errors) {
    const { min, max } = occurs(p);
    if (p.localName === 'element') {
      const name = particleName(p);
      let n = 0;
      while (n < max && kids[i] && kids[i].localName === name) {
        validateElement(kids[i], p, `${where}/${name}`, errors);
        i++; n++;
      }
      if (n < min) throw new Error(`${where}: faltou <${name}>${kids[i] ? ` (veio <${kids[i].localName}>)` : ''}`);
      return i;
    }
    if (p.localName === 'sequence' || p.localName === 'choice') {
      let occ = 0;
      while (occ < max) {
        const start = i;
        try {
          if (p.localName === 'sequence') {
            for (const c of xsKids(p)) i = match(c, kids, i, where, errors);
          } else {
            let ok = false;
            for (const c of xsKids(p)) {
              const errsAntes = errors.length;
              try {
                const j = match(c, kids, i, where, errors);
                if (j > i) { i = j; ok = true; break; }
                errors.length = errsAntes;
              } catch (_) { errors.length = errsAntes; }
            }
            if (!ok) {
              const vazio = xsKids(p).some((c) => occurs(c).min === 0);
              if (!vazio) throw new Error(`${where}: nenhuma opção do xs:choice casou${kids[i] ? ` com <${kids[i].localName}>` : ''}`);
            }
          }
        } catch (e) {
          if (occ >= min) { i = start; break; }
          throw e;
        }
        if (i === start) break;
        occ++;
      }
      return i;
    }
    throw new Error(`${where}: partícula xs:${p.localName} não suportada pelo xsdLite`);
  }

  function validateComplex(el, ct, where, errors) {
    for (const a of xsKids(ct, 'attribute')) {
      const name = a.getAttribute('name');
      const has = el.hasAttribute(name);
      if (a.getAttribute('use') === 'required' && !has) errors.push(`${where}: atributo obrigatório ${name} ausente`);
      if (has && a.getAttribute('type')) checkSimple(a.getAttribute('type'), el.getAttribute(name), `${where}@${name}`, errors);
    }
    const particle = xsKids(ct).find((c) => c.localName === 'sequence' || c.localName === 'choice');
    const kids = elems(el);
    if (!particle) {
      if (kids.length) errors.push(`${where}: não esperava filhos`);
      return;
    }
    try {
      const i = match(particle, kids, 0, where, errors);
      if (i < kids.length) errors.push(`${where}: elemento inesperado <${kids[i].localName}>`);
    } catch (e) {
      errors.push(e.message);
    }
  }

  function validateElement(el, decl, where, errors) {
    if (isDs(decl.getAttribute('ref'))) return; // ds:Signature: só a presença
    const type = decl.getAttribute('type');
    const inlineC = xsKids(decl, 'complexType')[0];
    const inlineS = xsKids(decl, 'simpleType')[0];
    if (inlineC) return validateComplex(el, inlineC, where, errors);
    if (inlineS) return checkSimple(inlineS, textOf(el), where, errors);
    if (!type) return;
    const ct = S.complex.get(strip(type));
    if (ct) return validateComplex(el, ct, where, errors);
    if (elems(el).length) { errors.push(`${where}: tipo simples com filhos`); return; }
    checkSimple(type, textOf(el), where, errors);
  }

  /** @returns {string[]} erros (vazio = válido) */
  function validate(xml, { rootNamespace } = {}) {
    const errors = [];
    const doc = new DOMParser({ onError: (lvl, msg) => { if (lvl !== 'warning') errors.push(`XML mal formado: ${msg}`); } })
      .parseFromString(String(xml), 'text/xml');
    const root = doc.documentElement;
    if (!root) return ['documento vazio'];
    if (rootNamespace && root.namespaceURI !== rootNamespace) errors.push(`namespace da raiz ${root.namespaceURI} ≠ ${rootNamespace}`);
    const decl = S.elements.get(root.localName);
    if (!decl) return [`elemento raiz <${root.localName}> não é global no esquema`];
    validateElement(root, decl, root.localName, errors);
    return errors;
  }

  return { validate, schemas: S };
}

module.exports = { createValidator };
