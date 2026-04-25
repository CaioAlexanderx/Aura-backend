// ============================================================
// AURA. — W2-02 F3+F4: Gerador XML TISS 4.01.00
//
// Conforme padrao ANS publicado (2024+):
//   https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-tiss
//
// 4 tipos de guia suportados:
//   - consulta     -> guiaConsulta
//   - sp_sadt      -> guiaSP-SADT (servicos profissionais / auxilio diagnostico)
//   - honorario    -> guiaHonorarioIndividual
//   - internacao   -> guiaSolicitacaoInternacao + guiaResumoInternacao
//
// Estrutura do envelope (envio em lote):
//   <ans:mensagemTISS>
//     <ans:cabecalho>...</ans:cabecalho>
//     <ans:prestadorParaOperadora>
//       <ans:loteGuias>
//         <ans:numeroLote>...</ans:numeroLote>
//         <ans:guiasTISS>
//           <ans:guiaConsulta>...</ans:guiaConsulta> (multiplas)
//         </ans:guiasTISS>
//       </ans:loteGuias>
//     </ans:prestadorParaOperadora>
//     <ans:epilogo>
//       <ans:hash>md5</ans:hash>
//     </ans:epilogo>
//   </ans:mensagemTISS>
//
// IMPORTANTE: O hash MD5 e calculado SOBRE o XML SEM os espacos
// em branco, conforme RegExp do XSD ANS. Implementacao abaixo.
//
// ATENCAO: cada operadora pode ter peculiaridades nao documentadas
// no XSD oficial. Este gerador segue ESTRITAMENTE o padrao ANS.
// Se uma operadora rejeitar, ajuste por operadora via campo
// dental_insurance.xml_namespace ou flags futuras.
// ============================================================

const crypto = require('crypto');

const TISS_VERSION   = '4.01.00';
const ANS_NAMESPACE  = 'http://www.ans.gov.br/padroes/tiss/schemas';
const XSI_NAMESPACE  = 'http://www.w3.org/2001/XMLSchema-instance';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Serializa em padrao TISS: tags ans: + indentacao opcional
function tag(name, value, opts = {}) {
  if (value === null || value === undefined || value === '') {
    if (opts.optional) return '';
    return `<ans:${name}/>`;
  }
  return `<ans:${name}>${escapeXml(value)}</ans:${name}>`;
}

function el(name, children) {
  if (!children) return '';
  return `<ans:${name}>${children}</ans:${name}>`;
}

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') {
    // YYYY-MM-DD ou ISO
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.substring(0, 10);
    return new Date(d).toISOString().substring(0, 10);
  }
  return new Date(d).toISOString().substring(0, 10);
}

function fmtTime(t) {
  if (!t) return '';
  if (typeof t === 'string') {
    // HH:MM:SS ou HH:MM
    const m = t.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return `${m[1]}:${m[2]}:${m[3] || '00'}`;
  }
  return '';
}

function fmtMoney(v) {
  const n = parseFloat(v) || 0;
  return n.toFixed(2);
}

function onlyDigits(s) {
  return (s || '').toString().replace(/\D/g, '');
}

// Hash conforme XSD ANS: md5 sobre XML sem espacos em branco
function calculateHash(xmlContent) {
  const stripped = xmlContent.replace(/>\s+</g, '><').trim();
  return crypto.createHash('md5').update(stripped, 'utf8').digest('hex');
}

// Sequencia de guia (1..N) dentro do lote
function guideSequence(idx) {
  return String(idx + 1).padStart(8, '0');
}

// ─────────────────────────────────────────────────────────
// Validacao basica antes de gerar
// ─────────────────────────────────────────────────────────

function validateGuide(guide, insurance, company) {
  const errors = [];

  if (!guide.guide_type) errors.push('guide_type obrigatorio');
  if (!['consulta', 'sp_sadt', 'honorario', 'internacao'].includes(guide.guide_type)) {
    errors.push(`guide_type invalido: ${guide.guide_type}`);
  }
  if (!guide.card_number) errors.push('card_number (carteirinha) obrigatorio');
  if (!guide.guide_number) errors.push('guide_number obrigatorio');
  if (!guide.service_date) errors.push('service_date obrigatorio');
  if (!Array.isArray(guide.procedures) || guide.procedures.length === 0) {
    errors.push('procedures vazio');
  }
  if (!guide.professional_cro) errors.push('professional_cro obrigatorio');

  if (!insurance.ans_code && !insurance.cnpj) {
    errors.push('Convenio sem ans_code nem cnpj');
  }
  if (!insurance.razao_social && !insurance.name) {
    errors.push('Convenio sem razao_social');
  }
  if (!insurance.provider_code) errors.push('provider_code (codigo prestador no convenio) obrigatorio');

  if (!company.cnpj) errors.push('CNPJ da clinica obrigatorio');

  // Internacao tem campos extras
  if (guide.guide_type === 'internacao') {
    if (!guide.hospital_admission_at) errors.push('hospital_admission_at obrigatorio em internacao');
    if (!guide.hospital_regime) errors.push('hospital_regime obrigatorio em internacao');
    if (!guide.cid_code) errors.push('cid_code obrigatorio em internacao');
  }

  return errors;
}

// ─────────────────────────────────────────────────────────
// Cabecalho do XML
// ─────────────────────────────────────────────────────────

function buildCabecalho(opts) {
  const dataRegistro = fmtDate(new Date());
  const horaRegistro = new Date().toTimeString().substring(0, 8);

  return el('cabecalho', [
    el('identificacaoTransacao', [
      tag('tipoTransacao', 'ENVIO_LOTE_GUIAS'),
      tag('sequencialTransacao', opts.sequencial),
      tag('dataRegistroTransacao', dataRegistro),
      tag('horaRegistroTransacao', horaRegistro),
    ].join('')),
    el('origem', el('identificacaoPrestador', tag('CNPJ', onlyDigits(opts.companyCnpj)))),
    el('destino', tag('registroANS', opts.ansCode || '000000')),
    tag('Padrao', TISS_VERSION),
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// Identificacao da operadora (usado em todas as guias)
// ─────────────────────────────────────────────────────────

function buildIdentOperadora(insurance) {
  return el('dadosOperadora', [
    tag('registroANS', insurance.ans_code || '000000'),
    tag('numeroGuiaPrestador', insurance.guide_number || ''), // overridden por guia
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// Beneficiario (paciente)
// ─────────────────────────────────────────────────────────

function buildBeneficiario(guide, customer) {
  return el('dadosBeneficiario', [
    tag('numeroCarteira', guide.card_number),
    tag('atendimentoRN', 'N'),
    guide.card_valid_until ? tag('dataValidadeCarteira', fmtDate(guide.card_valid_until)) : '',
    tag('nomeBeneficiario', (customer?.full_name || customer?.name || guide.holder_name || '').toUpperCase()),
    customer?.cpf ? tag('numeroCPF', onlyDigits(customer.cpf)) : '',
    customer?.cns ? tag('cns', customer.cns) : '',
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// Contratado executante (a clinica)
// ─────────────────────────────────────────────────────────

function buildContratadoExecutante(insurance, company) {
  return el('contratadoExecutante', [
    el('contratadoCodigo', [
      tag('codigoPrestadorNaOperadora', insurance.provider_code),
    ].join('')),
    tag('nomeContratado', (company.legal_name || company.trade_name || '').toUpperCase()),
    tag('CNES', company.cnes || ''),
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// Profissional executante
// ─────────────────────────────────────────────────────────

function buildProfissionalExecutante(guide) {
  return el('profissionalExecutante', [
    el('codProfissional', [
      el('codigoPrestadorNaOperadora', guide.professional_provider_code || ''),
    ].join('')),
    tag('nomeProfissional', (guide.professional_name || '').toUpperCase()),
    el('conselhoProfissional', tag('codigoConselho', guide.professional_council || 'CRO')),
    tag('numeroConselhoProfissional', guide.professional_cro),
    tag('UF', guide.professional_council_uf || 'SP'),
    tag('CBOS', guide.professional_cbo || '223208'), // 223208 = Cirurgião-Dentista
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// Procedimento executado (para SP/SADT, internacao)
// ─────────────────────────────────────────────────────────

function buildProcedimentoExecutado(p, idx) {
  return el('procedimentoExecutado', [
    tag('sequencialItem', String(idx + 1).padStart(2, '0')),
    tag('dataExecucao', fmtDate(p.execution_date || p.service_date || new Date())),
    p.start_time ? tag('horaInicial', fmtTime(p.start_time)) : '',
    p.end_time ? tag('horaFinal', fmtTime(p.end_time)) : '',
    el('procedimento', [
      tag('codigoTabela', p.table_id || '22'),
      tag('codigoProcedimento', p.tuss_code),
      tag('descricaoProcedimento', p.description || ''),
    ].join('')),
    tag('quantidadeExecutada', String(p.quantity || 1).padStart(3, '0')),
    p.tooth ? tag('identDente', String(p.tooth)) : '',
    p.region ? tag('codRegiao', p.region) : '',
    p.face ? tag('denteFace', p.face) : '',
    tag('viaAcesso', p.access_route || 'U'),
    tag('tecnicaUtilizada', p.technique || 'C'),
    tag('reducaoAcrescimo', '1.00'),
    tag('valorUnitario', fmtMoney(p.unit_value || p.value)),
    tag('valorTotal', fmtMoney((p.unit_value || p.value) * (p.quantity || 1))),
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// 1. GUIA DE CONSULTA
// ─────────────────────────────────────────────────────────

function buildGuiaConsulta(guide, customer, insurance, company) {
  const proc = guide.procedures[0] || {};
  const totalValue = fmtMoney(guide.total_value);

  return el('guiaConsulta', [
    el('cabecalhoConsulta', [
      el('registroANS', insurance.ans_code || ''),
      tag('numeroGuiaPrestador', guide.guide_number),
      guide.auth_number ? tag('numeroGuiaOperadora', guide.auth_number) : '',
    ].join('')),

    buildBeneficiario(guide, customer),
    buildContratadoExecutante(insurance, company),
    buildProfissionalExecutante(guide),

    el('dadosAtendimento', [
      tag('indicacaoAcidente', guide.accident_indication === 'trabalho' ? '1' :
                               guide.accident_indication === 'transito' ? '2' :
                               guide.accident_indication === 'outros'   ? '3' : '9'),
      tag('coberturaEspecial', '0'),
      tag('regimeAtendimento', guide.attendance_type === 'hospitalar' ? '2' : '1'),
      tag('saudeOcupacional', '5'),
      tag('tipoConsulta', proc.consultation_type || '1'), // 1=Primeira, 2=Retorno, 3=Pre-natal, 4=Por encaminhamento
      tag('tipoSaida', '1'),
      el('procedimento', [
        tag('codigoTabela', proc.table_id || '22'),
        tag('codigoProcedimento', proc.tuss_code || '10101012'), // consulta odontologica padrao
        tag('descricaoProcedimento', proc.description || 'Consulta'),
      ].join('')),
      tag('valorConsulta', totalValue),
    ].join('')),

    el('observacao', escapeXml(guide.notes || '')),
    tag('valorTotal', totalValue),
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// 2. GUIA SP/SADT (Servicos Profissionais / Auxilio Diagnostico)
//    Usada pra MAIORIA dos procedimentos odontologicos
//    (restauracao, endodontia, cirurgia, protese, etc)
// ─────────────────────────────────────────────────────────

function buildGuiaSpSadt(guide, customer, insurance, company) {
  const procedimentos = guide.procedures.map((p, idx) => buildProcedimentoExecutado(p, idx)).join('');

  return el('guiaSP-SADT', [
    el('cabecalhoSADT', [
      el('registroANS', insurance.ans_code || ''),
      tag('numeroGuiaPrestador', guide.guide_number),
      guide.auth_number ? tag('numeroGuiaOperadora', guide.auth_number) : '',
      guide.auth_number ? tag('guiaSolicitacaoInternacao', '') : '',
    ].join('')),

    el('dadosAutorizacao', [
      guide.auth_number ? tag('numeroGuiaOperadora', guide.auth_number) : '',
      guide.auth_number ? tag('dataAutorizacao', fmtDate(guide.created_at || new Date())) : '',
      guide.auth_password ? tag('senha', guide.auth_password) : '',
      guide.auth_validity ? tag('dataValidadeSenha', fmtDate(guide.auth_validity)) : '',
    ].filter(Boolean).join('')),

    buildBeneficiario(guide, customer),

    el('dadosSolicitante', [
      buildContratadoExecutante(insurance, company),
      el('profissionalSolicitante', [
        tag('nomeProfissional', (guide.professional_name || '').toUpperCase()),
        el('conselhoProfissional', tag('codigoConselho', guide.professional_council || 'CRO')),
        tag('numeroConselhoProfissional', guide.professional_cro),
        tag('UF', guide.professional_council_uf || 'SP'),
        tag('CBOS', guide.professional_cbo || '223208'),
      ].join('')),
    ].join('')),

    el('dadosSolicitacao', [
      tag('dataSolicitacao', fmtDate(guide.service_date)),
      tag('caraterAtendimento', '1'), // 1=eletivo, 2=urgencia
      tag('indicacaoClinica', guide.clinical_indication || '-'),
    ].join('')),

    el('dadosExecutante', buildContratadoExecutante(insurance, company)),

    el('dadosAtendimento', [
      tag('tipoAtendimento', '05'), // 05=tratamento clinico
      tag('indicacaoAcidente', guide.accident_indication === 'trabalho' ? '1' :
                               guide.accident_indication === 'transito' ? '2' :
                               guide.accident_indication === 'outros'   ? '3' : '9'),
      tag('tipoConsulta', '1'),
      tag('motivoEncerramento', '11'), // 11=alta curado
    ].join('')),

    el('procedimentosExecutados', procedimentos),

    el('valorTotal', [
      tag('valorProcedimentos', fmtMoney(guide.total_value)),
      tag('valorDiarias', '0.00'),
      tag('valorTaxasAlugueis', '0.00'),
      tag('valorMateriais', '0.00'),
      tag('valorMedicamentos', '0.00'),
      tag('valorOPME', '0.00'),
      tag('valorGasesMedicinais', '0.00'),
      tag('valorTotalGeral', fmtMoney(guide.total_value)),
    ].join('')),
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// 3. GUIA HONORARIO INDIVIDUAL
//    Pra equipe medica multidisciplinar (cada profissional emite)
// ─────────────────────────────────────────────────────────

function buildGuiaHonorario(guide, customer, insurance, company) {
  const procedimentos = guide.procedures.map((p, idx) => buildProcedimentoExecutado(p, idx)).join('');

  return el('guiaHonorarioIndividual', [
    el('cabecalhoGuia', [
      el('registroANS', insurance.ans_code || ''),
      tag('numeroGuiaPrestador', guide.guide_number),
      guide.auth_number ? tag('numeroGuiaOperadora', guide.auth_number) : '',
    ].join('')),

    el('dadosAutorizacao', [
      tag('numeroGuiaSolicitacaoInternacao', guide.referral_guide_number || ''),
      tag('numeroGuiaOperadoraPrincipal', guide.auth_number || ''),
      guide.auth_password ? tag('senha', guide.auth_password) : '',
      tag('dataAutorizacao', fmtDate(guide.created_at || new Date())),
    ].filter(Boolean).join('')),

    buildBeneficiario(guide, customer),

    el('dadosExecutante', buildContratadoExecutante(insurance, company)),

    el('dadosInternacao', [
      tag('dataInicioFaturamento', fmtDate(guide.service_date)),
      tag('dataFinalFaturamento', fmtDate(guide.service_end_date || guide.service_date)),
    ].join('')),

    el('procedimentosExecutados', procedimentos),

    el('valorTotal', [
      tag('valorProcedimentos', fmtMoney(guide.total_value)),
      tag('valorTotalGeral', fmtMoney(guide.total_value)),
    ].join('')),
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// 4. GUIA SOLICITACAO DE INTERNACAO
// ─────────────────────────────────────────────────────────

function buildGuiaInternacao(guide, customer, insurance, company) {
  return el('guiaSolicitacaoInternacao', [
    el('cabecalhoSolicitacao', [
      el('registroANS', insurance.ans_code || ''),
      tag('numeroGuiaPrestador', guide.guide_number),
    ].join('')),

    buildBeneficiario(guide, customer),

    el('dadosSolicitante', [
      buildContratadoExecutante(insurance, company),
      buildProfissionalExecutante(guide),
    ].join('')),

    el('dadosInternacao', [
      tag('caraterAtendimento', '1'), // 1=eletiva, 2=urgencia
      tag('tipoInternacao', '4'), // 4=odontologica
      tag('regimeInternacao',
          guide.hospital_regime === 'hospital_dia' ? '2' :
          guide.hospital_regime === 'domiciliar'    ? '3' : '1'),
      el('quantidadeDiariasSolicitadas', String(guide.days_requested || 1)),
      tag('indicacaoClinica', guide.clinical_indication),
    ].join('')),

    el('dadosCID10', [
      tag('CID-10-Principal', guide.cid_code),
    ].join('')),
  ].join(''));
}

// ─────────────────────────────────────────────────────────
// Dispatcher: gera o XML de UMA guia (tag externa por tipo)
// ─────────────────────────────────────────────────────────

function buildSingleGuide(guide, customer, insurance, company) {
  switch (guide.guide_type) {
    case 'consulta':   return buildGuiaConsulta(guide, customer, insurance, company);
    case 'sp_sadt':    return buildGuiaSpSadt(guide, customer, insurance, company);
    case 'honorario':  return buildGuiaHonorario(guide, customer, insurance, company);
    case 'internacao': return buildGuiaInternacao(guide, customer, insurance, company);
    default:
      throw new Error(`Tipo de guia nao suportado: ${guide.guide_type}`);
  }
}

// ─────────────────────────────────────────────────────────
// Build de lote (varias guias) — formato de envio em massa
// ─────────────────────────────────────────────────────────

function buildBatchXml(opts) {
  const { batch, guides, insurance, company } = opts;

  if (!guides || guides.length === 0) {
    throw new Error('Lote sem guias');
  }

  // Validar todas as guias
  for (const g of guides) {
    const errs = validateGuide(g.guide, insurance, company);
    if (errs.length > 0) {
      throw new Error(`Guia ${g.guide.guide_number} invalida: ${errs.join('; ')}`);
    }
  }

  const sequencial = String(Date.now()).slice(-12);

  const guiasXml = guides.map(g =>
    buildSingleGuide(g.guide, g.customer, insurance, company)
  ).join('');

  const cabecalho = buildCabecalho({
    sequencial,
    companyCnpj: company.cnpj,
    ansCode:     insurance.ans_code,
  });

  const lote = el('prestadorParaOperadora', el('loteGuias', [
    tag('numeroLote', batch.batch_number),
    el('guiasTISS', guiasXml),
  ].join('')));

  // Monta sem hash pra calcular
  const bodyXml = cabecalho + lote;

  // Hash sobre o XML SEM espacos em branco
  const fullForHash = bodyXml + el('epilogo', tag('hash', '00000000000000000000000000000000'));
  const hash = calculateHash(fullForHash);

  const epilogo = el('epilogo', tag('hash', hash));

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ans:mensagemTISS xmlns:ans="${ANS_NAMESPACE}" ` +
    `xmlns:xsi="${XSI_NAMESPACE}" ` +
    `xsi:schemaLocation="${ANS_NAMESPACE} http://www.ans.gov.br/padroes/tiss/schemas/tissV4_01_00.xsd">\n` +
    bodyXml + epilogo +
    `\n</ans:mensagemTISS>`;

  return { xml, hash, sequencial, totalGuias: guides.length };
}

// ─────────────────────────────────────────────────────────
// Build de UMA guia (envelope minimo, util pra preview/teste)
// ─────────────────────────────────────────────────────────

function buildSingleGuideXml(guide, customer, insurance, company) {
  const errs = validateGuide(guide, insurance, company);
  if (errs.length > 0) {
    throw new Error(`Guia invalida: ${errs.join('; ')}`);
  }
  return buildSingleGuide(guide, customer, insurance, company);
}

// ============================================================
// PARSER DE RETORNO (DemonstrativoPagamento)
//
// Quando a operadora processa o lote, devolve um XML de retorno
// com o status de cada guia + valores pagos + glosas.
// Este parser le esse XML e atualiza as guias correspondentes.
//
// Formato simplificado do XML de retorno:
//   <ans:mensagemTISS>
//     <ans:operadoraParaPrestador>
//       <ans:demonstrativoPagamento>
//         <ans:numeroProtocolo>...</ans:numeroProtocolo>
//         <ans:guiaProcessada>
//           <ans:numeroGuiaPrestador>GTO-000001</ans:numeroGuiaPrestador>
//           <ans:valorProcessado>...</ans:valorProcessado>
//           <ans:valorPago>...</ans:valorPago>
//           <ans:valorGlosa>...</ans:valorGlosa>
//           <ans:glosa>
//             <ans:codigoGlosa>1001</ans:codigoGlosa>
//             <ans:valorGlosa>...</ans:valorGlosa>
//           </ans:glosa>
//         </ans:guiaProcessada>
//       </ans:demonstrativoPagamento>
//     </ans:operadoraParaPrestador>
//   </ans:mensagemTISS>
// ============================================================

function parseReturnXml(xmlString) {
  // Parser minimalista — sem dependencias externas (regex)
  // Em producao real, considerar `fast-xml-parser` se ficar complexo.

  const result = {
    protocol: null,
    processedAt: null,
    guides: [],
    errors: [],
  };

  try {
    const protocolMatch = xmlString.match(/<ans:numeroProtocolo>([^<]+)<\/ans:numeroProtocolo>/);
    if (protocolMatch) result.protocol = protocolMatch[1].trim();

    const dateMatch = xmlString.match(/<ans:dataProcessamento>([^<]+)<\/ans:dataProcessamento>/);
    if (dateMatch) result.processedAt = dateMatch[1].trim();

    // Extrair cada guiaProcessada
    const guideRegex = /<ans:guiaProcessada>([\s\S]*?)<\/ans:guiaProcessada>/g;
    let match;
    while ((match = guideRegex.exec(xmlString)) !== null) {
      const block = match[1];

      const guide = {
        guide_number:    extractTag(block, 'numeroGuiaPrestador'),
        operator_guide:  extractTag(block, 'numeroGuiaOperadora'),
        processed_value: parseFloat(extractTag(block, 'valorProcessado') || '0'),
        paid_value:      parseFloat(extractTag(block, 'valorPago') || '0'),
        glossed_value:   parseFloat(extractTag(block, 'valorGlosa') || '0'),
        glosas:          [],
      };

      const glosaRegex = /<ans:glosa>([\s\S]*?)<\/ans:glosa>/g;
      let gMatch;
      while ((gMatch = glosaRegex.exec(block)) !== null) {
        guide.glosas.push({
          code:        extractTag(gMatch[1], 'codigoGlosa'),
          description: extractTag(gMatch[1], 'descricaoGlosa') || '',
          value:       parseFloat(extractTag(gMatch[1], 'valorGlosa') || '0'),
        });
      }

      // Status inferido
      if (guide.glossed_value === 0 && guide.paid_value > 0) {
        guide.status = 'paga';
      } else if (guide.paid_value > 0 && guide.glossed_value > 0) {
        guide.status = 'paga_parcial';
      } else if (guide.paid_value === 0 && guide.glossed_value > 0) {
        guide.status = 'glosada';
      } else {
        guide.status = 'em_analise';
      }

      result.guides.push(guide);
    }
  } catch (err) {
    result.errors.push(err.message || 'Erro ao parsear XML');
  }

  return result;
}

function extractTag(text, name) {
  const m = text.match(new RegExp(`<ans:${name}>([^<]*)</ans:${name}>`));
  return m ? m[1].trim() : null;
}

module.exports = {
  TISS_VERSION,
  buildBatchXml,
  buildSingleGuideXml,
  parseReturnXml,
  validateGuide,
  calculateHash,
};
