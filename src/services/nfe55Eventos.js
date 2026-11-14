// ============================================================
// AURA. — Eventos da NF-e modelo 55 (venda e devolução): cancelamento
// (110111) e carta de correção (110110). 14/11/2026 — CP5.
//
// Antes (defeito documentado no CP2): o POST /nfce/:id/cancel mandava
// QUALQUER nota com xml_signed para sefazSp.cancelNfce — endpoints da NFC-e
// (nfce.fazenda...) e prazo de 30 min. A 55 vai ao NFeRecepcaoEvento4 da
// NF-e (getEndpoints55) e o prazo é de 24 h depois da autorização
// (NFE55_CANCEL_DEADLINE_H, padrão 24). A NFC-e não muda.
//
// Gravação: status 'cancelada' + metadata.cancelamento { protocolo,
// registrado_em, justificativa, xml (procEventoNFe) } e, para cada carta,
// metadata.cartas_correcao[] { seq, texto, protocolo, registrada_em, xml }.
// A NF-e de venda cancelada deixa de travar a venda (notasDaVenda ignora
// 'cancelada') e o DANFE sai com a marca CANCELADA (CP3).
// ============================================================
'use strict';

const eventos = require('./sefazSp/eventos');
const { getEndpoints55 } = require('./sefazSp/nfe55');
const { loadCertificate } = require('./sefazSp/certStore');
const { openPfx } = require('./sefazSp/pfx');
const rejectionCatalog = require('./sefazSp/rejectionCatalog');
const { DocErro } = require('./nfe55Documentos');

const LIMITE_CARTAS = 20;

function horasDoPrazo(env = process.env) {
  const h = Number(String(env.NFE55_CANCEL_DEADLINE_H || '').replace(',', '.'));
  return Number.isFinite(h) && h > 0 ? h : 24;
}

function metadataDe(row) {
  if (!row || !row.metadata) return {};
  if (typeof row.metadata === 'string') { try { return JSON.parse(row.metadata); } catch (_) { return {}; } }
  return row.metadata;
}

const ehModelo55 = (chave) => /^\d{44}$/.test(String(chave || '')) && String(chave).slice(20, 22) === '55';

/** "15/11 às 15:51" no fuso de São Paulo. */
function dataHoraCurta(d) {
  const f = (o) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...o });
  return `${f({ day: '2-digit', month: '2-digit' })} às ${f({ hour: '2-digit', minute: '2-digit' })}`;
}

/** Até quando a NF-e pode ser cancelada. */
function prazoDeCancelamento(row, { now = Date.now(), env = process.env } = {}) {
  const horas = horasDoPrazo(env);
  if (!row || !row.authorized_at) return { horas, ate: null, vencido: false };
  const ate = new Date(new Date(row.authorized_at).getTime() + horas * 3600e3);
  return { horas, ate: ate.toISOString(), vencido: now > ate.getTime() };
}

function mensagemPrazoVencido(prazo) {
  return `Passou o prazo de ${prazo.horas} h para cancelar esta NF-e`
    + (prazo.ate ? ` (venceu em ${dataHoraCurta(prazo.ate)})` : '')
    + '. Para desfazer, emita uma NF-e de devolução — fale com seu contador.';
}

function tpAmbDoXml(xml) {
  const m = String(xml || '').match(/<tpAmb>(\d)<\/tpAmb>/);
  return m ? Number(m[1]) : 2;
}

/** Certificado + endpoints da 55 da loja que emitiu a nota. */
async function contextoDoEvento(db, row) {
  const { rows } = await db.query('SELECT * FROM nfce_config WHERE company_id = $1', [row.company_id]);
  const config = rows[0] || {};
  const tpAmb = tpAmbDoXml(row.xml_signed);
  const endpoints = getEndpoints55(config.uf || 'SP', tpAmb);
  const { pfx, password } = await loadCertificate(db, row.company_id);
  const cert = openPfx(pfx, password);
  return {
    tpAmb, endpoints, pfx, passphrase: password,
    cert: { keyPem: cert.keyPem, certDerBase64: cert.certDerBase64 },
    cOrgao: Number(String(row.chave_acesso).slice(0, 2)),   // cUF da chave = UF de quem autorizou
    cnpj: String(row.chave_acesso).slice(6, 20),
  };
}

function recusa(code, cStat, xMotivo, extra) {
  const amigavel = rejectionCatalog.lookup(cStat, xMotivo);
  const err = new DocErro(422, code, amigavel.titulo + '. ' + amigavel.acao);
  err.extra = { cStat: cStat || null, motivo: xMotivo || null, rejeicao_amigavel: amigavel, ...(extra || {}) };
  return err;
}

function semResposta(err) {
  const e = new DocErro(502, 'NFE_EVENTO_SEM_RESPOSTA',
    'A SEFAZ não respondeu agora. Tente de novo em instantes; se o evento já tiver sido registrado, a gente reconhece.');
  e.extra = { detalhe: err && err.message ? String(err.message).slice(0, 300) : null };
  return e;
}

async function juntarNoMetadata(db, id, objeto) {
  await db.query(
    `UPDATE nfce_emissions SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify(objeto), id]
  );
}

/**
 * Cancela a NF-e 55 (110111). Idempotente para nota já cancelada.
 * @returns {{ nota, evento: { cStat, protocolo, registrado_em, ja_cancelada }, prazo }}
 */
async function cancelarNfe55(db, row, { justificativa, userId, transport, now = Date.now(), env = process.env } = {}) {
  if (!ehModelo55(row.chave_acesso)) throw new DocErro(422, 'NFE_NAO_E_MODELO_55', 'Esta nota não é uma NF-e modelo 55.');
  const prazo = prazoDeCancelamento(row, { now, env });
  if (row.status === 'cancelada') {
    return { nota: row, evento: { ja_cancelada: true }, prazo, idempotente: true };
  }
  if (row.status !== 'autorizada' || !row.protocolo) {
    throw new DocErro(409, 'NFE_NAO_AUTORIZADA', 'Só nota autorizada pode ser cancelada.');
  }
  const xJust = String(justificativa || '').replace(/\s+/g, ' ').trim();
  if (xJust.length < 15 || xJust.length > 255) {
    throw new DocErro(422, 'JUSTIFICATIVA_INVALIDA', 'Escreva o motivo do cancelamento com 15 a 255 letras (regra da SEFAZ).');
  }
  if (prazo.vencido) {
    const e = new DocErro(422, 'NFE_PRAZO_CANCELAMENTO_VENCIDO', mensagemPrazoVencido(prazo));
    e.extra = { cancelavel_ate: prazo.ate };
    throw e;
  }

  const ctx = await contextoDoEvento(db, row);
  let r;
  try {
    r = await eventos.cancelarNfce({
      chave: row.chave_acesso, cnpj: ctx.cnpj, tpAmb: ctx.tpAmb, cOrgao: ctx.cOrgao,
      protocolo: row.protocolo, justificativa: xJust, endpoints: ctx.endpoints, cert: ctx.cert,
      pfx: ctx.pfx, passphrase: ctx.passphrase, transport,
    });
  } catch (err) {
    throw semResposta(err);
  }
  if (!r.sucesso) {
    if (String(r.cStat) === '501') {
      const e = recusa('NFE_PRAZO_CANCELAMENTO_VENCIDO', r.cStat, r.xMotivo, { cancelavel_ate: prazo.ate });
      e.message = mensagemPrazoVencido(prazo);
      throw e;
    }
    throw recusa('NFE_CANCELAMENTO_RECUSADO', r.cStat, r.xMotivo);
  }

  const cancelamento = {
    protocolo: r.protocoloEvento || null,
    registrado_em: r.dhRegEvento || new Date(now).toISOString(),
    justificativa: xJust,
    c_stat: r.cStat,
    ja_cancelada: !!r.jaCancelada,
    por: userId || null,
    xml: r.procEventoXml || null,
  };
  const { rows } = await db.query(
    `UPDATE nfce_emissions
        SET status = 'cancelada', cancel_reason = $1, cancelled_at = NOW(),
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE id = $3 RETURNING *`,
    [xJust, JSON.stringify({ cancelamento }), row.id]
  );
  return {
    nota: rows[0] || { ...row, status: 'cancelada' },
    evento: { cStat: r.cStat, protocolo: cancelamento.protocolo, registrado_em: cancelamento.registrado_em, ja_cancelada: !!r.jaCancelada },
    prazo,
  };
}

function cartasDe(row) {
  const lista = metadataDe(row).cartas_correcao;
  return Array.isArray(lista) ? lista : [];
}

/** Cartas sem o XML (para a tela). */
function resumoDasCartas(row) {
  return cartasDe(row).map((c) => ({ seq: c.seq, texto: c.texto, protocolo: c.protocolo || null, registrada_em: c.registrada_em || null }));
}

/**
 * Carta de correção (110110). nSeqEvento = maior já registrada + 1; cada
 * carta substitui a anterior.
 * @returns {{ carta: { seq, texto, protocolo, registrada_em }, cartas }}
 */
async function cartaCorrecao(db, row, { texto, userId, transport, now = Date.now() } = {}) {
  if (!ehModelo55(row.chave_acesso)) throw new DocErro(422, 'NFE_NAO_E_MODELO_55', 'Esta nota não é uma NF-e modelo 55.');
  if (row.status !== 'autorizada') {
    throw new DocErro(409, 'NFE_NAO_AUTORIZADA', row.status === 'cancelada'
      ? 'Esta nota foi cancelada: não dá para corrigir o texto dela.'
      : 'Só nota autorizada recebe carta de correção.');
  }
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (t.length < 15 || t.length > 1000) {
    throw new DocErro(422, 'TEXTO_INVALIDO', 'Escreva a correção com 15 a 1.000 letras.');
  }
  const anteriores = cartasDe(row);
  const seq = anteriores.reduce((m, c) => Math.max(m, Number(c.seq) || 0), 0) + 1;
  if (seq > LIMITE_CARTAS) {
    throw new DocErro(422, 'LIMITE_DE_CARTAS', `Esta nota já tem ${LIMITE_CARTAS} cartas de correção, o máximo da SEFAZ. Fale com seu contador.`);
  }

  const ctx = await contextoDoEvento(db, row);
  let r;
  try {
    r = await eventos.enviarCartaCorrecao({
      chave: row.chave_acesso, cnpj: ctx.cnpj, tpAmb: ctx.tpAmb, cOrgao: ctx.cOrgao,
      nSeqEvento: seq, correcao: t, endpoints: ctx.endpoints, cert: ctx.cert,
      pfx: ctx.pfx, passphrase: ctx.passphrase, transport,
    });
  } catch (err) {
    throw semResposta(err);
  }
  if (!r.sucesso) {
    if (String(r.cStat) === '573') {
      const e = new DocErro(409, 'CARTA_JA_REGISTRADA',
        `A SEFAZ já tem uma carta de correção com o número ${seq} para esta nota (de uma tentativa anterior). Atualize a nota e confira antes de enviar outra.`);
      e.extra = { cStat: r.cStat, motivo: r.xMotivo };
      throw e;
    }
    throw recusa('CARTA_CORRECAO_RECUSADA', r.cStat, r.xMotivo);
  }

  const carta = {
    seq, texto: r.xCorrecao, protocolo: r.protocoloEvento || null,
    registrada_em: r.dhRegEvento || new Date(now).toISOString(), por: userId || null, xml: r.procEventoXml || null,
  };
  await juntarNoMetadata(db, row.id, { cartas_correcao: [...anteriores, carta] });
  const resumo = { seq: carta.seq, texto: carta.texto, protocolo: carta.protocolo, registrada_em: carta.registrada_em };
  return { carta: resumo, cartas: [...resumoDasCartas(row), resumo] };
}

/** procEventoNFe de uma carta (para baixar). */
function xmlDaCarta(row, seq) {
  const c = cartasDe(row).find((x) => Number(x.seq) === Number(seq));
  if (!c) throw new DocErro(404, 'CARTA_NAO_ENCONTRADA', 'Carta de correção não encontrada nesta nota.');
  if (!c.xml) throw new DocErro(422, 'CARTA_SEM_XML', 'O XML desta carta não ficou guardado.');
  return c.xml;
}

/** Situação dos eventos para a tela (prazo de cancelamento e cartas). */
function situacao(row, opts) {
  const prazo = prazoDeCancelamento(row, opts);
  const meta = metadataDe(row);
  return {
    status: row.status,
    pode_cancelar: row.status === 'autorizada' && !prazo.vencido,
    cancelavel_ate: prazo.ate,
    prazo_horas: prazo.horas,
    cancelamento: meta.cancelamento
      ? { protocolo: meta.cancelamento.protocolo || null, registrado_em: meta.cancelamento.registrado_em || null, justificativa: meta.cancelamento.justificativa || null }
      : null,
    cartas: resumoDasCartas(row),
    pode_corrigir: row.status === 'autorizada' && cartasDe(row).length < LIMITE_CARTAS,
  };
}

module.exports = {
  cancelarNfe55, cartaCorrecao, xmlDaCarta, situacao, prazoDeCancelamento, mensagemPrazoVencido,
  ehModelo55, horasDoPrazo, LIMITE_CARTAS,
};
