// ============================================================
// AURA. — nfseNacional/conferenciaDps: a NFS-e devolvida pelo Sefin é
// mesmo da DPS que a Aura assinou? — função PURA.
//
// Por quê (incidente de 10/11/2026, produção): a loja já tinha emitido, por
// outro emissor, uma DPS com a MESMA série e o MESMO número que a Aura usou.
// O POST voltou E0014 ("Conjunto de Série, Número, Código do Município
// Emissor e CNPJ/CPF informado nesta DPS já existe em uma NFS-e gerada a
// partir de uma DPS enviada anteriormente"), a Aura consultou GET /dps/{Id},
// recebeu a NFS-e ANTIGA (outra data, outro valor, outro código) e a gravou
// como a nota da venda nova. O Id da DPS só tem município, CNPJ, série e
// número: Id igual não prova que a nota é nossa.
//
// Como confere (a NFS-e traz a DPS que a gerou, infNFSe/DPS, obrigatória no
// XSD NFSe_v1.01):
//   1. as duas DPS assinadas: o DigestValue da assinatura é o hash do
//      infDPS inteiro. Igual = a mesma DPS; diferente = outra DPS.
//   2. sem assinatura de um dos lados: campo a campo — Id, valor do serviço
//      (vServ), código de tributação nacional (cTribNac), data/hora de
//      emissão (dhEmi), competência (dCompet) e o documento do tomador.
//      Qualquer diferença = outra DPS. Faltou campo na devolvida para
//      conferir = 'indeterminado' (a nota não é adotada nem marcada).
// ============================================================
'use strict';

const { lerNfse, lerDps } = require('./nfseParser');

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function mesmoInstante(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb;
  return String(a).trim() === String(b).trim();
}

const CAMPOS = [
  { campo: 'id', ler: (d) => d.id, igual: (a, b) => a === b },
  { campo: 'vServ', ler: (d) => d.vServ, igual: (a, b) => Math.abs(Number(a) - Number(b)) < 0.005 },
  { campo: 'cTribNac', ler: (d) => d.cTribNac, igual: (a, b) => onlyDigits(a) === onlyDigits(b) },
  { campo: 'dhEmi', ler: (d) => d.dhEmi, igual: mesmoInstante },
  { campo: 'dCompet', ler: (d) => d.dCompet, igual: (a, b) => String(a).slice(0, 10) === String(b).slice(0, 10) },
];

/** Resumo sem dado pessoal (o documento do tomador fica de fora). */
function resumo(d) {
  if (!d) return null;
  return {
    id: d.id, serie: d.serie, nDPS: d.nDPS, dhEmi: d.dhEmi, dCompet: d.dCompet,
    cTribNac: d.cTribNac, vServ: d.vServ, verAplic: d.verAplic, assinada: !!d.digest,
  };
}

/**
 * @param {{ nfseXml: string, dpsXml: string }} p — dpsXml = a DPS assinada pela Aura (nfse.xml_dps)
 * @returns {{ resultado: 'igual'|'diferente'|'indeterminado', por: 'assinatura'|'campos'|null,
 *             divergencias: string[], faltando: string[], devolvida: object|null, nossa: object|null, nfse: object|null }}
 */
function conferirNfseComDps({ nfseXml, dpsXml }) {
  let nfse = null;
  let devolvida = null;
  let nossa = null;
  try { nfse = lerNfse(nfseXml); devolvida = nfse.dps; } catch (_) { /* ilegível */ }
  try { nossa = lerDps(dpsXml); } catch (_) { /* ilegível */ }
  const base = {
    devolvida: resumo(devolvida),
    nossa: resumo(nossa),
    nfse: nfse ? { chaveAcesso: nfse.chaveAcesso, nNFSe: nfse.nNFSe, dhProc: nfse.dhProc, verAplic: nfse.verAplic } : null,
  };
  if (!devolvida || !nossa) {
    return { resultado: 'indeterminado', por: null, divergencias: [], faltando: [!devolvida ? 'dps_devolvida' : 'dps_da_aura'], ...base };
  }

  const divergencias = [];
  const faltando = [];
  for (const c of CAMPOS) {
    const a = c.ler(nossa);
    const b = c.ler(devolvida);
    if (a == null || a === '') continue; // a Aura sempre preenche; só por segurança
    if (b == null || b === '') { faltando.push(c.campo); continue; }
    if (!c.igual(a, b)) divergencias.push(c.campo);
  }
  // tomador: se um dos lados tem, os dois precisam ter o mesmo documento
  const ta = onlyDigits(nossa.tomadorDoc);
  const tb = onlyDigits(devolvida.tomadorDoc);
  if ((ta || tb) && ta !== tb) divergencias.push('tomador');

  if (nossa.digest && devolvida.digest) {
    if (nossa.digest === devolvida.digest && nossa.id === devolvida.id) {
      return { resultado: 'igual', por: 'assinatura', divergencias: [], faltando: [], ...base };
    }
    return { resultado: 'diferente', por: 'assinatura', divergencias: ['assinatura', ...divergencias], faltando, ...base };
  }
  if (divergencias.length) return { resultado: 'diferente', por: 'campos', divergencias, faltando, ...base };
  if (faltando.length) return { resultado: 'indeterminado', por: 'campos', divergencias, faltando, ...base };
  return { resultado: 'igual', por: 'campos', divergencias, faltando, ...base };
}

module.exports = { conferirNfseComDps };
