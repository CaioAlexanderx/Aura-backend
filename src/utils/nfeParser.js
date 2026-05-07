// ============================================================
// AURA. — Parser NF-e XML determinístico (SEFAZ 4.00)
// Extraído de danfeImport.js para permitir testes unitários
// sem depender de HTTP ou banco.
// ============================================================

/**
 * Carrega fast-xml-parser de forma lazy.
 * Lança erro descritivo se a lib não estiver instalada.
 */
function getXMLParser() {
  try {
    return require('fast-xml-parser');
  } catch (e) {
    throw new Error('fast-xml-parser não instalado. Execute npm install no servidor.');
  }
}

/**
 * Converte decimal brasileiro ou americano para float.
 *
 * Regras:
 *   "1.234,56" → 1234.56  (ponto = milhar, vírgula = decimal)
 *   "76,1000"  → 76.1     (só vírgula = decimal)
 *   "76.1000"  → 76.1     (só ponto = decimal americano)
 *   número JS  → retorna direto via parseFloat
 *
 * @param {string|number|null|undefined} val
 * @returns {number}
 */
function parseBRFloat(val) {
  if (val === null || val === undefined) return 0;
  const s = String(val).trim();
  if (!s) return 0;
  // Tem ponto E vírgula: ponto é separador de milhar, vírgula é decimal
  if (s.includes(',') && s.includes('.')) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  }
  // Só vírgula: vírgula é decimal
  if (s.includes(',')) {
    return parseFloat(s.replace(',', '.')) || 0;
  }
  // Só ponto ou inteiro: padrão americano / sem separador
  return parseFloat(s) || 0;
}

/**
 * Parseia NF-e XML (padrão SEFAZ 4.00) deterministicamente.
 *
 * Lida com:
 *   - nfeProc/NFe/infNFe  (nota autorizada — formato mais comum)
 *   - NFe/infNFe           (raw, sem wrapper nfeProc)
 *   - Prefixos de namespace (nfe:NFe etc) → removidos pelo parser
 *   - <det> como objeto único ou array → sempre normaliza pra array
 *   - Decimal brasileiro em qCom/vUnCom/vNF
 *
 * Nota sobre CNPJ: fast-xml-parser com parseTagValue=true converte
 * strings numéricas para JS Number, o que descarta zeros à esquerda
 * (ex: 04883797000141 vira 4883797000141). Por isso aplicamos
 * padStart(14, '0') após extrair o CNPJ como string.
 *
 * @param {string} xmlString  Conteúdo bruto do arquivo .xml
 * @returns {{\
 *   supplier_name: string|null,
 *   supplier_cnpj: string|null,
 *   invoice_number: string|null,
 *   invoice_series: string|null,
 *   invoice_date: string|null,
 *   total_value: number,
 *   items: Array<{\
 *     idx: number,
 *     description: string,
 *     quantity: number,
 *     unit_cost: number,
 *     unit: string,
 *     ncm: string|null,
 *     supplier_code: string|null,
 *     ean: string|null
 *   }>
 * }}
 */
function parseNFeXML(xmlString) {
  const { XMLParser } = getXMLParser();

  const parser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    removeNSPrefix:      true,   // remove prefixos nfe:, nfeProc: etc
    isArray: (name) => name === 'det', // det sempre array, mesmo com 1 item
    parseTagValue:       true,
    trimValues:          true,
  });

  let obj;
  try {
    obj = parser.parse(xmlString);
  } catch (e) {
    throw new Error('XML inválido: ' + e.message);
  }

  // Localiza infNFe independente do wrapper (nfeProc ou raw)
  const nfe = obj.nfeProc?.NFe || obj.NFe || obj.nfeProc?.nfe || obj.nfe;
  if (!nfe) {
    throw new Error(
      'XML não reconhecido: elemento NFe não encontrado. ' +
      'Verifique se é um arquivo NF-e válido.'
    );
  }

  const infNFe = nfe.infNFe;
  if (!infNFe) {
    throw new Error('XML inválido: elemento infNFe não encontrado.');
  }

  // det é sempre array graças ao isArray acima
  const det = Array.isArray(infNFe.det) ? infNFe.det : [];
  if (det.length === 0) {
    throw new Error(
      'Nenhum item encontrado no XML. ' +
      'Verifique se a NF-e contém produtos.'
    );
  }

  const items = det
    .map((item, idx) => {
      const prod     = item.prod || {};
      const qCom     = parseBRFloat(prod.qCom);
      const vUnCom   = parseBRFloat(prod.vUnCom);
      const ncmRaw   = String(prod.NCM || '').replace(/\D/g, '');
      const eanRaw   = String(prod.cEAN || '').trim();
      const validEan = eanRaw && eanRaw !== 'SEM GTIN' && /^\d+$/.test(eanRaw)
        ? eanRaw
        : null;

      return {
        idx,
        description:   String(prod.xProd   || '').trim().slice(0, 200),
        quantity:      qCom,
        unit_cost:     vUnCom,
        unit:          String(prod.uCom    || 'un').trim().slice(0, 10),
        ncm:           /^\d{8}$/.test(ncmRaw) ? ncmRaw : null,
        supplier_code: prod.cProd ? String(prod.cProd).trim().slice(0, 50) : null,
        ean:           validEan,
      };
    })
    .filter(it => it.description && it.quantity > 0);

  // Data de emissão: dhEmi (com hora) ou dEmi (só data)
  let invoiceDate = null;
  const rawDate = infNFe.ide?.dhEmi || infNFe.ide?.dEmi;
  if (rawDate) {
    invoiceDate = String(rawDate).split('T')[0]; // "2026-04-30"
  }

  // CNPJ: fast-xml-parser pode converter para Number descartando zeros
  // à esquerda. Forçamos string e aplicamos padStart(14) para garantir
  // o formato correto (ex: "04883797000141" em vez de "4883797000141").
  const rawCnpj = String(infNFe.emit?.CNPJ || '').replace(/\D/g, '');

  return {
    supplier_name:  String(infNFe.emit?.xNome || infNFe.emit?.xFant || '').trim() || null,
    supplier_cnpj:  rawCnpj ? rawCnpj.padStart(14, '0') : null,
    invoice_number: String(infNFe.ide?.nNF    || '').trim() || null,
    invoice_series: String(infNFe.ide?.serie  || '').trim() || null,
    invoice_date:   invoiceDate,
    total_value:    parseBRFloat(infNFe.total?.ICMSTot?.vNF),
    items,
  };
}

module.exports = { parseNFeXML, parseBRFloat };
