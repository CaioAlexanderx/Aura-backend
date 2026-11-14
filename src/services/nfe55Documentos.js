// ============================================================
// AURA. — Documentos da NF-e modelo 55 (venda e devolução): DANFE A4, XML
// (nfeProc) e envio por e-mail ao cliente. 14/11/2026 — CP3.
// Usado por routes/nfe55Documentos.js e pelo DANFE da devolução em
// routes/print.js (que dependia da Nuvem Fiscal, desligada).
//
// E-mail: envio UNITÁRIO, disparado pelo lojista (nunca em lote). Vai ao
// cliente final da loja → modelo único na variante "loja" (marca da loja,
// rodapé "Enviado pela Aura para {loja}"), remetente neutro
// "Aura <contato@getaura.com.br>" e Reply-To no e-mail da loja (mesma regra
// do status do pedido, tq-72). Assinado com o nome da loja.
// ============================================================
'use strict';

const { gerarDanfe55Pdf } = require('./sefazSp/danfe55');
const { montarNfeProc, dhBrasilia } = require('./sefazSp/nfeProc');
const L = require('./emailLayout');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FROM_NEUTRO = 'Aura <contato@getaura.com.br>';
const REPLY_TO_SEM_RESPOSTA = 'noreply@getaura.com.br';

class DocErro extends Error {
  constructor(status, code, mensagem) { super(mensagem); this.status = status; this.code = code; }
}

function emailValido(v) {
  const s = v == null ? '' : String(v).trim();
  return /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/.test(s) && s.length <= 254 ? s : null;
}

function metadataDe(row) {
  if (!row || !row.metadata) return {};
  if (typeof row.metadata === 'string') { try { return JSON.parse(row.metadata); } catch (_) { return {}; } }
  return row.metadata;
}

/** O <protNFe> guardado (venda: metadata.prot_xml; devolução: idem, gravado pelo trocaDevolucao55). */
function protXmlDe(row) {
  const m = metadataDe(row);
  return m.prot_xml || (m.nfe55_venda && m.nfe55_venda.prot_xml) || null;
}

/**
 * NF-e 55 desta loja (venda ou devolução) com XML próprio.
 * Multi-CNPJ: só a loja que emitiu (company_id) enxerga a nota.
 */
async function carregarNota(db, companyId, emissaoId) {
  if (!UUID.test(String(emissaoId || ''))) throw new DocErro(404, 'NFE_NAO_ENCONTRADA', 'Nota não encontrada nesta loja.');
  const { rows } = await db.query(
    `SELECT * FROM nfce_emissions
      WHERE id = $1 AND company_id = $2 AND tipo IN ('nfe', 'nfe_devolucao')`,
    [emissaoId, companyId]
  );
  const row = rows[0];
  if (!row) throw new DocErro(404, 'NFE_NAO_ENCONTRADA', 'Nota não encontrada nesta loja.');
  if (!row.xml_signed) {
    throw new DocErro(422, 'NFE_SEM_XML',
      'Esta nota saiu pelo provedor antigo e o XML dela não está guardado na Aura. Fale com o suporte se precisar dela.');
  }
  return row;
}

function exigirStatus(row, permitidos) {
  if (permitidos.includes(row.status)) return;
  const motivo = row.status === 'rejeitada' ? 'foi recusada pela SEFAZ'
    : row.status === 'cancelada' ? 'foi cancelada'
    : row.status === 'processando' ? 'ainda está aguardando a SEFAZ'
    : `está com a situação "${row.status}"`;
  throw new DocErro(409, 'NFE_NAO_AUTORIZADA', `Esta nota ${motivo}. Só nota autorizada tem DANFE, XML e envio por e-mail.`);
}

/** DANFE A4 (PDF). Autorizada ou cancelada (com a marca). */
async function danfePdf(row, { compress = true } = {}) {
  exigirStatus(row, ['autorizada', 'cancelada']);
  const prot = protXmlDe(row);
  const xml = prot
    ? montarNfeProc(row.xml_signed, { protXml: prot, protocolo: row.protocolo, dhRecbto: row.authorized_at }).xml
    : row.xml_signed;
  return gerarDanfe55Pdf(xml, {
    protocolo: row.protocolo || undefined,
    dhRecbto: prot ? undefined : dhBrasilia(row.authorized_at),
    cancelada: row.status === 'cancelada',
    compress,
  });
}

/** nfeProc (só autorizada). */
function nfeProcXml(row) {
  exigirStatus(row, ['autorizada']);
  return montarNfeProc(row.xml_signed, { protXml: protXmlDe(row), protocolo: row.protocolo, dhRecbto: row.authorized_at });
}

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Texto do e-mail ao cliente. Curto, humano, assinado pela loja.
 * @returns {{ assunto, html, text }}
 */
function montarEmailDaNota({ loja, numero, serie, valor, devolucao, homologacao, temRespostaDaLoja }) {
  const doc = `NF-e nº ${numero}, série ${serie}`;
  const assunto = devolucao ? `Nota fiscal de devolução — ${loja}` : `Nota fiscal da sua compra — ${loja}`;
  const abertura = devolucao
    ? `Segue a nota fiscal de devolução (${doc}) da sua troca em ${loja}.`
    : `Segue a nota fiscal da sua compra em ${loja} (${doc}, no valor de ${brl(valor)}).`;
  const linhas = [
    'Olá!',
    abertura,
    'O DANFE (em PDF) e o arquivo XML estão anexados. Guarde o XML: ele é a nota fiscal de verdade.',
    ...(homologacao ? ['Esta nota é de teste (ambiente de homologação) e não tem valor fiscal.'] : []),
    temRespostaDaLoja ? 'Qualquer dúvida, é só responder este e-mail.' : 'Qualquer dúvida, fale com a loja.',
  ];
  const corpo = [
    ...linhas.map((t) => L.p(t)),
    L.pHtml(`Obrigado!<br><strong>${L.esc(loja)}</strong>`),
  ].join('\n');
  const html = L.montarEmail({
    variante: 'loja',
    assunto,
    previa: abertura,
    corpo,
    whatsapp: false,
    marca: { nome: loja },
  });
  const text = [...linhas, '', 'Obrigado!', loja].join('\n');
  return { assunto, html, text };
}

/** E-mail padrão: corpo > <dest><email> do XML > cadastro do cliente da venda. */
async function emailPadrao(db, row) {
  const doXml = (String(row.xml_signed).match(/<dest>[\s\S]*?<email>([^<]+)<\/email>[\s\S]*?<\/dest>/) || [])[1];
  if (emailValido(doXml)) return emailValido(doXml);
  if (!row.sale_id) return null;
  try {
    const { rows } = await db.query(
      `SELECT c.email FROM sales s JOIN customers c ON c.id = s.customer_id
        WHERE s.id = $1 AND s.company_id = $2`,
      [row.sale_id, row.company_id]
    );
    return emailValido(rows[0] && rows[0].email);
  } catch (_) {
    return null;
  }
}

/**
 * Envia o DANFE + XML a UM destinatário e registra no metadata.
 * @returns {{ para, enviado_em, id }}
 */
async function enviarPorEmail(db, row, { email, userId, sendMail }) {
  exigirStatus(row, ['autorizada']);
  let para = null;
  if (email !== undefined && email !== null && String(email).trim() !== '') {
    para = emailValido(email);
    if (!para) throw new DocErro(422, 'EMAIL_INVALIDO', 'Esse e-mail não parece certo. Confira e tente de novo (um endereço só).');
  } else {
    para = await emailPadrao(db, row);
    if (!para) {
      throw new DocErro(422, 'NFE_SEM_EMAIL',
        'Não achamos o e-mail do cliente nesta nota. Digite o e-mail para onde a nota deve ir e envie de novo.');
    }
  }

  const { rows: emp } = await db.query(
    'SELECT COALESCE(trade_name, legal_name) AS nome, email FROM companies WHERE id = $1',
    [row.company_id]
  );
  const loja = (emp[0] && emp[0].nome) || 'a loja';
  const emailDaLoja = emailValido(emp[0] && emp[0].email);

  const proc = nfeProcXml(row);
  const pdf = await danfePdf(row);
  const homologacao = /<tpAmb>2<\/tpAmb>/.test(row.xml_signed);
  const devolucao = Number(row.finalidade) === 4 || row.tipo === 'nfe_devolucao';
  const email_ = montarEmailDaNota({
    loja, numero: row.numero, serie: row.serie, valor: row.total_nfce, devolucao, homologacao,
    temRespostaDaLoja: !!emailDaLoja,
  });

  const r = await sendMail({
    from: FROM_NEUTRO,
    replyTo: emailDaLoja || REPLY_TO_SEM_RESPOSTA,
    to: para,
    subject: email_.assunto,
    html: email_.html,
    text: email_.text,
    tipo: 'nfe55_cliente',
    companyId: row.company_id,
    userId: userId || null,
    attachments: [
      { filename: `${proc.chave}-danfe.pdf`, content: pdf, contentType: 'application/pdf' },
      { filename: `${proc.chave}-nfe.xml`, content: Buffer.from(proc.xml, 'utf8'), contentType: 'application/xml' },
    ],
  });

  const registro = { para, enviado_em: new Date().toISOString(), por: userId || null, id: (r && r.id) || null };
  try {
    await db.query(
      `UPDATE nfce_emissions
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('emails_enviados', COALESCE(metadata->'emails_enviados', '[]'::jsonb) || $1::jsonb)
        WHERE id = $2`,
      [JSON.stringify([registro]), row.id]
    );
  } catch (e) {
    // registro nunca desfaz um envio que já saiu
    console.error('[nfe55Documentos] registro do envio falhou:', e.message);
  }
  return registro;
}

module.exports = {
  carregarNota, danfePdf, nfeProcXml, enviarPorEmail, montarEmailDaNota, emailPadrao,
  exigirStatus, protXmlDe, emailValido, DocErro, FROM_NEUTRO,
};
